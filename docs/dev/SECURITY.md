# Security Posture

## What This Document Is For

This is a hobby project with one user (the author) and a small number of other users who install it from npm or as an MCPB bundle. This doc exists so that security decisions — what we defend against, what we don't, and why — are a lookup rather than a memory exercise. It is the reference for evaluating security-flavored PRs and issues.

Not a compliance document. Not a responsible-disclosure SLA. Just a written position.

---

## Context

Bear Notes MCP is a single-user desktop server. It runs locally on macOS, reads the user's Bear SQLite database, and writes to Bear via `x-callback-url`. It is invoked by an MCP client (Claude Desktop, Claude Code, Cursor, etc.) under the same UID as the user.

The operator and the beneficiary are the same person. There is no multi-tenancy, no remote surface, no authentication layer — the OS user account is the trust boundary.

---

## Trust Model

| Component | Trust level | Notes |
|-----------|-------------|-------|
| User | Fully trusted | Operator of the machine and target of all output |
| Operating system (macOS) | Trusted | We rely on Gatekeeper, filesystem permissions, and the UID boundary |
| Bear app | Trusted | The user chose to install it; we do not defend against Bear bugs |
| MCP client (Claude Desktop, Claude Code, etc.) | Trusted to be the user's chosen client | We do not defend against a malicious client |
| LLM behind the MCP client | **Partially trusted** | Treated as a fallible collaborator — may make mistakes, may be influenced by prompt injection inside content it reads. Not treated as fully hostile. |
| Content the LLM reads (Bear notes, fetched URLs) | Untrusted | Anything a user pastes into a note or a fetched web page may contain injection attempts |
| Filesystem paths chosen by the LLM | Untrusted choice, trusted contents | The file contents belong to the user, but the *choice of which file* comes from the LLM and should be narrowed |
| Network destinations chosen by the LLM | Untrusted | Same reasoning as above |

The key asymmetry: the LLM is trusted enough to be given tools, but not trusted enough to freely pick arbitrary file paths or arbitrary hosts. This is the axis most server-side defenses sit on.

---

## What We Defend Against

1. **Accidental data loss in the user's notes** — covered by the `bear-replace-text` opt-in gate and the absence of a delete tool (see `SPECIFICATION.md` § Safety Gates).
2. **SQL injection via user input** — covered by parameterized queries and a read-only database connection.
3. **Shell injection via the subprocess path** — covered by `spawn()` with an argv array; no shell interpolation.
4. **LLM misjudgment of dangerous primitives** — this is the work that is *partially done*. Tools that grant file-read or network-fetch primitives should narrow what the LLM can reach, even when the user is not actively paying attention.

## What We Do Not Defend Against

1. **A fully compromised LLM or client.** If the client is malicious or the LLM is jailbroken into adversarial behavior, this server is not the last line of defense — the client already has direct filesystem and network access in most MCP setups.
2. **Local attackers already on the user's machine.** They have broader primitives than this server exposes.
3. **Bear app vulnerabilities.** Bugs in Bear's x-callback-url handling or its database schema are upstream.
4. **Supply-chain compromise of npm dependencies.** We use Snyk for known CVEs but do not vendor or audit transitive deps.
5. **Content the user themselves wrote into Bear being exposed to the LLM.** That is the intended function of the server.

---

## Current Protections

Inventory as of 2026-04. Update this table when adding or removing a protection.

| Layer | Protection | Where |
|-------|------------|-------|
| SQL | Parameterized queries, read-only DB, LIKE wildcard escaping | `database.ts`, `notes.ts`, `tags.ts` |
| Subprocess | `spawn()` with argv array, no shell | `bear-urls.ts` |
| URL construction | `URLSearchParams` + `%20` post-pass, fixed `bear://` scheme | `bear-urls.ts`, `config.ts` |
| Tool input | Zod schemas with `.trim().min(1)` baseline, enum-restricted fields where applicable | `main.ts` |
| Destructive writes | `ENABLE_CONTENT_REPLACEMENT` opt-in gate on `bear-replace-text` | `main.ts`, `config.ts` |
| Delete operations | No tool exists. Archive only. | by omission |
| `bear-grab-url` | `http`/`https` scheme enforcement | `main.ts` |
| `bear-add-file` | Handled `ENOENT` / `EACCES` / empty-file errors | `main.ts` |

---

## Known Gaps

These are acknowledged and, where applicable, tracked as issues. Presence in this list is not a commitment to fix — it's honesty about the current state.

| Gap | Risk | Current stance |
|-----|------|----------------|
| `bear-add-file` accepts any path the Node process can read (no traversal check, no symlink resolution, no allowlist, no size cap, no MIME check) | LLM could be nudged by prompt injection into reading `~/.ssh/id_rsa` or similar | Planned: path policy + size cap. Preference is input validation over feature-flag gating. |
| `bear-grab-url` has no host filter (no block on `localhost`, RFC1918, link-local, metadata endpoints) | Fetch handoff is Bear's, but the server does not narrow the surface | Planned: host filter with opt-in escape hatch for private networks |
| No audit log of writes | User cannot reconstruct what the LLM did | Accepted. Logs go to stderr via `debug`; the user's Bear version history is the audit trail for content. |
| No rate limiting or tool-call throttling | An LLM loop could spam Bear with writes | Accepted. Low risk at hobby scale; would complicate UX. |
| No interactive confirmation for destructive operations | Reliance on opt-in flags and Bear's archive-over-delete model | Accepted. Confirmation prompts belong in the MCP client, not here. |
| `limit` parameters on search tools lack `.int().min().max()` bounds | Minor DoS via huge result sets | Low priority, cheap to fix when next touching the file. |

---

## Principles for Security Decisions

These are the rules of thumb used to evaluate security-flavored PRs and issues. They sit underneath the project's general KISS / YAGNI principles.

1. **Prefer input validation over feature flags.** A feature flag hides a tool; validation narrows it. Validation preserves UX and is the right default unless the capability is genuinely irrecoverable when misused.

2. **Safety gates are for irreversibility plus regret.** `ENABLE_CONTENT_REPLACEMENT` exists because overwriting a note with the wrong content is hard to undo and the user would be unhappy. A gate for a tool whose worst case is "a note got created with an unexpected file attached" is overkill — the user can archive it.

3. **Do not ship defense-in-depth as dead code.** If a guard is unreachable (for example, a runtime check inside a handler that cannot be invoked because its registration was skipped), pick one layer. Unreachable branches are not defense; they are future confusion.

4. **Any new tool that grants the Node process a capability the MCP client does not already provide requires a threat-model note in the PR.** `bear-add-file` grants arbitrary disk read; `bear-grab-url` grants arbitrary HTTP fetch. These are the capabilities that need narrowing. A tool that only reads Bear's own database or writes via `x-callback-url` does not expand the client's surface and does not need a special note.

5. **Update this document when a security decision is made.** Add to the protections table when a defense lands. Add to the gaps table when a gap is identified. Move items between them as they change. If a decision overrides one of the principles above, say so here rather than in a PR comment that will be forgotten.

6. **Honesty over theater.** An opt-in flag that the user will always flip on is not a defense — it is a UX tax disguised as one. If a mitigation does not actually reduce risk for the realistic user, do not ship it.

---

## Reporting

This is a personal project. If you find something you believe is a security issue, open a GitHub issue or contact the maintainer via the email listed in `package.json`. Response time is best-effort. There is no embargo process and no bounty.

---

## References

- `SPECIFICATION.md` — system architecture, safety gates, error handling contract
- `BEAR_DATABASE_SCHEMA.md` — database structure and fragility points
- MCP specification: https://spec.modelcontextprotocol.io/

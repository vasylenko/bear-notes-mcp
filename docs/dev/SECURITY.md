# Security Posture

## What This Document Is For

Bear Notes MCP is a small open-source tool distributed via npm and MCPB to a real, if modest, user base. Security decisions here shape everyday UX for those users, which means they need to live somewhere other than chat logs and maintainer memory.

This doc is the reference for anyone working on the project — the maintainer, AI collaborators, outside contributors — when validating an idea, reviewing an implementation, or deciding whether a new capability belongs here. It states what this project defends against, what it doesn't, and the principles that settle the question when a new proposal is on the table.

Not a compliance document.

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
| MCP client | Trusted to be the user's chosen client | We do not defend against a malicious client |
| LLM behind the MCP client | **Partially trusted** | A fallible collaborator — may make mistakes, may be influenced by prompt injection inside content it fetches. Not treated as fully hostile. |
| Content fetched from the network | Untrusted | A fetched web page may contain text intended to manipulate the LLM into unintended tool calls |
| Filesystem paths and hosts chosen by the LLM | Untrusted choice | The user's files and their network belong to them, but the *choice of which file or host* comes from the LLM and should be narrowed |

The key asymmetry: the LLM is trusted enough to be given tools, but not trusted enough to freely pick arbitrary file paths or arbitrary hosts. This is the axis most server-side defenses sit on.

Content already inside the user's Bear library is not treated as a threat vector. If the user put something in a note, they accepted that risk. Server-side defenses narrow what an LLM nudged by *incoming* content (a fetched page, an attached file) can do — not what the user stored themselves.

---

## What We Defend Against

1. Accidental data loss in the user's notes.
2. SQL injection via user or LLM input.
3. Shell injection via the subprocess path.
4. LLM overreach on tools that expose primitives beyond what the MCP client already provides (file read, network fetch).

## What We Do Not Defend Against

1. A fully compromised LLM or client. If the client is malicious or the LLM is jailbroken into adversarial behavior, this server is not the last line of defense.
2. Local attackers already on the user's machine. They have broader primitives than this server exposes.
3. Bear app vulnerabilities. Bugs in Bear's x-callback-url handling or its database schema are upstream.
4. Supply-chain compromise of dependencies. We rely on Snyk for known CVEs.
5. Content the user themselves wrote into Bear being exposed to the LLM. That is the intended function of the server.

---

## How We Defend

Standing rules. These are how new code is expected to be written and how existing code is already structured. A PR that cannot follow one of these should explain why in its description.

| Class | Rule |
|-------|------|
| Database reads | Every query goes through `db.prepare(...)` with bound parameters. String interpolation of user or LLM input into SQL is forbidden. `LIKE` queries escape `%`, `_`, `\` before binding. The connection is opened read-only. |
| Subprocess | Every invocation uses `spawn()` (or equivalent) with an argv array. Shell-string concatenation is forbidden. |
| URL construction | URLs are built with `URLSearchParams`, not string concatenation. The `bear://` scheme is a constant, not input. |
| Tool inputs | Tool inputs use zod schemas with a `.trim().min(1)` baseline on strings, enum restriction where values are bounded, scheme restriction for URL inputs, and integer bounds on numeric limits. |
| Destructive writes | Operations that overwrite user content are gated behind an opt-in env var (the `ENABLE_CONTENT_REPLACEMENT` pattern). No tool permanently deletes user data — archive is the substitute. |
| Surface-expanding tools | Tools that grant the Node process a capability the MCP client does not already provide (file read, network fetch) narrow what the LLM can reach: path policy and size cap for filesystem, host filter for network. |

---

## Principles for Security Decisions

These sit underneath the project's general KISS / YAGNI principles.

1. **Prefer input validation over feature flags.** A feature flag hides a tool; validation narrows it. Validation preserves UX and is the right default unless the capability is genuinely irrecoverable when misused.

2. **Safety gates are for irreversibility plus regret.** `ENABLE_CONTENT_REPLACEMENT` exists because overwriting a note with the wrong content is hard to undo and the user would be unhappy. A gate for a tool whose worst case is "a note got created with an unexpected file attached" is overkill — the user can archive it.

3. **Do not ship defense-in-depth as dead code.** If a guard is unreachable (for example, a runtime check inside a handler that cannot be invoked because its registration was skipped), pick one layer. Unreachable branches are not defense; they are future confusion.

4. **Any new tool that grants the Node process a capability the MCP client does not already provide requires a threat-model note in the PR.** `bear-add-file` grants arbitrary disk read; `bear-grab-url` grants arbitrary HTTP fetch. These are the capabilities that need narrowing. A tool that only reads Bear's own database or writes via `x-callback-url` does not expand the client's surface and does not need a special note.

5. **Honesty over theater.** A gate defends only when enabling it is a real risk-acceptance — the user is actively deciding to live with a specific failure mode. A gate that every realistic user flips on reflexively ("I just wanted the tool") is UX tax, not defense. This is why gates sit on irreversible operations, where enabling asks a real question, rather than on recoverable ones, where there is nothing to accept.

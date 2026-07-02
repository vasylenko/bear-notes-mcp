# Project Specification: Bear Notes MCP Server

## What This Document Is For

Architecture decisions, system boundaries, and design constraints that shape how the codebase works. Tool descriptions and feature lists live in `manifest.json` and `README.md` — not here.

---

## System Architecture

### Hybrid Data Access Model

The server uses two distinct paths to interact with Bear, chosen to avoid corrupting Bear's database while maximizing read performance:

```
  MCP Client
        │
        ▼
  MCP Server (main.ts)
        │
        ├── READ path ──▶ Bear SQLite DB (direct, read-only)
        │                  src/operations/{notes,tags}.ts
        │                  → src/infra/{database,bear-schema,bear-encoding,fts-index}.ts
        │
        └── WRITE path ──▶ Bear x-callback-url (fire-and-forget)
                           src/infra/bear-urls.ts → macOS `open -g` subprocess
```

**Why not just use the database for everything?** Writing directly to Bear's Core Data SQLite would risk corruption — Bear doesn't expect external writers and could overwrite changes or crash.

**Why not just use x-callback-url for everything?** Bear's x-callback-url has no x-success callback that works without a running server to receive it. Reads via URL would require polling or a callback server. Direct SQLite is faster and simpler for reads.

### Fire-and-Forget Write Model

All write operations go through the URL path. This is intentionally one-way:

- The server builds a URL, hands it to macOS, and gets back only an exit code
- Bear processes the URL asynchronously — there's no confirmation that the operation succeeded inside Bear
- For note-level writes, the server does pre-flight validation via the DB read path (note exists? section exists?) to catch errors early rather than letting Bear silently fail
- For global operations (tag rename/delete), no pre-flight check is possible — Bear silently no-ops on missing targets

### Background Execution

All write operations execute in the background without disrupting the user's Bear UI. The principle: the user is working in their MCP client, not Bear — writes should never steal focus, open windows, or switch the active note.

### Search: In-Memory FTS5 Index

`bear-search-notes` is backed by a separate in-memory SQLite full-text search index, rebuilt on demand from Bear's read-only DB:

```
  bear-search-notes call
        │
        ▼
  searchByQuery (src/infra/fts-index.ts)
        │
        ├──▶ Drift check: MAX(ZMODIFICATIONDATE) + COUNT(*) of active notes
        │     vs. cached values. Sub-millisecond. Mismatch → rebuild.
        │
        ├──▶ (Re)build: read non-trashed/non-archived/non-encrypted notes
        │     from ZSFNOTE, concat OCR text from ZSFNOTEFILE, capture per-tag
        │     pinned status from the discovered Z_<n>TAGS / Z_<n>PINNEDINTAGS
        │     join tables. Bulk-insert into a :memory: FTS5 virtual table
        │     (unicode61 tokenizer, remove_diacritics=2) plus a side
        │     note_tags table.
        │
        ├──▶ Run: FTS5 MATCH + ORDER BY rank (per-column BM25 weights:
        │     title/body=2.0, ocr=0.5) with snippet() output (matched terms
        │     wrapped in `[...]`) for term queries; mod-date DESC with a
        │     200-character body-prefix snippet for filter-only queries.
        │     Filters (tag, pinned, date) compose with AND.
        │
        └──▶ Hydrate revision (`fetchRevisionsForResults`): batch SELECT
              against the live Bear DB to attach each result's current
              `Z_OPT`. Goes against the live DB rather than the FTS shadow
              because the drift sentinel above misses pin-only and tag-only
              writes that bump `Z_OPT` without bumping `ZMODIFICATIONDATE` —
              a cached revision would silently lag. Identifiers absent from
              the live DB (note vanished between rebuild and hydration)
              surface as `Revision: unknown` with `REVISION_UNAVAILABLE_SENTENCE`.
```

**Why in-memory, not persistent.** Bear syncs notes across the user's machines via iCloud. Any persistent derived state (a side-car DB, a shadow FTS5 file) would diverge from Bear's authoritative state without coordination. In-memory rebuild satisfies cross-Mac consistency by construction. Build cost (~70 ms / 229 notes empirically) is small enough to absorb on first search per server process.

**Why MAX + COUNT, not MAX alone.** A bulk import of pre-dated notes (ZMODIFICATIONDATE < the previous max) would not move the maximum. COUNT closes that gap. Both aggregates fit a single SELECT.

**Concurrency.** `node:sqlite` is synchronous. JSON-RPC handlers run on Node's single event loop, so a search call that triggers a rebuild completes the rebuild atomically before the next call starts. No mutex needed; do not refactor the entry point to async/await without re-establishing this invariant.

The atomicity guarantee is in-process only — Bear.app writes the source SQLite file as an independent macOS process, and `journal_mode=DELETE` provides no snapshot isolation across processes. Bear writes that land between rebuilds are detected by the next `MAX + COUNT` drift check and force a fresh rebuild. Bear writes that land _during_ a rebuild — between `insertNotes`/`insertNoteTags` and `readDriftKey` — are reflected in the post-build drift key but not the index, leaving the new note invisible until another Bear write moves the key again. Bounded by Bear's typical write cadence; not addressed here because the build window is sub-100 ms for typical libraries.

**FTS5 query handling.** User-supplied terms are inspected by `prepareFTS5Term`:

- **Quoted or grouped expressions pass through verbatim** — `"exact phrase"` and `(grouped expr)` are caller opt-ins to FTS5's own phrase / grouping syntax.
- **Uppercase boolean keywords are not honored as operators.** `AND` / `OR` / `NOT` / `NEAR` written in uppercase are quoted as literal tokens in the OR-join path. Search is positioned as natural-language only across tool descriptions, errors, and user docs — the SVA-28 A/B eval showed agents underperform when nudged into capability mode, and a pasted `apple NOT banana` more likely means "notes about both" than boolean exclusion. Quoting also serves an FTS5-syntax purpose: an unquoted bare `NOT` would otherwise reach the parser as an operator with no operands and surface as a SQL syntax error. FTS5's keyword recognition is case-sensitive, so lowercase `not`/`and` already pass through as content tokens without quoting.
- **Everything else is tokenized via `[\p{L}\p{N}_]+\*?` and routed by shape.** Unicode-aware on purpose: ASCII `\w` would silently zero-hit any non-ASCII script (Cyrillic, accented Latin, Greek, etc.) because `unicode61` indexes those scripts as ordinary letter tokens. A single bareword (with optional `*` suffix) passes through unchanged so FTS5's prefix rule applies. Single-identifier punctuated input — no whitespace in the trimmed term, no wildcard tokens, e.g. `bear-notes-mcp` or `2026-04-15` — is tokenized and wrapped as an FTS5 phrase so the consecutive token sequence matches, restoring the substring-style precision v2.x's LIKE gave for slugs and identifiers; the no-wildcard guard exists because FTS5 only allows `*` on the last phrase token, so phrase-quoting a wildcard input would silently strip the prefix-match. Multi-word input with whitespace — bare or punctuation-laden — reduces to OR-rank-by-density. Incidental punctuation (brackets, hyphens, colons) within tokens is dropped because unicode61 tokenized the indexed corpus the same way, so query-side punctuation removal mirrors what FTS5 did on the body side. Input with no word characters at all falls through verbatim and surfaces an FTS5 syntax error (caught and reframed by `runWithFts5SyntaxRemap`).

The OR-rank fallthrough is deliberate. FTS5's bareword default is implicit-AND, which silently filters out notes missing any single token — including notes that paraphrase or use a different word for one of the user's referents. The SVA-28 A/B eval found 73% of search calls containing a hyphen or colon returning zero hits under an earlier phrase-quote branch, which turned natural-language input into rigid token-order phrase matches. OR-rank with BM25 lets density-rich notes still surface, matching the user/agent expectation that ranked search returns relevance-ordered results rather than a strict filter.

**Why per-column BM25 weights, not equal.** Bear's search corpus mixes authored text (title and body) with OCR text extracted from attached images and PDFs, which is noisier — receipts, screenshots, photos of unrelated material captured in passing. With default 1.0/1.0/1.0 weights, OCR and authored columns score identically, so a stray OCR hit can outrank an authored hit on length normalization alone. The persistent rank config installed at index build (`INSERT INTO notes(notes, rank) VALUES('rank', 'bm25(2.0, 2.0, 0.5)')`) uses title=2.0, body=2.0, ocr=0.5 — a 4× bias toward authored content. The bias is statistical rather than strict: BM25 also applies aggregate-doclen length normalization on top of the weighted term frequency, so a very short OCR-only note can still outrank a very long authored note. OCR-only matches still surface when nothing else matches (weight is 0.5, not 0). Term-query SQL uses `ORDER BY rank`, not `ORDER BY bm25(notes)`: the no-arg `bm25(notes)` ignores the rank config and always applies default 1.0/1.0/1.0 weights — only the `rank` auxiliary column reads the configured per-column weights. The config lives inside `buildIndex`, not at startup: rank config is per-connection state, and the `:memory:` DB is destroyed and recreated whenever drift triggers a fresh build.

**Schema discovery.** Bear's tag-join table names embed Core Data entity IDs (`Z_5TAGS`, `Z_13TAGS`, etc.) that can shift across Bear schema migrations. `src/infra/bear-schema.ts:discoverBearSchema` resolves the actual names at runtime via `Z_PRIMARYKEY` (Core Data's entity registry). Both the FTS5 build path and `src/operations/tags.ts` consume this utility — no hardcoded entity IDs remain in the codebase.

**Load-bearing assumption.** `node:sqlite`'s bundled SQLite must include FTS5. Verified at planning time on Node 24.14.1 / SQLite 3.51.2; locked into CI by `src/infra/bear-schema.test.ts` so any future Node version that disables FTS5 fails before the rest of the search subsystem panics.

---

## Safety Gates

### Registration-Time Read/Write Gating

Every tool registers directly via `server.registerTool(...)` — the call shape is identical for reads and writes. Write tools additionally pass the returned `RegisteredTool` through `applyWriteGate(...)` from `src/tools/registration.ts`, which calls `RegisteredTool.disable()` when `ENABLE_CONTENT_REPLACEMENT` is `false`. The MCP SDK auto-filters disabled tools out of `tools/list` (see `dist/esm/server/mcp.js` in `@modelcontextprotocol/sdk`) and refuses any `tools/call` against them with `McpError(InvalidParams, "Tool ... disabled")` — so write tools exist in the SDK's registry but are invisible on the wire when the gate is closed.

The gate is the env var `UI_ENABLE_CONTENT_REPLACEMENT` (strict equality `=== 'true'`). It maps to the Claude Desktop user-config field labeled **"Edit Mode"** (the manifest's `enable_content_replacement` key with `title: "Edit Mode"`). The env var is read once at process startup (module initialization) in `src/config.ts:ENABLE_CONTENT_REPLACEMENT` and never re-checked at call time.

When the gate is closed (default), the server's `tools/list` returns the 4 Bear-domain read-only tools plus `bear-capabilities`, a discovery tool registered conditionally (only when the gate is closed). The `initialize` response's `instructions` field carries the unlock guidance, but it's unreliable across MCP clients (Claude Desktop and OpenCode drop it; Codex CLI reroutes it), so `bear-capabilities` surfaces the same guidance through `tools/list` — the only channel guaranteed to reach the model in every client. When the gate is open, the 12 Bear-domain tools are advertised in `tools/list` and `instructions` carries the edit-mode guidance; `bear-capabilities` is not registered because there's nothing left to unlock.

The read/write classification is locked in by the system test at `tests/system/registration-gate.test.ts`. Its `EXPECTED_READ_ONLY_TOOLS`, `EXPECTED_OFF_ONLY_TOOLS`, and `EXPECTED_WRITE_TOOLS` constants enumerate which tool falls in which class; `task test:system` (run locally before merge) fails if a future tool registration is misclassified. System tests cannot run in CI — see _Testing Constraints_ below.

**Why registration-time, not call-time.** With the gate at call time the LLM still sees write tools in `tools/list`, picks one, and receives a runtime error — wasted tokens and confusing UX. Registration-time gating gives the user a _provably_ read-only mode verifiable with a single MCP wire call. The gate also widens past content replacement: it now covers all 8 write operations, not just `bear-replace-text`. The user-facing label "Edit Mode" replaces the older "Content Replacement" to reflect this widened scope.

### No Note Deletion

There is no delete tool. Too destructive for AI-assisted workflows — a misidentified note ID would mean permanent data loss. Archiving is the closest alternative and is reversible in Bear.

### Optimistic Concurrency Control

OCC has two halves and both ship here.
1. Inform — every note-scoped response carries the note's current revision (`ZSFNOTE.Z_OPT`) as `Revision: <n>` — followed Kung & Robinson's 1981 ACM TODS paper _"On Optimistic Methods for Concurrency Control"_ 
2. Enforce — body-modifying note tools require the caller to echo that revision and reject stale writes with a soft error — turns the advisory token into a write gate.

#### Inform half

Three write-path patterns capture the revision honestly — distinguished by what's known about the note before vs after the URL fires:

- **Content writes** (`bear-add-text`, `bear-replace-text`, `bear-add-file`, `bear-add-tag`) — `existingNote.revision` from the pre-flight `getNoteContent`, then `awaitRevisionIncrement(id, baseline)` polls `Z_OPT` every 15ms until inequality, budgeted by `REVISION_POLL_TARGET_MS`. On timeout: duration-free `Revision: unknown (...)` sentinel.
- **`bear-create-note`** — no pre-flight baseline (the note doesn't exist yet). `awaitNoteCreation(title)` polls `ZSFNOTE` by `(title, recent ZCREATIONDATE)`, projecting `{ZUNIQUEIDENTIFIER, Z_OPT}` in one SELECT, capped at `POLL_TIMEOUT_MS` (2000ms — wider than the content-write budget because first-row appearance is slower than a counter bump). On timeout: `Note ID: unknown ...` + `Revision: unknown (creation confirmation timed out after 2000ms)`.
- **`bear-archive-note`** — pre-write snapshot only. Post-archive the row is filtered from default queries (`ZARCHIVED = 1`), so a post-write read would return null. Response carries the pre-archive snapshot directly; no timeout sentinel applies.

**In-scope tools.** The six note-mutating tools — `bear-create-note`, `bear-add-text`, `bear-replace-text`, `bear-add-file`, `bear-add-tag`, `bear-archive-note` — and the three note-reading tools that return notes — `bear-open-note`, `bear-search-notes`, `bear-find-untagged-notes` — emit a revision line per the diagrams above. Global tag tools (`bear-rename-tag`, `bear-delete-tag`, `bear-list-tags`) and `bear-capabilities` do not reference a specific note and emit no revision line.

**Field-sourcing discipline.** Per the mutation-response-metadata rule in `MCP_STANDARDS.md`, every field must come from a value known before the write or from a write-confirming poll — never from a post-write read that samples current state. Concrete sourcing:

- **Note ID** — for modifications, from the input parameter. For creation, from `awaitNoteCreation`'s post-create poll (the only path that needs polling at all, since the ID doesn't exist before the URL fires).
- **Note title** — for modifications, from the pre-flight `getNoteContent` validation. For creation, from the input parameter when one was provided (the title-less creation path omits the line).
- **Revision** — pre-flight `existingNote.revision` plus a post-write capture: `awaitRevisionIncrement` for content writes, `awaitNoteCreation`'s bundled `{id, revision}` SELECT for create, the pre-flight snapshot itself for archive. Three timeout sentinels — content-write, creation, and read-side-miss — each cite the cap that actually fired (constants in `src/tools/responses.ts`).

**Constraint partially lifted: write verification.** _Key Design Constraints → Intentional Exclusions_ notes "Write verification: No way to confirm Bear processed a URL action." OCC inform lifts this for any write that bumps `Z_OPT` — polling waits for the change, so a non-null `Revision` in the response _is_ the confirmation. The constraint persists for writes that don't bump `Z_OPT` (the timeout sentence honestly signals this rather than masking it).

**Constraint partially lifted: test pause-after-write.** New OCC system tests use the response's `Revision` as a deterministic completion signal — no `sleep` is needed between the under-test write and its readback. The polling doesn't cover Bear's first-edit recompute save (the `+2` jump documented in `BEAR_DATABASE_SCHEMA.md`), so tests that chain a `create-note` before the under-test write still pause between them.

Empirical findings about `Z_OPT` behavior across URL actions live in `BEAR_DATABASE_SCHEMA.md`. The compound polling rule (compare for inequality, not `baseline + 1`) is driven by the empirically observed `+2` first-edit-after-creation jump.

#### Enforce half

Every body-modifying note tool requires the caller to supply `revision` alongside the note ID. The handler reads the live revision via the existing `getNoteContent(id)` pre-flight (no new DB call — the row already carries `Z_OPT`), compares to the caller's value, and rejects mismatches with a soft error (`isError: true`) instructing the caller to re-read with `bear-open-note`.

**Gate placement.** After the existing `getNoteContent` non-null check, BEFORE any tool-specific pre-flight (header existence, attachment readability, etc.). Stale-revision wins over downstream pre-flight because a stale view of the structure is itself a revision-mismatch symptom — surfacing "header not found" first would mislead the caller into thinking the structural shape changed when in fact their whole view is out of date.

**Scope: body-modifying tools.** The criterion is "does the tool write body bytes?", not "is this any write at all". The threat the gate exists to mitigate — an agent writing from a stale view of the body — applies wherever caller intent depends on body content the caller previously read. Stale-clobber for replace, stale-intent for the additive writes.

| Tool                | Body bytes change?                       | Threat without gate                                                                                                                            | Gated? |
| ------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `bear-add-text`     | Yes — text inserted into body            | Stale-intent: wrong place by structure drift; wrong section by rename; wrong format by format drift; wrong semantics by note pivot             | ✓      |
| `bear-replace-text` | Yes — section or full body replaced      | Stale-clobber (direct data loss) plus the stale-intent failures above                                                                          | ✓      |
| `bear-add-file`     | Yes — attachment marker inserted in body | Stale-intent positional (attachment lands wrong place after structure drift)                                                                   | ✓      |
| `bear-add-tag`      | Yes — tag markers prepended to body      | Stale-intent semantic (right ID, wrong meaning after note pivot)                                                                               | ✓      |
| `bear-archive-note` | No — `ZARCHIVED` flag flip; reversible   | Mild stale-intent on whole-note signals (title, age, content overview) that are not sensitive to small concurrent edits; unarchive is one click | ✗      |
| `bear-create-note`  | No prior state                           | No baseline to be stale against                                                                                                                | ✗      |

**Constants and helper** (in `src/tools/responses.ts`, sitting next to the existing `REVISION_*_SENTENCE` constants and `createErrorResponse`):

- `STALE_REVISION_MESSAGE` — single source of truth for the gate's error sentence. Contains the literal `bear-open-note` (testable recovery instruction). Deliberately contains no revision value (see decision below).
- `checkRevisionGate(expected: NoteRevision, live: NoteRevision): Pick<CallToolResult, 'content' | 'isError'> | null` — body-modifying handlers all delegate here. Returns `null` on match, `createErrorResponse(STALE_REVISION_MESSAGE)` on mismatch. Downstream SVA-44 and SVA-43 reuse this helper.

**Deliberate decision: the error message names `bear-open-note` but NOT the live revision value.** Returning the live revision would let an obedient agent extract it from the error, retry with the fresh number, and write a body derived from the stale view through a now-satisfied gate — defeating the safety property the gate exists for. The recovery path is `bear-open-note` (a fresh body and a fresh revision arrive together in one trip), not a number to copy. The system test for each gated tool includes a `not.toContain(String(liveRevision))` assertion as the load-bearing regression guard for this decision.

---

## Key Design Constraints

### Bear's Database

Bear uses Core Data with SQLite. The schema is undocumented; the DB is small enough to inspect directly when needed. The database path is hardcoded to Bear's app group container at `~/Library/Group Containers/9K33E3U3T4.net.shinyfrog.bear/Application Data/database.sqlite` (overridable via `BEAR_DB_PATH` env var for tests). Key fragility points:

- Tag name decoding goes through a single function — `decodeTagName` in `infra/bear-encoding.ts`. Both the in-memory index build (`infra/fts-index.ts`) and the query path call it, so index-side and query-side normalization can never drift. Doing this in JS rather than SQL is deliberate: SQLite's built-in `LOWER()` is ASCII-only, while JS `toLowerCase()` folds Unicode — required for non-ASCII tag matching.
- Tag hierarchy is not stored relationally — it's reconstructed at query time by splitting slash-delimited paths.
- All queries exclude trashed, archived, and encrypted notes to match what Bear's UI shows.

### Bear's URL Scheme Quirks

- **Space encoding**: Bear expects `%20`, not `+`. `URLSearchParams` encodes spaces as `+` by default, so a global replace is applied after encoding.
- **No response data**: Unlike standard x-callback-url, Bear's implementation doesn't return data via x-success in a way the server can capture without a callback receiver.
- **Note creation has no ID in response**: After creating a note, the server polls the database to find the new note's ID by title match. This is best-effort and may time out.

### Platform Constraints

- **macOS only**: Bear is a macOS/iOS app; the database is at a macOS-specific path; `open -g` is a macOS command.
- **Node.js native SQLite**: Uses `node:sqlite` (experimental) to avoid third-party binary dependencies that macOS Gatekeeper would block.

### Intentional Exclusions

- **Encrypted notes**: Bear encrypts content in the DB. Excluded from all queries.
- **Per-tag pinning**: Bear's URL scheme supports `pin=yes` for global pinning but has no action for pinning within a specific tag.
- **Write verification**: No way to confirm Bear processed a URL action. Exit code 0 from `open` only means macOS accepted the URL, not that Bear acted on it.

---

## Error Handling Contract

Two tiers of errors, from the client's perspective:

| Tier       | When                                                                                                                               | What the client sees                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Soft error | Expected condition handled inside tool handlers (note not found, section missing, handler-level parameter validation, file errors) | `isError: true` response with text describing the problem and suggesting a fix                 |
| Hard error | Unexpected failure or deep validation error (subprocess crash, DB error, invalid date format)                                      | MCP-level error response (thrown exception — SDK wraps these in `isError: true` automatically) |

The classification boundary is: **"Did the tool accomplish what it was asked to do?"** If yes (even with zero results), it stays a normal response via `createToolResponse()`. If no, it becomes `isError: true` via `createErrorResponse()`.

Normal responses (not errors): empty search results, no tags found, no untagged notes, title disambiguation — these are correct answers, not failures.

Note-level write tools do pre-flight DB validation to turn silent Bear failures into clear soft errors. Global tag operations cannot be pre-validated. Conditions tied to server configuration — such as Edit Mode being off — are surfaced via the MCP `instructions` field at registration time rather than via per-call soft errors (see _Registration-Time Read/Write Gating_).

---

## Testing Constraints

- **System tests require a live Bear installation** — they create real notes, modify them, and verify results. Cannot run in CI.
- **System tests share Bear state** — they run sequentially, each suite managing its own test data with unique prefixes and cleanup in afterAll.
- **Write operation timing** — after a URL write, tests pause briefly before reading back via SQLite, giving Bear time to process the callback.

---

## References

### Documentation

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/README.md)
- [MCPB Specification](https://github.com/anthropics/mcpb/blob/main/README.md)
- [MCPB Manifest](https://github.com/anthropics/mcpb/blob/main/MANIFEST.md)
- [MCPB CLI](https://github.com/anthropics/mcpb/blob/main/CLI.md)
- [Taskfile Documentation](https://taskfile.dev/docs/guide)

### Bear Notes API

- [Bear x-callback-url API](https://bear.app/faq/X-callback-url%20Scheme%20documentation/)

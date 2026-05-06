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
        │                  notes.ts, tags.ts
        │
        └── WRITE path ──▶ Bear x-callback-url (fire-and-forget)
                           bear-urls.ts → macOS `open -g` subprocess
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
        └──▶ Run: FTS5 MATCH + bm25() ranking with snippet() output (matched
              terms wrapped in `[...]`) for term queries; mod-date DESC with
              a 200-character body-prefix snippet for filter-only queries.
              Filters (tag, pinned, date) compose with AND.
```

**Why in-memory, not persistent.** Bear syncs notes across the user's machines via iCloud. Any persistent derived state (a side-car DB, a shadow FTS5 file) would diverge from Bear's authoritative state without coordination. In-memory rebuild satisfies cross-Mac consistency by construction. Build cost (~70 ms / 229 notes empirically) is small enough to absorb on first search per server process.

**Why MAX + COUNT, not MAX alone.** A bulk import of pre-dated notes (ZMODIFICATIONDATE < the previous max) would not move the maximum. COUNT closes that gap. Both aggregates fit a single SELECT.

**Concurrency.** `node:sqlite` is synchronous. JSON-RPC handlers run on Node's single event loop, so a search call that triggers a rebuild completes the rebuild atomically before the next call starts. No mutex needed; do not refactor the entry point to async/await without re-establishing this invariant.

The atomicity guarantee is in-process only — Bear.app writes the source SQLite file as an independent macOS process, and `journal_mode=DELETE` provides no snapshot isolation across processes. Bear writes that land between rebuilds are detected by the next `MAX + COUNT` drift check and force a fresh rebuild. Bear writes that land *during* a rebuild — between `insertNotes`/`insertNoteTags` and `readDriftKey` — are reflected in the post-build drift key but not the index, leaving the new note invisible until another Bear write moves the key again. Bounded by Bear's typical write cadence; not addressed here because the build window is sub-100 ms for typical libraries.

**FTS5 query handling.** User-supplied terms are inspected by `prepareFTS5Term`:

- **Quoted or grouped expressions pass through verbatim** — `"exact phrase"` and `(grouped expr)` are caller opt-ins to FTS5's own phrase / grouping syntax.
- **Uppercase boolean keywords are not honored as operators.** `AND` / `OR` / `NOT` / `NEAR` written in uppercase are quoted as literal tokens in the OR-join path. Search is positioned as natural-language only across tool descriptions, errors, and user docs — the SVA-28 A/B eval showed agents underperform when nudged into capability mode, and a pasted `apple NOT banana` more likely means "notes about both" than boolean exclusion. Quoting also serves an FTS5-syntax purpose: an unquoted bare `NOT` would otherwise reach the parser as an operator with no operands and surface as a SQL syntax error. FTS5's keyword recognition is case-sensitive, so lowercase `not`/`and` already pass through as content tokens without quoting.
- **Everything else is tokenized via `[\p{L}\p{N}_]+\*?` and routed by shape.** Unicode-aware on purpose: ASCII `\w` would silently zero-hit any non-ASCII script (Cyrillic, accented Latin, Greek, etc.) because `unicode61` indexes those scripts as ordinary letter tokens. A single bareword (with optional `*` suffix) passes through unchanged so FTS5's prefix rule applies. Single-identifier punctuated input — no whitespace in the trimmed term, no wildcard tokens, e.g. `bear-notes-mcp` or `2026-04-15` — is tokenized and wrapped as an FTS5 phrase so the consecutive token sequence matches, restoring the substring-style precision v2.x's LIKE gave for slugs and identifiers; the no-wildcard guard exists because FTS5 only allows `*` on the last phrase token, so phrase-quoting a wildcard input would silently strip the prefix-match. Multi-word input with whitespace — bare or punctuation-laden — reduces to OR-rank-by-density. Incidental punctuation (brackets, hyphens, colons) within tokens is dropped because unicode61 tokenized the indexed corpus the same way, so query-side punctuation removal mirrors what FTS5 did on the body side. Input with no word characters at all falls through verbatim and surfaces an FTS5 syntax error (caught and reframed by `runWithFts5SyntaxRemap`).

The OR-rank fallthrough is deliberate. FTS5's bareword default is implicit-AND, which silently filters out notes missing any single token — including notes that paraphrase or use a different word for one of the user's referents. The SVA-28 A/B eval found 73% of search calls containing a hyphen or colon returning zero hits under an earlier phrase-quote branch, which turned natural-language input into rigid token-order phrase matches. OR-rank with BM25 lets density-rich notes still surface, matching the user/agent expectation that ranked search returns relevance-ordered results rather than a strict filter.

**Schema discovery.** Bear's tag-join table names embed Core Data entity IDs (`Z_5TAGS`, `Z_13TAGS`, etc.) that can shift across Bear schema migrations. `src/infra/bear-schema.ts:discoverBearSchema` resolves the actual names at runtime via `Z_PRIMARYKEY` (Core Data's entity registry). Both the FTS5 build path and `src/operations/tags.ts` consume this utility — no hardcoded entity IDs remain in the codebase.

**Load-bearing assumption.** `node:sqlite`'s bundled SQLite must include FTS5. Verified at planning time on Node 24.14.1 / SQLite 3.51.2; locked into CI by `src/infra/bear-schema.test.ts` so any future Node version that disables FTS5 fails before the rest of the search subsystem panics.

---

## Safety Gates

### Content Replacement Is Opt-In

The ability to overwrite note content (full body or specific sections) is **disabled by default**. Users must explicitly enable "Content Replacement" in server settings before `bear-replace-text` works. This prevents AI from accidentally destroying note content.

### No Note Deletion

There is no delete tool. Too destructive for AI-assisted workflows — a misidentified note ID would mean permanent data loss. Archiving is the closest alternative and is reversible in Bear.

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

| Tier | When | What the client sees |
|------|------|---------------------|
| Soft error | Expected condition handled inside tool handlers (note not found, section missing, feature disabled, handler-level parameter validation, file errors) | `isError: true` response with text describing the problem and suggesting a fix |
| Hard error | Unexpected failure or deep validation error (subprocess crash, DB error, invalid date format) | MCP-level error response (thrown exception — SDK wraps these in `isError: true` automatically) |

The classification boundary is: **"Did the tool accomplish what it was asked to do?"** If yes (even with zero results), it stays a normal response via `createToolResponse()`. If no, it becomes `isError: true` via `createErrorResponse()`.

Normal responses (not errors): empty search results, no tags found, no untagged notes, title disambiguation — these are correct answers, not failures.

Note-level write tools do pre-flight DB validation to turn silent Bear failures into clear soft errors. Global tag operations cannot be pre-validated. Permanent conditions (e.g., feature disabled) include explicit non-retryability language to prevent LLM retry loops.

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

# Bear Database Schema — Empirical Write-Behavior Findings

Reference notes for contributors working in `src/infra/` and `src/operations/` on code that observes or polls Bear's SQLite database. Captures what we know about Bear's Core Data write semantics that isn't recoverable from reading the schema alone.

## Core Data Optimistic-Locking Counter (`ZSFNOTE.Z_OPT`)

`Z_OPT` is the per-row optimistic-locking counter Core Data assigns to every entity. It is the OCC version token the MCP server exposes as `Revision: <n>` in tool responses (see `docs/dev/SPECIFICATION.md` → Safety Gates → Optimistic Concurrency Control).

- **Increments by +1 on every note-row save**, regardless of origin: URL-API writes (`bear://x-callback-url/...`), Bear UI edits, CloudKit sync pulls.
- **Plus-two on first-edit-after-creation.** Bear performs a subtitle/index recompute save right after a note's initial create-save, so the first edit observed by an external poller jumps `Z_OPT` from `1` to `3` rather than `2`. **Implication for `awaitRevisionIncrement`: compare for inequality (`current !== baseline`), not exact `baseline + 1`** — a `+1` comparison would miss the jump and time out.
- **Propagation from `open -g 'bear://...'` to observable SQLite is <30 ms** in typical operation. `REVISION_POLL_TARGET_MS = 1_000` is a generous budget that also absorbs event-loop slop on slow machines; in the >95th-percentile path the polling resolves within ~30 ms. It is a target, not a hard wall-clock cap — each `stmt.get()` can block up to `busy_timeout = 3000 ms` (`src/infra/database.ts:59`) when Bear holds a writer lock, so a contended poll can extend the total wait. The duration-free `REVISION_TIMEOUT_SENTENCE` (see `src/tools/responses.ts`) is what keeps the user-visible response honest regardless.
- **`Z_OPT` covers writes that `ZMODIFICATIONDATE` misses.** Pin-only writes (toggling pinned status) update `ZPINNED` and `Z_OPT` but do NOT update `ZMODIFICATIONDATE`. This has two implications:
  - For OCC inform: `Z_OPT` is a strictly more reliable change sentinel than `ZMODIFICATIONDATE`.
  - For the in-memory FTS index drift sentinel (`MAX(ZMODIFICATIONDATE) + COUNT(*)`): pin-only writes can leave the index stale; the FTS index is not rebuilt for them. This is why search-result revision hydration goes against the live Bear DB (post-FTS batch SELECT), not against a cached `Z_OPT` in the FTS shadow — see `src/infra/fts-index.ts:fetchRevisionsForResults`.

## `Z_OPT` Bump Behavior by URL Action

| Bear URL action | Bumps `ZSFNOTE.Z_OPT`? | Source | Used by |
|-----------------|------------------------|--------|---------|
| `/add-text` (with `text` param) | **Yes** (+1 per save) | Empirical, SVA-20 | `bear-add-text`, `bear-replace-text` |
| `/create` | **Yes** (initial value `1`, jumps to `3` on first edit) | Empirical, SVA-20 | `bear-create-note` |
| `/add-tags` (the dedicated endpoint) | **No** — updates `Z_5TAGS`/`ZSFNOTETAG` join tables, not the note row | Empirical, SVA-20 | (none — `bear-add-tag` uses `/add-text` instead) |
| `/add-text` with `tags=` param and no `text=` param | **Yes (+1)** — confirmed empirically against Bear running locally (fresh note `Z_OPT=1` → after `bear-add-tag` → `Z_OPT=2`). Goes through Bear's content-write pipeline; SVA-20's "no bump" finding was specific to the dedicated `/add-tags` endpoint, not this code path. | Empirical, this PR | `bear-add-tag` |
| `/add-file` (attachment) | **Yes (+1)** — confirmed empirically against Bear running locally (`Z_OPT=2` → after `bear-add-file` → `Z_OPT=3`). The note-row `Z_OPT` updates on attachment-add, not only `ZSFNOTEFILE.Z_OPT`. SVA-20 had left this empirically unverified. | Empirical, this PR | `bear-add-file` |
| `/archive` | N/A — `bear-archive-note` uses `existingNote.revision` captured BEFORE the URL fires (post-archive the note is filtered from default queries; reading `Z_OPT` post-archive returns `null` under the default `ZARCHIVED = 0` filter). | Design choice | `bear-archive-note` |

If a future Bear version starts skipping `Z_OPT` bumps on these paths, the system tests (`tests/system/add-tag.test.ts`, `tests/system/attached-files.test.ts`) will surface it as the timeout sentence in the response — both tests assert "either a numeric Revision or the timeout sentence", so the failure mode is honest rather than silent. The remediation is to migrate the affected handler to the single-shot pattern: pre-flight `existingNote.revision`, fire the URL, return that value with a caveat sentence (`"Revision reflects note-body state; this write path does not bump it."`).

## Why `ZVERSION = 3` Is Not a Row Revision

`ZVERSION` is uniform (`3`) across every note on the local machine — it's a Core Data **schema/protocol version**, not a per-row counter. Useless as an OCC token. Do not confuse it with `Z_OPT`.

## Concurrency Semantics

- Bear's SQLite database uses `journal_mode=DELETE` (not WAL). Readers and writers block each other; without a busy timeout, our reads fail instantly if Bear is mid-write.
- The MCP server sets `PRAGMA busy_timeout = 3000` at connection open (`src/infra/database.ts:59`). This absorbs Bear's writer locks during the 3-second window typical of UI saves.
- `node:sqlite` is synchronous, so JSON-RPC handlers can't interleave: a search call that triggers an FTS rebuild completes atomically before the next call starts. The in-memory FTS index is single-process; the source Bear DB is multi-process (Bear.app + this server), but the busy_timeout + drift check absorbs that.

## When to Update This Doc

Update this file when:
- A new Bear URL action is added to the codebase (`src/tools/note-tools.ts`, `src/tools/tag-tools.ts`) and its `Z_OPT` behavior is verified empirically by a system test.
- A Bear upgrade changes any of the observed timings or bump behaviors (rare, but possible if Apple changes Core Data internals).

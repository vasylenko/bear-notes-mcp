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

---

## Safety Gates

### Content Replacement Is Opt-In

The ability to overwrite note content (full body or specific sections) is **disabled by default**. Users must explicitly enable "Content Replacement" in server settings before `bear-replace-text` works. This prevents AI from accidentally destroying note content.

### No Note Deletion

There is no delete tool. Too destructive for AI-assisted workflows — a misidentified note ID would mean permanent data loss. Archiving is the closest alternative and is reversible in Bear.

---

## Key Design Constraints

### Bear's Database

Bear uses Core Data with SQLite. The schema is undocumented — our understanding comes from reverse-engineering (see `BEAR_DATABASE_SCHEMA.md`). The database path is discovered via Bear's app container at `~/Library/Group Containers/group.com.shinyfrog.bear/`. Key fragility points:

- Tag name decoding logic exists in two places (SQL expression in `notes.ts` and TypeScript function in `tags.ts`) — these must produce identical results. Bidirectional comments link them.
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
| Soft error | Expected condition (note not found, section missing, feature disabled) | Normal text response describing the problem and suggesting a fix |
| Hard error | Unexpected failure (subprocess crash, DB error) | MCP-level error response |

Note-level write tools do pre-flight DB validation to turn silent Bear failures into clear soft errors. Global tag operations cannot be pre-validated.

Neither tier uses the MCP SDK's `isError` field — this is a potential future improvement.

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
- Bear Database Schema: see `.claude/contexts/BEAR_DATABASE_SCHEMA.md`

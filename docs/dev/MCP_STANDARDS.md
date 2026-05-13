# MCP Standards

Conventions for the MCP server's tool surface — how to write tool descriptions, schemas, and mutation responses so they work well with LLM clients. Read this when adding a new tool or modifying an existing one.

## Separation of Concerns

Tool descriptions help with tool **selection** and understanding; schema (`describe()`) text guides correct **invocation**. Don't conflate the two — a description full of parameter syntax is hard for the LLM to scan when choosing among tools, and a schema description missing constraint details forces the LLM to guess.

## LLM-First Design

Tools are first discovered via descriptions, then invoked via schemas. Optimize both for the consumer (an LLM), not for human readability. The reference implementations are `src/tools/note-tools.ts` and `src/tools/tag-tools.ts` — mirror their patterns when adding new tools.

## Mutation Response Metadata

Every note-level mutation tool — `bear-create-note`, `bear-add-text`, `bear-replace-text`, `bear-add-file`, `bear-add-tag`, `bear-archive-note` — must return **note ID + note title + revision + what changed** in its response. ID and title are always available without post-write database reads:

- For modifications: ID comes from the input parameter, title from the pre-flight `getNoteContent()` validation
- For creation: title comes from the input parameter, ID from post-create polling

Revision (the OCC version token, `ZSFNOTE.Z_OPT`) is sourced via post-write polling — see the "polling for change" exception below.

Global tag mutations (`bear-rename-tag`, `bear-delete-tag`) are not note-level and intentionally omit note metadata.

Never fetch tags or other metadata from the database after a write — Bear's fire-and-forget architecture means post-write reads return pre-mutation state, which would mislead the LLM into thinking the operation failed.

**Exception: polling for change.** Reading `ZSFNOTE.Z_OPT` post-write IS permitted iff the read waits *for the value to change* (write-confirmation), not for current state. This preserves the spirit of the rule — the LLM receives a value that confirms the write landed, not a pre-mutation snapshot mistaken for fresh state. Implementation: `awaitRevisionIncrement` in `src/operations/notes.ts`. On timeout (write didn't land within `REVISION_POLL_CAP_MS`), the response emits `REVISION_TIMEOUT_SENTENCE` rather than a stale value.

**Archive-flow exception.** `bear-archive-note` uses `existingNote.revision` captured BEFORE the archive URL fires, labeled `Revision at time of archive: <n>`. This is NOT a post-write read — it's a pre-write snapshot with explicit temporal labeling that signals to the LLM consumer that the value is frozen at the moment of archival (post-archive the note is filtered from default queries, so a fresh read would return null).

## Tool Description

The `description` field should provide a concise, high-level explanation of what the tool accomplishes.

- **Purpose**: communicate tool functionality and use cases; focus on user needs
- **Audience**: LLMs choosing among available tools
- **Avoid**: parameter-specific details (those belong in the schema)

Example:

```js
{
  name: "read_multiple_files",
  description: "Read the contents of multiple files simultaneously. More efficient than reading files individually when analyzing or comparing multiple files."
}
```

## Schema Descriptions

The `inputSchema` property `describe()` text should provide parameter-specific documentation.

- **Purpose**: guide correct tool invocation
- **Audience**: LLMs constructing tool calls
- **Content**:
  - Specify parameter types and constraints
  - Include validation requirements
  - Provide usage examples where helpful
  - Explain parameter relationships
- **Source numeric defaults from runtime constants, not string literals.** Use template literals (`` `default: ${DEFAULT_SEARCH_LIMIT}` ``) so the schema text can never drift from the runtime default. String-literal defaults silently desync the moment someone changes the constant — this drift class has bitten us before.

Example:

```js
const schema = z.object({
  paths: z.array(z.string())
    .min(1, "At least one file path must be provided")
    .describe("Array of file paths to read. Each path must be a valid absolute or relative file path.")
});
```

# MCP Standards

This project's conventions for designing our MCP server's tool surface — how we write tool descriptions, schemas, and mutation responses so they work well with LLM clients. Project-wide rules; they apply to every tool we add or modify. Read when adding a new tool or touching an existing one.

Specific instantiation details (which fields a particular mutation response carries, which underlying system tokens it threads, which exceptions Bear's URL-API quirks force) live in `SPECIFICATION.md` and `BEAR_DATABASE_SCHEMA.md` — not here. This doc stays focused on the conventions themselves, so they remain easy to apply consistently across new and existing tools; it deliberately doesn't name specific tools, DB columns, or helper functions, because those belong with the implementations they describe.

## Separation of Concerns

Tool descriptions help with tool **selection** and understanding; schema (`describe()`) text guides correct **invocation**. Don't conflate the two — a description full of parameter syntax is hard for the LLM to scan when choosing among tools, and a schema description missing constraint details forces the LLM to guess.

## LLM-First Design

Tools are first discovered via descriptions, then invoked via schemas. Optimize both for the consumer (an LLM), not for human readability. The reference implementations are `src/tools/note-tools.ts` and `src/tools/tag-tools.ts` — mirror their patterns when adding new tools.

## Mutation Response Conventions

A mutation tool's response should give the LLM enough metadata to:

1. **Confirm the write landed** — a "what-changed" summary or a version token the LLM can compare against its prior view.
2. **Address the affected resource in follow-up calls** — a stable identifier (note ID, row ID, document path, etc.) the LLM can pass back without round-tripping through search.
3. **Reason about freshness for subsequent writes** — a version token where the underlying system exposes one (HTTP `ETag`, Core Data `Z_OPT`, document revision, etc.). This is what enables eventual *enforce*-style optimistic concurrency (HTTP `If-Match` / `412 Precondition Failed`).

**Field-sourcing discipline matters more than the field list.** Prefer values already available pre-write — input parameters, pre-flight validation reads, helpers that bundle id+version in a single SELECT — over post-write reads that may reflect pre-mutation state if the underlying write path is asynchronous and has no completion handle. When a post-write read is genuinely required to capture a version token, design it to wait for a *change* (write-confirmation) rather than to sample current state, and surface a clearly-labelled sentinel on timeout instead of a value that could be stale.

For this server's instantiation — which fields the response carries, which underlying token is the version, how it's sourced safely, and the narrow exceptions to the general "never read after write" rule — see `SPECIFICATION.md`.

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

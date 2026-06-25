# MCP Standards

Conventions for the MCP server's tool surface — how to write tool descriptions, schemas, and mutation responses so they work well with LLM clients. Read this when adding a new tool or modifying an existing one.

## Separation of Concerns

Tool descriptions help with tool **selection** and understanding; schema (`describe()`) text guides correct **invocation**. Don't conflate the two — a description full of parameter syntax is hard for the LLM to scan when choosing among tools, and a schema description missing constraint details forces the LLM to guess.

## LLM-First Design

Tools are first discovered via descriptions, then invoked via schemas. Optimize both for the consumer (an LLM), not for human readability. The reference implementations are `src/tools/note-tools.ts` and `src/tools/tag-tools.ts` — mirror their patterns when adding new tools.

## Mutation Response Metadata

A mutation tool's response must carry enough metadata for the LLM consumer to confirm the write landed, address the affected resource in follow-up calls, and detect concurrent edits. Concretely:

- **Stable identifier** of the affected resource so the consumer doesn't have to re-search to follow up.
- **Human-readable label** naming the resource (e.g. note title) when one is available — so the response is meaningful to the user looking over the agent's shoulder.
- **Version token** that moves monotonically across writes, so the consumer can compare across calls and detect "did this change since I last read it" (OCC inform).
- **What changed** in user-facing terms.

Source these from values already known before the write (input parameters, pre-flight validation reads) or from polls that wait *for state to change*. **Never from a post-write read that samples current state** — fire-and-forget write architectures (anything where the underlying API has no synchronous completion handle) can return pre-mutation state in a naïvely-timed post-write read, which would mislead the LLM into thinking the operation failed.

**Exception: polling for change.** A post-write read IS permitted if it waits *until* the version token differs from a captured pre-write baseline. This preserves the spirit of the rule: the consumer receives a value that confirms the write landed, not a snapshot that might still reflect pre-mutation state. On timeout the response must surface a clearly-labeled sentinel rather than a value that could be stale.

Global mutations whose target is a taxonomy rather than a specific resource intentionally omit per-resource metadata.

The concrete instantiation for this server — which tools are in scope, which helpers implement these patterns, the runtime constants and labels — lives in `docs/dev/SPECIFICATION.md` under "Optimistic Concurrency Control" → "Inform half". Empirical findings about the underlying DB columns those helpers read live in `docs/dev/BEAR_DATABASE_SCHEMA.md`.

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

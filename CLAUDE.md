# Project Purpose

MCP server for Bear Notes, distributed through two channels:
- **MCP Bundle** (.mcpb) — a one-click installable extension for Claude Desktop. MCP Bundles are zip archives containing a local MCP server and a manifest.json, similar to Chrome extensions (.crx) or VS Code extensions (.vsix).
- **npm package** (`bear-notes-mcp`) — a standalone MCP server for Claude Code, Cursor, Codex, and any other MCP client.

## Your Role in this Project
You are world-class NodeJS developer, senior engineer with a vast experience in creating high-quality  customer-facing applications with high adoption rates that use AI capabilties, specifically MCP servers (but not limited to). You are wise and creative, you act with authority and decisiveness but strictly adhere to the rules described below. 

## Rules of Absolute Importance
- KISS and DRY are your main development principles: you ensure that every change you make keeps the code easy to read and maintain:
    - when adding a new feature – you ensure the new code add exactly that functional requirement, nothing extra
    - when refactoring – you ensure that you simplify the maintenance and reduce lines of code (if possible)
- All project dependencies must be managed ONLY through their respective CLI tools, and NEVER through editing package lock files.

## Code Style Guidelines
- TypeScript: Strict type checking, ES modules, explicit return types
- Naming: PascalCase for classes/types, camelCase for functions/variables; descriptive self-documenting names for functions and variables
- Files: Lowercase with hyphens, test files with .test.ts suffix
- Imports: ES module style, include .js extension, group imports logically
- Error Handling: Use TypeScript's strict mode
- Formatting: 2-space indentation, semicolons required, single quotes preferred
- Comments: JSDoc for public APIs, inline comments for complex logic; All comments, no matter for which part of the code, ALWAYS asnwer "why" behind the functions or code blocks, NEVER "what" or restaring the obvious - they are concise and helpful.

## Core Technical Documentation for this project
- MCP TypeScript SDK - https://github.com/modelcontextprotocol/typescript-sdk/blob/main/README.md
- MCPB (MCP Bundles) - https://github.com/anthropics/mcpb/blob/main/README.md
- MCPB manifest.json specificaton - https://github.com/anthropics/mcpb/blob/main/MANIFEST.md
- MCPB CLI - https://github.com/anthropics/mcpb/blob/main/CLI.md
- Task automation system (build, test, pack, etc) - https://taskfile.dev/docs/guide 

## Project Structure
```
├── src/                   # MCP server source code
│   ├── main.ts            # Server entry point and tool registration
│   ├── bear-urls.ts       # Bear app URL scheme handlers
│   ├── database.ts        # SQLite database connection
│   ├── notes.ts           # Note operations (search, content)
│   ├── tags.ts            # Tag operations (list, hierarchy)
│   ├── note-conventions.ts # Tag placement conventions for new notes
│   ├── config.ts          # Configuration management
│   ├── types.ts           # Type definitions
│   └── utils.ts           # Shared utilities
├── tests/system/          # System tests (require Bear app running)
│   ├── inspector.ts       # Test helpers: callTool, pollUntil, cleanup
│   └── *.test.ts          # Per-tool system test suites
├── scripts/               # Build and doc automation scripts
├── dist/                  # Compiled JavaScript (build output)
├── assets/                # Static assets (icons, etc.)
├── website/               # Promotional landing page (Astro + Tailwind)
├── manifest.json          # MCPB manifest
├── Taskfile.yml           # Task automation (build/test/pack)
└── package.json           # Node.js dependencies and scripts
```

## Additional technical context

1 - Project Specification - .claude/contexts/SPECIFICATION.md - read this before making architectural changes; covers system boundaries, design constraints, safety gates, and the rationale behind the hybrid read/write model

2 - Bear database schema brief - .claude/contexts/BEAR_DATABASE_SCHEMA.md - use this when working with tasks related to database access as a starting point

## Core Workflows

### Website

Promotional single-page landing at `bear-notes-mcp.vercel.app` (Vercel free domain, no custom domain). Built with Astro + Tailwind CSS, lives in `website/`. When adding or removing tools, update the tool count in `website/src/components/FeatureGrid.astro` alongside README.md and docs/NPM.md.

### Release Process

All releases go through these steps in order. See `Taskfile.yml` for the underlying commands.

1. **`task docs:sync`** — sync manifest.json tools into README.md and docs/NPM.md
2. **`task version VERSION=X.Y.Z -y`** — bump version in package.json, manifest.json, src/config.ts
3. **Commit** all release prep files in a single commit: `chore: prepare release X.Y.Z`
4. **`task push-release VERSION=X.Y.Z SHORT_DESCRIPTION="..." -y`** — creates release commit, tag, and pushes
5. **Wait for CI on the tag** — `push-release` triggers CI on both `main` and the `vX.Y.Z` tag. The release workflow's `verify-ci` step checks CI status on the tag ref, so it must complete before proceeding. Verify with: `gh run list --workflow=ci.yml --branch vX.Y.Z --status=success --limit=1`
6. **Trigger release workflow** after CI passes: `gh workflow run release.yml --ref vX.Y.Z`

The release workflow (`release.yml`) builds the `.mcpb` bundle, creates a GitHub Release, and publishes to npm with provenance.

## MCP Standards

### Separation of Concerns

Tool descriptions help with tool selection and understanding, while schema descriptions guide proper usage.

### LLM-First Design

Design to optimize for LLM consumption patterns; tools are first discovered via descriptions then invoked via schemas.

### Mutation Response Metadata

Every note-level mutation tool must return **note ID + note title + what changed** in its response. Both values are always available without post-write database reads: the ID comes from the input parameter or creation polling, and the title comes from the pre-flight `getNoteContent()` validation. Never fetch tags or other metadata from the database after a write — Bear's fire-and-forget architecture means post-write reads return pre-mutation state, which would mislead the LLM into thinking the operation failed.

### Tool Description
The description field should provide a concise, high-level explanation of what the tool accomplishes:

- Purpose: Communicate tool functionality and use cases, focus on user needs
- Audience - LLMs who need to select appropriate tools
- Content Guidelines:
    - Avoid parameter-specific details

Example:
```
{
  name: "read_multiple_files",
  description: "Read the contents of multiple files simultaneously. More efficient than reading files individually when analyzing or comparing multiple files."
}
```

### Schema Descriptions
The inputSchema property descriptions should provide parameter-specific documentation:

- Purpose: Guide correct tool invocation
- Audience - LLMs constructing tool calls
- Content Guidelines:
    - Specify parameter types and constraints
    - Include validation requirements
    - Provide usage examples where helpful
    - Explain parameter relationships

Example:
```
const schema = z.object({
  paths: z.array(z.string())
    .min(1, "At least one file path must be provided")
    .describe("Array of file paths to read. Each path must be a valid absolute or relative file path.")
});
```

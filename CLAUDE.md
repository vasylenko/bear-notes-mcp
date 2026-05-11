# Project Purpose

MCP server for Bear Notes, distributed through two channels:
- **MCP Bundle** (.mcpb) — a one-click installable extension for Claude Desktop. MCP Bundles are zip archives containing a local MCP server and a manifest.json, similar to Chrome extensions (.crx) or VS Code extensions (.vsix).
- **npm package** (`bear-notes-mcp`) — a standalone MCP server for Claude Code, Cursor, Codex, and any other MCP client.

## Rules of Absolute Importance

- All project dependencies must be managed ONLY through their respective CLI tools, and NEVER through editing package lock files.
- Tests:
    - System tests are the default. Unit tests are justified only when a situation is genuinely hard to recreate via system tests due to test setup complexity. Unit tests are a last resort.
    - If the assertion is about something the server decided before calling Bear (input validation, schema rejection, response format with no Bear interaction), it's almost always a misplaced unit test. System tests should verify behavior at the Bear-integration boundary — anything else is paying the spawn-Inspector / open-Bear cost for no integration risk.
    - Exception: when an input composition step is exhaustively unit-tested AND one system test exercises the URL roundtrip, additional system tests covering other input shapes are redundant — Bear's URL boundary doesn't discriminate between composed strings.

## Core Technical Documentation for this project
- MCP TypeScript SDK - https://github.com/modelcontextprotocol/typescript-sdk/blob/main/README.md
- MCPB (MCP Bundles) - https://github.com/anthropics/mcpb/blob/main/README.md
- MCPB manifest.json specificaton - https://github.com/anthropics/mcpb/blob/main/MANIFEST.md
- MCPB CLI - https://github.com/anthropics/mcpb/blob/main/CLI.md
- Task automation system (build, test, pack, etc) - https://taskfile.dev/docs/guide

## Source Layout

`src/` is layered as **infra → operations → tools**. Adapters to external systems (SQLite, filesystem, Bear URL scheme) live in `infra/`; pure business logic in `operations/`; MCP tool registrations and handlers in `tools/`. Dependencies flow downward only — `tools/` may import from `operations/` and `infra/`, `operations/` from `infra/`, never the reverse. Tests are co-located with their source files using the `.test.ts` suffix. Use `find src -type f` for the current file list; the rules above are what's load-bearing.

## Additional technical context

Read the relevant reference doc when working in that area:

- `docs/dev/SPECIFICATION.md` — system boundaries, design constraints, safety gates, hybrid read/write rationale. Read before architectural changes.
- `docs/dev/SECURITY.md` — trust model and defenses.
- @docs/dev/MCP_STANDARDS.md — tool description vs schema separation, mutation response metadata rule, examples. Read when adding or modifying MCP tools.
- @docs/dev/CODE_STYLE.md — style choices not auto-enforced; the WHY-not-WHAT comments rule.

## Core Workflows

### Website

Promotional single-page landing at `bear-notes-mcp.vercel.app` (Vercel free domain, no custom domain). Built with Astro + Tailwind CSS, lives in `website/`. When adding or removing tools, update the tool count in `website/src/components/FeatureGrid.astro`, `website/src/components/InstallGuide.astro`, and `website/src/components/FAQ.astro` alongside README.md and docs/user/NPM.md.

### Release Process

All releases go through these steps in order. See `Taskfile.yml` for the underlying commands.

1. **`task docs:sync`** — sync manifest.json tools into README.md and docs/user/NPM.md
2. **`task version VERSION=X.Y.Z -y`** — bump version in package.json, manifest.json, src/config.ts
3. **Commit** all release prep files in a single commit: `chore: prepare release X.Y.Z`
4. **`task push-release VERSION=X.Y.Z SHORT_DESCRIPTION="..." -y`** — creates release commit, tag, and pushes
5. **Wait for CI on the tag** — `push-release` triggers CI on both `main` and the `vX.Y.Z` tag. The release workflow's `verify-ci` step checks CI status on the tag ref, so it must complete before proceeding (use `gh run list --workflow=ci.yml --branch vX.Y.Z` to verify).
6. **Trigger release workflow** after CI passes: `gh workflow run release.yml --ref vX.Y.Z`

The release workflow (`release.yml`) builds the `.mcpb` bundle, creates a GitHub Release, and publishes to npm with provenance.

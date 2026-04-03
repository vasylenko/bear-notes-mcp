---
title: "feat: Convert Bear Notes MCP to Claude Plugin"
type: feat
status: completed
date: 2026-04-03
origin: docs/conversion/CONVERSION_OVERVIEW.md
---

## Enhancement Summary

**Deepened on:** 2026-04-03
**Sections enhanced:** 8
**Research agents used:** agent-native-reviewer, architecture-strategist, security-sentinel, code-simplicity-reviewer, pattern-recognition-specialist, best-practices-researcher, performance-oracle

### Key Improvements
1. Simplified v1 scope — MVP is 5 core files; slash commands, sub-agent, and extras deferred to post-v1
2. Fixed `allowed-tools` glob to match actual Claude plugin MCP tool naming convention
3. Pinned MCP server version instead of `@latest` (consensus from architecture, security, performance reviews)
4. Added SETUP.md skill for first-time configuration guidance
5. Added operation-specific verify-after-write patterns for fire-and-forget writes

### New Considerations Discovered
- `allowed-tools: mcp__bear-notes-*` is the WRONG format — must be `mcp__plugin_bear-notes_bear-notes__*`
- `userConfig` has no `type` or `default` field in the schema — document accepted values in `description`
- `marketplace.json` should live in `.claude-plugin/`, not the repo root
- `npx` cold start can be 2-15 seconds; document global install as the faster alternative
- Sub-agent with 25 turns risks blowing the context window if tool results include full note bodies

---

# feat: Convert Bear Notes MCP to Claude Plugin

## Overview

Wrap the existing `bear-notes-mcp` MCP server (v2.9.0) in a Claude Plugin so it works in Claude Code and Cowork — not just Claude Desktop (MCPB) and standalone MCP clients. No changes to the MCP server code. The plugin adds a skill layer (best-practice instructions) and a `.mcp.json` that references the published npm package.

**Key insight from research:** This cannot be "just a skill." Skills are markdown-only prompt instructions. They cannot access SQLite databases or execute x-callback-url commands. The MCP server must remain the connector layer; the plugin wraps it with skills and configuration (see origin: `docs/conversion/CONVERSION_OVERVIEW.md`).

**Scope statement (from agent-native review):** This plugin provides parity with the **12 MCP tools**, not full Bear app UI parity. Actions like delete, trash recovery, pin to sidebar, and export are outside the MCP surface and therefore outside the plugin.

## Problem Statement / Motivation

The MCP server already works well as a connector. But users who want to use Bear Notes in Claude Code or Cowork have no way to install it as a first-class plugin with skills and configuration. The plugin format is the distribution unit for these platforms — it bundles the connector with higher-level workflow guidance.

## Proposed Solution

Create a **new directory** (`bear-notes-plugin/`) alongside the existing codebase. This is a lightweight wrapper — markdown files plus configuration — that references the published `bear-notes-mcp` npm package via `.mcp.json`.

### v1 Target Directory Structure (Simplified)

```
bear-notes-plugin/
├── .claude-plugin/
│   └── plugin.json              # Plugin manifest with userConfig
├── .mcp.json                    # MCP server → npx bear-notes-mcp@2
├── skills/
│   └── bear-notes/
│       └── SKILL.md             # Best practices + tool reference
├── skills/
│   └── setup/
│       └── SKILL.md             # First-time setup guidance
└── README.md
```

### Research Insights (Code Simplicity Reviewer)

**MVP is 5 files.** The minimum to ship "Bear Notes works in Claude Code/Cowork" is: `plugin.json` + `.mcp.json` + `skills/bear-notes/SKILL.md` + `skills/setup/SKILL.md` + `README.md`. Everything else is polish.

**Deferred to post-v1:**
- Slash commands (`commands/search.md`, `create.md`, `organize.md`) — the skill handles these workflows via auto-invocation
- Sub-agent (`agents/note-curator.md`) — bulk workflows can be handled by skill instructions initially
- `TOOL_REFERENCE.md` — fold into SKILL.md directly; MCP server already provides tool descriptions
- `marketplace.json` — add when publishing to marketplace
- `CHANGELOG.md` — add at second release

## Technical Considerations

### Plugin Manifest (`plugin.json`)

Mirror the existing MCPB `user_config` fields as plugin `userConfig`:

```json
{
  "name": "bear-notes",
  "version": "1.0.0",
  "description": "Search, read, create, and update Bear Notes from Claude Code and Cowork. macOS only.",
  "author": { "name": "Serhii Vasylenko" },
  "repository": "https://github.com/vasylenko/bear-notes-mcp",
  "homepage": "https://github.com/vasylenko/bear-notes-mcp",
  "license": "MIT",
  "keywords": ["bear", "notes", "productivity", "markdown", "macos"],
  "userConfig": {
    "debug": {
      "description": "Enable debug logging for troubleshooting (true or false, default: false)",
      "sensitive": false
    },
    "enable_new_note_convention": {
      "description": "Place tags after title instead of at bottom when creating notes (true or false, default: false)",
      "sensitive": false
    },
    "enable_content_replacement": {
      "description": "Allow replacing note content via bear-replace-text — DESTRUCTIVE, use with caution (true or false, default: false)",
      "sensitive": false
    }
  }
}
```

### Research Insights (Pattern Recognition + Best Practices)

- `userConfig` has **no `type` or `default` field** in the schema — document accepted values and defaults in the `description` string itself
- Values are **stringly-typed** (user types at enable time); validate in server or SessionStart hook
- Non-sensitive values stored in `settings.json` under `pluginConfigs[].options`
- Exported as `CLAUDE_PLUGIN_OPTION_*` env vars to subprocesses

### Environment Contract

Single source of truth for how configuration flows from plugin UI to server behavior:

| `userConfig` key | `.mcp.json` env var | Server reads | Default | Effect |
|---|---|---|---|---|
| `debug` | `UI_DEBUG_TOGGLE` | `src/utils.ts:14-19` | `false` | Sets `DEBUG=bear-notes-mcp:*` |
| `enable_new_note_convention` | `UI_ENABLE_NEW_NOTE_CONVENTION` | `src/config.ts:9` | `false` | Tags after title on create |
| `enable_content_replacement` | `UI_ENABLE_CONTENT_REPLACEMENT` | `src/config.ts:10` | `false` | Enables `bear-replace-text` tool |

### MCP Connector (`.mcp.json`)

```json
{
  "mcpServers": {
    "bear-notes": {
      "command": "npx",
      "args": ["-y", "bear-notes-mcp@2"],
      "env": {
        "UI_DEBUG_TOGGLE": "${user_config.debug}",
        "UI_ENABLE_NEW_NOTE_CONVENTION": "${user_config.enable_new_note_convention}",
        "UI_ENABLE_CONTENT_REPLACEMENT": "${user_config.enable_content_replacement}"
      }
    }
  }
}
```

### Research Insights (Architecture + Security + Performance)

**Version pinning (consensus from 3 agents):** Use `bear-notes-mcp@2` (major pin) instead of `@latest`:
- Prevents non-deterministic behavior across machines
- Eliminates supply chain risk from surprise upgrades
- Reduces cold start variability
- Document upgrade path: bump version in `.mcp.json` when new major releases

**Alternative for power users:** Document global install for faster startup:
```bash
npm i -g bear-notes-mcp
# Then use command: "bear-notes-mcp" instead of npx
```

**npx cold start:** First run can take 2-15+ seconds (registry fetch + extract). Warm cache: ~200ms-2s. Document this expected behavior.

**MCP server key:** The key `"bear-notes"` in `.mcp.json` becomes part of the tool prefix. Keep it stable — renaming would break `allowed-tools` references.

### Skill Design (`SKILL.md`)

The skill teaches Claude *how to use the tools well*, not what tools exist. The MCP server's tool descriptions handle that.

**Frontmatter:**
```yaml
---
name: bear-notes
description: Best practices for searching, reading, creating, and updating Bear Notes via MCP tools. Use when the user mentions Bear, notes, or note-taking workflows on macOS.
allowed-tools: mcp__plugin_bear-notes_bear-notes__*
---
```

### Research Insights (Pattern Recognition — Critical Fix)

The `allowed-tools` format `mcp__bear-notes-*` from the original plan is **WRONG**. The actual Claude plugin MCP tool naming convention is:

```
mcp__plugin_<plugin-name>_<server-key>__<tool-name>
```

For plugin `bear-notes` with MCP server key `bear-notes`:
- `mcp__plugin_bear-notes_bear-notes__bear-open-note`
- `mcp__plugin_bear-notes_bear-notes__bear-search-notes`
- etc.

**Use:** `allowed-tools: mcp__plugin_bear-notes_bear-notes__*`

**Verify after first test:** Run `/mcp` in Claude Code with the plugin loaded to confirm actual tool names, then update the glob or switch to an explicit list.

### Skill Content Sections

1. **Platform requirement**: macOS only. Bear must be installed and have been opened at least once.
2. **Search strategy**: Use `bear-search-notes` first to get IDs, then `bear-open-note` to read content. Or use title-based lookup for exact matches.
3. **Section targeting**: Bear notes use markdown headings. `bear-add-text` and `bear-replace-text` target sections by header name — only direct content under that header, not nested sub-sections.
4. **Tag conventions**: Tags are slash-delimited hierarchies (e.g., `work/meetings`). Use `bear-list-tags` to discover existing hierarchy before creating new tags.
5. **Safety**: Content replacement is opt-in and destructive. Always confirm with the user before replacing note content. There is no undo via the MCP server. No delete-note tool exists by design.
6. **Verify-after-write pattern** (from agent-native review): Writes are fire-and-forget via Bear's x-callback-url — the MCP server cannot confirm Bear processed them. Verification must be **operation-specific** because archived/trashed notes are excluded from all read queries (`ZARCHIVED = 0` in `src/notes.ts:103,179,278`):
   - **create / add-text / replace-text / add-tag / add-file**: Read the note back via `bear-open-note` to confirm the change applied.
   - **archive**: Verify the note **disappears** from active results — call `bear-open-note` and confirm it returns "not found." A successful archive means the note is no longer readable through the MCP.
   - **rename-tag / delete-tag**: Verify via `bear-list-tags` — confirm the old tag name is gone and the new name appears (rename) or the tag is absent (delete). These are global operations with no per-note pre-flight check.
7. **Bulk operations**: When working with multiple notes, process sequentially and confirm with the user every 10-20 notes. Summarize planned changes before executing.
8. **Quick tool reference**: Inline table of all 12 tools with one-line descriptions (replaces separate TOOL_REFERENCE.md).
9. **Troubleshooting**: Common issues — Bear not installed, Node version < 24.13.0, database permissions, enabling debug logging.

### Research Insights (Agent-Native + Security)

**Operation-specific verification is critical.** The x-callback-url is fire-and-forget: `open -g "bear://..."` returns exit code 0 if macOS accepted the URL, not if Bear processed it. The skill must instruct Claude to verify mutations — but the verification strategy differs by operation because archived notes are filtered from all read paths (`ZARCHIVED = 0`). A naive "read the note back" after archive would look like a failure when it's actually the expected success state.

**Debug logging caveat (security):** When `UI_DEBUG_TOGGLE=true`, the server sets `DEBUG=bear-notes-mcp:*` which enables all debug loggers. This includes `buildBearUrl()` in `src/bear-urls.ts:80` which logs the full constructed Bear URL — including note text, tags, and base64 attachment payloads for write operations. This is a **known data exposure risk** in the current server. The plugin cannot fix this without server changes, so the SKILL.md must warn users: "Debug mode logs full note content and file attachments to stderr. Do not enable in shared or logged environments if your notes contain sensitive data." A future server improvement could redact body content from debug URLs, but that is out of scope for this plugin (no server changes).

**Content replacement gates:** The `enable_content_replacement` userConfig toggle is the primary gate. The skill should add a secondary soft gate: always preview the replacement (show diff-style before/after) and get user confirmation.

### SETUP.md Skill

A small skill to guide first-time plugin setup:

```yaml
---
name: setup
description: Guide user through Bear Notes plugin setup and verification. Use when the plugin is first installed or when troubleshooting connection issues.
disable-model-invocation: true
---
```

Content: Verify Bear is installed, check Node version, test MCP connection by calling `bear-list-tags`, explain userConfig options.

### Distribution

| Channel | Format | Status |
|---------|--------|--------|
| Claude Desktop | `.mcpb` bundle | Keep as-is (existing) |
| Claude Code | Plugin via `--plugin-dir` or marketplace | New (this plan) |
| Claude Cowork | Plugin (same as Code) | New (this plan) |
| npm | Standalone MCP server | Keep as-is (existing) |

### Research Insights (Best Practices + Submission)

**For marketplace submission (post-v1):**
- `marketplace.json` goes in `.claude-plugin/` with `$schema` URL
- Anthropic prefers plugins that bundle skills + MCP into coherent job-oriented packages
- Include a `SETUP.md` skill — Anthropic's submission docs specifically call this out
- Use connectors from the Connectors Directory or well-known publishers for higher verification odds
- Submit via [claude.ai/settings/plugins/submit](https://claude.ai/settings/plugins/submit)

**marketplace.json structure** (when ready):
```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "bear-notes-plugin",
  "owner": { "name": "Serhii Vasylenko", "url": "https://github.com/vasylenko" },
  "plugins": [{
    "name": "bear-notes",
    "version": "1.0.0",
    "description": "Search, read, create, and update Bear Notes from Claude Code and Cowork.",
    "source": "./"
  }]
}
```

## System-Wide Impact

- **No changes to the MCP server**: The existing `bear-notes-mcp` npm package and MCPB are untouched.
- **Parallel distribution**: MCPB (Desktop) and plugin (Code/Cowork) coexist. Users choose based on their Claude client.
- **Concurrent access**: Both MCPB and plugin hit the same Bear SQLite database. SQLite is read-only in the server; writes serialize through Bear's URL scheme internally. No locking needed.
- **Platform constraint**: macOS only. Document prominently in plugin description, SKILL.md, and README.

### Research Insights (Security)

**Supply chain mitigations:**
- Pin to major version (`@2`) in `.mcp.json`
- Document npm package name explicitly to prevent typosquatting
- Consider adding SHA256 checksum of published tarball in README for high-assurance users
- Run `npm audit` in CI for the MCP server package

**x-callback-url safety:**
- Bear URL builder must use strict allowlist, percent-encoding, and reject control characters
- Never pass raw model output directly into `open` command — parse into structured fields first
- Already handled in `src/bear-urls.ts` (verify in code review)

## Acceptance Criteria

### v1 (Ship)

**Structural:**
- [ ] `plugin.json` manifest with `userConfig` matching MCPB's three settings
- [ ] `.mcp.json` referencing `bear-notes-mcp@2` with env substitution
- [ ] `skills/bear-notes/SKILL.md` with search strategy, section targeting, tag conventions, operation-specific verify-after-write, safety, and troubleshooting
- [ ] `skills/setup/SKILL.md` for first-time setup guidance
- [ ] `README.md` with install instructions for Claude Code and Cowork

**Functional — plugin loading:**
- [ ] Plugin loads via `claude --plugin-dir ./bear-notes-plugin`
- [ ] All 12 MCP tools accessible after plugin installation
- [ ] `allowed-tools` glob verified against actual tool names via `/mcp`

**Functional — userConfig end-to-end (validates the env contract):**
- [ ] With `enable_content_replacement` set to `true`: `bear-replace-text` executes successfully (does not return "Content replacement is not enabled")
- [ ] With `enable_content_replacement` unset or `false`: `bear-replace-text` returns the "not enabled" gate message (confirms the gate at `src/main.ts:434` fires)
- [ ] With `enable_new_note_convention` set to `true`: `bear-create-note` places tags after the title (not at the bottom)
- [ ] With `debug` set to `true`: MCP server stderr shows `bear-notes-mcp:*` debug output

### Post-v1 (Defer)
- [ ] `commands/search.md`, `create.md`, `organize.md` slash commands
- [ ] `agents/note-curator.md` sub-agent with bulk operation guardrails
- [ ] `.claude-plugin/marketplace.json` for marketplace distribution
- [ ] Submit to Anthropic plugin directory
- [ ] `CHANGELOG.md`

## Success Metrics

- Plugin installs and connects to Bear without manual `.mcp.json` editing
- Skill activates when users mention Bear Notes in conversation
- 12 MCP tools work identically to standalone MCP server usage
- First-time setup guidance helps users configure all three options

## Dependencies & Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `npx` cold start 2-15s on first use | Medium | Document; recommend global install for power users |
| `bear-notes-mcp@2` major version boundary | Medium | Pin to `@2`; document upgrade when v3 ships |
| Node.js >=24.13.0 not available in Cowork | Medium | Document requirement; setup skill checks version |
| Bear not installed on user's Mac | Low | Setup skill verifies; MCP errors surface naturally |
| `userConfig` boolean as string (`"true"` vs `true`) | Low | Server already handles string env vars |
| `allowed-tools` glob wrong after MCP naming change | Low | Verify via `/mcp` on first test; document in README |

## MVP Implementation Order

Files to create, in sequence:

1. `bear-notes-plugin/.claude-plugin/plugin.json`
2. `bear-notes-plugin/.mcp.json`
3. `bear-notes-plugin/skills/bear-notes/SKILL.md`
4. `bear-notes-plugin/skills/setup/SKILL.md`
5. `bear-notes-plugin/README.md`

**Total: 5 files. ~300 lines of markdown + ~30 lines of JSON.**

## Sources & References

### Origin

- **Origin document:** [docs/conversion/CONVERSION_OVERVIEW.md](docs/conversion/CONVERSION_OVERVIEW.md) — Key decisions: plugin (not skill) is the correct target; MCP server stays untouched; `.mcp.json` references npm package

### Internal References

- Architecture: [.claude/contexts/SPECIFICATION.md](.claude/contexts/SPECIFICATION.md) — hybrid read/write model, safety gates
- MCPB manifest: [manifest.json](manifest.json) — `user_config` fields (lines 37-58)
- MCP tools: [src/main.ts](src/main.ts) — 12 tool registrations with Zod schemas
- Config: [src/config.ts](src/config.ts) — env var to feature flag mapping (lines 6-10)

### External References

- [Claude Plugin Docs](https://code.claude.com/docs/en/plugins) — Plugin creation guide
- [Plugin Reference](https://code.claude.com/docs/en/plugins-reference) — Manifest schema, userConfig, environment variables
- [Agent Skills Specification](https://agentskills.io/specification) — SKILL.md format
- [Plugin Submission](https://claude.com/docs/plugins/submit) — Marketplace submission process
- [Plugin Marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) — marketplace.json schema and distribution

### Related Work

- Existing plugin reference: [dailyzen-skill](https://github.com/kropdx/dailyzen-skill) — minimal plugin structure
- Compound-engineering plugin — complex plugin with 42 skills, 29 agents, inline + file MCP configs
- Existing conversion research: [docs/conversion/PLAN.md](docs/conversion/PLAN.md) — initial task list

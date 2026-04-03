# Conversion Plan: bear-notes-mcp to Claude Plugin

## Overview

Analysis of bear-notes-mcp's architecture and a clear strategy for converting it from a standalone MCP server into a Claude Plugin that works across Claude Code, Cowork, and Claude.ai — with a clear explanation of why "just a skill" won't work and "plugin" is the correct target.

## Tasks

- [ ] **Create plugin scaffold** -- Create the plugin directory structure with `.claude-plugin/plugin.json`, `skills/`, `commands/`, `agents/`, and `.mcp.json`
- [ ] **Write SKILL.md** -- Write `skills/bear-notes/SKILL.md` with best practices for Claude when working with Bear Notes (search strategies, section targeting, tag conventions)
- [ ] **Create slash commands** -- Create slash commands: `search.md`, `create.md`, `organize.md` in `commands/` directory
- [ ] **Create sub-agent** -- Create `agents/note-curator.md` sub-agent for complex multi-step note workflows
- [ ] **Write .mcp.json** -- Create `.mcp.json` that references `bear-notes-mcp` npm package with `userConfig` env var mapping
- [ ] **Write plugin.json** -- Create plugin manifest with name, version, author, `userConfig` fields matching current MCPB `user_config`
- [ ] **Test locally** -- Test the plugin locally with `claude --plugin-dir ./bear-notes-plugin`

## Reference Documentation

- [Claude Skills Overview](https://claude.com/docs/skills)
- [Creating Custom Skills](https://claude.com/docs/skills/how-to)
- [Agent Skills Specification](https://agentskills.io/specification)
- [Connectors Overview](https://claude.com/docs/connectors/overview)
- [Plugins Overview](https://claude.com/docs/plugins/overview)
- [Claude Code Plugins Guide](https://code.claude.com/docs/en/plugins)
- [Claude Code Plugins Reference](https://code.claude.com/docs/en/plugins-reference)
- [Submitting a Plugin](https://claude.com/docs/plugins/submit)

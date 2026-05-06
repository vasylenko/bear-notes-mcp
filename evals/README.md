# Evals for bear-notes-mcp

A/B eval harness comparing MCP server versions on efficiency metrics (tool calls, turns, cost). Uses [promptfoo](https://promptfoo.dev) with the `anthropic:claude-agent-sdk` provider.

## What This Measures

Two versions of the MCP server run against the same prompt. The eval measures how efficiently each version completes the task:

- **Tool calls** (emitted as a named score, not gated): how many times the agent calls the MCP server
- **Turns**: conversation turns between the agent and MCP server
- **Cost**: USD per run

Two evals live here:

- **`fts5-vs-like.yaml`** — SVA-28 FTS5 BM25 ranking: relevance vs the prior LIKE+mod-date ordering
- **`native-vs-fts5.yaml`** — v3.0.0 FTS5 vs Bear's own MCP server (`bearcli mcp-server`)

## Prerequisites

1. **Bear app running** — the MCP server reads Bear's SQLite DB
2. **`dist/main.js` built** — run `task build` from project root
3. **`evals/released/` populated** — drop a baseline npm release into it
4. **`ANTHROPIC_API_KEY` exported** in your shell

## Provider Isolation

Each eval run is isolated from host Claude Code settings:

- `setting_sources: []` — blocks `~/.claude/settings.json` and project settings
- `custom_allowed_tools` — strict allowlist; only the eval's MCP server tools are callable
- `mcp.servers` — passed via `--mcp-config`, independent of settings files
- `persist_session: false` — no session transcripts written

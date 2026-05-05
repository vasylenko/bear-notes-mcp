# Evals for bear-notes-mcp

A/B eval harness comparing MCP server versions on efficiency metrics (tool calls, turns, cost). Uses [promptfoo](https://promptfoo.dev) with the `anthropic:claude-agent-sdk` provider.

## What This Measures

Two versions of the MCP server run against the same prompt. The eval measures how efficiently each version completes the task:

- **Tool calls** (gate ≤5): how many times the agent calls the MCP server
- **Turns**: conversation turns between the agent and MCP server
- **Cost**: USD per run

Two evals live here:

- **`promptfooconfig.yaml`** — tags-in-search efficiency (PR #100): search results include tags so the agent skips follow-up reads
- **`fts5-promptfooconfig.yaml`** — SVA-28 FTS5 BM25 ranking: relevance vs the prior LIKE+mod-date ordering

## Prerequisites

1. **Bear app running** — the MCP server reads Bear's SQLite DB
2. **`dist/main.js` built** — run `task build` from project root
3. **`evals/released/` populated** — drop a baseline npm release into it (see Quick Start)
4. **`ANTHROPIC_API_KEY` exported** in your shell

## Quick Start

```bash
# One-time: place a baseline build in evals/released/ (FTS5 eval expects 2.11.0)
mkdir -p evals/released && (cd evals && npm pack bear-notes-mcp@2.11.0 \
  && tar xzf bear-notes-mcp-2.11.0.tgz -C released --strip-components=1 \
  && rm bear-notes-mcp-2.11.0.tgz)

task build  # build current HEAD
npx promptfoo eval --config evals/fts5-promptfooconfig.yaml --no-cache
npx promptfoo view evals/outputs/results.json
```

Higher-level automation (orchestration, fresh isolation dir per run) is being rewritten — until it lands, the raw promptfoo commands above work.

## Files

| File | Purpose |
|------|---------|
| `promptfooconfig.yaml` / `fts5-promptfooconfig.yaml` | Eval configs — providers, assertions, prompts |
| `shared/default-test.yaml` | Shared assertion (reads `namedScores.toolCalls` for per-provider metrics) |
| `outputs/` | Results, report, SDK debug logs (gitignored) |
| `released/` | Baseline server from npm (gitignored) |

## Provider Isolation

Each eval run is isolated from host Claude Code settings:

- `setting_sources: []` — blocks `~/.claude/settings.json` and project settings
- `custom_allowed_tools` — strict allowlist; only the eval's MCP server tools are callable
- `mcp.servers` — passed via `--mcp-config`, independent of settings files
- `persist_session: false` — no session transcripts written

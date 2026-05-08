import { describe, expect, it } from 'vitest';

import { callTool, GATE_CLOSED_ENV, initialize, listTools } from './inspector.js';

// Source of truth for the SVA-32 registration-time gate. The
// `Read/Write Tool Gating` section of docs/dev/SPECIFICATION.md references
// these constants. Adding a future tool requires updating exactly one of
// the two arrays — and the assertions below force the choice to be explicit.
const EXPECTED_READ_ONLY_TOOLS = [
  'bear-open-note',
  'bear-search-notes',
  'bear-find-untagged-notes',
  'bear-list-tags',
] as const;

const EXPECTED_WRITE_TOOLS = [
  'bear-create-note',
  'bear-add-text',
  'bear-replace-text',
  'bear-add-file',
  'bear-add-tag',
  'bear-archive-note',
  'bear-rename-tag',
  'bear-delete-tag',
] as const;

describe('Registration-time read/write gate (UI_ENABLE_CONTENT_REPLACEMENT)', () => {
  describe('with the gate closed (env var unset — default)', () => {
    it('tools/list returns exactly the 4 read-only tools', () => {
      const tools = new Set(listTools(GATE_CLOSED_ENV));

      expect(tools.size).toBe(EXPECTED_READ_ONLY_TOOLS.length);
      for (const name of EXPECTED_READ_ONLY_TOOLS) {
        expect(tools.has(name), `expected read-only tool "${name}" to be advertised`).toBe(true);
      }
      for (const name of EXPECTED_WRITE_TOOLS) {
        expect(tools.has(name), `expected write tool "${name}" to be hidden`).toBe(false);
      }
    });

    it('initialize.instructions tells the LLM how to unlock Edit Mode', async () => {
      const init = await initialize(GATE_CLOSED_ENV);

      expect(init.instructions).toBeDefined();
      expect(init.instructions).toMatch(/Edit Mode/);
      expect(init.instructions).toMatch(/UI_ENABLE_CONTENT_REPLACEMENT/);
      // Edit-mode-only guidance must NOT leak — referencing tools that aren't
      // registered would invite hallucinated tool calls.
      expect(init.instructions).not.toMatch(/bear-add-text inserts text/);
    });
  });

  describe('with the gate open (UI_ENABLE_CONTENT_REPLACEMENT=true)', () => {
    it('tools/list returns all 12 tools', () => {
      const tools = new Set(listTools({ UI_ENABLE_CONTENT_REPLACEMENT: 'true' }));

      expect(tools.size).toBe(EXPECTED_READ_ONLY_TOOLS.length + EXPECTED_WRITE_TOOLS.length);
      for (const name of [...EXPECTED_READ_ONLY_TOOLS, ...EXPECTED_WRITE_TOOLS]) {
        expect(tools.has(name), `expected tool "${name}" to be advertised`).toBe(true);
      }
    });

    it('initialize.instructions carries the edit-mode guidance, not the unlock notice', async () => {
      const init = await initialize({ UI_ENABLE_CONTENT_REPLACEMENT: 'true' });

      expect(init.instructions).toBeDefined();
      expect(init.instructions).toMatch(/bear-add-text inserts text/);
      expect(init.instructions).not.toMatch(/Edit Mode is currently off/);
    });
  });

  describe('regression smoke', () => {
    it('bear-search-notes still works under default (read-only) registration', () => {
      const result = callTool({
        toolName: 'bear-search-notes',
        args: { term: 'bear-mcp-registration-gate-smoke-noresults-expected' },
        env: GATE_CLOSED_ENV,
      });

      // The query is intentionally unlikely to match; we're verifying the
      // tool dispatches and returns a normal (non-error) response, not the
      // result content. Empty result sets are normal responses, not errors.
      expect(result.isError).not.toBe(true);
      expect(result.content[0].type).toBe('text');
    });
  });
});

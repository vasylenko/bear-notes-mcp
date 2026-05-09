import { describe, expect, it } from 'vitest';

import { APP_VERSION } from '../../src/config.js';
import { readOnlyInstructions } from '../../src/instructions.js';

import { callTool, GATE_CLOSED_ENV, initialize, listTools } from './inspector.js';

// Source of truth for the read/write classification — referenced by
// docs/dev/SPECIFICATION.md. Future tools update one of these arrays;
// the assertions below force the choice to be explicit.
const EXPECTED_READ_ONLY_TOOLS = [
  'bear-open-note',
  'bear-search-notes',
  'bear-find-untagged-notes',
  'bear-list-tags',
] as const;

// bear-capabilities exists to discover the unlock path; it serves no purpose
// once Edit Mode is on, so it's registered only when the gate is closed.
const EXPECTED_OFF_ONLY_TOOLS = ['bear-capabilities'] as const;

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
  describe('with the gate closed (UI_ENABLE_CONTENT_REPLACEMENT=false)', () => {
    it('tools/list returns the 4 read-only tools plus bear-capabilities', () => {
      const tools = new Set(listTools(GATE_CLOSED_ENV));

      const expected = [...EXPECTED_READ_ONLY_TOOLS, ...EXPECTED_OFF_ONLY_TOOLS];
      expect(tools.size).toBe(expected.length);
      for (const name of expected) {
        expect(tools.has(name), `expected tool "${name}" to be advertised`).toBe(true);
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
      // Edit-mode-only tool names must not leak — referencing disabled
      // tools would invite hallucinated calls. `bear-add-text` is a stable
      // substring of editModeInstructions only.
      expect(init.instructions).not.toMatch(/bear-add-text/);
    });

    it('bear-capabilities call returns the composed unlock guidance verbatim', () => {
      const response = callTool({ toolName: 'bear-capabilities', env: GATE_CLOSED_ENV });

      // Reconstruct from the same constants the tool uses — any drift in the
      // template, the unlock copy, or the version stamp surfaces as inequality.
      const body = readOnlyInstructions.filter((line) => line.length > 0).join('\n');
      const expected = [
        '# Bear Notes MCP — capabilities',
        '**Edit Mode:** OFF',
        '',
        body,
        '',
        `Server version: ${APP_VERSION}`,
      ].join('\n');

      expect(response.content[0].text).toBe(expected);
    });
  });

  describe('with the gate open (UI_ENABLE_CONTENT_REPLACEMENT=true)', () => {
    it('tools/list returns the 12 Bear-domain tools — bear-capabilities is gone', () => {
      const tools = new Set(listTools({ UI_ENABLE_CONTENT_REPLACEMENT: 'true' }));

      expect(tools.size).toBe(EXPECTED_READ_ONLY_TOOLS.length + EXPECTED_WRITE_TOOLS.length);
      for (const name of [...EXPECTED_READ_ONLY_TOOLS, ...EXPECTED_WRITE_TOOLS]) {
        expect(tools.has(name), `expected tool "${name}" to be advertised`).toBe(true);
      }
      for (const name of EXPECTED_OFF_ONLY_TOOLS) {
        expect(tools.has(name), `expected off-only tool "${name}" to be hidden`).toBe(false);
      }
    });

    it('initialize.instructions carries the edit-mode guidance, not the unlock notice', async () => {
      const init = await initialize({ UI_ENABLE_CONTENT_REPLACEMENT: 'true' });

      expect(init.instructions).toBeDefined();
      expect(init.instructions).toMatch(/bear-add-text/);
      // The unlock notice mentions UI_ENABLE_CONTENT_REPLACEMENT=true; that env
      // var name only appears in readOnlyInstructions, so its absence proves
      // the unlock notice is not present when the gate is open.
      expect(init.instructions).not.toMatch(/UI_ENABLE_CONTENT_REPLACEMENT/);
    });
  });

  describe('regression smoke', () => {
    it('all 4 read tools are callable when the gate is closed', () => {
      // Test 1 proves the read tools are *advertised* under gate-closed env.
      // This test exercises the dispatch path — proves they're callable, not
      // just declared. A future refactor that accidentally hides a read tool
      // behind the gate would surface here.
      expect(() =>
        callTool({
          toolName: 'bear-search-notes',
          args: { term: 'bear-mcp-registration-gate-smoke-noresults-expected' },
          env: GATE_CLOSED_ENV,
        })
      ).not.toThrow();

      expect(() => callTool({ toolName: 'bear-list-tags', env: GATE_CLOSED_ENV })).not.toThrow();

      expect(() =>
        callTool({ toolName: 'bear-find-untagged-notes', env: GATE_CLOSED_ENV })
      ).not.toThrow();

      // bear-open-note requires id or title; passing a nonexistent id returns
      // an input-validation soft error, which is still a successful dispatch
      // at the wire level (callTool throws only on Inspector-level failures).
      expect(() =>
        callTool({
          toolName: 'bear-open-note',
          args: { id: 'bear-mcp-registration-gate-smoke-nonexistent' },
          env: GATE_CLOSED_ENV,
        })
      ).not.toThrow();
    });
  });
});

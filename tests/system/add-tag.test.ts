import { afterAll, describe, expect, it } from 'vitest';

import { callTool, cleanupTestNotes, tryExtractNoteId, uniqueTitle } from './inspector.js';

const TEST_PREFIX = '[Bear-MCP-stest-add-tag]';
const RUN_ID = Date.now();

afterAll(() => {
  cleanupTestNotes(TEST_PREFIX);
});

describe('bear-add-tag via MCP Inspector CLI', () => {
  it('adds tags to a note and returns each tag plus note metadata in the response', () => {
    const title = uniqueTitle(TEST_PREFIX, 'AddTags', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Add tag test note', tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;
    // Two tags exercise the array iteration in the handler — single-tag is a degenerate case of this
    const tags = [`stest-add-tag-${RUN_ID}-a`, `stest-add-tag-${RUN_ID}-b`];

    const result = callTool({
      toolName: 'bear-add-tag',
      args: { id: noteId, tags: JSON.stringify(tags) },
    }).content[0].text;

    expect(result).toContain('added successfully');
    expect(result).toContain(title);
    expect(result).toContain(noteId);
    for (const tag of tags) {
      expect(result).toContain(`#${tag}`);
    }
  });

  it('returns error for non-existent note ID', () => {
    const response = callTool({
      toolName: 'bear-add-tag',
      args: { id: '00000000-0000-0000-0000-000000000000', tags: '["bogus"]' },
    });

    expect(response.content[0].text).toContain('not found');
    expect(response.isError).toBe(true);
  });
});

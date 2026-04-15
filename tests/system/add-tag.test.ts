import { afterAll, describe, expect, it } from 'vitest';

import { callTool, cleanupTestNotes, findNoteId, trashNote, uniqueTitle } from './inspector.js';

const TEST_PREFIX = '[Bear-MCP-stest-add-tag]';
const RUN_ID = Date.now();

afterAll(() => {
  cleanupTestNotes(TEST_PREFIX);
});

describe('bear-add-tag via MCP Inspector CLI', () => {
  it('returns note ID, title, and tag in response', () => {
    const title = uniqueTitle(TEST_PREFIX, 'Single', RUN_ID);
    let noteId: string | undefined;

    try {
      callTool({
        toolName: 'bear-create-note',
        args: { title, text: 'Add tag test note', tags: 'system-test' },
      });

      noteId = findNoteId(title);
      const tag = `stest-add-tag-${RUN_ID}`;

      const result = callTool({
        toolName: 'bear-add-tag',
        args: { id: noteId, tags: JSON.stringify([tag]) },
      }).content[0].text;

      expect(result).toContain('added successfully');
      expect(result).toContain(title);
      expect(result).toContain(noteId);
      expect(result).toContain(`#${tag}`);
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('lists all tags when multiple are added', () => {
    const title = uniqueTitle(TEST_PREFIX, 'Multi', RUN_ID);
    let noteId: string | undefined;

    try {
      callTool({
        toolName: 'bear-create-note',
        args: { title, text: 'Multi-tag test note', tags: 'system-test' },
      });

      noteId = findNoteId(title);
      const tags = [`stest-add-tag-${RUN_ID}-a`, `stest-add-tag-${RUN_ID}-b`];

      const result = callTool({
        toolName: 'bear-add-tag',
        args: { id: noteId, tags: JSON.stringify(tags) },
      }).content[0].text;

      expect(result).toContain(noteId);
      expect(result).toContain(title);
      for (const tag of tags) {
        expect(result).toContain(`#${tag}`);
      }
    } finally {
      if (noteId) trashNote(noteId);
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

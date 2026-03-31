import { afterAll, describe, expect, it } from 'vitest';

import {
  trashNote,
  callTool,
  cleanupTestNotes,
  extractNoteBody,
  findNoteId,
  sleep,
  uniqueTitle,
} from './inspector.js';

const TEST_PREFIX = '[Bear-MCP-stest-add-text]';
const RUN_ID = Date.now();
const PAUSE_AFTER_WRITE_OP = 100; // ms to wait after write operations for Bear to process changes

afterAll(() => {
  cleanupTestNotes(TEST_PREFIX);
});

describe('bear-add-text via MCP Inspector CLI', () => {
  it('prepends text to a note', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'Prepend', RUN_ID);
    let noteId: string | undefined;

    try {
      callTool({
        toolName: 'bear-create-note',
        args: { title, text: 'Original content', tags: 'system-test' },
      });

      noteId = findNoteId(title);

      callTool({
        toolName: 'bear-add-text',
        args: { id: noteId, text: 'Prepended text', position: 'beginning' },
      });

      await sleep(PAUSE_AFTER_WRITE_OP);

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { id: noteId },
      }).content[0].text;

      const noteBody = extractNoteBody(openResult);
      expect(noteBody).toContain('Original content');
      expect(noteBody).toContain('Prepended text');
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('appends text to a specific section via header', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'Append Header', RUN_ID);
    let noteId: string | undefined;

    const sectionedText = [
      '## Notes',
      'Existing note text',
      '',
      '## Action Items',
      'Existing action items',
    ].join('\n');

    try {
      callTool({
        toolName: 'bear-create-note',
        args: { title, text: sectionedText, tags: 'system-test' },
      });

      noteId = findNoteId(title);

      callTool({
        toolName: 'bear-add-text',
        args: { id: noteId, text: 'New action item appended', header: 'Action Items' },
      });

      await sleep(PAUSE_AFTER_WRITE_OP);

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { id: noteId },
      }).content[0].text;

      const noteBody = extractNoteBody(openResult);
      expect(noteBody).toContain('New action item appended');
      expect(noteBody).toContain('Existing note text');
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('appends text to a note by default', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'Append', RUN_ID);
    let noteId: string | undefined;

    try {
      callTool({
        toolName: 'bear-create-note',
        args: { title, text: 'Original content', tags: 'system-test' },
      });

      noteId = findNoteId(title);

      callTool({
        toolName: 'bear-add-text',
        args: { id: noteId, text: 'Appended text' },
      });

      await sleep(PAUSE_AFTER_WRITE_OP);

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { id: noteId },
      }).content[0].text;

      const noteBody = extractNoteBody(openResult);
      expect(noteBody).toContain('Original content');
      expect(noteBody).toContain('Appended text');
    } finally {
      if (noteId) trashNote(noteId);
    }
  });
});

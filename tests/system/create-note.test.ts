import { afterAll, describe, expect, it } from 'vitest';

import {
  trashNote,
  callTool,
  cleanupTestNotes,
  findNoteId,
  tryExtractNoteId,
  uniqueTitle,
} from './inspector.js';

const TEST_PREFIX = '[Bear-MCP-stest-create-note]';
const RUN_ID = Date.now();

afterAll(() => {
  cleanupTestNotes(TEST_PREFIX);
});

describe('bear-create-note returns note ID via MCP Inspector CLI', () => {
  it('returns note ID when title is provided', () => {
    const title = uniqueTitle(TEST_PREFIX, 'With Title', RUN_ID);
    let noteId: string | undefined;

    try {
      const createResult = callTool({
        toolName: 'bear-create-note',
        args: { title, text: 'System test content', tags: 'system-test' },
      }).content[0].text;

      // Response must contain Note ID with a UUID
      noteId = tryExtractNoteId(createResult) ?? undefined;
      expect(noteId, `Expected "Note ID: <UUID>" in response:\n${createResult}`).toBeDefined();

      // Verify the returned ID is valid by opening the note
      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { id: noteId },
      }).content[0].text;

      expect(openResult).toContain(title);
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('does not return note ID when no title is provided', () => {
    const marker = `${TEST_PREFIX} no-title ${crypto.randomUUID()}`;
    let noteId: string | undefined;

    try {
      const createResult = callTool({
        toolName: 'bear-create-note',
        args: { text: marker, tags: 'system-test' },
      }).content[0].text;

      // No title → no polling → no Note ID line
      expect(tryExtractNoteId(createResult)).toBeNull();

      // Find the orphan note by its unique marker text so we can clean it up
      noteId = findNoteId(marker);
    } finally {
      if (noteId) trashNote(noteId);
    }
  });
});

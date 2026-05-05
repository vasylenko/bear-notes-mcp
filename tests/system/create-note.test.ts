import { afterAll, describe, expect, it } from 'vitest';

import { callTool, cleanupTestNotes, tryExtractNoteId, uniqueTitle } from './inspector.js';

const TEST_PREFIX = '[Bear-MCP-stest-create-note]';
const RUN_ID = Date.now();

afterAll(() => {
  cleanupTestNotes(TEST_PREFIX);
});

describe('bear-create-note returns note ID via MCP Inspector CLI', () => {
  it('returns note ID when title is provided', () => {
    const title = uniqueTitle(TEST_PREFIX, 'With Title', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'System test content', tags: 'system-test' },
    }).content[0].text;

    // Response must contain Note ID with a UUID
    const noteId = tryExtractNoteId(createResult);
    expect(noteId, `Expected "Note ID: <UUID>" in response:\n${createResult}`).toBeTruthy();

    // Verify the returned ID is valid by opening the note
    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { id: noteId! },
    }).content[0].text;

    expect(openResult).toContain(title);
  });
});

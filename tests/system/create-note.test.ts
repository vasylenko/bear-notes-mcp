import { afterAll, describe, expect, it } from 'vitest';

import {
  callTool,
  cleanupTestNotes,
  readNoteRevision,
  tryExtractNoteId,
  tryExtractRevision,
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

  it('emits Revision matching live Z_OPT after creation (OCC inform)', () => {
    const title = uniqueTitle(TEST_PREFIX, 'Revision', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Creation revision test' },
    }).content[0].text;

    const noteId = tryExtractNoteId(createResult);
    expect(noteId).toBeTruthy();

    const responseRevision = tryExtractRevision(createResult);
    expect(responseRevision).not.toBeNull();
    // Bear's Z_OPT starts at 1 for a freshly-created note and can jump to 2 on the
    // first edit (subtitle/index recompute save, SVA-20 finding). For a fresh
    // create we only assert >= 1 — the exact value is captured by the DB compare.
    expect(responseRevision).toBeGreaterThanOrEqual(1);

    const dbRevision = readNoteRevision(noteId!);
    expect(dbRevision).not.toBeNull();
    expect(responseRevision).toBe(dbRevision);
  });
});

import { afterAll, describe, expect, it } from 'vitest';

import {
  callTool,
  readNoteRevision,
  sleep,
  trashNote,
  tryExtractNoteId,
  uniqueTitle,
} from './inspector.js';

const TEST_PREFIX = '[Bear-MCP-stest-archive-rev]';
const RUN_ID = Date.now();
const PAUSE_AFTER_WRITE_OP = 100; // ms to wait after write operations for Bear to process changes

// Track ids explicitly — cleanupTestNotes filters out archived notes (its SELECT
// has WHERE ZARCHIVED = 0), so the standard prefix-cleanup path doesn't reach
// notes we archive in this suite. Trash them directly via id instead.
const createdIds: string[] = [];

afterAll(() => {
  for (const id of createdIds) {
    trashNote(id);
  }
});

describe('bear-archive-note Revision wiring (OCC inform)', () => {
  it('returns the pre-archive revision (post-archive read is filtered out)', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'Archive', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Body to be archived' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;
    createdIds.push(noteId);

    // Settle briefly so create's subtitle/index recompute save (the +2 jump
    // in BEAR_DATABASE_SCHEMA.md) lands BEFORE we snapshot Z_OPT. Without it,
    // the test's readNoteRevision and the handler's pre-flight getNoteContent
    // race against the recompute and read different values.
    await sleep(PAUSE_AFTER_WRITE_OP);

    const preArchiveRevision = readNoteRevision(noteId);
    expect(preArchiveRevision).not.toBeNull();

    const archiveResult = callTool({
      toolName: 'bear-archive-note',
      args: { id: noteId },
    }).content[0].text;

    expect(archiveResult).toContain(`Revision: ${preArchiveRevision}`);
  });
});

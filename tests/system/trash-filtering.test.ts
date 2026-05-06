import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  callTool,
  cleanupTestNotes,
  trashNote,
  tryExtractNoteId,
  uniqueTitle,
} from './inspector.js';

const TEST_PREFIX = '[Bear-MCP-stest-trash-filter]';
const RUN_ID = Date.now();

const TAG = `stest77-${RUN_ID}`;

function title(label: string): string {
  return uniqueTitle(TEST_PREFIX, label, RUN_ID);
}

const TITLE = title('TrashTag');

let noteId: string;

beforeAll(() => {
  const createResult = callTool({
    toolName: 'bear-create-note',
    args: { title: TITLE, tags: TAG },
  }).content[0].text;
  noteId = tryExtractNoteId(createResult)!;
});

afterAll(() => {
  // Only cleans up notes that weren't trashed during tests — trashed notes
  // are excluded from search by design. Bear auto-empties trash after 7 days.
  cleanupTestNotes(TEST_PREFIX);
});

describe('trash filtering in tag listing', () => {
  it('tag appears in bear-list-tags before trashing', () => {
    const result = callTool({ toolName: 'bear-list-tags' }).content[0].text;
    expect(result).toContain(TAG);
  });

  it('trashed note tag disappears from bear-list-tags', () => {
    trashNote(noteId);

    const result = callTool({ toolName: 'bear-list-tags' }).content[0].text;
    expect(result).not.toContain(TAG);
  });

  it('trashed note is excluded from bear-search-notes', () => {
    // Assert the trashed note's specific ID isn't returned, not "zero results
    // overall". Under FTS5 OR-rank, the title's tokens (Bear, MCP, etc.) can
    // match unrelated notes in the user's library — the test would flake on
    // any non-empty library if we required no IDs at all.
    const result = callTool({ toolName: 'bear-search-notes', args: { term: TITLE } }).content[0]
      .text;
    expect(result).not.toContain(noteId);
  });
});

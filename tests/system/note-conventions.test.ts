import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  callTool,
  cleanupTestNotes,
  extractNoteBody,
  tryExtractNoteId,
  uniqueTitle,
} from './inspector.js';

const FIXTURE_TEXT = readFileSync(
  resolve(import.meta.dirname, '../fixtures/sample-note.md'),
  'utf-8'
);

const TEST_PREFIX = '[Bear-MCP-stest-note-convention]';
const RUN_ID = Date.now();

afterAll(() => {
  cleanupTestNotes(TEST_PREFIX);
});

describe('note conventions via MCP Inspector CLI', () => {
  // Verifies the feature-flag wiring end-to-end: with the flag OFF, tags are not
  // embedded in the note body via Bear URL params. The shape of the embedded
  // output (when the flag is ON) is exhaustively covered by unit tests for
  // applyNoteConventions in src/operations/note-conventions.test.ts.
  it('convention OFF — tags placed by Bear via URL params', () => {
    const title = uniqueTitle(TEST_PREFIX, 'Conv Off', RUN_ID);
    // No env override — convention OFF by default
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: FIXTURE_TEXT, tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { id: noteId },
    }).content[0].text;

    const noteBody = extractNoteBody(openResult);

    // Bear places tags via URL params — they appear after the title, not embedded at start of text
    // The note body should NOT start with #system-test\n--- (that's the convention ON pattern)
    expect(noteBody).not.toMatch(/^#system-test\n---/);
    // The fixture content should be present in the body
    expect(noteBody).toContain('retention is set to 15 days');
  });
});

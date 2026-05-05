import { afterAll, describe, expect, it } from 'vitest';

import {
  callTool,
  cleanupTestNotes,
  extractNoteBody,
  trashNote,
  tryExtractNoteId,
  uniqueTitle,
} from './inspector.js';

const TEST_PREFIX = '[Bear-MCP-stest-open-by-title]';
const RUN_ID = Date.now();

function title(label: string): string {
  return uniqueTitle(TEST_PREFIX, label, RUN_ID);
}

afterAll(() => {
  cleanupTestNotes(TEST_PREFIX);
});

describe('bear-open-note by title', () => {
  it('opens a note by exact title', () => {
    const noteTitle = title('Unique');
    const noteText = 'Content for open-by-title test';

    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title: noteTitle, text: noteText },
    }).content[0].text;
    expect(tryExtractNoteId(createResult)).toBeTruthy();

    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { title: noteTitle },
    }).content[0].text;

    expect(openResult).toContain(noteTitle);
    expect(extractNoteBody(openResult)).toContain(noteText);
    // Response must include the note ID for follow-up operations
    expect(tryExtractNoteId(openResult)).toBeTruthy();
  });

  it('title matching is case-insensitive', () => {
    const noteTitle = title('CaseTest');
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title: noteTitle, text: 'Case sensitivity test' },
    }).content[0].text;
    expect(tryExtractNoteId(createResult)).toBeTruthy();

    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { title: noteTitle.toLowerCase() },
    }).content[0].text;

    expect(openResult).toContain(noteTitle);
  });

  it('returns not-found error for non-existent title', () => {
    const response = callTool({
      toolName: 'bear-open-note',
      args: { title: `Non-existent note ${RUN_ID}` },
    });

    expect(response.content[0].text).toContain('No note found with title');
    expect(response.isError).toBe(true);
  });

  it('returns disambiguation list when multiple notes share the same title', () => {
    const sharedTitle = title('Duplicate');

    // Create two notes with the same title — don't rely on returned IDs
    // because awaitNoteCreation resolves the most recent note by title,
    // which is the same for both creates
    for (const text of ['First duplicate', 'Second duplicate']) {
      callTool({
        toolName: 'bear-create-note',
        args: { title: sharedTitle, text },
      });
    }

    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { title: sharedTitle },
    }).content[0].text;

    expect(openResult).toContain('Multiple notes found');
    expect(openResult).toContain(sharedTitle);
    expect(openResult).toMatch(/modified:\s*\d{4}-\d{2}-\d{2}/);

    // Extract IDs from the disambiguation list for cleanup and verification
    const idMatches = [...openResult.matchAll(/ID:\s*([A-F0-9-]+)/gi)];
    expect(idMatches.length).toBe(2);
    expect(new Set(idMatches.map((m) => m[1])).size).toBe(2);
  });

  it('excludes trashed notes from title lookup', () => {
    const noteTitle = title('Trashed');
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title: noteTitle, text: 'Will be trashed' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    trashNote(noteId);

    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { title: noteTitle },
    }).content[0].text;

    expect(openResult).toContain('No note found with title');
  });

  it('opens a note by ID (regression)', () => {
    const noteTitle = title('ByID');
    const noteText = 'Regression test for ID-based lookup';

    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title: noteTitle, text: noteText },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { id: noteId },
    }).content[0].text;

    expect(openResult).toContain(noteTitle);
    expect(extractNoteBody(openResult)).toContain(noteText);
  });
});

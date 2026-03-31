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
    let noteId: string | undefined;

    try {
      const createResult = callTool({
        toolName: 'bear-create-note',
        args: { title: noteTitle, text: noteText },
      }).content[0].text;
      noteId = tryExtractNoteId(createResult) ?? undefined;
      expect(noteId).toBeDefined();

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { title: noteTitle },
      }).content[0].text;

      expect(openResult).toContain(noteTitle);
      expect(extractNoteBody(openResult)).toContain(noteText);
      // Response must include the note ID for follow-up operations
      expect(tryExtractNoteId(openResult)).toBeTruthy();
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('title matching is case-insensitive', () => {
    const noteTitle = title('CaseTest');
    let noteId: string | undefined;

    try {
      const createResult = callTool({
        toolName: 'bear-create-note',
        args: { title: noteTitle, text: 'Case sensitivity test' },
      }).content[0].text;
      noteId = tryExtractNoteId(createResult) ?? undefined;
      expect(noteId).toBeDefined();

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { title: noteTitle.toLowerCase() },
      }).content[0].text;

      expect(openResult).toContain(noteTitle);
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('returns not-found error for non-existent title', () => {
    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { title: `Non-existent note ${RUN_ID}` },
    }).content[0].text;

    expect(openResult).toContain('No note found with title');
  });

  it('returns disambiguation list when multiple notes share the same title', () => {
    const sharedTitle = title('Duplicate');
    const noteIds: string[] = [];

    try {
      // Create two notes with the same title
      for (const text of ['First duplicate', 'Second duplicate']) {
        const createResult = callTool({
          toolName: 'bear-create-note',
          args: { title: sharedTitle, text },
        }).content[0].text;
        const id = tryExtractNoteId(createResult);
        expect(id).toBeTruthy();
        if (id) noteIds.push(id);
      }

      expect(new Set(noteIds).size).toBe(2);

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { title: sharedTitle },
      }).content[0].text;

      expect(openResult).toContain('Multiple notes found');
      // Both IDs and modification dates should appear in the disambiguation list
      for (const id of noteIds) {
        expect(openResult).toContain(id);
      }
      expect(openResult).toMatch(/modified:\s*\d{4}-\d{2}-\d{2}/);
    } finally {
      for (const id of noteIds) {
        trashNote(id);
      }
    }
  });

  it('returns error when neither id nor title is provided', () => {
    const openResult = callTool({
      toolName: 'bear-open-note',
      args: {},
    }).content[0].text;

    expect(openResult).toContain('Either note ID or title is required');
  });

  it('excludes trashed notes from title lookup', () => {
    const noteTitle = title('Trashed');
    let noteId: string | undefined;

    try {
      const createResult = callTool({
        toolName: 'bear-create-note',
        args: { title: noteTitle, text: 'Will be trashed' },
      }).content[0].text;
      noteId = tryExtractNoteId(createResult) ?? undefined;
      expect(noteId).toBeDefined();

      trashNote(noteId!);

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { title: noteTitle },
      }).content[0].text;

      expect(openResult).toContain('No note found with title');
    } finally {
      // trashNote already moved it out of active notes
    }
  });

  it('opens a note by ID (regression)', () => {
    const noteTitle = title('ByID');
    const noteText = 'Regression test for ID-based lookup';
    let noteId: string | undefined;

    try {
      const createResult = callTool({
        toolName: 'bear-create-note',
        args: { title: noteTitle, text: noteText },
      }).content[0].text;
      noteId = tryExtractNoteId(createResult) ?? undefined;
      expect(noteId).toBeDefined();

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { id: noteId! },
      }).content[0].text;

      expect(openResult).toContain(noteTitle);
      expect(extractNoteBody(openResult)).toContain(noteText);
    } finally {
      if (noteId) trashNote(noteId);
    }
  });
});

import { afterAll, describe, expect, it } from 'vitest';

import {
  callTool,
  cleanupTestNotes,
  extractNoteBody,
  trashNote,
  tryExtractNoteId,
  uniqueTitle,
} from './inspector.js';

const TEST_PREFIX = '[Bear-MCP-stest-frontmatter]';
const RUN_ID = Date.now();

afterAll(() => {
  cleanupTestNotes(TEST_PREFIX);
});

describe('bear-create-note preserves YAML frontmatter', () => {
  it('creates note with frontmatter intact and title as H1', () => {
    const title = uniqueTitle(TEST_PREFIX, 'CreateFM', RUN_ID);
    let noteId: string | undefined;

    try {
      const fm = '---\nstatus: draft\nproject: test\n---';
      const text = `${fm}\nBody content here.`;

      const createResult = callTool({
        toolName: 'bear-create-note',
        args: { title, text },
      }).content[0].text;

      noteId = tryExtractNoteId(createResult) ?? undefined;
      expect(noteId, `Expected "Note ID: <UUID>" in: ${createResult}`).toBeDefined();

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { id: noteId! },
      }).content[0].text;

      const body = extractNoteBody(openResult);
      // Frontmatter block must appear before the title
      expect(body.indexOf('---\nstatus: draft')).toBeLessThan(body.indexOf(`# ${title}`));
      expect(body).toContain('status: draft');
      expect(body).toContain('Body content here.');
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('creates note with frontmatter and tags after closing ---', () => {
    const title = uniqueTitle(TEST_PREFIX, 'CreateFMTags', RUN_ID);
    let noteId: string | undefined;

    try {
      const fm = '---\nstatus: active\n---';
      const text = `${fm}\nNote body.`;

      const createResult = callTool({
        toolName: 'bear-create-note',
        args: { title, text, tags: 'stest-frontmatter' },
      }).content[0].text;

      noteId = tryExtractNoteId(createResult) ?? undefined;
      expect(noteId).toBeDefined();

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { id: noteId! },
      }).content[0].text;

      const body = extractNoteBody(openResult);
      const fmEnd = body.indexOf('---\n', 4); // position of closing ---
      const tagPos = body.indexOf('#stest-frontmatter', fmEnd);
      // Tag must appear after the closing ---
      expect(tagPos).toBeGreaterThan(fmEnd);
      // Frontmatter must not be broken
      expect(body).toContain('status: active');
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('non-frontmatter text is unaffected (backward compat)', () => {
    const title = uniqueTitle(TEST_PREFIX, 'NoFM', RUN_ID);
    let noteId: string | undefined;

    try {
      const createResult = callTool({
        toolName: 'bear-create-note',
        args: { title, text: 'Plain body without frontmatter.', tags: 'stest-frontmatter' },
      }).content[0].text;

      noteId = tryExtractNoteId(createResult) ?? undefined;
      expect(noteId).toBeDefined();

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { id: noteId! },
      }).content[0].text;

      expect(openResult).toContain('Plain body without frontmatter.');
    } finally {
      if (noteId) trashNote(noteId);
    }
  });
});

describe('bear-add-tag on notes with YAML frontmatter', () => {
  it('inserts tags after closing --- without clobbering frontmatter', () => {
    const title = uniqueTitle(TEST_PREFIX, 'AddTagFM', RUN_ID);
    let noteId: string | undefined;

    try {
      const fm = '---\nstatus: draft\n---';
      const text = `${fm}\nContent below frontmatter.`;

      callTool({
        toolName: 'bear-create-note',
        args: { title, text },
      });

      // Find the note created above
      const searchResult = callTool({
        toolName: 'bear-search-notes',
        args: { term: title },
      }).content[0].text;

      noteId = tryExtractNoteId(searchResult) ?? undefined;
      expect(noteId).toBeDefined();

      const tag = `stest-fm-tag-${RUN_ID}`;
      const addTagResult = callTool({
        toolName: 'bear-add-tag',
        args: { id: noteId!, tags: JSON.stringify([tag]) },
      }).content[0].text;

      expect(addTagResult).toContain('added successfully');

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { id: noteId! },
      }).content[0].text;

      const body = extractNoteBody(openResult);
      // Frontmatter must still be intact
      expect(body).toContain('status: draft');
      // Tag must be present
      expect(body).toContain(`#${tag}`);
      // Tag must appear after the closing --- of frontmatter
      const fmClose = body.indexOf('---\n', 4);
      expect(body.indexOf(`#${tag}`, fmClose)).toBeGreaterThan(fmClose);
      // --- must still be line 1 (frontmatter not clobbered)
      expect(body.startsWith('---')).toBe(true);
    } finally {
      if (noteId) trashNote(noteId);
    }
  });
});

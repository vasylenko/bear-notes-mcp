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

  it('creates note with frontmatter and tags at the end by default', () => {
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
      const tagPos = body.indexOf('#stest-frontmatter');
      expect(tagPos).toBeGreaterThan(body.indexOf(`# ${title}`));
      expect(tagPos).toBeGreaterThan(body.indexOf('Note body.'));
      // Frontmatter must not be broken
      expect(body).toContain('status: active');
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('creates note with frontmatter and tags after title when convention is enabled', () => {
    const title = uniqueTitle(TEST_PREFIX, 'CreateFMTagsAfterTitle', RUN_ID);
    let noteId: string | undefined;

    try {
      const fm = '---\nstatus: active\n---';
      const text = `${fm}\nNote body.`;

      const createResult = callTool({
        toolName: 'bear-create-note',
        args: { title, text, tags: 'stest-frontmatter' },
        env: { UI_ENABLE_NEW_NOTE_CONVENTION: 'true' },
      }).content[0].text;

      noteId = tryExtractNoteId(createResult) ?? undefined;
      expect(noteId).toBeDefined();

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { id: noteId! },
      }).content[0].text;

      const body = extractNoteBody(openResult);
      const titlePos = body.indexOf(`# ${title}`);
      const tagPos = body.indexOf('#stest-frontmatter');
      expect(tagPos).toBeGreaterThan(titlePos);
      expect(tagPos).toBeLessThan(body.indexOf('Note body.'));
      expect(body).toContain(`# ${title}\n#stest-frontmatter\n---\nNote body.`);
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('creates note with frontmatter by merging into an existing tag line', () => {
    const title = uniqueTitle(TEST_PREFIX, 'CreateFMExistingTags', RUN_ID);
    let noteId: string | undefined;

    try {
      const fm = '---\nstatus: active\n---';
      const text = `${fm}\n#existing\nBody with existing tags.`;

      const createResult = callTool({
        toolName: 'bear-create-note',
        args: { title, text, tags: 'stest-frontmatter' },
        env: { UI_ENABLE_NEW_NOTE_CONVENTION: 'true' },
      }).content[0].text;

      noteId = tryExtractNoteId(createResult) ?? undefined;
      expect(noteId).toBeDefined();

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { id: noteId! },
      }).content[0].text;

      const body = extractNoteBody(openResult);
      expect(body).toContain(`# ${title}\n#existing #stest-frontmatter\nBody with existing tags.`);
      expect(body).not.toContain('#stest-frontmatter\n---\n');
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
  it('appends tags at the end by default without clobbering frontmatter', () => {
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
      // Tag must not appear between frontmatter and the title/body
      expect(body.indexOf(`#${tag}`)).toBeGreaterThan(body.indexOf('Content below frontmatter.'));
      // --- must still be line 1 (frontmatter not clobbered)
      expect(body.startsWith('---')).toBe(true);
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('inserts tags after title when convention is enabled without clobbering frontmatter', () => {
    const title = uniqueTitle(TEST_PREFIX, 'AddTagFMAfterTitle', RUN_ID);
    let noteId: string | undefined;

    try {
      const fm = '---\nstatus: draft\n---';
      const text = `${fm}\nContent below frontmatter.`;

      const createResult = callTool({
        toolName: 'bear-create-note',
        args: { title, text },
      }).content[0].text;

      noteId = tryExtractNoteId(createResult) ?? undefined;
      expect(noteId).toBeDefined();

      const tag = `stest-fm-tag-after-title-${RUN_ID}`;
      const addTagResult = callTool({
        toolName: 'bear-add-tag',
        args: { id: noteId!, tags: JSON.stringify([tag]) },
        env: { UI_ENABLE_NEW_NOTE_CONVENTION: 'true' },
      }).content[0].text;

      expect(addTagResult).toContain('added successfully');

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { id: noteId! },
      }).content[0].text;

      const body = extractNoteBody(openResult);
      const titlePos = body.indexOf(`# ${title}`);
      const tagPos = body.indexOf(`#${tag}`);
      expect(body.startsWith('---')).toBe(true);
      expect(tagPos).toBeGreaterThan(titlePos);
      expect(tagPos).toBeLessThan(body.indexOf('Content below frontmatter.'));
      expect(body).toContain(`# ${title}\n#${tag}\nContent below frontmatter.`);
      expect(body).not.toContain(`#${tag}\n---\n`);
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('merges tags into an existing tag line when convention is enabled', () => {
    const title = uniqueTitle(TEST_PREFIX, 'AddTagFMExistingTags', RUN_ID);
    let noteId: string | undefined;

    try {
      const fm = '---\nstatus: draft\n---';
      const text = `${fm}\n#existing\nContent below frontmatter.`;

      const createResult = callTool({
        toolName: 'bear-create-note',
        args: { title, text },
      }).content[0].text;

      noteId = tryExtractNoteId(createResult) ?? undefined;
      expect(noteId).toBeDefined();

      const tag = `stest-fm-tag-existing-${RUN_ID}`;
      const addTagResult = callTool({
        toolName: 'bear-add-tag',
        args: { id: noteId!, tags: JSON.stringify([tag]) },
        env: { UI_ENABLE_NEW_NOTE_CONVENTION: 'true' },
      }).content[0].text;

      expect(addTagResult).toContain('added successfully');

      const openResult = callTool({
        toolName: 'bear-open-note',
        args: { id: noteId! },
      }).content[0].text;

      const body = extractNoteBody(openResult);
      expect(body.startsWith('---')).toBe(true);
      expect(body).toContain(`# ${title}\n#existing #${tag}\nContent below frontmatter.`);
      expect(body).not.toContain(`#${tag}\n---\n`);
    } finally {
      if (noteId) trashNote(noteId);
    }
  });
});

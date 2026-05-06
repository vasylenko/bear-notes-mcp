import { afterAll, describe, expect, it } from 'vitest';

import {
  callTool,
  cleanupTestNotes,
  extractNoteBody,
  tryExtractNoteId,
  sleep,
  uniqueTitle,
} from './inspector.js';

const TEST_PREFIX = '[Bear-MCP-stest-replace-text]';
const RUN_ID = Date.now();
const PAUSE_AFTER_WRITE_OP = 100; // ms to wait after write operations for Bear to process changes as we don't catch the callback response in these tests to confirm completion

afterAll(() => {
  cleanupTestNotes(TEST_PREFIX);
});

describe('bear-replace-text via MCP Inspector CLI', () => {
  it('replaces full note content', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'Full Replace', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Original body content', tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    callTool({
      toolName: 'bear-replace-text',
      args: { id: noteId, scope: 'full-note-body', text: 'Completely new content' },
      env: { UI_ENABLE_CONTENT_REPLACEMENT: 'true' },
    });

    await sleep(PAUSE_AFTER_WRITE_OP);

    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { id: noteId },
    }).content[0].text;

    const noteBody = extractNoteBody(openResult);
    expect(noteBody).toContain('Completely new content');
    expect(noteBody).not.toContain('Original body content');

    // Bear's replace mode preserves the note title
    expect(openResult).toContain(title);
  });

  it('replaces only the targeted section under a header', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'Section Replace', RUN_ID);
    const sectionedText = [
      '## Introduction',
      'Original intro text',
      '',
      '## Details',
      'Original details text',
      '',
      '## Conclusion',
      'Original conclusion text',
    ].join('\n');

    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: sectionedText, tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    callTool({
      toolName: 'bear-replace-text',
      args: { id: noteId, scope: 'section', text: 'Updated details text', header: 'Details' },
      env: { UI_ENABLE_CONTENT_REPLACEMENT: 'true' },
    });

    await sleep(PAUSE_AFTER_WRITE_OP);

    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { id: noteId },
    }).content[0].text;

    const noteBody = extractNoteBody(openResult);
    expect(noteBody).toContain('Updated details text');
    // Other sections remain untouched
    expect(noteBody).toContain('Original intro text');
    expect(noteBody).toContain('Original conclusion text');
  });

  it('does not duplicate header when replacement text includes it', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'Header Dedup', RUN_ID);
    const sectionedText = [
      '## Introduction',
      'Intro text',
      '',
      '## Details',
      'Original details',
      '',
      '## Conclusion',
      'Conclusion text',
    ].join('\n');

    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: sectionedText, tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    // AI agents naturally include the header in replacement text — the server must strip it
    callTool({
      toolName: 'bear-replace-text',
      args: {
        id: noteId,
        scope: 'section',
        text: '## Details\nReplaced details content',
        header: 'Details',
      },
      env: { UI_ENABLE_CONTENT_REPLACEMENT: 'true' },
    });

    await sleep(PAUSE_AFTER_WRITE_OP);

    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { id: noteId },
    }).content[0].text;

    const noteBody = extractNoteBody(openResult);
    expect(noteBody).toContain('Replaced details content');
    // Header must appear exactly once — no duplication
    const detailsCount = (noteBody.match(/## Details/g) || []).length;
    expect(detailsCount).toBe(1);
    // Other sections remain untouched
    expect(noteBody).toContain('Intro text');
    expect(noteBody).toContain('Conclusion text');
    expect(noteBody).not.toContain('Original details');
  });

  it('returns error when targeting a non-existent header', () => {
    const title = uniqueTitle(TEST_PREFIX, 'Bad Header', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Some simple content', tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    const response = callTool({
      toolName: 'bear-replace-text',
      args: { id: noteId, scope: 'section', text: 'new content', header: 'NonExistentSection' },
      env: { UI_ENABLE_CONTENT_REPLACEMENT: 'true' },
    });

    expect(response.content[0].text).toContain('"NonExistentSection" not found');
    expect(response.isError).toBe(true);
  });

  it('does not duplicate title in full-body replace', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'Title Dedup', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Original body', tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    // AI agents naturally include the title heading — the server must strip it
    callTool({
      toolName: 'bear-replace-text',
      args: { id: noteId, scope: 'full-note-body', text: `# ${title}\nBrand new body content` },
      env: { UI_ENABLE_CONTENT_REPLACEMENT: 'true' },
    });

    await sleep(PAUSE_AFTER_WRITE_OP);

    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { id: noteId },
    }).content[0].text;

    const noteBody = extractNoteBody(openResult);
    expect(noteBody).toContain('Brand new body content');
    // Title must appear exactly once — no duplication
    const titleRegex = new RegExp(`# ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
    const titleCount = (noteBody.match(titleRegex) || []).length;
    expect(titleCount).toBe(1);
  });

  it('replaces only direct body content when section has sub-headers', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'Nested Sections', RUN_ID);

    // Mirrors issue #73: parent section with child sub-headers
    const originalText = [
      '## Execution Model',
      'Original body text',
      '',
      '### Progress tracking',
      'Tracking content here',
      '',
      '### Services',
      'Services content here',
      '',
      '## Other Section',
      'Other content',
    ].join('\n');

    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: originalText, tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    // Correct usage: replace only the direct body under the header, not sub-headers
    callTool({
      toolName: 'bear-replace-text',
      args: {
        id: noteId,
        scope: 'section',
        text: 'Updated body text',
        header: 'Execution Model',
      },
      env: { UI_ENABLE_CONTENT_REPLACEMENT: 'true' },
    });

    await sleep(PAUSE_AFTER_WRITE_OP);

    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { id: noteId },
    }).content[0].text;

    const noteBody = extractNoteBody(openResult);
    expect(noteBody).toContain('Updated body text');
    expect(noteBody).not.toContain('Original body text');
    // Sub-headers appear exactly once — no duplication (issue #73)
    const progressCount = (noteBody.match(/### Progress tracking/g) || []).length;
    expect(progressCount).toBe(1);
    const servicesCount = (noteBody.match(/### Services/g) || []).length;
    expect(servicesCount).toBe(1);
    expect(noteBody).toContain('Tracking content here');
    expect(noteBody).toContain('Services content here');
    expect(noteBody).toContain('Other content');
  });
});

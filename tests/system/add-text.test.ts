import { afterAll, describe, expect, it } from 'vitest';

import {
  callTool,
  cleanupTestNotes,
  extractNoteBody,
  sleep,
  tryExtractNoteId,
  uniqueTitle,
} from './inspector.js';

const TEST_PREFIX = '[Bear-MCP-stest-add-text]';
const RUN_ID = Date.now();
const PAUSE_AFTER_WRITE_OP = 100; // ms to wait after write operations for Bear to process changes

afterAll(() => {
  cleanupTestNotes(TEST_PREFIX);
});

describe('bear-add-text via MCP Inspector CLI', () => {
  it('prepends text to a note', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'Prepend', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Original content', tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    callTool({
      toolName: 'bear-add-text',
      args: { id: noteId, text: 'Prepended text', position: 'beginning' },
    });

    await sleep(PAUSE_AFTER_WRITE_OP);

    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { id: noteId },
    }).content[0].text;

    const noteBody = extractNoteBody(openResult);
    expect(noteBody).toContain('Original content');
    expect(noteBody).toContain('Prepended text');
  });

  it('appends text to a specific section via header', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'Append Header', RUN_ID);
    const sectionedText = [
      '## Notes',
      'Existing note text',
      '',
      '## Action Items',
      'Existing action items',
    ].join('\n');

    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: sectionedText, tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    callTool({
      toolName: 'bear-add-text',
      args: { id: noteId, text: 'New action item appended', header: 'Action Items' },
    });

    await sleep(PAUSE_AFTER_WRITE_OP);

    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { id: noteId },
    }).content[0].text;

    const noteBody = extractNoteBody(openResult);
    expect(noteBody).toContain('New action item appended');
    expect(noteBody).toContain('Existing note text');
  });

  it('appends text to a note by default', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'Append', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Original content', tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    callTool({
      toolName: 'bear-add-text',
      args: { id: noteId, text: 'Appended text' },
    });

    await sleep(PAUSE_AFTER_WRITE_OP);

    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { id: noteId },
    }).content[0].text;

    const noteBody = extractNoteBody(openResult);
    expect(noteBody).toContain('Original content');
    expect(noteBody).toContain('Appended text');
  });
});

import { afterAll, describe, expect, it } from 'vitest';

import {
  callTool,
  cleanupTestNotes,
  extractNoteBody,
  readNoteRevision,
  sleep,
  tryExtractNoteId,
  tryExtractRevision,
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

  it('emits Revision matching live Z_OPT after add-text (OCC inform)', async () => {
    // /add-text bumps ZSFNOTE.Z_OPT by +1 (empirically confirmed — see
    // docs/dev/BEAR_DATABASE_SCHEMA.md). awaitRevisionIncrement returns only
    // when Z_OPT !== baseline, so the response carries the post-write
    // revision captured directly from the live DB at poll time. Assertions
    // match the response against (a) the pre-write baseline (strictly
    // greater, proving the baseline wasn't echoed back) and (b) the current
    // live Z_OPT (proving the response value is fresh and matches reality).
    // A future Bear regression that stopped bumping would surface as a
    // tryExtractRevision null and fail loudly.
    const title = uniqueTitle(TEST_PREFIX, 'AddTextRevision', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Pre-write body for revision test', tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    // Wait for Bear's +2 recompute save before reading baseline (BEAR_DATABASE_SCHEMA.md).
    await sleep(PAUSE_AFTER_WRITE_OP);
    const preWriteRevision = readNoteRevision(noteId);
    expect(preWriteRevision).not.toBeNull();

    const result = callTool({
      toolName: 'bear-add-text',
      args: { id: noteId, text: 'Appended text for revision test' },
    }).content[0].text;

    const responseRevision = tryExtractRevision(result);
    expect(responseRevision).not.toBeNull();
    expect(responseRevision!).toBeGreaterThan(preWriteRevision!);

    const liveDbRevision = readNoteRevision(noteId);
    expect(responseRevision).toBe(liveDbRevision);
  });
});

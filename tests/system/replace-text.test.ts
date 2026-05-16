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

    // Let the create + first-edit-recompute settle before reading the live
    // revision the OCC enforce gate will compare against (see
    // docs/dev/BEAR_DATABASE_SCHEMA.md on the 1→3 jump).
    await sleep(PAUSE_AFTER_WRITE_OP);
    const liveRevision = readNoteRevision(noteId);
    expect(liveRevision).not.toBeNull();

    callTool({
      toolName: 'bear-replace-text',
      args: {
        id: noteId,
        scope: 'full-note-body',
        text: 'Completely new content',
        revision: liveRevision!,
      },
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

    await sleep(PAUSE_AFTER_WRITE_OP);
    const liveRevision = readNoteRevision(noteId);
    expect(liveRevision).not.toBeNull();

    callTool({
      toolName: 'bear-replace-text',
      args: {
        id: noteId,
        scope: 'section',
        text: 'Updated details text',
        header: 'Details',
        revision: liveRevision!,
      },
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

    await sleep(PAUSE_AFTER_WRITE_OP);
    const liveRevision = readNoteRevision(noteId);
    expect(liveRevision).not.toBeNull();

    // AI agents naturally include the header in replacement text — the server must strip it
    callTool({
      toolName: 'bear-replace-text',
      args: {
        id: noteId,
        scope: 'section',
        text: '## Details\nReplaced details content',
        header: 'Details',
        revision: liveRevision!,
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

  it('returns error when targeting a non-existent header', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'Bad Header', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Some simple content', tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    // Pass the live revision so the OCC gate is satisfied and the
    // section-existence check is the actual error the test asserts on
    // (the gate fires before the section-existence check by design).
    await sleep(PAUSE_AFTER_WRITE_OP);
    const liveRevision = readNoteRevision(noteId);
    expect(liveRevision).not.toBeNull();

    const response = callTool({
      toolName: 'bear-replace-text',
      args: {
        id: noteId,
        scope: 'section',
        text: 'new content',
        header: 'NonExistentSection',
        revision: liveRevision!,
      },
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

    await sleep(PAUSE_AFTER_WRITE_OP);
    const liveRevision = readNoteRevision(noteId);
    expect(liveRevision).not.toBeNull();

    // AI agents naturally include the title heading — the server must strip it
    callTool({
      toolName: 'bear-replace-text',
      args: {
        id: noteId,
        scope: 'full-note-body',
        text: `# ${title}\nBrand new body content`,
        revision: liveRevision!,
      },
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

    await sleep(PAUSE_AFTER_WRITE_OP);
    const liveRevision = readNoteRevision(noteId);
    expect(liveRevision).not.toBeNull();

    // Correct usage: replace only the direct body under the header, not sub-headers
    callTool({
      toolName: 'bear-replace-text',
      args: {
        id: noteId,
        scope: 'section',
        text: 'Updated body text',
        header: 'Execution Model',
        revision: liveRevision!,
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

  it('emits Revision matching live Z_OPT after replace-text (OCC inform)', async () => {
    // /add-text in replace mode bumps ZSFNOTE.Z_OPT by +1 (empirically
    // confirmed — see docs/dev/BEAR_DATABASE_SCHEMA.md). Response Revision
    // must (a) exceed the pre-write baseline (proving the baseline wasn't
    // echoed back) and (b) equal current live Z_OPT (proving freshness).
    const title = uniqueTitle(TEST_PREFIX, 'ReplaceTextRevision', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Pre-replace body for revision test', tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    // Wait for Bear's +2 recompute save before reading baseline (BEAR_DATABASE_SCHEMA.md).
    await sleep(PAUSE_AFTER_WRITE_OP);
    const preWriteRevision = readNoteRevision(noteId);
    expect(preWriteRevision).not.toBeNull();

    const result = callTool({
      toolName: 'bear-replace-text',
      args: {
        id: noteId,
        scope: 'full-note-body',
        text: 'Replaced body for revision test',
        revision: preWriteRevision!,
      },
      env: { UI_ENABLE_CONTENT_REPLACEMENT: 'true' },
    }).content[0].text;

    const responseRevision = tryExtractRevision(result);
    expect(responseRevision).not.toBeNull();
    expect(responseRevision!).toBeGreaterThan(preWriteRevision!);

    const liveDbRevision = readNoteRevision(noteId);
    expect(responseRevision).toBe(liveDbRevision);
  });

  it('rejects stale revision and instructs re-read without leaking live value (OCC enforce)', async () => {
    // The gate fires after the existence check, before the section-existence
    // check. The error message must direct the caller to re-read with
    // bear-open-note and must NOT contain the live revision — leaking it
    // would let an agent satisfy the gate without re-reading the body, which
    // defeats the safety property.
    const title = uniqueTitle(TEST_PREFIX, 'StaleRevision', RUN_ID);
    const sectionedText = ['## Foo', 'old content under foo'].join('\n');
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: sectionedText, tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    // Warm up the note's Z_OPT past 9 so the not.toContain(String(liveRevision))
    // assertion below isn't fooled by incidental single-digit substrings in
    // the error message.
    await sleep(PAUSE_AFTER_WRITE_OP);
    let currentRev = readNoteRevision(noteId);
    expect(currentRev).not.toBeNull();
    while (currentRev! < 10) {
      callTool({
        toolName: 'bear-add-text',
        args: {
          id: noteId,
          text: 'warmup',
          position: 'end',
          revision: currentRev!,
        },
        env: { UI_ENABLE_CONTENT_REPLACEMENT: 'true' },
      });
      await sleep(PAUSE_AFTER_WRITE_OP);
      currentRev = readNoteRevision(noteId);
      expect(currentRev).not.toBeNull();
    }
    expect(currentRev!).toBeGreaterThanOrEqual(10);

    // Capture R₁ (what the caller thinks the revision is).
    const r1 = currentRev!;

    // Simulate a concurrent edit bumping the note past R₁.
    callTool({
      toolName: 'bear-add-text',
      args: { id: noteId, text: 'competing edit', position: 'end', revision: r1 },
      env: { UI_ENABLE_CONTENT_REPLACEMENT: 'true' },
    });
    await sleep(PAUSE_AFTER_WRITE_OP);
    const r2 = readNoteRevision(noteId)!;
    expect(r2).toBeGreaterThan(r1);
    expect(r2).toBeGreaterThanOrEqual(10); // multi-digit guard for the assertion below

    // Now attempt bear-replace-text with stale R₁.
    const response = callTool({
      toolName: 'bear-replace-text',
      args: {
        id: noteId,
        scope: 'section',
        text: 'should be rejected',
        header: 'Foo',
        revision: r1,
      },
      env: { UI_ENABLE_CONTENT_REPLACEMENT: 'true' },
    });

    expect(response.isError).toBe(true);
    const errorText = response.content[0].text;
    expect(errorText).toContain('bear-open-note');
    // Regression guard: live revision must NOT appear in the error.
    expect(errorText).not.toContain(String(r2));

    // The rejected write must not have side-effected Bear: live revision
    // unchanged, and the Foo section's content is still the original.
    await sleep(PAUSE_AFTER_WRITE_OP);
    expect(readNoteRevision(noteId)).toBe(r2);
    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { id: noteId },
    }).content[0].text;
    const noteBody = extractNoteBody(openResult);
    expect(noteBody).toContain('old content under foo');
    expect(noteBody).not.toContain('should be rejected');
  });
});

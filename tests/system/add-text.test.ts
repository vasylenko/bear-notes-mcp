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

    // Wait for Bear's +2 recompute save before capturing the OCC revision.
    await sleep(PAUSE_AFTER_WRITE_OP);
    const revision = readNoteRevision(noteId)!;

    callTool({
      toolName: 'bear-add-text',
      args: { id: noteId, text: 'Prepended text', position: 'beginning', revision },
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

    await sleep(PAUSE_AFTER_WRITE_OP);
    const revision = readNoteRevision(noteId)!;

    callTool({
      toolName: 'bear-add-text',
      args: {
        id: noteId,
        text: 'New action item appended',
        header: 'Action Items',
        revision,
      },
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

    await sleep(PAUSE_AFTER_WRITE_OP);
    const revision = readNoteRevision(noteId)!;

    callTool({
      toolName: 'bear-add-text',
      args: { id: noteId, text: 'Appended text', revision },
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
      args: {
        id: noteId,
        text: 'Appended text for revision test',
        revision: preWriteRevision!,
      },
    }).content[0].text;

    const responseRevision = tryExtractRevision(result);
    expect(responseRevision).not.toBeNull();
    expect(responseRevision!).toBeGreaterThan(preWriteRevision!);

    const liveDbRevision = readNoteRevision(noteId);
    expect(responseRevision).toBe(liveDbRevision);
  });
});

describe('bear-add-text OCC enforce', () => {
  it('rejects a stale revision without mutating the note', async () => {
    // SVA-22 — the gate must (a) reject when the caller's revision doesn't
    // match the live Z_OPT, (b) point the caller at bear-open-note as the
    // recovery path, (c) NOT leak the live revision (leaking would let an
    // agent satisfy the gate without re-reading the body), and (d) not bump
    // Z_OPT (no observable side effect in Bear).
    const title = uniqueTitle(TEST_PREFIX, 'StaleReject', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Stale-revision test body', tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    // Warm-up: push Z_OPT past 9 so the live revision used below is multi-digit.
    // Two reasons: (1) skips the Z_OPT 1→3 jump after first edit, and
    // (2) makes the not.toContain(String(R2)) guard robust against incidental
    // single-digit substrings in the error message. Each iteration uses the
    // current live revision so the gate passes for the warm-up writes.
    await sleep(PAUSE_AFTER_WRITE_OP);
    while ((readNoteRevision(noteId) ?? 0) < 10) {
      const currentRevision = readNoteRevision(noteId)!;
      callTool({
        toolName: 'bear-add-text',
        args: { id: noteId, text: 'warm', revision: currentRevision },
      });
      await sleep(PAUSE_AFTER_WRITE_OP);
    }

    // Snapshot R1 from a real bear-open-note response (the path a real
    // caller would take to get the revision).
    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { id: noteId },
    }).content[0].text;
    const r1 = tryExtractRevision(openResult);
    expect(r1).not.toBeNull();
    expect(readNoteRevision(noteId)).toBe(r1);

    // Competing write — bumps live revision to R2 > R1, while the caller
    // still holds R1 in its cached view.
    const competingResult = callTool({
      toolName: 'bear-add-text',
      args: { id: noteId, text: 'competing write', revision: r1! },
    }).content[0].text;
    const r2 = tryExtractRevision(competingResult);
    expect(r2).not.toBeNull();
    expect(r2!).toBeGreaterThan(r1!);
    expect(r2!).toBeGreaterThanOrEqual(10); // multi-digit, see comment above.
    await sleep(PAUSE_AFTER_WRITE_OP);
    expect(readNoteRevision(noteId)).toBe(r2);

    // Stale write — caller still believes the note is at R1.
    const staleResponse = callTool({
      toolName: 'bear-add-text',
      args: {
        id: noteId,
        text: 'should be rejected',
        position: 'end',
        revision: r1!,
      },
    });

    expect(staleResponse.isError).toBe(true);
    const errorText = staleResponse.content[0].text;
    expect(errorText).toContain('bear-open-note');
    // Live revision must NOT appear in the message: leaking it would let an
    // agent satisfy the gate without re-reading the body.
    expect(errorText).not.toContain(String(r2));

    // No side effect — Z_OPT unchanged, body not touched by the rejected write.
    await sleep(PAUSE_AFTER_WRITE_OP);
    expect(readNoteRevision(noteId)).toBe(r2);
    const finalBody = extractNoteBody(
      callTool({ toolName: 'bear-open-note', args: { id: noteId } }).content[0].text
    );
    expect(finalBody).not.toContain('should be rejected');
  });
});

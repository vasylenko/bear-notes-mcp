import { afterAll, describe, expect, it } from 'vitest';

import {
  callTool,
  cleanupTestNotes,
  readNoteRevision,
  sleep,
  tryExtractNoteId,
  tryExtractRevision,
  uniqueTitle,
} from './inspector.js';

const TEST_PREFIX = '[Bear-MCP-stest-add-tag]';
const RUN_ID = Date.now();

afterAll(() => {
  cleanupTestNotes(TEST_PREFIX);
});

describe('bear-add-tag via MCP Inspector CLI', () => {
  it('adds tags to a note and returns each tag plus note metadata in the response', () => {
    const title = uniqueTitle(TEST_PREFIX, 'AddTags', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Add tag test note', tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;
    // Two tags exercise the array iteration in the handler — single-tag is a degenerate case of this
    const tags = [`stest-add-tag-${RUN_ID}-a`, `stest-add-tag-${RUN_ID}-b`];

    const result = callTool({
      toolName: 'bear-add-tag',
      args: { id: noteId, tags: JSON.stringify(tags) },
    }).content[0].text;

    expect(result).toContain('added successfully');
    expect(result).toContain(title);
    expect(result).toContain(noteId);
    for (const tag of tags) {
      expect(result).toContain(`#${tag}`);
    }
  });

  it('returns error for non-existent note ID', () => {
    const response = callTool({
      toolName: 'bear-add-tag',
      args: { id: '00000000-0000-0000-0000-000000000000', tags: '["bogus"]' },
    });

    expect(response.content[0].text).toContain('not found');
    expect(response.isError).toBe(true);
  });

  it('emits Revision matching live Z_OPT after add-tag (OCC inform)', async () => {
    // /add-text with a `tags` param bumps ZSFNOTE.Z_OPT by +1 (empirically
    // confirmed — see docs/dev/BEAR_DATABASE_SCHEMA.md; the separate /add-tags
    // URL does NOT bump per SVA-20). awaitRevisionIncrement returns only when
    // Z_OPT !== baseline, so the response carries the post-write revision
    // captured directly from the live DB at poll time — assertions match it
    // against (a) the pre-write baseline (strictly greater, proving the
    // baseline wasn't echoed back) and (b) the current live Z_OPT (proving
    // the response value is fresh and matches reality). A future Bear
    // regression that stopped bumping would surface as a tryExtractRevision
    // null and fail the toBe(liveDbRevision) assertion loudly.
    const title = uniqueTitle(TEST_PREFIX, 'AddTagRevision', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Pre-tag body for revision test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    // Settle briefly so create's subtitle/index recompute save lands before
    // we read the baseline (otherwise Z_OPT can still jump +2 between baseline
    // and the handler's pre-flight read — see BEAR_DATABASE_SCHEMA.md).
    await sleep(100);
    const preAddRevision = readNoteRevision(noteId);
    expect(preAddRevision).not.toBeNull();

    const result = callTool({
      toolName: 'bear-add-tag',
      args: { id: noteId, tags: JSON.stringify([`stest-rev-${RUN_ID}`]) },
    }).content[0].text;

    const responseRevision = tryExtractRevision(result);
    expect(responseRevision).not.toBeNull();
    expect(responseRevision!).toBeGreaterThan(preAddRevision!);

    const liveDbRevision = readNoteRevision(noteId);
    expect(responseRevision).toBe(liveDbRevision);
  });
});

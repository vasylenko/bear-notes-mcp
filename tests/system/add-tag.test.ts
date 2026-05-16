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
const PAUSE_AFTER_WRITE_OP = 100; // ms to wait after write operations for Bear to process changes

afterAll(() => {
  cleanupTestNotes(TEST_PREFIX);
});

describe('bear-add-tag via MCP Inspector CLI', () => {
  it('adds tags to a note and returns each tag plus note metadata in the response', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'AddTags', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Add tag test note', tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;
    // Wait for Bear's +2 recompute save before reading revision — the OCC enforce
    // gate (SVA-22) rejects writes whose revision doesn't match live Z_OPT, so
    // reading too early returns the stale pre-recompute value and the gate fires.
    await sleep(PAUSE_AFTER_WRITE_OP);
    const revision = readNoteRevision(noteId);
    expect(revision).not.toBeNull();
    // Two tags exercise the array iteration in the handler — single-tag is a degenerate case of this
    const tags = [`stest-add-tag-${RUN_ID}-a`, `stest-add-tag-${RUN_ID}-b`];

    const result = callTool({
      toolName: 'bear-add-tag',
      args: { id: noteId, tags: JSON.stringify(tags), revision: String(revision!) },
    }).content[0].text;

    expect(result).toContain('added successfully');
    expect(result).toContain(title);
    expect(result).toContain(noteId);
    for (const tag of tags) {
      expect(result).toContain(`#${tag}`);
    }
  });

  it('returns error for non-existent note ID', () => {
    // Any revision value satisfies the schema; the not-found branch fires inside
    // the handler before the revision gate is reached, so this test still
    // verifies the existence-check path post-SVA-22.
    const response = callTool({
      toolName: 'bear-add-tag',
      args: {
        id: '00000000-0000-0000-0000-000000000000',
        tags: '["bogus"]',
        revision: '0',
      },
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

    // Wait for Bear's +2 recompute save before reading baseline (BEAR_DATABASE_SCHEMA.md).
    await sleep(PAUSE_AFTER_WRITE_OP);
    const preAddRevision = readNoteRevision(noteId);
    expect(preAddRevision).not.toBeNull();

    const result = callTool({
      toolName: 'bear-add-tag',
      args: {
        id: noteId,
        tags: JSON.stringify([`stest-rev-${RUN_ID}`]),
        revision: String(preAddRevision!),
      },
    }).content[0].text;

    const responseRevision = tryExtractRevision(result);
    expect(responseRevision).not.toBeNull();
    expect(responseRevision!).toBeGreaterThan(preAddRevision!);

    const liveDbRevision = readNoteRevision(noteId);
    expect(responseRevision).toBe(liveDbRevision);
  });
});

describe('bear-add-tag OCC enforce', () => {
  it('rejects a stale revision, does not leak the live value, and leaves the note unchanged', async () => {
    // OCC enforce contract (SVA-22): when the caller's revision doesn't match
    // live Z_OPT, the write is rejected as a soft error with a re-read
    // instruction (mentioning bear-open-note) and the error message must NOT
    // include the live revision — returning it would let an agent satisfy
    // the gate without re-reading the body, defeating the safety property.
    const title = uniqueTitle(TEST_PREFIX, 'AddTagStaleRev', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Stale-revision test note' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    // Warm-up writes bump live Z_OPT past 9 so the assertion that the error
    // message does NOT contain String(R₂) isn't fooled by an incidental single
    // digit in the wording. Also dodges the 1→3 first-edit-after-creation
    // jump documented in BEAR_DATABASE_SCHEMA.md.
    //
    // Each iteration sleeps then re-reads live Z_OPT so Bear's async +2
    // recompute can settle before the next iteration's write — the gate the
    // test is about to exercise would otherwise reject the next warm-up
    // call when the previous response revision is stale relative to live DB.
    await sleep(PAUSE_AFTER_WRITE_OP);
    let currentRev = readNoteRevision(noteId);
    expect(currentRev).not.toBeNull();
    while (currentRev! < 10) {
      callTool({
        toolName: 'bear-add-text',
        args: { id: noteId, text: 'warmup', revision: String(currentRev!) },
      });
      await sleep(PAUSE_AFTER_WRITE_OP);
      currentRev = readNoteRevision(noteId);
      expect(currentRev).not.toBeNull();
    }

    // Capture R₁ — the caller's view of the note's revision.
    const r1 = currentRev;
    expect(r1!).toBeGreaterThanOrEqual(10);

    // Bump live to R₂ via a competing write (uses R₁, which is still fresh
    // at this instant, so the write succeeds).
    callTool({
      toolName: 'bear-add-text',
      args: { id: noteId, text: 'competing', revision: String(r1!) },
    });
    await sleep(PAUSE_AFTER_WRITE_OP);
    const r2 = readNoteRevision(noteId);
    expect(r2).not.toBeNull();
    expect(r2!).toBeGreaterThan(r1!);
    expect(String(r2!).length).toBeGreaterThanOrEqual(2);

    // Submit bear-add-tag with the now-stale R₁. The gate must reject.
    const staleResp = callTool({
      toolName: 'bear-add-tag',
      args: {
        id: noteId,
        tags: JSON.stringify([`stest-stale-${RUN_ID}`]),
        revision: String(r1!),
      },
    });

    expect(staleResp.isError).toBe(true);
    expect(staleResp.content[0].text).toContain('bear-open-note');
    // Load-bearing regression guard: the live revision must not appear in the
    // message. If a future change inlines it (e.g. "the note is at N"), this
    // assertion catches it before the leak ships.
    expect(staleResp.content[0].text).not.toContain(String(r2!));

    // The rejected write must not have side-effected Bear — live revision
    // is unchanged from R₂.
    expect(readNoteRevision(noteId)).toBe(r2);
  });
});

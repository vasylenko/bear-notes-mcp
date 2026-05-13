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

  it('emits Revision honestly after add-tag (OCC inform)', async () => {
    // /add-text with a `tags` param bumps ZSFNOTE.Z_OPT by +1 (empirically
    // confirmed — see docs/dev/BEAR_DATABASE_SCHEMA.md; the separate /add-tags
    // URL does NOT bump per SVA-20). The disjunction (numeric revision OR
    // timeout sentence) stays for forward-compat against a future Bear
    // regression that stops bumping.
    const title = uniqueTitle(TEST_PREFIX, 'AddTagRevision', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Pre-tag body for revision test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    // Settle briefly so create propagates before reading baseline.
    await sleep(100);
    const preAddRevision = readNoteRevision(noteId);
    expect(preAddRevision).not.toBeNull();

    const result = callTool({
      toolName: 'bear-add-tag',
      args: { id: noteId, tags: JSON.stringify([`stest-rev-${RUN_ID}`]) },
    }).content[0].text;

    const containsTimeoutSentence = result.includes('Revision: unknown');
    const responseRevision = tryExtractRevision(result);

    expect(
      containsTimeoutSentence || responseRevision !== null,
      `Expected a numeric Revision or the timeout sentence, got:\n${result}`
    ).toBe(true);

    if (responseRevision !== null) {
      // Bump branch: must be >= pre-add value (strictly greater on bump, equal
      // if Bear's /add-text returns the same Z_OPT for the tags-only call shape).
      expect(responseRevision).toBeGreaterThanOrEqual(preAddRevision!);
    }
  });
});

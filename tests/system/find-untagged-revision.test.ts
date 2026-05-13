import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  callTool,
  cleanupTestNotes,
  readNoteRevision,
  tryExtractNoteId,
  uniqueTitle,
} from './inspector.js';

const TEST_PREFIX = '[Bear-MCP-stest-untagged-rev]';
const RUN_ID = Date.now();

// One untagged note is sufficient to exercise the per-result Revision wiring.
// Bear's broader untagged inventory may include many other notes, so the test
// scopes its assertions to the specific note it just created — extract its id,
// then locate that id's result block in the response.
const TITLE_UNTAGGED = uniqueTitle(TEST_PREFIX, 'Untagged', RUN_ID);
let untaggedId: string;

beforeAll(() => {
  const createResult = callTool({
    toolName: 'bear-create-note',
    args: { title: TITLE_UNTAGGED, text: 'Untagged body — no tags arg passed.' },
  }).content[0].text;
  untaggedId = tryExtractNoteId(createResult)!;
});

afterAll(() => {
  cleanupTestNotes(TEST_PREFIX);
});

describe('bear-find-untagged-notes Revision wiring', () => {
  it('per-result Revision matches live Z_OPT (OCC inform)', () => {
    const result = callTool({
      toolName: 'bear-find-untagged-notes',
      args: { limit: '250' },
    }).content[0].text;

    // The response may include many other untagged notes from the user's library.
    // Find the block containing our specific note's ID, then extract the Revision
    // line that follows it. Anchoring on the ID keeps the test deterministic in
    // libraries that have unrelated untagged notes.
    const blockRegex = new RegExp(`ID:\\s+${untaggedId}\\s*\\n\\s*Revision:\\s+(\\d+)`);
    const match = result.match(blockRegex);
    expect(match).toBeTruthy();
    const responseRevision = parseInt(match![1], 10);

    const dbRevision = readNoteRevision(untaggedId);
    expect(dbRevision).not.toBeNull();
    expect(responseRevision).toBe(dbRevision);
  });
});

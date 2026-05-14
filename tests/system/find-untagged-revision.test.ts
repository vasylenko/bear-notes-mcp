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

// Test scopes assertions to its own note ID since the user's library may hold
// many other untagged notes that would otherwise be in the result.
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

    // Anchor on the test's ID — other untagged notes in the library are noise.
    const blockRegex = new RegExp(`ID:\\s+${untaggedId}\\s*\\n\\s*Revision:\\s+(\\d+)`);
    const match = result.match(blockRegex);
    expect(match).toBeTruthy();
    const responseRevision = parseInt(match![1], 10);

    const dbRevision = readNoteRevision(untaggedId);
    expect(dbRevision).not.toBeNull();
    expect(responseRevision).toBe(dbRevision);
  });
});

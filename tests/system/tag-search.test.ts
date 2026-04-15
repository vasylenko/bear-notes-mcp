import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { callTool, cleanupTestNotes, findNoteId, trashNote, uniqueTitle } from './inspector.js';

const TEST_PREFIX = '[Bear-MCP-stest-tag-search]';
const RUN_ID = Date.now();

// Tag names reference issue #67 (false-positive tag matching).
// TAG_BASE is the "parent" tag; TAG_NESTED is a child; TAG_SIMILAR has the parent as a prefix.
const TAG_BASE = `stest67-${RUN_ID}`;
const TAG_NESTED = `${TAG_BASE}/child`;
const TAG_SIMILAR = `${TAG_BASE}plus`;

function title(label: string): string {
  return uniqueTitle(TEST_PREFIX, label, RUN_ID);
}

// Titles are deterministic per run — used to verify search result presence/absence.
const TITLE_EXACT = title('Exact');
const TITLE_NESTED = title('Nested');
const TITLE_SIMILAR = title('Similar');

const noteIds: string[] = [];

beforeAll(() => {
  // Create three notes with distinct tag relationships:
  // "Exact" — tagged with TAG_BASE only
  // "Nested" — tagged with TAG_NESTED (child of TAG_BASE)
  // "Similar" — tagged with TAG_SIMILAR (prefix overlap, NOT a child)
  for (const { noteTitle, tag } of [
    { noteTitle: TITLE_EXACT, tag: TAG_BASE },
    { noteTitle: TITLE_NESTED, tag: TAG_NESTED },
    { noteTitle: TITLE_SIMILAR, tag: TAG_SIMILAR },
  ]) {
    callTool({ toolName: 'bear-create-note', args: { title: noteTitle, tags: tag } });
    noteIds.push(findNoteId(noteTitle));
  }
});

afterAll(() => {
  for (const id of noteIds) {
    trashNote(id);
  }
  cleanupTestNotes(TEST_PREFIX);
});

describe('tag search via MCP Inspector CLI', () => {
  it('exact tag returns the matching note', () => {
    const result = callTool({
      toolName: 'bear-search-notes',
      args: { tag: TAG_BASE },
    }).content[0].text;

    expect(result).toContain(TITLE_EXACT);
  });

  it('parent tag search includes notes with nested child tags', () => {
    const result = callTool({
      toolName: 'bear-search-notes',
      args: { tag: TAG_BASE },
    }).content[0].text;

    expect(result).toContain(TITLE_NESTED);
  });

  it('parent tag search excludes notes whose tag merely shares a prefix', () => {
    const result = callTool({
      toolName: 'bear-search-notes',
      args: { tag: TAG_BASE },
    }).content[0].text;

    // TAG_SIMILAR ("stest67-...plus") is a different tag, not a child of TAG_BASE
    expect(result).not.toContain(TITLE_SIMILAR);
  });

  it('nested tag search returns only the nested-tagged note', () => {
    const result = callTool({
      toolName: 'bear-search-notes',
      args: { tag: TAG_NESTED },
    }).content[0].text;

    expect(result).toContain(TITLE_NESTED);
    expect(result).not.toContain(TITLE_EXACT);
    expect(result).not.toContain(TITLE_SIMILAR);
  });

  it('similar tag search returns only the similar-tagged note', () => {
    const result = callTool({
      toolName: 'bear-search-notes',
      args: { tag: TAG_SIMILAR },
    }).content[0].text;

    expect(result).toContain(TITLE_SIMILAR);
    expect(result).not.toContain(TITLE_EXACT);
    expect(result).not.toContain(TITLE_NESTED);
  });

  it('search results include decoded tag names', () => {
    const result = callTool({
      toolName: 'bear-search-notes',
      args: { tag: TAG_BASE },
    }).content[0].text;

    // Verify the Tags: line exists and contains decoded tag names.
    // Bear auto-assigns parent tags to nested-tagged notes, so the "Nested" note
    // has both TAG_BASE and TAG_NESTED — match each tag independently.
    expect(result).toContain('Tags:');
    expect(result).toContain(TAG_BASE);
    expect(result).toContain(TAG_NESTED);
  });
});

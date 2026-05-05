import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { callTool, cleanupTestNotes, tryExtractNoteId, sleep, uniqueTitle } from './inspector.js';

const TEST_PREFIX = '[Bear-MCP-stest-tag-mgmt]';
const RUN_ID = Date.now();
const PAUSE_AFTER_WRITE_OP = 100; // ms to wait after write operations for Bear to process changes

const TAG_ORIGINAL = `stest-tag-mgmt-${RUN_ID}-original`;
const TAG_RENAMED = `stest-tag-mgmt-${RUN_ID}-renamed`;
const TAG_TO_DELETE = `stest-tag-mgmt-${RUN_ID}-to-delete`;

const TAG_NESTED_ORIGINAL = `stest-tag-mgmt-${RUN_ID}/nested-original`;
const TAG_NESTED_RENAMED = `stest-tag-mgmt-${RUN_ID}/nested-renamed`;
const TAG_NESTED_TO_DELETE = `stest-tag-mgmt-${RUN_ID}/nested-to-delete`;

afterAll(() => {
  cleanupTestNotes(TEST_PREFIX);
});

describe('bear-rename-tag via MCP Inspector CLI', () => {
  const RENAME_NOTE_TITLE = uniqueTitle(TEST_PREFIX, 'Rename', RUN_ID);

  beforeAll(() => {
    callTool({
      toolName: 'bear-create-note',
      args: { title: RENAME_NOTE_TITLE, text: 'Rename tag test note', tags: TAG_ORIGINAL },
    });
  });

  it('renames a tag across notes — note moves to new tag, old tag returns no results', async () => {
    const result = callTool({
      toolName: 'bear-rename-tag',
      args: { name: TAG_ORIGINAL, new_name: TAG_RENAMED },
    }).content[0].text;

    expect(result).toContain('renamed successfully');

    await sleep(PAUSE_AFTER_WRITE_OP);

    // New tag finds the note
    const newTagResult = callTool({
      toolName: 'bear-search-notes',
      args: { tag: TAG_RENAMED },
    }).content[0].text;
    expect(newTagResult).toContain(RENAME_NOTE_TITLE);

    // Old tag returns no notes
    const oldTagResult = callTool({
      toolName: 'bear-search-notes',
      args: { tag: TAG_ORIGINAL },
    }).content[0].text;
    expect(oldTagResult).toContain('No notes found');
  });
});

describe('bear-delete-tag via MCP Inspector CLI', () => {
  const DELETE_NOTE_TITLE = uniqueTitle(TEST_PREFIX, 'Delete', RUN_ID);
  let deleteNoteId: string | undefined;

  beforeAll(() => {
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title: DELETE_NOTE_TITLE, text: 'Delete tag test note', tags: TAG_TO_DELETE },
    }).content[0].text;
    deleteNoteId = tryExtractNoteId(createResult)!;
  });

  it('removes a tag without affecting the note', async () => {
    const result = callTool({
      toolName: 'bear-delete-tag',
      args: { name: TAG_TO_DELETE },
    }).content[0].text;

    expect(result).toContain('deleted successfully');

    await sleep(PAUSE_AFTER_WRITE_OP);

    const searchResult = callTool({
      toolName: 'bear-search-notes',
      args: { tag: TAG_TO_DELETE },
    }).content[0].text;

    expect(searchResult).toContain('No notes found');

    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { id: deleteNoteId! },
    }).content[0].text;

    expect(openResult).toContain(DELETE_NOTE_TITLE);
  });
});

// Slashes in tag names encode as %2F in URLs — exercises a different code path than flat tags
describe('hierarchical tag rename via MCP Inspector CLI', () => {
  const NESTED_RENAME_TITLE = uniqueTitle(TEST_PREFIX, 'NestedRename', RUN_ID);

  beforeAll(() => {
    callTool({
      toolName: 'bear-create-note',
      args: {
        title: NESTED_RENAME_TITLE,
        text: 'Hierarchical rename test',
        tags: TAG_NESTED_ORIGINAL,
      },
    });
  });

  it('renames a hierarchical tag', async () => {
    const result = callTool({
      toolName: 'bear-rename-tag',
      args: { name: TAG_NESTED_ORIGINAL, new_name: TAG_NESTED_RENAMED },
    }).content[0].text;

    expect(result).toContain('renamed successfully');

    await sleep(PAUSE_AFTER_WRITE_OP);

    const searchResult = callTool({
      toolName: 'bear-search-notes',
      args: { tag: TAG_NESTED_RENAMED },
    }).content[0].text;

    expect(searchResult).toContain(NESTED_RENAME_TITLE);
  });
});

describe('hierarchical tag delete via MCP Inspector CLI', () => {
  const NESTED_DELETE_TITLE = uniqueTitle(TEST_PREFIX, 'NestedDelete', RUN_ID);
  let nestedDeleteNoteId: string | undefined;

  beforeAll(() => {
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: {
        title: NESTED_DELETE_TITLE,
        text: 'Hierarchical delete test',
        tags: TAG_NESTED_TO_DELETE,
      },
    }).content[0].text;
    nestedDeleteNoteId = tryExtractNoteId(createResult)!;
  });

  it('deletes a hierarchical tag without affecting the note', async () => {
    const result = callTool({
      toolName: 'bear-delete-tag',
      args: { name: TAG_NESTED_TO_DELETE },
    }).content[0].text;

    expect(result).toContain('deleted successfully');

    await sleep(PAUSE_AFTER_WRITE_OP);

    const searchResult = callTool({
      toolName: 'bear-search-notes',
      args: { tag: TAG_NESTED_TO_DELETE },
    }).content[0].text;

    expect(searchResult).toContain('No notes found');

    const openResult = callTool({
      toolName: 'bear-open-note',
      args: { id: nestedDeleteNoteId! },
    }).content[0].text;

    expect(openResult).toContain(NESTED_DELETE_TITLE);
  });
});

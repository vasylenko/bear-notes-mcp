import { afterAll, describe, expect, it } from 'vitest';

import { callTool, pollUntil, trashNote, tryExtractNoteId } from './inspector.js';

const RUN_ID = Date.now();
const TAG = `stest-grab-url-${RUN_ID}`;

afterAll(() => {
  // Tag-based cleanup: grab-url notes have titles from the web page, not from us,
  // so prefix-based cleanupTestNotes() cannot find them
  try {
    const searchResult = callTool({
      toolName: 'bear-search-notes',
      args: { tag: TAG },
    }).content[0].text;
    const idMatches = searchResult.matchAll(/ID:\s+([A-Fa-f0-9-]+)/g);
    for (const match of idMatches) {
      trashNote(match[1]);
    }
  } catch {
    // Best-effort
  }
});

describe('bear-grab-url via MCP Inspector CLI', () => {
  it('grabs a URL and creates a note with tags', async () => {
    let noteId: string | undefined;

    try {
      const result = callTool({
        toolName: 'bear-grab-url',
        args: { url: 'https://example.com', tags: TAG },
      }).content[0].text;

      expect(result).toContain('Web page grab request sent to Bear!');
      expect(result).toContain('https://example.com');
      expect(result).toContain(TAG);

      // Poll until Bear finishes fetching the page and the note appears
      const searchResponse = await pollUntil(
        () => callTool({ toolName: 'bear-search-notes', args: { tag: TAG } }),
        (r) => tryExtractNoteId(r.content[0].text) !== null,
        { timeoutMs: 10_000, label: `note with tag "${TAG}" after grab-url` }
      );

      noteId = tryExtractNoteId(searchResponse.content[0].text) ?? undefined;
      expect(noteId, `Expected a note with tag "${TAG}" after grab-url`).toBeDefined();

      // Verify the note has content from the page
      const noteContent = callTool({
        toolName: 'bear-open-note',
        args: { id: noteId! },
      }).content[0].text;

      expect(noteContent).toContain('Example Domain');
    } finally {
      if (noteId) trashNote(noteId);
    }
  });
});

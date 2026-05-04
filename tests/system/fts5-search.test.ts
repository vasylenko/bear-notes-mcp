import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  callTool,
  cleanupTestNotes,
  findNoteId,
  trashNote,
  uniqueTitle,
  waitForFileContent,
} from './inspector.js';

const TEST_PREFIX = '[Bear-MCP-stest-fts5]';
const RUN_ID = Date.now();

function title(label: string): string {
  return uniqueTitle(TEST_PREFIX, label, RUN_ID);
}

const OCR_JPG_BASE64 = readFileSync(
  resolve(import.meta.dirname, '../fixtures/ocr-text.jpg')
).toString('base64');

const noteIds: string[] = [];

beforeAll(async () => {
  // OCR fixture: Bear's OCR engine is the only path that populates ZSEARCHTEXT
  // from real attachments. Unit tests fixture OCR strings into the index
  // directly; this is the only suite that exercises Bear's actual OCR pipeline
  // ending up in the FTS5 corpus.
  callTool({
    toolName: 'bear-create-note',
    args: { title: title('OCR'), text: 'A note with an attached image.' },
  });
  const ocrNoteId = findNoteId(title('OCR'));
  noteIds.push(ocrNoteId);
  callTool({
    toolName: 'bear-add-file',
    args: { id: ocrNoteId, filename: 'ocr-text.jpg', base64_content: OCR_JPG_BASE64 },
  });
  await waitForFileContent(ocrNoteId, 'simple');
}, 180_000);

afterAll(() => {
  for (const id of noteIds) {
    trashNote(id);
  }
  cleanupTestNotes(TEST_PREFIX);
}, 60_000);

describe('bear-search-notes via FTS5', () => {
  it('OCR-extracted text from attached images is searchable via the same tool', () => {
    const result = callTool({
      toolName: 'bear-search-notes',
      args: { term: 'simple' },
    }).content[0].text;

    expect(result).toContain(title('OCR'));
  });

  it('malformed FTS5 query returns a structured error with operator hint', () => {
    // Exercises the soft-error response path through the tool layer — unit
    // tests cover the throw inside executeQuery; this proves the tool wrapper
    // surfaces it as isError: true with the operator hint.
    const response = callTool({
      toolName: 'bear-search-notes',
      args: { term: '"unbalanced' },
    });

    expect(response.isError).toBe(true);
    const errorText = response.content[0].text;
    expect(errorText).toContain('Search query syntax error');
    expect(errorText).toContain('Supported operators');
  });
});

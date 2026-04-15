import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  callTool,
  cleanupTestNotes,
  extractNoteBody,
  findNoteId,
  sleep,
  trashNote,
  uniqueTitle,
  waitForFileContent,
} from './inspector.js';

const TEST_PREFIX = '[Bear-MCP-stest-attached-files]';
const RUN_ID = Date.now();
const PAUSE_AFTER_WRITE_OP = 100;
// Realistic note body shared across tests — validates structural integrity, not just a single word
const SAMPLE_NOTE_BODY = readFileSync(
  resolve(import.meta.dirname, '../fixtures/sample-note.md'),
  'utf-8'
);
// 262x400 JPEG with bold "make it simple" text — Bear can OCR this
const OCR_JPG_BASE64 = readFileSync(
  resolve(import.meta.dirname, '../fixtures/ocr-text.jpg')
).toString('base64');

// HTML file — Bear cannot OCR this file type
const HTML_BASE64 = 'PGh0bWw+PGJvZHk+PHA+QmVhciBjYW5ub3QgT0NSIHRoaXM8L3A+PC9ib2R5PjwvaHRtbD4K';

// Minimal 1x1 transparent PNG (67 bytes) — used for corruption test where OCR content doesn't matter
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Absolute path to fixture — used for file_path tests
const OCR_JPG_PATH = resolve(import.meta.dirname, '../fixtures/ocr-text.jpg');

afterAll(() => {
  cleanupTestNotes(TEST_PREFIX);
});

describe('attached files content separation', () => {
  it('note with attachment returns file content in a separate content block', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'With File', RUN_ID);
    let noteId: string | undefined;

    try {
      callTool({
        toolName: 'bear-create-note',
        args: { title, text: 'Note body text here', tags: 'system-test' },
      });

      noteId = findNoteId(title);

      callTool({
        toolName: 'bear-add-file',
        args: {
          id: noteId,
          filename: 'ocr-text.jpg',
          base64_content: OCR_JPG_BASE64,
        },
      });

      // Poll until Bear finishes OCR — avoids flaky fixed sleeps
      const response = await waitForFileContent(noteId, 'simple');

      // File metadata must be in a separate content block, not concatenated into block 0
      expect(response.content).toHaveLength(2);
      expect(response.content[0].text).not.toContain('# Attached Files');
      expect(response.content[1].text).toContain('# Attached Files');
      expect(response.content[1].text).toContain('ocr-text.jpg');
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('note without attachment returns single content block with no files mention', () => {
    const title = uniqueTitle(TEST_PREFIX, 'No File', RUN_ID);
    let noteId: string | undefined;

    try {
      callTool({
        toolName: 'bear-create-note',
        args: { title, text: 'Just plain text', tags: 'system-test' },
      });

      noteId = findNoteId(title);

      const response = callTool({
        toolName: 'bear-open-note',
        args: { id: noteId },
      });

      expect(response.content).toHaveLength(1);
      expect(response.content[0].text).not.toContain('# Attached Files');
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('note with multiple attachments returns all files in a single second block', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'Multi File', RUN_ID);
    let noteId: string | undefined;

    try {
      callTool({
        toolName: 'bear-create-note',
        args: { title, text: 'Multi-file note body', tags: 'system-test' },
      });

      noteId = findNoteId(title);

      // Attach an OCR-able image and a non-OCR-able HTML to exercise both content branches
      callTool({
        toolName: 'bear-add-file',
        args: { id: noteId, filename: 'ocr-text.jpg', base64_content: OCR_JPG_BASE64 },
      });
      callTool({
        toolName: 'bear-add-file',
        args: { id: noteId, filename: 'page.html', base64_content: HTML_BASE64 },
      });

      // Poll until Bear finishes OCR — avoids flaky fixed sleeps
      const response = await waitForFileContent(noteId, 'simple');

      expect(response.content).toHaveLength(2);
      expect(response.content[0].text).not.toContain('# Attached Files');
      const filesBlock = response.content[1].text;
      // OCR-able file: Bear extracts text from the image
      expect(filesBlock).toContain('ocr-text.jpg');
      // Non-OCR-able file: placeholder content
      expect(filesBlock).toContain('page.html');
      expect(filesBlock).toContain('File content not available');
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('full-body replace preserves note structure and mid-body file reference', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'Preserve Ref', RUN_ID);
    let noteId: string | undefined;

    try {
      callTool({
        toolName: 'bear-create-note',
        args: { title, text: SAMPLE_NOTE_BODY, tags: 'system-test' },
      });

      noteId = findNoteId(title);

      callTool({
        toolName: 'bear-add-file',
        args: { id: noteId, filename: 'architecture.png', base64_content: TINY_PNG_BASE64 },
      });

      const response = await waitForFileContent(noteId, 'architecture.png');
      expect(response.content).toHaveLength(2);

      // Bear appends ![](architecture.png) at the bottom. Relocate it between
      // sections to simulate a realistic note with a mid-body image.
      const originalBody = extractNoteBody(response.content[0].text);
      const relocated = originalBody
        .replace('![](architecture.png)\n\n', '')
        .replace('## Open Issues', '![](architecture.png)\n\n## Open Issues');

      callTool({
        toolName: 'bear-replace-text',
        args: { id: noteId, scope: 'full-note-body', text: relocated },
        env: { UI_ENABLE_CONTENT_REPLACEMENT: 'true' },
      });
      await sleep(PAUSE_AFTER_WRITE_OP);

      // Read the note with the mid-body image — this is our "original"
      const withMidBodyImage = callTool({ toolName: 'bear-open-note', args: { id: noteId } });
      const originalWithImage = extractNoteBody(withMidBodyImage.content[0].text);
      expect(originalWithImage).toContain('![](architecture.png)\n\n## Open Issues');

      // Simulate an AI editing the note: modify text around the image but keep it
      const modified = originalWithImage.replace(
        'We migrated three services to the new EKS cluster last quarter.',
        'All three services are now running on the new EKS cluster.'
      );

      callTool({
        toolName: 'bear-replace-text',
        args: { id: noteId, scope: 'full-note-body', text: modified },
        env: { UI_ENABLE_CONTENT_REPLACEMENT: 'true' },
      });
      await sleep(PAUSE_AFTER_WRITE_OP);

      const afterResponse = callTool({ toolName: 'bear-open-note', args: { id: noteId } });
      const afterBody = extractNoteBody(afterResponse.content[0].text);

      // Verify the full note structure survived
      expect(afterBody).toContain('## Current State');
      expect(afterBody).toContain('All three services are now running');
      expect(afterBody).toContain('![](architecture.png)');
      expect(afterBody).toContain('## Open Issues');
      expect(afterBody).toContain('## Next Steps');
      expect(afterBody).not.toContain('# Attached Files');

      // File attachment still present in the separate content block
      expect(afterResponse.content).toHaveLength(2);
      expect(afterResponse.content[1].text).toContain('architecture.png');
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('file attachment record survives even when inline reference is removed', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'Drop Ref', RUN_ID);
    let noteId: string | undefined;

    try {
      callTool({
        toolName: 'bear-create-note',
        args: { title, text: SAMPLE_NOTE_BODY, tags: 'system-test' },
      });

      noteId = findNoteId(title);

      callTool({
        toolName: 'bear-add-file',
        args: { id: noteId, filename: 'architecture.png', base64_content: TINY_PNG_BASE64 },
      });

      const response = await waitForFileContent(noteId, 'architecture.png');
      expect(response.content).toHaveLength(2);

      // Replace body with entirely new content — no file reference at all.
      // Simulates an AI that rewrites the note without preserving ![](…) markers.
      const rewrittenBody =
        '## Summary\n\nThe infrastructure review is complete. All services are stable.\n\n' +
        '## Action Items\n\n- Review alerting thresholds with SRE team\n- Evaluate managed Prometheus options';

      callTool({
        toolName: 'bear-replace-text',
        args: { id: noteId, scope: 'full-note-body', text: rewrittenBody },
        env: { UI_ENABLE_CONTENT_REPLACEMENT: 'true' },
      });
      await sleep(PAUSE_AFTER_WRITE_OP);

      const afterResponse = callTool({ toolName: 'bear-open-note', args: { id: noteId } });
      const afterBody = extractNoteBody(afterResponse.content[0].text);

      // Verify the rewritten body structure
      expect(afterBody).toContain('## Summary');
      expect(afterBody).toContain('infrastructure review is complete');
      expect(afterBody).toContain('## Action Items');
      expect(afterBody).not.toContain('![](architecture.png)');
      expect(afterBody).not.toContain('# Attached Files');

      // Bear preserves the file record in ZSFNOTEFILE even when the inline
      // reference is removed from the note body — the attachment is not orphaned
      expect(afterResponse.content).toHaveLength(2);
      expect(afterResponse.content[1].text).toContain('architecture.png');
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('attaches file via file_path', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'FilePath', RUN_ID);
    let noteId: string | undefined;

    try {
      callTool({
        toolName: 'bear-create-note',
        args: { title, text: 'File path attachment test', tags: 'system-test' },
      });

      noteId = findNoteId(title);

      const addResult = callTool({
        toolName: 'bear-add-file',
        args: { id: noteId, file_path: OCR_JPG_PATH },
      }).content[0].text;

      // Server should infer filename from path and return complete metadata
      expect(addResult).toContain('ocr-text.jpg');
      expect(addResult).toContain('added successfully');
      expect(addResult).toContain(title);
      expect(addResult).toContain(noteId);

      // Poll until Bear finishes OCR — proves the file was actually attached
      const response = await waitForFileContent(noteId, 'simple');
      expect(response.content).toHaveLength(2);
      expect(response.content[1].text).toContain('ocr-text.jpg');
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('file_path uses explicit filename when provided', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'FilePathCustomName', RUN_ID);
    let noteId: string | undefined;

    try {
      callTool({
        toolName: 'bear-create-note',
        args: { title, text: 'Custom filename test', tags: 'system-test' },
      });

      noteId = findNoteId(title);

      const addResult = callTool({
        toolName: 'bear-add-file',
        args: { id: noteId, file_path: OCR_JPG_PATH, filename: 'custom-name.jpg' },
      }).content[0].text;

      expect(addResult).toContain('custom-name.jpg');
      expect(addResult).toContain('added successfully');

      const response = await waitForFileContent(noteId, 'custom-name.jpg');
      expect(response.content).toHaveLength(2);
      expect(response.content[1].text).toContain('custom-name.jpg');
    } finally {
      if (noteId) trashNote(noteId);
    }
  });

  it('returns error for non-existent file_path', () => {
    const title = uniqueTitle(TEST_PREFIX, 'BadPath', RUN_ID);
    let noteId: string | undefined;

    try {
      callTool({
        toolName: 'bear-create-note',
        args: { title, text: 'Bad path test', tags: 'system-test' },
      });

      noteId = findNoteId(title);

      const response = callTool({
        toolName: 'bear-add-file',
        args: { id: noteId, file_path: '/tmp/does-not-exist-12345.pdf' },
      });

      expect(response.content[0].text).toContain('File not found');
      expect(response.isError).toBe(true);
    } finally {
      if (noteId) trashNote(noteId);
    }
  });
});

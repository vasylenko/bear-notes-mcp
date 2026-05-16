import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  callTool,
  cleanupTestNotes,
  extractNoteBody,
  readNoteRevision,
  tryExtractNoteId,
  tryExtractRevision,
  sleep,
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
const OCR_JPG_PATH = resolve(import.meta.dirname, '../fixtures/ocr-text.jpg');
// HTML file — Bear cannot OCR this file type
const HTML_PATH = resolve(import.meta.dirname, '../fixtures/page.html');
// Minimal 1x1 transparent PNG — used for cases where OCR content doesn't matter
const TINY_PNG_PATH = resolve(import.meta.dirname, '../fixtures/tiny.png');

afterAll(() => {
  cleanupTestNotes(TEST_PREFIX);
});

describe('attached files content separation', () => {
  it('note with attachment returns file content in a separate content block', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'With File', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Note body text here', tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    // OCC enforce gate: pass the live revision (post-Bear-recompute) so the write isn't rejected as stale.
    await sleep(PAUSE_AFTER_WRITE_OP);
    const revBeforeAttach = readNoteRevision(noteId);
    expect(revBeforeAttach).not.toBeNull();

    callTool({
      toolName: 'bear-add-file',
      args: { id: noteId, file_path: OCR_JPG_PATH, revision: revBeforeAttach! },
    });

    // Poll until Bear finishes OCR — avoids flaky fixed sleeps
    const response = await waitForFileContent(noteId, 'simple');

    // File metadata must be in a separate content block, not concatenated into block 0
    expect(response.content).toHaveLength(2);
    expect(response.content[0].text).not.toContain('# Attached Files');
    expect(response.content[1].text).toContain('# Attached Files');
    expect(response.content[1].text).toContain('ocr-text.jpg');
  });

  it('note without attachment returns single content block with no files mention', () => {
    const title = uniqueTitle(TEST_PREFIX, 'No File', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Just plain text', tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    const response = callTool({
      toolName: 'bear-open-note',
      args: { id: noteId },
    });

    expect(response.content).toHaveLength(1);
    expect(response.content[0].text).not.toContain('# Attached Files');
  });

  it('note with multiple attachments returns all files in a single second block', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'Multi File', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Multi-file note body', tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    // OCC enforce gate: pass the live revision before each gated write.
    await sleep(PAUSE_AFTER_WRITE_OP);
    const revBeforeFirstAttach = readNoteRevision(noteId);
    expect(revBeforeFirstAttach).not.toBeNull();

    // Attach an OCR-able image and a non-OCR-able HTML to exercise both content branches
    const firstAddResult = callTool({
      toolName: 'bear-add-file',
      args: { id: noteId, file_path: OCR_JPG_PATH, revision: revBeforeFirstAttach! },
    }).content[0].text;
    const revBeforeSecondAttach = tryExtractRevision(firstAddResult);
    expect(revBeforeSecondAttach).not.toBeNull();
    callTool({
      toolName: 'bear-add-file',
      args: { id: noteId, file_path: HTML_PATH, revision: revBeforeSecondAttach! },
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
  });

  it('full-body replace preserves note structure and mid-body file reference', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'Preserve Ref', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: SAMPLE_NOTE_BODY, tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    // OCC enforce gate: chain revisions through every gated write.
    await sleep(PAUSE_AFTER_WRITE_OP);
    const revBeforeAttach = readNoteRevision(noteId);
    expect(revBeforeAttach).not.toBeNull();

    callTool({
      toolName: 'bear-add-file',
      args: {
        id: noteId,
        file_path: TINY_PNG_PATH,
        filename: 'architecture.png',
        revision: revBeforeAttach!,
      },
    });

    const response = await waitForFileContent(noteId, 'architecture.png');
    expect(response.content).toHaveLength(2);

    // Bear appends ![](architecture.png) at the bottom. Relocate it between
    // sections to simulate a realistic note with a mid-body image.
    const originalBody = extractNoteBody(response.content[0].text);
    const relocated = originalBody
      .replace('![](architecture.png)\n\n', '')
      .replace('## Open Issues', '![](architecture.png)\n\n## Open Issues');

    // The bear-open-note inside waitForFileContent returns the latest revision; reuse it.
    const revBeforeFirstReplace = tryExtractRevision(response.content[0].text);
    expect(revBeforeFirstReplace).not.toBeNull();
    callTool({
      toolName: 'bear-replace-text',
      args: {
        id: noteId,
        scope: 'full-note-body',
        text: relocated,
        revision: revBeforeFirstReplace!,
      },
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

    // The bear-open-note above carries the latest revision — use it.
    const revBeforeSecondReplace = tryExtractRevision(withMidBodyImage.content[0].text);
    expect(revBeforeSecondReplace).not.toBeNull();
    callTool({
      toolName: 'bear-replace-text',
      args: {
        id: noteId,
        scope: 'full-note-body',
        text: modified,
        revision: revBeforeSecondReplace!,
      },
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
  });

  it('file attachment record survives even when inline reference is removed', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'Drop Ref', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: SAMPLE_NOTE_BODY, tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    // OCC enforce gate: chain revisions through every gated write.
    await sleep(PAUSE_AFTER_WRITE_OP);
    const revBeforeAttach = readNoteRevision(noteId);
    expect(revBeforeAttach).not.toBeNull();

    callTool({
      toolName: 'bear-add-file',
      args: {
        id: noteId,
        file_path: TINY_PNG_PATH,
        filename: 'architecture.png',
        revision: revBeforeAttach!,
      },
    });

    const response = await waitForFileContent(noteId, 'architecture.png');
    expect(response.content).toHaveLength(2);

    // Replace body with entirely new content — no file reference at all.
    // Simulates an AI that rewrites the note without preserving ![](…) markers.
    const rewrittenBody =
      '## Summary\n\nThe infrastructure review is complete. All services are stable.\n\n' +
      '## Action Items\n\n- Review alerting thresholds with SRE team\n- Evaluate managed Prometheus options';

    const revBeforeReplace = tryExtractRevision(response.content[0].text);
    expect(revBeforeReplace).not.toBeNull();
    callTool({
      toolName: 'bear-replace-text',
      args: {
        id: noteId,
        scope: 'full-note-body',
        text: rewrittenBody,
        revision: revBeforeReplace!,
      },
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
  });

  it('attaches file via file_path', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'FilePath', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'File path attachment test', tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    // OCC enforce gate: capture live revision before the write.
    await sleep(PAUSE_AFTER_WRITE_OP);
    const revBeforeAttach = readNoteRevision(noteId);
    expect(revBeforeAttach).not.toBeNull();

    const addResult = callTool({
      toolName: 'bear-add-file',
      args: { id: noteId, file_path: OCR_JPG_PATH, revision: revBeforeAttach! },
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
  });

  it('file_path uses explicit filename when provided', async () => {
    const title = uniqueTitle(TEST_PREFIX, 'FilePathCustomName', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Custom filename test', tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    // OCC enforce gate: capture live revision before the write.
    await sleep(PAUSE_AFTER_WRITE_OP);
    const revBeforeAttach = readNoteRevision(noteId);
    expect(revBeforeAttach).not.toBeNull();

    const addResult = callTool({
      toolName: 'bear-add-file',
      args: {
        id: noteId,
        file_path: OCR_JPG_PATH,
        filename: 'custom-name.jpg',
        revision: revBeforeAttach!,
      },
    }).content[0].text;

    expect(addResult).toContain('custom-name.jpg');
    expect(addResult).toContain('added successfully');

    const response = await waitForFileContent(noteId, 'custom-name.jpg');
    expect(response.content).toHaveLength(2);
    expect(response.content[1].text).toContain('custom-name.jpg');
  });

  it('emits Revision matching live Z_OPT after add-file (OCC inform)', async () => {
    // /add-file bumps ZSFNOTE.Z_OPT by +1 (empirically confirmed —
    // see docs/dev/BEAR_DATABASE_SCHEMA.md; note-row bumps, not only
    // ZSFNOTEFILE). Response Revision must (a) exceed the pre-attach
    // baseline (proving the baseline wasn't echoed back) and (b) equal
    // current live Z_OPT (proving freshness).
    const title = uniqueTitle(TEST_PREFIX, 'AddFileRevision', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Pre-attach body for revision test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    // Wait for Bear's +2 recompute save before reading baseline (BEAR_DATABASE_SCHEMA.md).
    await sleep(PAUSE_AFTER_WRITE_OP);

    const preAttachRevision = readNoteRevision(noteId);
    expect(preAttachRevision).not.toBeNull();

    const addResult = callTool({
      toolName: 'bear-add-file',
      args: { id: noteId, file_path: TINY_PNG_PATH, revision: preAttachRevision! },
    }).content[0].text;

    const responseRevision = tryExtractRevision(addResult);
    expect(responseRevision).not.toBeNull();
    expect(responseRevision!).toBeGreaterThan(preAttachRevision!);

    const liveDbRevision = readNoteRevision(noteId);
    expect(responseRevision).toBe(liveDbRevision);
  });

  it('bear-add-file rejects a stale revision and does not bump the note', async () => {
    // OCC enforce: a write whose `revision` no longer matches live Z_OPT must
    // return a soft error pointing at bear-open-note and must not leak the
    // live revision (which would let the agent satisfy the gate without
    // re-reading the body — see docs/dev/SPECIFICATION.md OCC enforce).
    const title = uniqueTitle(TEST_PREFIX, 'StaleAddFile', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Initial body for stale-revision test', tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    // Past Bear's +2 recompute save (BEAR_DATABASE_SCHEMA.md) before reading.
    await sleep(PAUSE_AFTER_WRITE_OP);

    // Warm Z_OPT up past 9 so the not.toContain(String(R₂)) guard below isn't
    // fooled by an incidental single-digit substring in the error message.
    let warmupRev = readNoteRevision(noteId)!;
    while (warmupRev < 10) {
      callTool({
        toolName: 'bear-add-text',
        args: { id: noteId, text: 'warmup', position: 'end', revision: warmupRev },
      });
      await sleep(PAUSE_AFTER_WRITE_OP);
      warmupRev = readNoteRevision(noteId)!;
    }

    const r1 = warmupRev;
    expect(r1).toBeGreaterThanOrEqual(10);

    // Competing write — bumps live revision past R₁.
    callTool({
      toolName: 'bear-add-text',
      args: { id: noteId, text: 'competing', position: 'end', revision: r1 },
    });
    await sleep(PAUSE_AFTER_WRITE_OP);

    const r2 = readNoteRevision(noteId)!;
    expect(r2).toBeGreaterThan(r1);
    expect(String(r2).length).toBeGreaterThanOrEqual(2);

    // Now the stale write — should be rejected.
    const response = callTool({
      toolName: 'bear-add-file',
      args: { id: noteId, file_path: TINY_PNG_PATH, revision: r1 },
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('bear-open-note');
    expect(response.content[0].text).not.toContain(String(r2));

    // Rejected write must not bump live revision.
    const liveAfter = readNoteRevision(noteId);
    expect(liveAfter).toBe(r2);
  });

  it('rejects a stale revision before checking attachment readability', async () => {
    // SPECIFICATION.md: the OCC gate fires BEFORE any tool-specific pre-flight,
    // including attachment readability. A caller submitting both a stale
    // revision AND an unreadable file must see the stale-revision error first
    // so they refresh their view of the note instead of chasing a file path.
    const title = uniqueTitle(TEST_PREFIX, 'StaleAddFileBadPath', RUN_ID);
    const createResult = callTool({
      toolName: 'bear-create-note',
      args: { title, text: 'Initial body', tags: 'system-test' },
    }).content[0].text;
    const noteId = tryExtractNoteId(createResult)!;

    await sleep(PAUSE_AFTER_WRITE_OP);

    let warmupRev = readNoteRevision(noteId)!;
    while (warmupRev < 10) {
      callTool({
        toolName: 'bear-add-text',
        args: { id: noteId, text: 'warmup', position: 'end', revision: warmupRev },
      });
      await sleep(PAUSE_AFTER_WRITE_OP);
      warmupRev = readNoteRevision(noteId)!;
    }

    const r1 = warmupRev;
    expect(r1).toBeGreaterThanOrEqual(10);

    callTool({
      toolName: 'bear-add-text',
      args: { id: noteId, text: 'competing', position: 'end', revision: r1 },
    });
    await sleep(PAUSE_AFTER_WRITE_OP);

    const r2 = readNoteRevision(noteId)!;
    expect(r2).toBeGreaterThan(r1);

    // Stale revision + bogus file path: gate must fire first. Path is in the
    // tracked fixtures dir (mirroring TINY_PNG_PATH) but with a guaranteed-
    // missing filename — keeps the test off Sonar's /tmp publicly-writable
    // rule (S5443) without changing what we're proving.
    const missingPath = resolve(import.meta.dirname, '../fixtures/sva22-missing.png');
    const response = callTool({
      toolName: 'bear-add-file',
      args: {
        id: noteId,
        file_path: missingPath,
        revision: r1,
      },
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('bear-open-note');
    // The file-readability error sentinels must NOT appear — the gate ran first.
    expect(response.content[0].text).not.toContain('File not found');
    expect(response.content[0].text).not.toContain('Cannot read file');

    const liveAfter = readNoteRevision(noteId);
    expect(liveAfter).toBe(r2);
  });
});

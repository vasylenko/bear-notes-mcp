import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { __testing__ } from './note-tools.js';

const { readAttachmentFile, MAX_ATTACHMENT_BYTES } = __testing__;

// Pins the new security guards added by S1: symlink rejection, non-file rejection,
// size cap. Pre-existing branches (happy path, empty file, ENOENT mapping) stay
// uncovered by intent — they're behavior shipped before this PR via system tests.
describe('readAttachmentFile security guards', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'bear-mcp-attach-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('rejects symbolic links (no follow-the-link exfiltration)', () => {
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'secret');
    const link = join(dir, 'link.txt');
    symlinkSync(target, link);
    const result = readAttachmentFile(link);
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/^Symbolic links are not supported:/),
    });
  });

  it('rejects non-files (e.g. directories)', () => {
    const subdir = join(dir, 'sub');
    mkdirSync(subdir);
    const result = readAttachmentFile(subdir);
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/^Not a regular file:/) });
  });

  it('rejects files exceeding MAX_ATTACHMENT_BYTES (resource cap)', () => {
    const path = join(dir, 'big.txt');
    writeFileSync(path, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    const result = readAttachmentFile(path);
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/^File too large /) });
  });
});

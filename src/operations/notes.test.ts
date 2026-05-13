import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as scheduleAfter } from 'node:timers';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CORE_DATA_EPOCH_OFFSET } from '../config.js';

import {
  awaitNoteCreation,
  awaitRevisionIncrement,
  noteHasHeader,
  parseDateString,
  searchNotes,
  stripLeadingHeader,
} from './notes.js';

describe('parseDateString', () => {
  beforeEach(() => {
    // Fix "now" to January 15, 2026 for predictable tests
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('"start of last month" in January returns December of previous year', () => {
    const result = parseDateString('start of last month');

    expect(result.getFullYear()).toBe(2025);
    expect(result.getMonth()).toBe(11); // December (0-indexed)
    expect(result.getDate()).toBe(1);
  });

  it('"end of last month" returns last day with end-of-day time', () => {
    const result = parseDateString('end of last month');

    expect(result.getFullYear()).toBe(2025);
    expect(result.getMonth()).toBe(11); // December
    expect(result.getDate()).toBe(31);
    expect(result.getHours()).toBe(23);
    expect(result.getMinutes()).toBe(59);
    expect(result.getSeconds()).toBe(59);
  });

  // ISO date-only inputs must be interpreted in local time — callers snap
  // bounds with local-time setHours, so a UTC-midnight parse would produce
  // previous-day bounds for negative-UTC users. Asserting local-time
  // components catches the bug for any developer running tests in non-UTC.
  it('parses ISO YYYY-MM-DD as local-time midnight', () => {
    const result = parseDateString('2026-04-15');

    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(3); // April, 0-indexed
    expect(result.getDate()).toBe(15);
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
    expect(result.getSeconds()).toBe(0);
    expect(result.getMilliseconds()).toBe(0);
  });

  it('ISO date-only result equals local-time Date(y, m-1, d)', () => {
    expect(parseDateString('2026-04-15').getTime()).toBe(new Date(2026, 3, 15).getTime());
  });

  it('rejects invalid ISO components instead of rolling over', () => {
    // Date(2026, 1, 30) silently becomes March 2; the round-trip check rejects it.
    expect(() => parseDateString('2026-02-30')).toThrow(/Invalid date format/);
    expect(() => parseDateString('2026-13-01')).toThrow(/Invalid date format/);
    expect(() => parseDateString('2026-04-00')).toThrow(/Invalid date format/);
  });

  it('preserves explicit-timezone datetime semantics (fallthrough path)', () => {
    // Strings with explicit TZ keep their UTC interpretation — only the
    // ambiguous YYYY-MM-DD form was reinterpreted as local-time.
    const utc = parseDateString('2026-04-15T00:00:00Z');
    expect(utc.getTime()).toBe(Date.UTC(2026, 3, 15, 0, 0, 0));
  });
});

describe('noteHasHeader', () => {
  const noteText = [
    '# Title',
    'Intro paragraph',
    '',
    '## Details',
    'Some details here',
    '',
    '### Q&A',
    'Questions and answers',
    '',
    '## Details (v2)',
    'Updated details',
    '',
    '## v1.0 Release',
    'Release notes',
  ].join('\n');

  it('finds an exact header match', () => {
    expect(noteHasHeader(noteText, 'Details')).toBe(true);
  });

  it('strips markdown prefix from header input', () => {
    expect(noteHasHeader(noteText, '## Details')).toBe(true);
    expect(noteHasHeader(noteText, '### Q&A')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(noteHasHeader(noteText, 'details')).toBe(true);
    expect(noteHasHeader(noteText, 'DETAILS')).toBe(true);
  });

  it('rejects partial header name', () => {
    expect(noteHasHeader(noteText, 'Detail')).toBe(false);
  });

  it('handles parentheses in header name', () => {
    expect(noteHasHeader(noteText, 'Details (v2)')).toBe(true);
  });

  it('handles ampersand in header name', () => {
    expect(noteHasHeader(noteText, 'Q&A')).toBe(true);
  });

  it('handles dots in header name', () => {
    expect(noteHasHeader(noteText, 'v1.0 Release')).toBe(true);
  });

  it('returns false for empty note text', () => {
    expect(noteHasHeader('', 'Details')).toBe(false);
  });

  it('returns false for empty header input', () => {
    expect(noteHasHeader(noteText, '')).toBe(false);
  });
});

describe('stripLeadingHeader', () => {
  it('strips matching header with exact case', () => {
    expect(stripLeadingHeader('## Details\nNew content', 'Details')).toBe('New content');
  });

  it('strips matching header case-insensitively', () => {
    expect(stripLeadingHeader('## DETAILS\nNew content', 'Details')).toBe('New content');
    expect(stripLeadingHeader('## details\nNew content', 'Details')).toBe('New content');
  });

  it('strips matching header at any heading level', () => {
    expect(stripLeadingHeader('### Details\nNew content', 'Details')).toBe('New content');
    expect(stripLeadingHeader('#### Details\nNew content', 'Details')).toBe('New content');
  });

  it('does not strip when header text does not match', () => {
    expect(stripLeadingHeader('## Other\nNew content', 'Details')).toBe('## Other\nNew content');
  });

  it('does not strip when text does not start with a header', () => {
    expect(stripLeadingHeader('New content', 'Details')).toBe('New content');
  });

  it('handles special characters in header name', () => {
    expect(stripLeadingHeader('## Details (v2)\nNew content', 'Details (v2)')).toBe('New content');
    expect(stripLeadingHeader('## Q&A\nNew content', 'Q&A')).toBe('New content');
  });

  it('returns text unchanged when header is empty string', () => {
    expect(stripLeadingHeader('## Details\nNew content', '')).toBe('## Details\nNew content');
  });
});

describe('searchNotes validation', () => {
  // The "at least one criterion" check must look at trimmed values; otherwise a
  // whitespace-only term passes `!!searchTerm` then trims to empty and the
  // search silently degrades to browse-all-recent-notes. The throw runs before
  // any FTS5/database contact, so this is unit-test scope by design.
  it.each([
    { name: 'whitespace-only searchTerm', call: () => searchNotes('   ') },
    { name: 'whitespace-only tag', call: () => searchNotes(undefined, '   ') },
    { name: 'all parameters omitted', call: () => searchNotes() },
  ])('throws when no real search criterion is provided: $name', ({ call }) => {
    expect(call).toThrow(/Please provide a search term, tag, date filter, or pinned filter/);
  });
});

describe('awaitRevisionIncrement', () => {
  // Inline file-backed synthetic DB rather than `:memory:`. The function-under-test
  // opens its own read-only connection via openBearDatabase(BEAR_DB_PATH); both
  // connections need to see the same data, which only works for a file-backed
  // SQLite (since `:memory:` is per-connection).
  let tempDir: string;
  let dbPath: string;
  let writeDb: DatabaseSync;
  let originalBearDbPath: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'bear-mcp-occ-'));
    dbPath = join(tempDir, 'database.sqlite');
    writeDb = new DatabaseSync(dbPath);
    writeDb.exec(`
      CREATE TABLE ZSFNOTE (
        Z_PK INTEGER PRIMARY KEY,
        ZUNIQUEIDENTIFIER TEXT,
        Z_OPT INTEGER DEFAULT 1,
        ZARCHIVED INTEGER DEFAULT 0,
        ZTRASHED INTEGER DEFAULT 0,
        ZENCRYPTED INTEGER DEFAULT 0
      )
    `);
    originalBearDbPath = process.env.BEAR_DB_PATH;
    process.env.BEAR_DB_PATH = dbPath;
  });

  afterEach(() => {
    writeDb.close();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalBearDbPath === undefined) {
      delete process.env.BEAR_DB_PATH;
    } else {
      process.env.BEAR_DB_PATH = originalBearDbPath;
    }
  });

  it('resolves with the new revision when Z_OPT changes (inequality, not baseline+1)', async () => {
    writeDb
      .prepare('INSERT INTO ZSFNOTE (Z_PK, ZUNIQUEIDENTIFIER, Z_OPT) VALUES (1, ?, 5)')
      .run('note-id');

    // Schedule a +2 jump mid-poll. The +2 (not +1) mirrors first-edit-after-creation
    // empirical behavior; the helper must resolve on inequality, not wait for 6.
    scheduleAfter(() => {
      writeDb.prepare('UPDATE ZSFNOTE SET Z_OPT = 7 WHERE ZUNIQUEIDENTIFIER = ?').run('note-id');
    }, 50);

    const result = await awaitRevisionIncrement('note-id', 5);
    expect(result).toBe(7);
  });

  it('returns null on timeout when Z_OPT does not change', async () => {
    writeDb
      .prepare('INSERT INTO ZSFNOTE (Z_PK, ZUNIQUEIDENTIFIER, Z_OPT) VALUES (1, ?, 5)')
      .run('note-id');

    const start = Date.now();
    const result = await awaitRevisionIncrement('note-id', 5);
    const elapsed = Date.now() - start;

    expect(result).toBeNull();
    // Cap is REVISION_POLL_CAP_MS=500; allow slack for CI/system variance.
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(900);
  });

  it('returns null when the note does not exist', async () => {
    // stmt.get returns undefined every poll; loop never matches; falls through to timeout.
    const result = await awaitRevisionIncrement('ghost-id', 0);
    expect(result).toBeNull();
  });
});

describe('awaitNoteCreation', () => {
  // Reuses the same file-backed temp-DB pattern as awaitRevisionIncrement.
  // The function opens its own read-only connection via BEAR_DB_PATH; mid-poll
  // INSERT proves the {id, revision} tuple is bundled from a single SELECT
  // (no second round trip for revision). Schema mirrors what awaitNoteCreation
  // actually reads: ZTITLE, ZUNIQUEIDENTIFIER, ZCREATIONDATE, ZARCHIVED,
  // ZTRASHED, ZENCRYPTED, Z_OPT.
  let tempDir: string;
  let dbPath: string;
  let writeDb: DatabaseSync;
  let originalBearDbPath: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'bear-mcp-create-'));
    dbPath = join(tempDir, 'database.sqlite');
    writeDb = new DatabaseSync(dbPath);
    writeDb.exec(`
      CREATE TABLE ZSFNOTE (
        Z_PK INTEGER PRIMARY KEY,
        ZTITLE TEXT,
        ZUNIQUEIDENTIFIER TEXT,
        ZCREATIONDATE REAL,
        ZARCHIVED INTEGER DEFAULT 0,
        ZTRASHED INTEGER DEFAULT 0,
        ZENCRYPTED INTEGER DEFAULT 0,
        Z_OPT INTEGER DEFAULT 1
      )
    `);
    originalBearDbPath = process.env.BEAR_DB_PATH;
    process.env.BEAR_DB_PATH = dbPath;
  });

  afterEach(() => {
    writeDb.close();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalBearDbPath === undefined) {
      delete process.env.BEAR_DB_PATH;
    } else {
      process.env.BEAR_DB_PATH = originalBearDbPath;
    }
  });

  it('resolves with both id and revision when the note is found', async () => {
    // ZCREATIONDATE in Core Data epoch (seconds since 2001-01-01). Any value
    // >= now - CREATION_LOOKBACK_MS qualifies; convertDateToCoreDataTimestamp
    // for `now` is well within range.
    const coreDataNow = Math.floor(Date.now() / 1000) - CORE_DATA_EPOCH_OFFSET;

    // Schedule INSERT mid-poll to mirror Bear's async creation.
    scheduleAfter(() => {
      writeDb
        .prepare(
          'INSERT INTO ZSFNOTE (Z_PK, ZTITLE, ZUNIQUEIDENTIFIER, ZCREATIONDATE, Z_OPT) VALUES (1, ?, ?, ?, 3)'
        )
        .run('Fresh Note', 'created-id', coreDataNow);
    }, 50);

    const result = await awaitNoteCreation('Fresh Note');
    expect(result).toEqual({ id: 'created-id', revision: 3 });
  });
});

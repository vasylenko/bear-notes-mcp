import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { CORE_DATA_EPOCH_OFFSET } from '../config.js';

import { type SearchSpec, __testing__ } from './fts-index.js';

const {
  buildIndex,
  checkDrift,
  ensureFreshIndex,
  executeQuery,
  executeQueryWithCount,
  getState,
  reset,
} = __testing__;

interface SyntheticNote {
  pk: number;
  title: string;
  text?: string;
  uniqueId?: string;
  pinned?: boolean;
  archived?: boolean;
  trashed?: boolean;
  encrypted?: boolean;
  created?: number; // Core Data timestamp
  modified?: number; // Core Data timestamp
  ocrTexts?: string[]; // attachment OCR contents
  tags?: string[]; // tag names (URL-encoded as Bear stores them, e.g. 'My+Tag')
  pinnedInTags?: string[]; // subset of `tags` where this note is pinned
}

// Builds an in-memory SQLite DB with the Bear schema subset needed by
// fts-index.ts: Z_PRIMARYKEY, ZSFNOTE (+attachments via ZSFNOTEFILE),
// ZSFNOTETAG, and the two Core Data join tables Z_5TAGS / Z_5PINNEDINTAGS.
// Synthesizes a populated fixture so build/drift/query can be exercised
// without touching the real Bear app.
function buildSyntheticBearDb(notes: SyntheticNote[]): DatabaseSync {
  const db = new DatabaseSync(':memory:');

  db.exec(`
    CREATE TABLE Z_PRIMARYKEY (
      Z_ENT INTEGER PRIMARY KEY,
      Z_NAME VARCHAR,
      Z_SUPER INTEGER,
      Z_MAX INTEGER
    );
    CREATE TABLE ZSFNOTE (
      Z_PK INTEGER PRIMARY KEY,
      ZTITLE VARCHAR,
      ZTEXT VARCHAR,
      ZUNIQUEIDENTIFIER VARCHAR,
      ZCREATIONDATE REAL,
      ZMODIFICATIONDATE REAL,
      ZPINNED INTEGER DEFAULT 0,
      ZARCHIVED INTEGER DEFAULT 0,
      ZTRASHED INTEGER DEFAULT 0,
      ZENCRYPTED INTEGER DEFAULT 0
    );
    CREATE TABLE ZSFNOTEFILE (
      Z_PK INTEGER PRIMARY KEY AUTOINCREMENT,
      ZNOTE INTEGER,
      ZSEARCHTEXT VARCHAR
    );
    CREATE TABLE ZSFNOTETAG (
      Z_PK INTEGER PRIMARY KEY AUTOINCREMENT,
      ZTITLE VARCHAR,
      ZISROOT INTEGER DEFAULT 1
    );
    CREATE TABLE Z_5TAGS (
      Z_5NOTES INTEGER,
      Z_13TAGS INTEGER
    );
    CREATE TABLE Z_5PINNEDINTAGS (
      Z_5PINNEDNOTES INTEGER,
      Z_13PINNEDINTAGS INTEGER
    );
  `);

  db.prepare('INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME, Z_SUPER, Z_MAX) VALUES (?, ?, 0, 0)').run(
    5,
    'SFNote'
  );
  db.prepare('INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME, Z_SUPER, Z_MAX) VALUES (?, ?, 0, 0)').run(
    13,
    'SFNoteTag'
  );

  // Resolve all distinct tag names in the fixture to ZSFNOTETAG primary keys
  const tagPks = new Map<string, number>();
  const insertTag = db.prepare(
    'INSERT INTO ZSFNOTETAG (ZTITLE, ZISROOT) VALUES (?, ?) RETURNING Z_PK'
  );
  for (const note of notes) {
    for (const tagName of note.tags ?? []) {
      if (!tagPks.has(tagName)) {
        const isRoot = tagName.includes('/') ? 0 : 1;
        const result = insertTag.get(tagName, isRoot) as unknown as { Z_PK: number };
        tagPks.set(tagName, result.Z_PK);
      }
    }
  }

  const insertNote = db.prepare(`
    INSERT INTO ZSFNOTE (
      Z_PK, ZTITLE, ZTEXT, ZUNIQUEIDENTIFIER,
      ZCREATIONDATE, ZMODIFICATIONDATE,
      ZPINNED, ZARCHIVED, ZTRASHED, ZENCRYPTED
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFile = db.prepare('INSERT INTO ZSFNOTEFILE (ZNOTE, ZSEARCHTEXT) VALUES (?, ?)');
  const insertNoteTag = db.prepare('INSERT INTO Z_5TAGS (Z_5NOTES, Z_13TAGS) VALUES (?, ?)');
  const insertPinnedTag = db.prepare(
    'INSERT INTO Z_5PINNEDINTAGS (Z_5PINNEDNOTES, Z_13PINNEDINTAGS) VALUES (?, ?)'
  );

  for (const note of notes) {
    insertNote.run(
      note.pk,
      note.title,
      note.text ?? null,
      note.uniqueId ?? `uuid-${note.pk}`,
      note.created ?? 700_000_000,
      note.modified ?? 700_000_000,
      note.pinned ? 1 : 0,
      note.archived ? 1 : 0,
      note.trashed ? 1 : 0,
      note.encrypted ? 1 : 0
    );
    for (const ocrText of note.ocrTexts ?? []) {
      insertFile.run(note.pk, ocrText);
    }
    for (const tagName of note.tags ?? []) {
      insertNoteTag.run(note.pk, tagPks.get(tagName)!);
    }
    for (const tagName of note.pinnedInTags ?? []) {
      insertPinnedTag.run(note.pk, tagPks.get(tagName)!);
    }
  }

  return db;
}

function isoToCoreData(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000) - CORE_DATA_EPOCH_OFFSET;
}

function spec(overrides: Partial<SearchSpec> = {}): SearchSpec {
  return { limit: 5, ...overrides };
}

describe('buildIndex', () => {
  afterEach(() => reset());

  it('builds an FTS5 index from non-trashed/non-archived/non-encrypted notes', () => {
    const bearDb = buildSyntheticBearDb([
      { pk: 1, title: 'Active note one', text: 'hello world' },
      { pk: 2, title: 'Active note two', text: 'goodbye world' },
      { pk: 3, title: 'Trashed note', text: 'should be excluded', trashed: true },
      { pk: 4, title: 'Archived note', text: 'should be excluded', archived: true },
      { pk: 5, title: 'Encrypted note', text: 'should be excluded', encrypted: true },
    ]);
    try {
      const state = buildIndex(bearDb);
      try {
        const count = (
          state.memDb.prepare('SELECT COUNT(*) AS c FROM notes').get() as unknown as { c: number }
        ).c;
        expect(count).toBe(2);
      } finally {
        state.memDb.close();
      }
    } finally {
      bearDb.close();
    }
  });

  it('captures OCR text from attached files into the ocr column', () => {
    const bearDb = buildSyntheticBearDb([
      {
        pk: 1,
        title: 'Note with image',
        text: 'short body',
        ocrTexts: ['extracted text from photo', 'second attachment ocr'],
      },
    ]);
    try {
      const state = buildIndex(bearDb);
      try {
        const row = state.memDb
          .prepare("SELECT ocr FROM notes WHERE bear_id = 'uuid-1'")
          .get() as unknown as { ocr: string };
        expect(row.ocr).toContain('extracted text from photo');
        expect(row.ocr).toContain('second attachment ocr');
      } finally {
        state.memDb.close();
      }
    } finally {
      bearDb.close();
    }
  });

  it('populates note_tags with decoded tag names and pinned-in-tag flags', () => {
    const bearDb = buildSyntheticBearDb([
      {
        pk: 1,
        title: 'Career note',
        // Bear stores tags URL-encoded with + for spaces; decoding maps to lowercase trimmed.
        tags: ['Career', 'Career/My+Meetings'],
        pinnedInTags: ['Career/My+Meetings'],
      },
    ]);
    try {
      const state = buildIndex(bearDb);
      try {
        const tagRows = state.memDb
          .prepare('SELECT tag, pinned_in_tag FROM note_tags WHERE rowid = 1 ORDER BY tag')
          .all() as unknown as Array<{ tag: string; pinned_in_tag: number }>;
        expect(tagRows).toEqual([
          { tag: 'career', pinned_in_tag: 0 },
          { tag: 'career/my meetings', pinned_in_tag: 1 },
        ]);
      } finally {
        state.memDb.close();
      }
    } finally {
      bearDb.close();
    }
  });

  it('marks pinned-globally-OR-in-any-tag in the notes.pinned column', () => {
    const bearDb = buildSyntheticBearDb([
      { pk: 1, title: 'Globally pinned', pinned: true },
      { pk: 2, title: 'Pinned in tag', tags: ['x'], pinnedInTags: ['x'] },
      { pk: 3, title: 'Not pinned', tags: ['x'] },
    ]);
    try {
      const state = buildIndex(bearDb);
      try {
        const rows = state.memDb
          .prepare('SELECT rowid, pinned FROM notes ORDER BY rowid')
          .all() as unknown as Array<{ rowid: number; pinned: number }>;
        expect(rows).toEqual([
          { rowid: 1, pinned: 1 },
          { rowid: 2, pinned: 1 },
          { rowid: 3, pinned: 0 },
        ]);
      } finally {
        state.memDb.close();
      }
    } finally {
      bearDb.close();
    }
  });
});

describe('ensureFreshIndex', () => {
  afterEach(() => reset());

  it('leaves state = null when buildIndex throws after closing the previous index', () => {
    // Step 1: populate state with a valid build.
    const bearDb = buildSyntheticBearDb([
      { pk: 1, title: 'note', text: 'content', modified: 700_000_000 },
    ]);
    try {
      ensureFreshIndex(bearDb);
      expect(getState()).not.toBeNull();

      // Step 2: poison the schema so the next buildIndex throws — drop
      // Z_PRIMARYKEY so discoverBearSchema can't resolve entity IDs.
      bearDb.exec('DROP TABLE Z_PRIMARYKEY');

      // Step 3: trigger drift by adding a row, forcing a rebuild attempt.
      bearDb
        .prepare(
          `INSERT INTO ZSFNOTE (Z_PK, ZTITLE, ZTEXT, ZUNIQUEIDENTIFIER, ZCREATIONDATE, ZMODIFICATIONDATE)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(2, 'second', 'more content', 'uuid-2', 700_000_001, 700_000_001);

      // Step 4: rebuild attempt fails. The pre-fix bug would leave state
      // pointing at the now-closed previous memDb; the fix sets state = null
      // before closing so a thrown buildIndex leaves a clean rebuild-needed
      // condition.
      expect(() => ensureFreshIndex(bearDb)).toThrow();
      expect(getState()).toBeNull();
    } finally {
      bearDb.close();
    }
  });

  it('rebuilds successfully on the next call after a previous rebuild failure', () => {
    // Verifies the recovery half of the invariant: once state is null,
    // a subsequent ensureFreshIndex against a healthy DB rebuilds cleanly.
    const brokenDb = buildSyntheticBearDb([
      { pk: 1, title: 'a', text: 'x', modified: 700_000_000 },
    ]);
    const healthyDb = buildSyntheticBearDb([
      { pk: 1, title: 'recovered', text: 'works again', modified: 700_000_001 },
    ]);
    try {
      ensureFreshIndex(brokenDb);
      brokenDb.exec('DROP TABLE Z_PRIMARYKEY');
      brokenDb
        .prepare(
          `INSERT INTO ZSFNOTE (Z_PK, ZTITLE, ZTEXT, ZUNIQUEIDENTIFIER, ZCREATIONDATE, ZMODIFICATIONDATE)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(2, 'b', 'y', 'uuid-2', 700_000_001, 700_000_001);
      expect(() => ensureFreshIndex(brokenDb)).toThrow();
      expect(getState()).toBeNull();

      // Recovery: rebuilding against a healthy DB succeeds without a process restart.
      ensureFreshIndex(healthyDb);
      const state = getState();
      expect(state).not.toBeNull();
      const count = (
        state!.memDb.prepare('SELECT COUNT(*) AS c FROM notes').get() as unknown as { c: number }
      ).c;
      expect(count).toBe(1);
    } finally {
      brokenDb.close();
      healthyDb.close();
    }
  });
});

describe('checkDrift', () => {
  afterEach(() => reset());

  it('returns true when no driftKey has been cached yet', () => {
    const bearDb = buildSyntheticBearDb([{ pk: 1, title: 'a', text: 'x' }]);
    try {
      expect(checkDrift(bearDb, null)).toBe(true);
    } finally {
      bearDb.close();
    }
  });

  it('returns false when neither MAX(modified) nor COUNT changed', () => {
    const bearDb = buildSyntheticBearDb([
      { pk: 1, title: 'a', text: 'x', modified: 700_000_000 },
      { pk: 2, title: 'b', text: 'y', modified: 700_000_001 },
    ]);
    try {
      const state = buildIndex(bearDb);
      state.memDb.close();
      expect(checkDrift(bearDb, state.driftKey)).toBe(false);
    } finally {
      bearDb.close();
    }
  });

  it('returns true when a note is added (count changes)', () => {
    const bearDb = buildSyntheticBearDb([{ pk: 1, title: 'a', text: 'x', modified: 700_000_000 }]);
    try {
      const state = buildIndex(bearDb);
      state.memDb.close();
      bearDb
        .prepare(
          `INSERT INTO ZSFNOTE (Z_PK, ZTITLE, ZTEXT, ZUNIQUEIDENTIFIER, ZCREATIONDATE, ZMODIFICATIONDATE)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(2, 'b', 'y', 'uuid-2', 700_000_000, 700_000_000);
      expect(checkDrift(bearDb, state.driftKey)).toBe(true);
    } finally {
      bearDb.close();
    }
  });

  it('returns true when a note is modified (max changes)', () => {
    const bearDb = buildSyntheticBearDb([
      { pk: 1, title: 'a', text: 'x', modified: 700_000_000 },
      { pk: 2, title: 'b', text: 'y', modified: 700_000_001 },
    ]);
    try {
      const state = buildIndex(bearDb);
      state.memDb.close();
      bearDb.prepare('UPDATE ZSFNOTE SET ZMODIFICATIONDATE = ? WHERE Z_PK = ?').run(700_000_500, 2);
      expect(checkDrift(bearDb, state.driftKey)).toBe(true);
    } finally {
      bearDb.close();
    }
  });

  it('returns true when a note is deleted (count changes)', () => {
    const bearDb = buildSyntheticBearDb([
      { pk: 1, title: 'a', text: 'x', modified: 700_000_000 },
      { pk: 2, title: 'b', text: 'y', modified: 700_000_001 },
    ]);
    try {
      const state = buildIndex(bearDb);
      state.memDb.close();
      bearDb.prepare('UPDATE ZSFNOTE SET ZTRASHED = 1 WHERE Z_PK = ?').run(2);
      expect(checkDrift(bearDb, state.driftKey)).toBe(true);
    } finally {
      bearDb.close();
    }
  });
});

describe('executeQuery', () => {
  afterEach(() => reset());

  function withFixture<T>(notes: SyntheticNote[], fn: (memDb: DatabaseSync) => T): T {
    const bearDb = buildSyntheticBearDb(notes);
    try {
      const state = buildIndex(bearDb);
      try {
        return fn(state.memDb);
      } finally {
        state.memDb.close();
      }
    } finally {
      bearDb.close();
    }
  }

  it('returns phrase exact matches and excludes near-misses', () => {
    withFixture(
      [
        { pk: 1, title: 'A', text: 'a strong firm and professional posture' },
        { pk: 2, title: 'B', text: 'firm but professional, not exact' },
        { pk: 3, title: 'C', text: 'unrelated content' },
      ],
      (memDb) => {
        const results = executeQuery(memDb, spec({ term: '"firm and professional"' }));
        expect(results.map((r) => r.identifier)).toEqual(['uuid-1']);
      }
    );
  });

  it('multi-word query density-ranks via BM25 (not mod-date)', () => {
    // Both notes contain all three query tokens. Dense is older but has many
    // occurrences; Sparse is newer but has one occurrence of each token. A
    // mod-date ordering would put Sparse first; BM25 puts Dense first because
    // of the much higher term density. Since both notes contain all three
    // tokens, this isolates the BM25-vs-mod-date axis from the OR-rank /
    // partial-overlap axis (covered by the next test).
    withFixture(
      [
        {
          pk: 1,
          title: 'Dense',
          text: 'professional posture interview professional interview professional posture',
          modified: 700_000_000, // older
        },
        {
          pk: 2,
          title: 'Sparse',
          text: 'professional standalone. somewhere later, posture appears. and finally, interview.',
          modified: 700_999_999, // newer
        },
      ],
      (memDb) => {
        const results = executeQuery(memDb, spec({ term: 'professional posture interview' }));
        // Both must match; Dense must come first. If ORDER BY bm25(notes) is
        // removed and ordering reverts to mod-date DESC, Sparse would land
        // first and this assertion would fail — that's the regression guard.
        expect(results.map((r) => r.identifier)).toEqual(['uuid-1', 'uuid-2']);
      }
    );
  });

  it('multi-word natural query OR-ranks: notes missing one term still match', () => {
    // Regression guard for the FTS5 implicit-AND trap: under the bare-AND
    // default, a note missing any single query token would be filtered out
    // before BM25 ever runs, even if it densely matches the other tokens.
    // prepareFTS5Term tokenizes bare multi-word input and OR-joins it so
    // BM25 ranks by overlap density — the full-overlap note ranks first,
    // the partial-overlap note still appears, the no-overlap note doesn't.
    withFixture(
      [
        { pk: 1, title: 'Full', text: 'alphafruit betafruit gammafruit' },
        { pk: 2, title: 'Partial', text: 'alphafruit betafruit no third token here' },
        { pk: 3, title: 'Other', text: 'unrelated content with no overlap whatsoever' },
      ],
      (memDb) => {
        const results = executeQuery(memDb, spec({ term: 'alphafruit betafruit gammafruit' }));
        const ids = results.map((r) => r.identifier);
        expect(ids).toContain('uuid-1');
        expect(ids).toContain('uuid-2'); // would be missing under implicit-AND
        expect(ids).not.toContain('uuid-3');
        // Density rank: Full (3 of 3) before Partial (2 of 3).
        expect(ids.indexOf('uuid-1')).toBeLessThan(ids.indexOf('uuid-2'));
      }
    );
  });

  it('supports prefix matching with *', () => {
    withFixture(
      [
        { pk: 1, title: 'A', text: 'professional career' },
        { pk: 2, title: 'B', text: 'profession statements' },
        { pk: 3, title: 'C', text: 'unrelated content' },
      ],
      (memDb) => {
        const results = executeQuery(memDb, spec({ term: 'profess*' }));
        expect(new Set(results.map((r) => r.identifier))).toEqual(new Set(['uuid-1', 'uuid-2']));
      }
    );
  });

  it('supports NOT operator', () => {
    withFixture(
      [
        { pk: 1, title: 'A', text: 'apple banana' },
        { pk: 2, title: 'B', text: 'apple cherry' },
        { pk: 3, title: 'C', text: 'banana cherry' },
      ],
      (memDb) => {
        const results = executeQuery(memDb, spec({ term: 'apple NOT banana' }));
        expect(results.map((r) => r.identifier)).toEqual(['uuid-2']);
      }
    );
  });

  it('handles tag-only search with hierarchical match', () => {
    withFixture(
      [
        { pk: 1, title: 'Career root', tags: ['career'] },
        { pk: 2, title: 'Career meeting', tags: ['career/meetings'] },
        { pk: 3, title: 'Different tag', tags: ['personal'] },
      ],
      (memDb) => {
        const results = executeQuery(memDb, spec({ tag: 'career' }));
        expect(new Set(results.map((r) => r.identifier))).toEqual(new Set(['uuid-1', 'uuid-2']));
      }
    );
  });

  it('matches non-ASCII tags with Unicode case folding (regression: SQLite LOWER is ASCII-only)', () => {
    // SQLite's built-in LOWER() leaves CAFÉ as cafÉ (ASCII-only fold) while
    // JS toLowerCase folds to café. Tag normalization runs entirely in JS via
    // decodeTagName so the index side and the query side agree on Unicode-
    // uppercased tag names. Without that, a Bear tag stored as `+CAFÉ`
    // would silently fail to match any case variant of the query.
    withFixture([{ pk: 1, title: 'Coffee log', tags: ['CAFÉ'] }], (memDb) => {
      const lowerHit = executeQuery(memDb, spec({ tag: 'café' }));
      expect(lowerHit.map((r) => r.identifier)).toEqual(['uuid-1']);

      const upperHit = executeQuery(memDb, spec({ tag: 'CAFÉ' }));
      expect(upperHit.map((r) => r.identifier)).toEqual(['uuid-1']);
    });
  });

  it('handles modified-date range filter without term', () => {
    withFixture(
      [
        { pk: 1, title: 'Old', text: 'a', modified: isoToCoreData('2026-01-01T00:00:00Z') },
        { pk: 2, title: 'New', text: 'b', modified: isoToCoreData('2026-04-15T00:00:00Z') },
      ],
      (memDb) => {
        const results = executeQuery(
          memDb,
          spec({ modifiedAfterTimestamp: isoToCoreData('2026-03-01T00:00:00Z') })
        );
        expect(results.map((r) => r.identifier)).toEqual(['uuid-2']);
      }
    );
  });

  it('handles pinned-only filter (globally pinned OR pinned in any tag)', () => {
    withFixture(
      [
        { pk: 1, title: 'Globally pinned', pinned: true },
        { pk: 2, title: 'Pinned in tag', tags: ['x'], pinnedInTags: ['x'] },
        { pk: 3, title: 'Not pinned', tags: ['x'] },
      ],
      (memDb) => {
        const results = executeQuery(memDb, spec({ pinned: true }));
        expect(new Set(results.map((r) => r.identifier))).toEqual(new Set(['uuid-1', 'uuid-2']));
      }
    );
  });

  it('pinned + tag returns notes pinned IN the tag, not globally pinned', () => {
    // Distinct branch in buildFilterClauses: when both `pinned: true` and
    // `tag: '...'` are set, the filter restricts to pinned_in_tag = 1 for
    // that specific tag — semantically different from "globally pinned".
    // A regression that turned the AND into OR or flipped pinned_in_tag = 0
    // would silently produce wrong results without this test.
    withFixture(
      [
        { pk: 1, title: 'Globally pinned, tagged x', pinned: true, tags: ['x'] },
        { pk: 2, title: 'Pinned in x', tags: ['x'], pinnedInTags: ['x'] },
        { pk: 3, title: 'Tagged x but not pinned', tags: ['x'] },
        { pk: 4, title: 'Pinned in y, also tagged x', tags: ['x', 'y'], pinnedInTags: ['y'] },
      ],
      (memDb) => {
        const results = executeQuery(memDb, spec({ tag: 'x', pinned: true }));
        expect(results.map((r) => r.identifier)).toEqual(['uuid-2']);
      }
    );
  });

  it('composes term + tag filters', () => {
    withFixture(
      [
        { pk: 1, title: 'A', text: 'common phrase here', tags: ['career'] },
        { pk: 2, title: 'B', text: 'common phrase here', tags: ['personal'] },
      ],
      (memDb) => {
        const results = executeQuery(memDb, spec({ term: 'common phrase', tag: 'career' }));
        expect(results.map((r) => r.identifier)).toEqual(['uuid-1']);
      }
    );
  });

  it('respects limit and orders by relevance with term, mod-date desc without', () => {
    withFixture(
      [
        { pk: 1, title: 'A', text: 'apple', modified: 700_000_001 },
        { pk: 2, title: 'B', text: 'apple', modified: 700_000_002 },
        { pk: 3, title: 'C', text: 'apple', modified: 700_000_003 },
      ],
      (memDb) => {
        // totalCount must reflect the full match count even when limit truncates
        // notes — note-tools.ts surfaces it to the LLM as a pagination hint
        // ("Use bear-search-notes with limit: ${totalCount} to get all results").
        // countMatches and executeQueryWithCount build their WHERE clauses
        // through the same buildFilterClauses helper but are independent
        // queries, so this assertion locks them in step.
        const limited = executeQueryWithCount(memDb, { limit: 2, term: 'apple' });
        expect(limited.notes).toHaveLength(2);
        expect(limited.totalCount).toBe(3);

        const noTerm = executeQuery(memDb, {
          limit: 5,
          modifiedAfterTimestamp: 0,
        });
        expect(noTerm.map((r) => r.identifier)).toEqual(['uuid-3', 'uuid-2', 'uuid-1']);
      }
    );
  });

  it('reports totalCount = 0 when no notes match the term', () => {
    withFixture(
      [
        { pk: 1, title: 'A', text: 'apple' },
        { pk: 2, title: 'B', text: 'banana' },
      ],
      (memDb) => {
        const result = executeQueryWithCount(memDb, spec({ term: 'cherry' }));
        expect(result.notes).toHaveLength(0);
        expect(result.totalCount).toBe(0);
      }
    );
  });

  it('reports totalCount for filter-only queries (no term, limit < matches)', () => {
    withFixture(
      [
        { pk: 1, title: 'A', tags: ['career'] },
        { pk: 2, title: 'B', tags: ['career'] },
        { pk: 3, title: 'C', tags: ['career'] },
        { pk: 4, title: 'D', tags: ['personal'] },
      ],
      (memDb) => {
        const result = executeQueryWithCount(memDb, { limit: 2, tag: 'career' });
        expect(result.notes).toHaveLength(2);
        expect(result.totalCount).toBe(3);
      }
    );
  });

  it('returns wide snippet (>= 64 chars) with matched term in brackets', () => {
    withFixture(
      [
        {
          pk: 1,
          title: 'A',
          text:
            'Lorem ipsum dolor sit amet, consectetur adipiscing elit. The uniquetargettoken ' +
            'appears here in the middle of plenty of surrounding context that should make for ' +
            'a usable snippet width without follow-up body fetches.',
        },
      ],
      (memDb) => {
        const [result] = executeQuery(memDb, spec({ term: 'uniquetargettoken' }));
        expect(result.snippet).toBeDefined();
        expect(result.snippet).toContain('[uniquetargettoken]');
        expect(result.snippet!.length).toBeGreaterThanOrEqual(64);
      }
    );
  });

  it('highlights matches in OCR text when body has no matches', () => {
    // OCR text comes from ZSFNOTEFILE.ZSEARCHTEXT (a separate column from
    // body), so a column-pinned snippet() would return the body prefix with
    // no [match] markers. snippet(notes, -1, ...) auto-picks the column with
    // the match, so OCR-only matches still get highlighted snippets.
    withFixture(
      [
        {
          pk: 1,
          title: 'Receipt scan',
          text: 'this body has nothing to do with the search',
          ocrTexts: [
            'Date 2026-04-15 Vendor Acme Corp Total 42.00 ' +
              'ocronlymarker appears here only in the OCR-extracted text from the attached image',
          ],
        },
      ],
      (memDb) => {
        const [result] = executeQuery(memDb, spec({ term: 'ocronlymarker' }));
        expect(result.snippet).toBeDefined();
        expect(result.snippet).toContain('[ocronlymarker]');
      }
    );
  });

  it('strips incidental punctuation from terms (brackets, hyphens) and OR-ranks tokens', () => {
    withFixture(
      [
        {
          pk: 1,
          title: '[Bear-MCP-stest] Sample 1234',
          text: 'this note has bracketed prefix in the title',
        },
        { pk: 2, title: 'unrelated note', text: 'no special chars here' },
      ],
      (memDb) => {
        // Brackets, hyphens, and digits would all break a verbatim FTS5 query;
        // prepareFTS5Term tokenizes via \w+\*?, dropping the punctuation, and
        // OR-joins the resulting tokens so BM25 ranks by overlap density.
        const a = executeQuery(memDb, spec({ term: '[Bear-MCP-stest] Sample 1234' }));
        expect(a.map((r) => r.identifier)).toEqual(['uuid-1']);

        // Bare two-word query exercises the same tokenize+OR-join path.
        const b = executeQuery(memDb, spec({ term: 'bracketed prefix' }));
        expect(b.map((r) => r.identifier)).toEqual(['uuid-1']);
      }
    );
  });

  it('hyphenated multi-word natural query OR-ranks (SVA-28 eval regression: phrase-lock made these silent zero-hits)', () => {
    // The SVA-28 A/B eval showed 37 of 51 hyphen/colon-containing v3.0.0
    // search calls returning zero hits because the prior phrase-quote branch
    // turned the agent's natural punctuation into rigid token-order phrase
    // matches. The fix removes the phrase-quote fallback for natural-language
    // input; this fixture guards against a regression that re-introduces it.
    withFixture(
      [
        {
          pk: 1,
          title: 'Common problems managing senior engineers',
          text: 'tactics for the over-engineer who looks for complexity when there is none',
        },
        // No overlap with any query token — would-be zero-hit reference.
        { pk: 2, title: 'Unrelated topic', text: 'weather forecast tomorrow rainy' },
      ],
      (memDb) => {
        const ids = executeQuery(
          memDb,
          spec({ term: 'over-engineering coaching senior engineer' })
        ).map((r) => r.identifier);
        // Under the old phrase-quote behavior, ids would be empty — the
        // hyphen forced a literal token-order match that no fixture row
        // satisfies. Under the fix, the semantically matching note surfaces.
        expect(ids).toContain('uuid-1');
        expect(ids).not.toContain('uuid-2');
      }
    );
  });

  // isFTS5SyntaxError matches several distinct SQLite error shapes — each gets
  // remapped to the same operator-hint envelope. Cover representative inputs
  // for the major patterns so a regression that drops one match arm surfaces
  // in tests rather than as a raw SQL error reaching the LLM.
  it.each([
    { name: 'unterminated string (unbalanced quote)', term: '"unbalanced' },
    { name: 'no such column (parenthesised colon-prefix)', term: '(fakecol:value)' },
    { name: 'fts5/syntax error (empty NEAR)', term: 'hello NEAR()' },
  ])('throws a structured error on malformed FTS5 query: $name', ({ term }) => {
    withFixture([{ pk: 1, title: 'A', text: 'hello' }], (memDb) => {
      expect(() => executeQuery(memDb, spec({ term }))).toThrow(/Search query syntax error/);
      expect(() => executeQuery(memDb, spec({ term }))).toThrow(/Supported operators/);
    });
  });
});

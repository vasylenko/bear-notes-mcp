import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { CORE_DATA_EPOCH_OFFSET } from '../config.js';

import { type SearchSpec, __testing__ } from './fts-index.js';

const {
  buildIndex,
  checkDrift,
  ensureFreshIndex,
  executeQueryWithCount,
  getState,
  prepareFTS5Term,
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

// Owns the synthetic bear DB lifecycle without forcing buildIndex. Drift and
// ensureFreshIndex tests need bearDb available across build → mutate → check
// sequences, so the index lifecycle belongs inside the test body, not around it.
function withBearDb<T>(notes: SyntheticNote[], fn: (bearDb: DatabaseSync) => T): T {
  const bearDb = buildSyntheticBearDb(notes);
  try {
    return fn(bearDb);
  } finally {
    bearDb.close();
  }
}

// Build-and-inspect wrapper for tests that only assert on the freshly built
// index. Composes withBearDb so both DB and memDb close even if assertions throw.
function withFixture<T>(notes: SyntheticNote[], fn: (memDb: DatabaseSync) => T): T {
  return withBearDb(notes, (bearDb) => {
    const state = buildIndex(bearDb);
    try {
      return fn(state.memDb);
    } finally {
      state.memDb.close();
    }
  });
}

// Common shape for "given fixture + term, expect this exact ranked id list."
// Most query-behavior tests follow this pattern; collapsing it into a helper
// keeps each `it` focused on the input/output contract rather than wiring.
// Tests with non-`toEqual` assertions (e.g. partial-overlap matches) keep
// their own body since they encode different semantics.
function expectQueryMatches(notes: SyntheticNote[], term: string, expectedIds: string[]): void {
  withFixture(notes, (memDb) => {
    const ids = executeQueryWithCount(memDb, spec({ term })).notes.map((r) => r.identifier);
    expect(ids).toEqual(expectedIds);
  });
}

describe('buildIndex', () => {
  afterEach(() => reset());

  it('builds an FTS5 index from non-trashed/non-archived/non-encrypted notes', () => {
    withFixture(
      [
        { pk: 1, title: 'Active note one', text: 'hello world' },
        { pk: 2, title: 'Active note two', text: 'goodbye world' },
        { pk: 3, title: 'Trashed note', text: 'should be excluded', trashed: true },
        { pk: 4, title: 'Archived note', text: 'should be excluded', archived: true },
        { pk: 5, title: 'Encrypted note', text: 'should be excluded', encrypted: true },
      ],
      (memDb) => {
        const count = (
          memDb.prepare('SELECT COUNT(*) AS c FROM notes').get() as unknown as { c: number }
        ).c;
        expect(count).toBe(2);
      }
    );
  });

  it('captures OCR text from attached files into the ocr column', () => {
    withFixture(
      [
        {
          pk: 1,
          title: 'Note with image',
          text: 'short body',
          ocrTexts: ['extracted text from photo', 'second attachment ocr'],
        },
      ],
      (memDb) => {
        const row = memDb
          .prepare("SELECT ocr FROM notes WHERE bear_id = 'uuid-1'")
          .get() as unknown as { ocr: string };
        expect(row.ocr).toContain('extracted text from photo');
        expect(row.ocr).toContain('second attachment ocr');
      }
    );
  });

  it('populates note_tags with decoded tag names and pinned-in-tag flags', () => {
    withFixture(
      [
        {
          pk: 1,
          title: 'Career note',
          // Bear stores tags URL-encoded with + for spaces; decoding maps to lowercase trimmed.
          tags: ['Career', 'Career/My+Meetings'],
          pinnedInTags: ['Career/My+Meetings'],
        },
      ],
      (memDb) => {
        const tagRows = memDb
          .prepare('SELECT tag, pinned_in_tag FROM note_tags WHERE rowid = 1 ORDER BY tag')
          .all() as unknown as Array<{ tag: string; pinned_in_tag: number }>;
        expect(tagRows).toEqual([
          { tag: 'career', pinned_in_tag: 0 },
          { tag: 'career/my meetings', pinned_in_tag: 1 },
        ]);
      }
    );
  });

  it('marks pinned-globally-OR-in-any-tag in the notes.pinned column', () => {
    withFixture(
      [
        { pk: 1, title: 'Globally pinned', pinned: true },
        { pk: 2, title: 'Pinned in tag', tags: ['x'], pinnedInTags: ['x'] },
        { pk: 3, title: 'Not pinned', tags: ['x'] },
      ],
      (memDb) => {
        const rows = memDb
          .prepare('SELECT rowid, pinned FROM notes ORDER BY rowid')
          .all() as unknown as Array<{ rowid: number; pinned: number }>;
        expect(rows).toEqual([
          { rowid: 1, pinned: 1 },
          { rowid: 2, pinned: 1 },
          { rowid: 3, pinned: 0 },
        ]);
      }
    );
  });
});

describe('ensureFreshIndex', () => {
  afterEach(() => reset());

  it('leaves state = null when buildIndex throws after closing the previous index', () => {
    withBearDb([{ pk: 1, title: 'note', text: 'content', modified: 700_000_000 }], (bearDb) => {
      // Step 1: populate state with a valid build.
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
    });
  });

  it('rebuilds successfully on the next call after a previous rebuild failure', () => {
    // Verifies the recovery half of the invariant: once state is null,
    // a subsequent ensureFreshIndex against a healthy DB rebuilds cleanly.
    withBearDb([{ pk: 1, title: 'a', text: 'x', modified: 700_000_000 }], (brokenDb) => {
      withBearDb(
        [{ pk: 1, title: 'recovered', text: 'works again', modified: 700_000_001 }],
        (healthyDb) => {
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
            state!.memDb.prepare('SELECT COUNT(*) AS c FROM notes').get() as unknown as {
              c: number;
            }
          ).c;
          expect(count).toBe(1);
        }
      );
    });
  });
});

describe('checkDrift', () => {
  afterEach(() => reset());

  it('returns false when neither MAX(modified) nor COUNT changed', () => {
    withBearDb(
      [
        { pk: 1, title: 'a', text: 'x', modified: 700_000_000 },
        { pk: 2, title: 'b', text: 'y', modified: 700_000_001 },
      ],
      (bearDb) => {
        const state = buildIndex(bearDb);
        state.memDb.close();
        expect(checkDrift(bearDb, state.driftKey)).toBe(false);
      }
    );
  });

  // Each mutation flips one column of the cached (MAX(modified), COUNT(*))
  // pair: add/trash change count; modify changes max. Pinning the cases to
  // the same single-note fixture isolates the drift signal from fixture shape.
  it.each([
    {
      name: 'note added (count changes)',
      mutate: (db: DatabaseSync) =>
        db
          .prepare(
            `INSERT INTO ZSFNOTE (Z_PK, ZTITLE, ZTEXT, ZUNIQUEIDENTIFIER, ZCREATIONDATE, ZMODIFICATIONDATE)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(2, 'b', 'y', 'uuid-2', 700_000_000, 700_000_000),
    },
    {
      name: 'note modified (max changes)',
      mutate: (db: DatabaseSync) =>
        db.prepare('UPDATE ZSFNOTE SET ZMODIFICATIONDATE = ? WHERE Z_PK = ?').run(700_000_500, 1),
    },
    {
      name: 'note trashed (count changes)',
      mutate: (db: DatabaseSync) =>
        db.prepare('UPDATE ZSFNOTE SET ZTRASHED = 1 WHERE Z_PK = ?').run(1),
    },
  ])('returns true when $name', ({ mutate }) => {
    withBearDb([{ pk: 1, title: 'a', text: 'x', modified: 700_000_000 }], (bearDb) => {
      const state = buildIndex(bearDb);
      state.memDb.close();
      mutate(bearDb);
      expect(checkDrift(bearDb, state.driftKey)).toBe(true);
    });
  });
});

describe('executeQueryWithCount', () => {
  afterEach(() => reset());

  it('multi-word natural query: notes missing one term still match (OR-join, not implicit AND)', () => {
    // Regression guard for the FTS5 implicit-AND trap: under the bare-AND
    // default, a note missing any single query token would be filtered out
    // even if it densely matches the other tokens. prepareFTS5Term tokenizes
    // bare multi-word input and OR-joins it so partial-overlap notes still
    // surface; relevance ranking is covered by the eval suite, not asserted
    // here.
    withFixture(
      [
        { pk: 1, title: 'Full', text: 'alphafruit betafruit gammafruit' },
        { pk: 2, title: 'Partial', text: 'alphafruit betafruit no third token here' },
        { pk: 3, title: 'Other', text: 'unrelated content with no overlap whatsoever' },
      ],
      (memDb) => {
        const results = executeQueryWithCount(
          memDb,
          spec({ term: 'alphafruit betafruit gammafruit' })
        ).notes;
        const ids = results.map((r) => r.identifier);
        expect(ids).toContain('uuid-1');
        expect(ids).toContain('uuid-2'); // would be missing under implicit-AND
        expect(ids).not.toContain('uuid-3');
      }
    );
  });

  it('handles tag-only search with hierarchical match (and excludes prefix-overlap)', () => {
    // Issue #67 regression: a top-level tag whose name happens to start with
    // the query (`careerist`) must NOT match a `career` search. The
    // hierarchical predicate's `/%` suffix makes the difference; a naive
    // `tag LIKE 'career%'` would over-match and silently leak unrelated tags.
    withFixture(
      [
        { pk: 1, title: 'Career root', tags: ['career'] },
        { pk: 2, title: 'Career meeting', tags: ['career/meetings'] },
        { pk: 3, title: 'Careerist note', tags: ['careerist'] },
        { pk: 4, title: 'Different tag', tags: ['personal'] },
      ],
      (memDb) => {
        const results = executeQueryWithCount(memDb, spec({ tag: 'career' })).notes;
        const ids = new Set(results.map((r) => r.identifier));
        expect(ids).toEqual(new Set(['uuid-1', 'uuid-2']));
        expect(ids).not.toContain('uuid-3'); // prefix-overlap excluded
      }
    );
  });

  it('attaches decoded tags to each result, omits the field for untagged notes', () => {
    // Coverage for fetchTagsForResults: every other query test asserts
    // on `r.identifier` and ignores the tag-attach pipeline (rowid →
    // GROUP_CONCAT in note_tags → split → result.tags). A regression that
    // dropped or mis-decoded that path would surface only at the system level
    // without this guard. The untagged branch also locks in the formatter
    // contract: result.tags is undefined (not []) when a note has no tags, so
    // the response formatter's `if (note.tags && note.tags.length > 0)` check
    // works as intended.
    withFixture(
      [
        // Indexed tag names are decoded at build time, so `My+Cool+Tag` lands
        // in note_tags as `my cool tag` — the assertion proves that decoding
        // survives the tag-attach roundtrip.
        { pk: 1, title: 'Tagged note', tags: ['career', 'My+Cool+Tag'] },
        { pk: 2, title: 'Untagged note' },
      ],
      (memDb) => {
        const tagged = executeQueryWithCount(memDb, spec({ term: 'tagged' })).notes;
        expect(tagged).toHaveLength(1);
        expect(tagged[0].tags).toEqual(expect.arrayContaining(['career', 'my cool tag']));

        const untagged = executeQueryWithCount(memDb, spec({ term: 'untagged' })).notes;
        expect(untagged).toHaveLength(1);
        expect(untagged[0].tags).toBeUndefined();
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
      const lowerHit = executeQueryWithCount(memDb, spec({ tag: 'café' })).notes;
      expect(lowerHit.map((r) => r.identifier)).toEqual(['uuid-1']);

      const upperHit = executeQueryWithCount(memDb, spec({ tag: 'CAFÉ' })).notes;
      expect(upperHit.map((r) => r.identifier)).toEqual(['uuid-1']);
    });
  });

  // ASCII \w drops é/ï and skips Cyrillic/Greek/CJK entirely, producing silent
  // zero-hits. One Latin-with-diacritic case + one non-Latin case pin both
  // failure modes; SQLite's tokenizer applies the same fold rules to index
  // and query, so any \p{L} script that survives on one side survives on both.
  it.each([
    { name: 'accented Latin (café)', body: 'meeting at the café', term: 'café' },
    { name: 'Cyrillic', body: 'привет мир', term: 'привет' },
  ])('term-side tokenizer matches Unicode body content: $name', ({ body, term }) => {
    withFixture([{ pk: 1, title: 'note', text: body }], (memDb) => {
      const hit = executeQueryWithCount(memDb, spec({ term })).notes;
      expect(hit.map((r) => r.identifier)).toEqual(['uuid-1']);
    });
  });

  it('matches `+`-encoded tag names from the query side (decodeTagName drives both sides)', () => {
    // Bear stores tag names with `+` standing in for spaces (URL-encoding
    // convention used by the x-callback API and reflected in ZSFNOTETAG.ZTITLE
    // for multi-word tags). The index side calls decodeTagName so a stored
    // `My+Cool+Tag` lands in note_tags as `my cool tag`. If the query side
    // skipped the `+` → space step, an agent or caller passing the same
    // encoded form back as `tag: 'My+Cool+Tag'` would fall through to a
    // literal `my+cool+tag` filter and silently miss the note.
    withFixture([{ pk: 1, title: 'Multiword tag', tags: ['My+Cool+Tag'] }], (memDb) => {
      // Encoded query form (most likely to appear when an agent copies a tag
      // out of a Bear x-callback URL).
      const encodedHit = executeQueryWithCount(memDb, spec({ tag: 'My+Cool+Tag' })).notes;
      expect(encodedHit.map((r) => r.identifier)).toEqual(['uuid-1']);

      // Human-readable query form.
      const decodedHit = executeQueryWithCount(memDb, spec({ tag: 'my cool tag' })).notes;
      expect(decodedHit.map((r) => r.identifier)).toEqual(['uuid-1']);
    });
  });

  it('handles modified-date range filter without term', () => {
    withFixture(
      [
        { pk: 1, title: 'Old', text: 'a', modified: isoToCoreData('2026-01-01T00:00:00Z') },
        { pk: 2, title: 'New', text: 'b', modified: isoToCoreData('2026-04-15T00:00:00Z') },
      ],
      (memDb) => {
        const results = executeQueryWithCount(
          memDb,
          spec({ modifiedAfterTimestamp: isoToCoreData('2026-03-01T00:00:00Z') })
        ).notes;
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
        const results = executeQueryWithCount(memDb, spec({ pinned: true })).notes;
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
        const results = executeQueryWithCount(memDb, spec({ tag: 'x', pinned: true })).notes;
        expect(results.map((r) => r.identifier)).toEqual(['uuid-2']);
      }
    );
  });

  it('pinned + parent tag matches notes pinned in child tags (hierarchical)', () => {
    // Regression guard: the pinned-branch must apply the same `tag = X OR
    // tag LIKE 'X/%'` hierarchical match the tag-only branch uses. The
    // pre-fix v3.0.0 code matched only `tag = X` exactly in this branch,
    // silently dropping notes pinned under any child of the queried parent.
    // Equivalent to the prior SQL implementation's behavior in the
    // Z_5PINNEDINTAGS join path (commit b24ec44).
    withFixture(
      [
        { pk: 1, title: 'Pinned in career', tags: ['career'], pinnedInTags: ['career'] },
        {
          pk: 2,
          title: 'Pinned in career/meetings',
          tags: ['career/meetings'],
          pinnedInTags: ['career/meetings'],
        },
        // Different top-level tag whose name happens to start with the query
        // — a naive `tag LIKE 'career%'` would over-match this; the `/%`
        // suffix in the predicate excludes it. Guard against that variant.
        { pk: 3, title: 'Pinned in careerist', tags: ['careerist'], pinnedInTags: ['careerist'] },
        // Tagged under career but not pinned anywhere → must not match.
        { pk: 4, title: 'Tagged career, not pinned', tags: ['career/meetings'] },
      ],
      (memDb) => {
        const results = executeQueryWithCount(memDb, spec({ tag: 'career', pinned: true })).notes;
        expect(new Set(results.map((r) => r.identifier))).toEqual(new Set(['uuid-1', 'uuid-2']));
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
        const results = executeQueryWithCount(
          memDb,
          spec({ term: 'common phrase', tag: 'career' })
        ).notes;
        expect(results.map((r) => r.identifier)).toEqual(['uuid-1']);
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
        const [result] = executeQueryWithCount(memDb, spec({ term: 'ocronlymarker' })).notes;
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
        const a = executeQueryWithCount(
          memDb,
          spec({ term: '[Bear-MCP-stest] Sample 1234' })
        ).notes;
        expect(a.map((r) => r.identifier)).toEqual(['uuid-1']);

        // Bare two-word query exercises the same tokenize+OR-join path.
        const b = executeQueryWithCount(memDb, spec({ term: 'bracketed prefix' })).notes;
        expect(b.map((r) => r.identifier)).toEqual(['uuid-1']);
      }
    );
  });

  // Phrase-quote heuristic for no-whitespace identifiers (slugs, dates):
  // restores v2.11.0 substring-match semantics. Without it, OR-rank
  // fallthrough would flood with notes containing any single token —
  // e.g. "bear" alone matching `bear-notes-mcp`, or "2026" alone matching
  // `2026-04-15`. unicode61 tokenizes hyphen- and space-separated forms
  // identically, so the phrase-quote matches both indexed shapes.
  it.each([
    {
      name: 'hyphenated identifier (slug)',
      fixture: [
        { pk: 1, title: 'Project notes', text: 'working on bear-notes-mcp this week' },
        { pk: 2, title: 'Bear sightings', text: 'I saw a bear in the woods' },
        { pk: 3, title: 'Other', text: 'notes about an unrelated mcp library' },
      ],
      term: 'bear-notes-mcp',
    },
    {
      name: 'date-style identifier (digits + hyphens)',
      fixture: [
        { pk: 1, title: 'Daily log', text: 'meeting on 2026-04-15 covered Q2 goals' },
        { pk: 2, title: 'Year recap', text: 'looking back at 2026 highlights' },
      ],
      term: '2026-04-15',
    },
  ])(
    'phrase-quotes single-identifier input so it matches the consecutive sequence: $name',
    ({ fixture, term }) => {
      expectQueryMatches(fixture, term, ['uuid-1']);
    }
  );

  it('falls through to OR-rank when any token carries a prefix wildcard (FTS5 phrase rule)', () => {
    // FTS5 phrase syntax allows `*` only at the end of the LAST token. The
    // identifier-branch guard skips phrase-quoting whenever any token has
    // `*`, so the multi-token wildcard query stays valid as OR-joined input.
    // Without the guard, prepareFTS5Term would produce invalid `"profess
    // engineer*"` shaped phrases on inputs like `profess-engineer*` (token
    // count > 1) and surface as a syntax error to the caller.
    // Tokenizes to [profess, engineer*] then OR-joins; note 1 matches via
    // "profess" and "engineering" (prefix match), note 2 doesn't.
    expectQueryMatches(
      [
        { pk: 1, title: 'A', text: 'profess and engineering' },
        { pk: 2, title: 'B', text: 'unrelated content' },
      ],
      'profess-engineer*',
      ['uuid-1']
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
        const ids = executeQueryWithCount(
          memDb,
          spec({ term: 'over-engineering coaching senior engineer' })
        ).notes.map((r) => r.identifier);
        // Under the old phrase-quote behavior, ids would be empty — the
        // hyphen forced a literal token-order match that no fixture row
        // satisfies. Under the fix, the semantically matching note surfaces.
        expect(ids).toContain('uuid-1');
        expect(ids).not.toContain('uuid-2');
      }
    );
  });

  // isFTS5SyntaxError matches several distinct SQLite error shapes — each gets
  // remapped to the same user-facing envelope (operator-free; users/agents
  // are positioned away from FTS5 syntax — see fts5SyntaxError comment).
  // Cover representative inputs for the major patterns so a regression that
  // drops one match arm surfaces in tests rather than as a raw SQL error.
  it.each([
    { name: 'unterminated string (unbalanced quote)', term: '"unbalanced' },
    { name: 'no such column (parenthesised colon-prefix)', term: '(fakecol:value)' },
    { name: 'fts5/syntax error (empty NEAR)', term: 'hello NEAR()' },
    { name: 'unknown special query (bare wildcard)', term: '*' },
  ])('throws an operator-free structured error on malformed FTS5 query: $name', ({ term }) => {
    withFixture([{ pk: 1, title: 'A', text: 'hello' }], (memDb) => {
      let thrown: Error | undefined;
      try {
        executeQueryWithCount(memDb, spec({ term }));
      } catch (e) {
        thrown = e as Error;
      }
      expect(thrown?.message).toMatch(/Search query couldn't be processed/);
      expect(thrown?.message).toMatch(/Try simplifying/);
      // Underlying SQLite text must not leak — see fts5SyntaxError comment.
      expect(thrown?.message).not.toMatch(/Underlying|fts5:|no such column|syntax error/i);
    });
  });
});

describe('prepareFTS5Term', () => {
  // The phrase/group passthrough and single-token wildcard branches each
  // bypass tokenization and return their input verbatim. They have no
  // integration coverage (the malformed-FTS5 system tests assert on the
  // error envelope, not on the passthrough decision), so a regression that
  // mangled either branch would surface only at user-query time.
  it.each([
    { name: 'phrase query', input: '"firm and professional"', expected: '"firm and professional"' },
    { name: 'single-token prefix wildcard', input: 'profess*', expected: 'profess*' },
  ])('passes %s through unchanged: $name', ({ input, expected }) => {
    expect(prepareFTS5Term(input)).toBe(expected);
  });

  // Bare uppercase AND/OR/NOT/NEAR would parse as FTS5 operators with no
  // operands; quoting forces literal-token semantics so the natural-language
  // stance survives both the single-token and OR-joined paths.
  it.each([
    { name: 'single bare operator', input: 'NOT', expected: '"NOT"' },
    {
      name: 'operator inline in multi-word OR-join',
      input: 'apple NOT banana',
      expected: 'apple OR "NOT" OR banana',
    },
  ])('quotes uppercase FTS5 operator keywords as literal tokens: $name', ({ input, expected }) => {
    expect(prepareFTS5Term(input)).toBe(expected);
  });
});

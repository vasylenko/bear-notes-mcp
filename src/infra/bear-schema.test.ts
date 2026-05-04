import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { discoverBearSchema } from './bear-schema.js';

// CI regression guard. The in-memory search index in src/infra/fts-index.ts depends on
// FTS5 being compiled into node:sqlite's bundled SQLite. Node 24.13+ ships SQLite with
// FTS5 enabled (verified on Node 24.14.1 / SQLite 3.51.2), but the bundled SQLite is
// outside our control — a future Node release could change build flags. This test
// fires loudly before the rest of the search subsystem panics with cryptic errors.
describe('node:sqlite FTS5 capability', () => {
  it('supports FTS5 with unicode61 remove_diacritics=2, snippet(), and bm25()', () => {
    const db = new DatabaseSync(':memory:');

    try {
      try {
        db.exec("CREATE VIRTUAL TABLE t USING fts5(c, tokenize='unicode61 remove_diacritics 2')");
      } catch (err) {
        throw new Error(
          'FTS5 is not available in this Node.js build of node:sqlite — ' +
            "bear-notes-mcp's search subsystem (src/infra/fts-index.ts) requires it. " +
            `Underlying SQLite error: ${(err as Error).message}`
        );
      }

      db.exec("INSERT INTO t(c) VALUES ('café'), ('cafe'), ('the quick brown fox')");

      // Diacritic folding: unicode61 with remove_diacritics=2 normalizes 'café' → 'cafe'
      // during tokenization, so a 'cafe' query matches both rows.
      const accentRows = db.prepare('SELECT rowid FROM t WHERE t MATCH ?').all('cafe') as Array<{
        rowid: number;
      }>;
      expect(accentRows).toHaveLength(2);

      // snippet() returns the matched span with bracket markers; bm25() returns a
      // negative score where more-negative means more-relevant.
      const matchRows = db
        .prepare(
          "SELECT rowid, snippet(t, 0, '[', ']', '...', 8) AS s, bm25(t) AS score FROM t WHERE t MATCH ?"
        )
        .all('fox') as Array<{ rowid: number; s: string; score: number }>;
      expect(matchRows).toHaveLength(1);
      expect(matchRows[0].s).toContain('[fox]');
      expect(matchRows[0].score).toBeLessThan(0);
    } finally {
      db.close();
    }
  });
});

interface SyntheticSchemaOptions {
  noteEntityId?: number;
  tagEntityId?: number;
  primaryKeyEntries?: Array<[string, number]>;
  includeTagsTable?: boolean;
  includePinnedTable?: boolean;
  /**
   * If set, the Z_<noteEntityId>TAGS table is created with the note-PK column
   * renamed to this value. Used to exercise verifyJoinExists's
   * "missing expected columns" branch (table exists but column shape diverges).
   */
  tagsTableNoteColOverride?: string;
}

// Builds an in-memory SQLite DB that mimics the Bear schema subset needed by
// discoverBearSchema. Defaults match a current Bear install (entity IDs 5/13).
// Override options to simulate renumbered or partial schemas in tests.
function buildSyntheticBearDb(opts: SyntheticSchemaOptions = {}): DatabaseSync {
  const noteEntityId = opts.noteEntityId ?? 5;
  const tagEntityId = opts.tagEntityId ?? 13;
  const primaryKeyEntries =
    opts.primaryKeyEntries ??
    ([
      ['SFNote', noteEntityId],
      ['SFNoteTag', tagEntityId],
    ] as Array<[string, number]>);
  const includeTagsTable = opts.includeTagsTable ?? true;
  const includePinnedTable = opts.includePinnedTable ?? true;

  const db = new DatabaseSync(':memory:');
  // Real Bear Z_PRIMARYKEY also has Z_SUPER and Z_MAX columns; included here
  // for fidelity though our discovery query reads only Z_ENT and Z_NAME.
  db.exec(`
    CREATE TABLE Z_PRIMARYKEY (
      Z_ENT INTEGER PRIMARY KEY,
      Z_NAME VARCHAR,
      Z_SUPER INTEGER,
      Z_MAX INTEGER
    );
  `);
  const insertEntity = db.prepare(
    'INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME, Z_SUPER, Z_MAX) VALUES (?, ?, 0, 0)'
  );
  for (const [name, ent] of primaryKeyEntries) {
    insertEntity.run(ent, name);
  }
  if (includeTagsTable) {
    const noteCol = opts.tagsTableNoteColOverride ?? `Z_${noteEntityId}NOTES`;
    db.exec(`
      CREATE TABLE Z_${noteEntityId}TAGS (
        ${noteCol} INTEGER,
        Z_${tagEntityId}TAGS INTEGER
      );
    `);
  }
  if (includePinnedTable) {
    db.exec(`
      CREATE TABLE Z_${noteEntityId}PINNEDINTAGS (
        Z_${noteEntityId}PINNEDNOTES INTEGER,
        Z_${tagEntityId}PINNEDINTAGS INTEGER
      );
    `);
  }
  return db;
}

describe('discoverBearSchema', () => {
  it('resolves the standard Bear schema (entity IDs 5 and 13)', () => {
    const db = buildSyntheticBearDb();
    try {
      const schema = discoverBearSchema(db);
      expect(schema).toEqual({
        noteToTagsJoin: {
          table: 'Z_5TAGS',
          noteCol: 'Z_5NOTES',
          tagCol: 'Z_13TAGS',
        },
        pinnedInTagsJoin: {
          table: 'Z_5PINNEDINTAGS',
          noteCol: 'Z_5PINNEDNOTES',
          tagCol: 'Z_13PINNEDINTAGS',
        },
      });
    } finally {
      db.close();
    }
  });

  it('resolves renumbered entity IDs (Bear schema migration scenario)', () => {
    const db = buildSyntheticBearDb({ noteEntityId: 4, tagEntityId: 12 });
    try {
      const schema = discoverBearSchema(db);
      // Resolved table/column names are the regression-proof signal that
      // discovery handled the renumbered entity IDs correctly.
      expect(schema.noteToTagsJoin.table).toBe('Z_4TAGS');
      expect(schema.noteToTagsJoin.noteCol).toBe('Z_4NOTES');
      expect(schema.noteToTagsJoin.tagCol).toBe('Z_12TAGS');
      expect(schema.pinnedInTagsJoin.table).toBe('Z_4PINNEDINTAGS');
      expect(schema.pinnedInTagsJoin.noteCol).toBe('Z_4PINNEDNOTES');
      expect(schema.pinnedInTagsJoin.tagCol).toBe('Z_12PINNEDINTAGS');
    } finally {
      db.close();
    }
  });

  it('throws a clear error when SFNote entity is missing from Z_PRIMARYKEY', () => {
    const db = buildSyntheticBearDb({
      primaryKeyEntries: [['SFNoteTag', 13]],
    });
    try {
      expect(() => discoverBearSchema(db)).toThrow(/required Core Data entities not found/);
      expect(() => discoverBearSchema(db)).toThrow(/SFNote/);
    } finally {
      db.close();
    }
  });

  it('throws a clear error when the tag-join table is missing', () => {
    const db = buildSyntheticBearDb({ includeTagsTable: false });
    try {
      expect(() => discoverBearSchema(db)).toThrow(/Z_5TAGS not found/);
    } finally {
      db.close();
    }
  });

  it('throws a clear error when the pinned-tag join table is missing', () => {
    const db = buildSyntheticBearDb({ includePinnedTable: false });
    try {
      expect(() => discoverBearSchema(db)).toThrow(/Z_5PINNEDINTAGS not found/);
    } finally {
      db.close();
    }
  });

  it('throws a clear error when a join table exists but is missing expected columns', () => {
    // Distinct branch in verifyJoinExists: the table exists (so the
    // "table not found" path doesn't fire) but the note-PK column has been
    // renamed. Without this guard, queries against the join table would fail
    // later with a cryptic "no such column: Z_5NOTES" SQL error.
    const db = buildSyntheticBearDb({ tagsTableNoteColOverride: 'Z_5RENAMED' });
    try {
      expect(() => discoverBearSchema(db)).toThrow(/Z_5TAGS is missing expected columns Z_5NOTES/);
    } finally {
      db.close();
    }
  });
});

import { DatabaseSync } from 'node:sqlite';

import type { BearNote } from '../types.js';
import { logAndThrow, logger } from '../logging.js';

import { convertCoreDataTimestamp, decodeTagName } from './bear-encoding.js';
import { type BearSchema, discoverBearSchema } from './bear-schema.js';
import { closeBearDatabase, openBearDatabase } from './database.js';

interface DriftKey {
  max: number;
  count: number;
}

interface IndexState {
  memDb: DatabaseSync;
  driftKey: DriftKey;
}

/**
 * Search request shape consumed by `searchByQuery`. Date filters are
 * pre-converted Core Data timestamps — the operations layer parses user-facing
 * date strings (e.g. "yesterday") so this infra layer stays free of
 * date-parsing concerns. At least one of `term`, `tag`, a date filter, or
 * `pinned === true` must be present (validated upstream).
 */
export interface SearchSpec {
  /** FTS5 query string. Empty/absent means "no term filter; rank by mod-date". */
  term?: string;
  /** Tag name to filter on. Hierarchical match: `career` matches `career/meetings`. */
  tag?: string;
  /** When true, restrict to notes pinned globally OR pinned in `tag` (if set). */
  pinned?: boolean;
  createdAfterTimestamp?: number;
  createdBeforeTimestamp?: number;
  modifiedAfterTimestamp?: number;
  modifiedBeforeTimestamp?: number;
  /** Maximum results to return. */
  limit: number;
}

/** A single search hit. Extends `BearNote` with an optional snippet. */
export interface SearchResult extends BearNote {
  /**
   * Snippet shape depends on the query:
   * - Term query: FTS5 `snippet()` excerpt with matched terms wrapped in `[...]`.
   * - Filter-only query (tag/date/pinned): leading 200-character body preview.
   *
   * Absent only when the underlying body is empty/null.
   */
  snippet?: string;
}

/** Aggregate response from `searchByQuery`: results plus the un-limited total match count. */
export interface SearchResults {
  notes: SearchResult[];
  totalCount: number;
}

// Module-level singleton. The MCP server is single-process and only ever talks
// to one Bear DB, so a single in-memory FTS5 index is sufficient. node:sqlite
// is synchronous, so JSON-RPC handlers can't interleave: a search call that
// triggers a rebuild completes the rebuild atomically before the next call
// starts. No mutex needed.
let state: IndexState | null = null;

/**
 * Runs a search against the in-memory FTS5 index, building or rebuilding the
 * index on demand if it's missing or stale relative to Bear's source DB.
 *
 * Drift is checked via `MAX(ZMODIFICATIONDATE) + COUNT(*)` of active notes
 * (sub-millisecond); a mismatch triggers a full rebuild. The rebuild is atomic
 * with respect to JSON-RPC handlers because `node:sqlite` is synchronous.
 *
 * @param spec - Search criteria (term, filters, limit). At least one of `term`,
 *   `tag`, a date filter, or `pinned === true` must be present.
 * @returns Ranked search hits with snippets plus the un-limited total match count.
 * @throws Error if Bear's database can't be opened, or if the FTS5 query has
 *   syntax errors (caller should surface the message via the soft-error path
 *   so the LLM can retry with simpler syntax).
 */
export function searchByQuery(spec: SearchSpec): SearchResults {
  const bearDb = openBearDatabase();
  try {
    const fresh = ensureFreshIndex(bearDb);
    return executeQueryWithCount(fresh.memDb, spec);
  } catch (error) {
    // FTS5 syntax errors are already remapped by runWithFts5SyntaxRemap into a
    // user-facing envelope — pass them through so the LLM can retry with
    // simpler syntax. Wrap everything else in the project's standard
    // "Database error:" prefix so all DB-level failures surface consistently
    // across the operations and infra modules (matches database.ts, tags.ts,
    // notes.ts).
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Search query couldn't be processed:")) {
      throw error;
    }
    logAndThrow(`Database error: Failed to execute search: ${message}`);
  } finally {
    closeBearDatabase(bearDb);
  }
}

// Drops the old reference BEFORE closing so a thrown buildIndex leaves
// state = null (next call rebuilds from scratch) rather than a stale reference
// to a closed DB — the latter would fail with "database is not open" for the
// rest of the process lifetime, requiring a Claude Desktop restart.
function ensureFreshIndex(bearDb: DatabaseSync): IndexState {
  if (state !== null && !checkDrift(bearDb, state.driftKey)) return state;
  const oldState = state;
  state = null;
  if (oldState) oldState.memDb.close();
  state = buildIndex(bearDb);
  return state;
}

// Test-only: drop the cached index so each test starts clean.
function resetIndex(): void {
  if (state) {
    state.memDb.close();
    state = null;
  }
}

function readDriftKey(bearDb: DatabaseSync): DriftKey {
  const row = bearDb
    .prepare(
      `SELECT MAX(ZMODIFICATIONDATE) AS max, COUNT(*) AS count
         FROM ZSFNOTE
        WHERE ZTRASHED = 0 AND ZARCHIVED = 0 AND ZENCRYPTED = 0`
    )
    .get() as unknown as { max: number | null; count: number };
  return { max: row.max ?? 0, count: row.count };
}

// MAX alone misses bulk imports of pre-dated notes (their stale timestamps don't
// move the maximum). COUNT covers that gap. Both aggregates fit a single SELECT
// and are sub-millisecond on a typical Bear library.
function checkDrift(bearDb: DatabaseSync, currentKey: DriftKey | null): boolean {
  if (currentKey === null) return true;
  const fresh = readDriftKey(bearDb);
  return fresh.max !== currentKey.max || fresh.count !== currentKey.count;
}

function buildIndex(bearDb: DatabaseSync): IndexState {
  const startTime = Date.now();
  const schema = discoverBearSchema(bearDb);
  const memDb = new DatabaseSync(':memory:');

  memDb.exec(`
    CREATE VIRTUAL TABLE notes USING fts5(
      title, body, ocr,
      bear_id UNINDEXED,
      created UNINDEXED,
      modified UNINDEXED,
      pinned UNINDEXED,
      tokenize='unicode61 remove_diacritics 2'
    );
    -- Per-column BM25 weights: title/body equal (both hold primary authored
    -- content); OCR at 1/4 so OCR-only matches still surface but never outrank
    -- authored hits at equivalent term frequency. Re-installed on every rebuild
    -- because rank config is per-connection state and the :memory: DB is
    -- destroyed when drift triggers a fresh buildIndex. The (notes, rank) form
    -- is FTS5's documented config-channel — without the table-name column the
    -- INSERT is treated as data and creates a phantom row.
    INSERT INTO notes(notes, rank) VALUES('rank', 'bm25(2.0, 2.0, 0.5)');
    CREATE TABLE note_tags(
      rowid INTEGER,
      tag TEXT,
      pinned_in_tag INTEGER DEFAULT 0
    );
    CREATE INDEX idx_note_tags_rowid ON note_tags(rowid);
    CREATE INDEX idx_note_tags_tag ON note_tags(tag);
  `);

  memDb.exec('BEGIN');
  try {
    insertNotes(bearDb, memDb, schema);
    insertNoteTags(bearDb, memDb, schema);
    memDb.exec('COMMIT');
  } catch (err) {
    memDb.exec('ROLLBACK');
    memDb.close();
    throw err;
  }

  const driftKey = readDriftKey(bearDb);

  const elapsed = Date.now() - startTime;
  const noteCount = (
    memDb.prepare('SELECT COUNT(*) AS c FROM notes').get() as unknown as { c: number }
  ).c;
  logger.info(`FTS5 index built: ${noteCount} notes in ${elapsed}ms`);

  return { memDb, driftKey };
}

interface NoteRow {
  bear_pk: number;
  title: string;
  body: string;
  bear_id: string;
  created: number;
  modified: number;
  pinned: number;
  ocr: string;
}

function insertNotes(bearDb: DatabaseSync, memDb: DatabaseSync, schema: BearSchema): void {
  const { table: pinnedTable, noteCol: pinnedNoteCol } = schema.pinnedInTagsJoin;

  // ZSFNOTEFILE join concats per-attachment OCR text. The CASE EXISTS pre-computes
  // "pinned globally OR pinned in any tag" so the no-tag pinned filter is a simple
  // column comparison at query time; per-tag pinned status is captured separately
  // in note_tags by insertNoteTags.
  const rows = bearDb
    .prepare(
      `SELECT note.Z_PK AS bear_pk,
              COALESCE(note.ZTITLE, '') AS title,
              COALESCE(note.ZTEXT, '') AS body,
              COALESCE(note.ZUNIQUEIDENTIFIER, '') AS bear_id,
              note.ZCREATIONDATE AS created,
              note.ZMODIFICATIONDATE AS modified,
              CASE
                WHEN note.ZPINNED = 1 THEN 1
                WHEN EXISTS (
                  SELECT 1 FROM ${pinnedTable} pt WHERE pt.${pinnedNoteCol} = note.Z_PK
                ) THEN 1
                ELSE 0
              END AS pinned,
              COALESCE(GROUP_CONCAT(f.ZSEARCHTEXT, ' '), '') AS ocr
         FROM ZSFNOTE note
         LEFT JOIN ZSFNOTEFILE f ON f.ZNOTE = note.Z_PK
        WHERE note.ZARCHIVED = 0 AND note.ZTRASHED = 0 AND note.ZENCRYPTED = 0
        GROUP BY note.Z_PK`
    )
    .all() as unknown as NoteRow[];

  const insert = memDb.prepare(
    `INSERT INTO notes(rowid, title, body, ocr, bear_id, created, modified, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of rows) {
    insert.run(
      row.bear_pk,
      row.title,
      row.body,
      row.ocr,
      row.bear_id,
      row.created,
      row.modified,
      row.pinned
    );
  }
}

interface TagRow {
  bear_pk: number;
  tag: string;
  pinned_in_tag: number;
}

function insertNoteTags(bearDb: DatabaseSync, memDb: DatabaseSync, schema: BearSchema): void {
  const { table: tagsJoin, noteCol: tagsNoteCol, tagCol: tagsTagCol } = schema.noteToTagsJoin;
  const {
    table: pinnedTable,
    noteCol: pinnedNoteCol,
    tagCol: pinnedTagCol,
  } = schema.pinnedInTagsJoin;

  // Tag normalization runs in JS via decodeTagName so the index side and the
  // query side share one implementation. SQLite's built-in LOWER() is ASCII-
  // only (e.g. LOWER('CAFÉ') = 'cafÉ') while JS toLowerCase folds Unicode, so
  // doing it in SQL on one side and JS on the other silently fails to match
  // tags whose names contain non-ASCII uppercase letters.
  const rows = bearDb
    .prepare(
      `SELECT nt.${tagsNoteCol} AS bear_pk,
              t.ZTITLE AS tag,
              CASE WHEN EXISTS (
                SELECT 1 FROM ${pinnedTable} pt
                 WHERE pt.${pinnedNoteCol} = nt.${tagsNoteCol}
                   AND pt.${pinnedTagCol} = nt.${tagsTagCol}
              ) THEN 1 ELSE 0 END AS pinned_in_tag
         FROM ${tagsJoin} nt
         JOIN ZSFNOTETAG t ON t.Z_PK = nt.${tagsTagCol}
        WHERE EXISTS (
          SELECT 1 FROM ZSFNOTE n
           WHERE n.Z_PK = nt.${tagsNoteCol}
             AND n.ZARCHIVED = 0
             AND n.ZTRASHED = 0
             AND n.ZENCRYPTED = 0
        )`
    )
    .all() as unknown as TagRow[];

  const insert = memDb.prepare('INSERT INTO note_tags(rowid, tag, pinned_in_tag) VALUES (?, ?, ?)');
  for (const row of rows) {
    insert.run(row.bear_pk, decodeTagName(row.tag), row.pinned_in_tag);
  }
}

interface QueryRow {
  identifier: string;
  title: string;
  created: number;
  modified: number;
  pinned: number;
  rowid: number;
  snippet: string | null;
}

// FTS5 disallows window functions like COUNT(*) OVER() in the same query that
// uses bm25() — SQLite reports "unable to use function bm25 in the requested
// context". So we compute totalCount via a separate count query that shares
// the same WHERE clauses through buildFilterClauses below.
interface FilterBuild {
  clauses: string[];
  params: (string | number)[];
}

function buildFilterClauses(spec: SearchSpec): FilterBuild {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (spec.tag) {
    // decodeTagName is the single source of truth for tag normalization —
    // see insertNoteTags above. Doing `spec.tag.trim().toLowerCase()` here
    // would drop the `+` → space step and silently miss tags whose stored
    // form encodes spaces as `+` (Bear's storage convention).
    const normalizedTag = decodeTagName(spec.tag);
    const escapedTag = normalizedTag.replaceAll(/[%_\\]/g, String.raw`\$&`);
    // Both branches apply hierarchical match (`tag = X OR tag LIKE 'X/%'`) so
    // a parent-tag query catches notes filed under children. The pinned branch
    // adds `pinned_in_tag = 1` so it picks up only the per-tag pinning relation,
    // not globally-pinned notes that happen to also carry the tag.
    if (spec.pinned === true) {
      clauses.push(
        String.raw`n.rowid IN (SELECT rowid FROM note_tags WHERE pinned_in_tag = 1 AND (tag = ? OR tag LIKE ? || '/%' ESCAPE '\'))`
      );
      params.push(normalizedTag, escapedTag);
    } else {
      clauses.push(
        String.raw`n.rowid IN (SELECT rowid FROM note_tags WHERE tag = ? OR tag LIKE ? || '/%' ESCAPE '\')`
      );
      params.push(normalizedTag, escapedTag);
    }
  } else if (spec.pinned === true) {
    clauses.push('n.pinned = 1');
  }

  if (spec.createdAfterTimestamp !== undefined) {
    clauses.push('n.created >= ?');
    params.push(spec.createdAfterTimestamp);
  }
  if (spec.createdBeforeTimestamp !== undefined) {
    clauses.push('n.created <= ?');
    params.push(spec.createdBeforeTimestamp);
  }
  if (spec.modifiedAfterTimestamp !== undefined) {
    clauses.push('n.modified >= ?');
    params.push(spec.modifiedAfterTimestamp);
  }
  if (spec.modifiedBeforeTimestamp !== undefined) {
    clauses.push('n.modified <= ?');
    params.push(spec.modifiedBeforeTimestamp);
  }

  return { clauses, params };
}

// FTS5 reserves ASCII characters as syntax (" ( ) [ ] : ^ * - +), so passing
// user input verbatim into MATCH breaks on accidental special chars. This
// wrapper handles three regimes:
//   - Quoted/grouped input passes through unchanged (caller opted into FTS5).
//   - Single-identifier input (no whitespace, no wildcard) gets tokenized and
//     phrase-quoted so `bear-notes-mcp` or `2026-04-15` match the consecutive
//     token sequence — OR-ranking each component would flood results with
//     notes containing just "bear" or just "2026". Wildcard inputs skip
//     phrase-quoting because FTS5 only allows `*` on the LAST phrase token.
//   - Multi-word input is tokenized via Unicode \p{L}/\p{N} (so accented Latin,
//     Cyrillic, Greek, etc. survive) and OR-joined so BM25 ranks by overlap
//     density. ASCII \w would silently zero-hit any non-ASCII script. We do
//     NOT normalize diacritics here — SQLite's own tokenizer applies the same
//     fold rules to both the indexed text and the MATCH expression, so query
//     and index agree by construction (e.g. `café` and `cafe` both fold to
//     `cafe`; Greek `καλημέρα` is preserved on both sides).
// Uppercase AND/OR/NOT/NEAR are quoted as literal tokens to keep the natural-
// language stance operator-free; FTS5 keyword recognition is case-sensitive,
// and an unquoted bare `NOT` would parse as an operator with no operands.
const FTS5_OPERATOR_KEYWORD = /^(AND|OR|NOT|NEAR)$/;

function prepareFTS5Term(term: string): string {
  if (/["()]/.test(term)) return term;
  const tokens = term.match(/[\p{L}\p{N}_]+\*?/gu) ?? [];
  if (tokens.length === 0) return term; // pass through; FTS5 will surface a syntax error
  if (tokens.length === 1) {
    return FTS5_OPERATOR_KEYWORD.test(tokens[0]) ? `"${tokens[0]}"` : tokens[0];
  }
  const isSingleIdentifier = !/\s/.test(term.trim()) && !tokens.some((t) => t.endsWith('*'));
  if (isSingleIdentifier) return `"${tokens.join(' ')}"`;
  return tokens.map((t) => (FTS5_OPERATOR_KEYWORD.test(t) ? `"${t}"` : t)).join(' OR ');
}

// countMatches and executeQueryWithCount are independent SQL queries against
// the FTS5 virtual table; both can raise the same MATCH-syntax errors when
// the user-supplied term doesn't parse. This helper centralizes the
// "is-FTS5-syntax-error → re-throw with structured message" classification
// so the two call sites can't drift in how they surface those errors.
//
// The user/LLM-facing message is deliberately operator-free: search is
// positioned as natural-language relevance ranking, so a parse failure should
// route the agent back to simpler natural input rather than nudging it into
// capability mode (which the SVA-28 eval showed underperforms). Operator
// details stay in docs/dev/SPECIFICATION.md and unit tests.
function runWithFts5SyntaxRemap<T>(term: string | undefined, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (term?.trim() && isFTS5SyntaxError(err)) {
      // Underlying SQLite text contains operator names — keep it in server logs
      // for debugging, but never on the user/LLM-facing surface.
      logger.error(
        `FTS5 query rejected: term=${JSON.stringify(term)} underlying=${(err as Error).message}`
      );
      logAndThrow(
        `Search query couldn't be processed: "${term}". ` +
          'Try simplifying the query — use natural words or a short phrase.'
      );
    }
    throw err;
  }
}

// countMatches and executeQueryWithCount share WHERE assembly + term param prep.
// hasTerm is computed here once and threaded out so executeQueryWithCount can
// pick the term-vs-filter-only projection and ORDER BY without re-deriving it.
function buildSearchSqlAndParams(spec: SearchSpec): {
  hasTerm: boolean;
  whereClause: string;
  baseParams: (string | number)[];
} {
  const hasTerm = !!(spec.term && spec.term.trim().length > 0);
  const { clauses, params } = buildFilterClauses(spec);
  if (hasTerm) {
    return {
      hasTerm,
      whereClause: ['notes MATCH ?', ...clauses].join(' AND '),
      baseParams: [prepareFTS5Term(spec.term!.trim()), ...params],
    };
  }
  return {
    hasTerm,
    whereClause: clauses.length > 0 ? clauses.join(' AND ') : '1=1',
    baseParams: params,
  };
}

function countMatches(memDb: DatabaseSync, spec: SearchSpec): number {
  const { whereClause, baseParams } = buildSearchSqlAndParams(spec);
  const row = runWithFts5SyntaxRemap(spec.term, () =>
    memDb.prepare(`SELECT COUNT(*) AS c FROM notes n WHERE ${whereClause}`).get(...baseParams)
  ) as unknown as { c: number };
  return row.c;
}

function executeQueryWithCount(memDb: DatabaseSync, spec: SearchSpec): SearchResults {
  const { hasTerm, whereClause, baseParams } = buildSearchSqlAndParams(spec);
  // With a term: ORDER BY rank uses the per-column BM25 weights installed at
  // index build (title/body=2.0, ocr=0.5) — authored hits outrank OCR-only
  // hits at equal term frequency. snippet() builds the preview window.
  // Without: fall back to mod-date ordering (the pre-FTS5 contract for filter-
  // only browses) and a leading-200-char preview.
  const projection = hasTerm ? "snippet(notes, -1, '[', ']', '...', 80)" : 'SUBSTR(n.body, 1, 200)';
  const orderBy = hasTerm ? 'rank' : 'n.modified DESC';
  const query = `
    SELECT n.bear_id AS identifier,
           n.title, n.created, n.modified, n.pinned, n.rowid AS rowid,
           ${projection} AS snippet
      FROM notes n
     WHERE ${whereClause}
     ORDER BY ${orderBy}
     LIMIT ?`;
  const rows = runWithFts5SyntaxRemap(spec.term, () =>
    memDb.prepare(query).all(...baseParams, spec.limit)
  ) as unknown as QueryRow[];

  if (rows.length === 0) return { notes: [], totalCount: 0 };

  const tagsByRowid = fetchTagsForResults(
    memDb,
    rows.map((r) => r.rowid)
  );

  // exactOptionalPropertyTypes: omit optional keys instead of assigning undefined.
  const notes = rows.map((row) => {
    const tags = tagsByRowid.get(row.rowid);
    const result: SearchResult = {
      title: row.title || 'Untitled',
      identifier: row.identifier,
      creation_date: convertCoreDataTimestamp(row.created),
      modification_date: convertCoreDataTimestamp(row.modified),
      pin: row.pinned === 1 ? ('yes' as const) : ('no' as const),
    };
    if (tags) result.tags = tags;
    if (row.snippet) result.snippet = row.snippet;
    return result;
  });

  // When the result set is below the requested limit, by construction it
  // contains every match — countMatches would re-scan the FTS5 MATCH for the
  // same number we already have. Only run the second scan when the LIMIT
  // could have truncated, i.e. rows.length === spec.limit.
  const totalCount = rows.length < spec.limit ? rows.length : countMatches(memDb, spec);
  return { notes, totalCount };
}

function fetchTagsForResults(memDb: DatabaseSync, rowIds: number[]): Map<number, string[]> {
  if (rowIds.length === 0) return new Map();
  const placeholders = rowIds.map(() => '?').join(',');
  const tagRows = memDb
    .prepare(
      `SELECT rowid, GROUP_CONCAT(tag, ',' ORDER BY tag) AS tags
         FROM note_tags
        WHERE rowid IN (${placeholders})
        GROUP BY rowid`
    )
    .all(...rowIds) as unknown as Array<{ rowid: number; tags: string }>;
  return new Map(tagRows.map((tr) => [tr.rowid, tr.tags.split(',')]));
}

// FTS5 surfaces user-query problems via several distinct SQLite error messages:
// "fts5: ..." for FTS5-engine errors, "syntax error" / "unterminated string" /
// "unrecognized token" for tokenizer/parser issues, "no such column: X" when
// an unquoted hyphen-NOT or colon-prefix turns part of the user's term into
// an unintended column reference, and "unknown special query" when the input
// reduces to bare wildcard tokens (e.g. `*`, `***`) that prepareFTS5Term
// passes through verbatim. All map to the same actionable hint: the user's
// query is malformed; tell them how to fix it.
function isFTS5SyntaxError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return (
    msg.includes('fts5') ||
    msg.includes('syntax error') ||
    msg.includes('unterminated string') ||
    msg.includes('unrecognized token') ||
    msg.includes('no such column') ||
    msg.includes('unknown special query')
  );
}

// Test-only handles. Production callers should use searchByQuery.
export const __testing__ = {
  buildIndex,
  checkDrift,
  executeQueryWithCount,
  ensureFreshIndex,
  getState: () => state,
  prepareFTS5Term,
  reset: resetIndex,
};

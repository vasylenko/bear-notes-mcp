import { DatabaseSync } from 'node:sqlite';

import type { BearNote } from '../types.js';
import { CORE_DATA_EPOCH_OFFSET } from '../config.js';
import { logAndThrow, logger } from '../logging.js';
import { decodeTagName } from '../operations/bear-encoding.js';

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

/** A single search hit. Extends `BearNote` with an optional FTS5 snippet. */
export interface SearchResult extends BearNote {
  /** Body/title/OCR excerpt with matched terms wrapped in `[...]`. Absent for term-less queries. */
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
    ensureFreshIndex(bearDb);
    return executeQueryWithCount(state!.memDb, spec);
  } finally {
    closeBearDatabase(bearDb);
  }
}

// Drops the old reference BEFORE closing so a thrown buildIndex leaves
// state = null (next call rebuilds from scratch) rather than a stale reference
// to a closed DB — the latter would fail with "database is not open" for the
// rest of the process lifetime, requiring a Claude Desktop restart.
function ensureFreshIndex(bearDb: DatabaseSync): void {
  if (state !== null && !checkDrift(bearDb, state.driftKey)) return;
  const oldState = state;
  state = null;
  if (oldState) oldState.memDb.close();
  state = buildIndex(bearDb);
}

/**
 * Closes the in-memory FTS5 index and clears the cached state. Idempotent.
 * Reachable only via `__testing__.reset` so tests can isolate per-test state.
 * The Node process exit reclaims the in-memory DB on its own; if a graceful
 * shutdown lifecycle is added later, surface this through `__testing__` →
 * a real export at the same time.
 */
function closeIndex(): void {
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
    const normalizedTag = spec.tag.trim().toLowerCase();
    const escapedTag = normalizedTag.replace(/[%_\\]/g, '\\$&');
    if (spec.pinned === true) {
      clauses.push('n.rowid IN (SELECT rowid FROM note_tags WHERE tag = ? AND pinned_in_tag = 1)');
      params.push(normalizedTag);
    } else {
      clauses.push(
        "n.rowid IN (SELECT rowid FROM note_tags WHERE tag = ? OR tag LIKE ? || '/%' ESCAPE '\\')"
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

// FTS5 reserves a number of ASCII characters as syntax: " ( ) [ ] : ^ * - +
// Passing user input verbatim into MATCH breaks for accidental special chars
// (e.g. titles with brackets, hyphenated words, punctuation). This wrapper
// distinguishes intentional FTS5 syntax from natural-language input:
//   - Quoted or grouped expressions → trusted as-is (user opted into FTS5).
//   - Uppercase boolean operators (AND/OR/NOT/NEAR) → trusted as-is. FTS5
//     only recognizes operators in uppercase; lowercase variants are content
//     tokens, so the case-sensitive check matches FTS5's own semantics.
//   - Everything else → tokenize via /\w+\*?/g (which already strips non-
//     token punctuation: hyphens, colons, brackets, etc.) and OR-join the
//     tokens. unicode61 would have tokenized the indexed text the same way,
//     so dropping incidental punctuation in the query matches what FTS5
//     does internally on the corpus side.
//
// Why OR-rank instead of phrase-quote when the term contains punctuation:
// the SVA-28 A/B eval showed that 73% of v3.0.0 search calls containing a
// hyphen or colon returned zero hits because the prior phrase-quote branch
// turned natural-language queries like "over-engineering coaching senior
// engineer" into rigid token-order phrase matches that failed against any
// note paraphrasing the concept. OR-rank with BM25 lets density-rich notes
// surface even when the user's punctuation was incidental rather than
// intentional FTS5 syntax — matching the user/agent expectation that ranked
// search returns relevance-ordered results, not strict filters.
function prepareFTS5Term(term: string): string {
  if (/["()]/.test(term)) return term;
  if (/\b(AND|OR|NOT|NEAR)\b/.test(term)) return term;
  const tokens = term.match(/\w+\*?/g) ?? [];
  if (tokens.length === 0) return term; // pass through; FTS5 will surface a syntax error
  if (tokens.length === 1) return tokens[0]; // FTS5 prefix rule applies for the '*' suffix
  return tokens.join(' OR ');
}

function fts5SyntaxError(term: string, underlying: Error): never {
  logAndThrow(
    `Search query syntax error: "${term}" — FTS5 cannot parse this expression. ` +
      'Supported operators: AND OR NOT NEAR("a" "b") "exact phrase" prefix*. ' +
      'Try simplifying the query or wrapping multi-word phrases in double quotes. ' +
      `(Underlying: ${underlying.message})`
  );
}

// countMatches and executeQueryWithCount are independent SQL queries against
// the FTS5 virtual table; both can raise the same MATCH-syntax errors when
// the user-supplied term doesn't parse. This helper centralizes the
// "is-FTS5-syntax-error → re-throw with structured message" classification
// so the two call sites can't drift in how they surface those errors.
function runWithFts5SyntaxRemap<T>(hasTerm: boolean, term: string | undefined, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (hasTerm && isFTS5SyntaxError(err)) {
      fts5SyntaxError(term!, err as Error);
    }
    throw err;
  }
}

function countMatches(memDb: DatabaseSync, spec: SearchSpec): number {
  const hasTerm = !!(spec.term && spec.term.trim().length > 0);
  const { clauses, params } = buildFilterClauses(spec);

  let query: string;
  let queryParams: (string | number)[];
  if (hasTerm) {
    const allClauses = ['notes MATCH ?', ...clauses].join(' AND ');
    query = `SELECT COUNT(*) AS c FROM notes n WHERE ${allClauses}`;
    queryParams = [prepareFTS5Term(spec.term!.trim()), ...params];
  } else {
    const allClauses = clauses.length > 0 ? clauses.join(' AND ') : '1=1';
    query = `SELECT COUNT(*) AS c FROM notes n WHERE ${allClauses}`;
    queryParams = params;
  }

  const row = runWithFts5SyntaxRemap(hasTerm, spec.term, () =>
    memDb.prepare(query).get(...queryParams)
  ) as unknown as { c: number };
  return row.c;
}

// Thin wrapper retained for test convenience: tests don't care about totalCount,
// production callers use executeQueryWithCount.
function executeQuery(memDb: DatabaseSync, spec: SearchSpec): SearchResult[] {
  return executeQueryWithCount(memDb, spec).notes;
}

function executeQueryWithCount(memDb: DatabaseSync, spec: SearchSpec): SearchResults {
  const hasTerm = !!(spec.term && spec.term.trim().length > 0);
  const { clauses, params } = buildFilterClauses(spec);

  let query: string;
  let queryParams: (string | number)[];
  if (hasTerm) {
    const allClauses = ['notes MATCH ?', ...clauses].join(' AND ');
    query = `
      SELECT n.bear_id AS identifier,
             n.title,
             n.created,
             n.modified,
             n.pinned,
             n.rowid AS rowid,
             snippet(notes, -1, '[', ']', '...', 80) AS snippet
        FROM notes n
       WHERE ${allClauses}
       ORDER BY bm25(notes)
       LIMIT ?`;
    queryParams = [prepareFTS5Term(spec.term!.trim()), ...params, spec.limit];
  } else {
    const allClauses = clauses.length > 0 ? clauses.join(' AND ') : '1=1';
    query = `
      SELECT n.bear_id AS identifier,
             n.title,
             n.created,
             n.modified,
             n.pinned,
             n.rowid AS rowid,
             SUBSTR(n.body, 1, 200) AS snippet
        FROM notes n
       WHERE ${allClauses}
       ORDER BY n.modified DESC
       LIMIT ?`;
    queryParams = [...params, spec.limit];
  }

  const rows = runWithFts5SyntaxRemap(hasTerm, spec.term, () =>
    memDb.prepare(query).all(...queryParams)
  ) as unknown as QueryRow[];

  if (rows.length === 0) return { notes: [], totalCount: 0 };

  const tagsByRowid = fetchTagsForResults(
    memDb,
    rows.map((r) => r.rowid)
  );

  // exactOptionalPropertyTypes: omit optional keys instead of assigning undefined.
  // Matches the existing formatBearNote pattern in src/operations/notes.ts.
  const notes = rows.map((row) => {
    const tags = tagsByRowid.get(row.rowid);
    const result: SearchResult = {
      title: row.title || 'Untitled',
      identifier: row.identifier,
      creation_date: coreDataToIso(row.created),
      modification_date: coreDataToIso(row.modified),
      pin: row.pinned === 1 ? ('yes' as const) : ('no' as const),
    };
    if (tags) result.tags = tags;
    if (row.snippet) result.snippet = row.snippet;
    return result;
  });

  return { notes, totalCount: countMatches(memDb, spec) };
}

function fetchTagsForResults(memDb: DatabaseSync, rowIds: number[]): Map<number, string[]> {
  if (rowIds.length === 0) return new Map();
  const placeholders = rowIds.map(() => '?').join(',');
  const tagRows = memDb
    .prepare(
      `SELECT rowid, GROUP_CONCAT(tag, ',') AS tags
         FROM note_tags
        WHERE rowid IN (${placeholders})
        GROUP BY rowid`
    )
    .all(...rowIds) as unknown as Array<{ rowid: number; tags: string }>;
  return new Map(tagRows.map((tr) => [tr.rowid, tr.tags.split(',')]));
}

// Inline (rather than importing operations/bear-encoding.ts) to keep the infra
// layer free of operations-layer dependencies. The constant lives in config.
function coreDataToIso(coreDataTimestamp: number): string {
  const unixTimestamp = coreDataTimestamp + CORE_DATA_EPOCH_OFFSET;
  return new Date(unixTimestamp * 1000).toISOString();
}

// FTS5 surfaces user-query problems via several distinct SQLite error messages:
// "fts5: ..." for FTS5-engine errors, "syntax error" / "unterminated string" /
// "unrecognized token" for tokenizer/parser issues, and "no such column: X"
// when an unquoted hyphen-NOT or colon-prefix turns part of the user's term
// into an unintended column reference. All map to the same actionable hint:
// the user's query is malformed; tell them how to fix it.
function isFTS5SyntaxError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return (
    msg.includes('fts5') ||
    msg.includes('syntax error') ||
    msg.includes('SQL logic error') ||
    msg.includes('unterminated string') ||
    msg.includes('unrecognized token') ||
    msg.includes('no such column')
  );
}

// Test-only handles. Production callers should use searchByQuery.
export const __testing__ = {
  buildIndex,
  checkDrift,
  executeQuery,
  executeQueryWithCount,
  ensureFreshIndex,
  getState: () => state,
  reset: closeIndex,
};

import { setTimeout } from 'node:timers/promises';

import type { AttachedFile, BearNote, DateFilter, NoteRevision, NoteTitleMatch } from '../types.js';
import { DEFAULT_SEARCH_LIMIT } from '../config.js';
import { closeBearDatabase, openBearDatabase } from '../infra/database.js';
import { type SearchResults, type SearchSpec, searchByQuery } from '../infra/fts-index.js';
import { logAndThrow, logger } from '../logging.js';
import {
  convertCoreDataTimestamp,
  convertDateToCoreDataTimestamp,
} from '../infra/bear-encoding.js';

const POLL_INTERVAL_MS = 25;
const POLL_TIMEOUT_MS = 2_000;
// Safety window wider than POLL_TIMEOUT_MS to avoid matching a stale note with the same title
const CREATION_LOOKBACK_MS = 10_000;

// OCC inform polling cap (SVA-21). 500ms is a generous upper bound vs. SVA-20's
// empirically observed <30ms typical propagation from `open -g` to observable
// SQLite. 15ms interval keeps polls tight enough to capture sub-30ms writes
// without spamming SQLite (~33 in-process reads worst case per write).
export const REVISION_POLL_INTERVAL_MS = 15;
export const REVISION_POLL_CAP_MS = 500;

interface NoteContentRow {
  title: string | null;
  identifier: string;
  modificationDate: number;
  creationDate: number;
  pinned: number | null;
  revision: number;
  text: string | null;
  filename: string | null;
  fileContent: string | null;
}

interface NoteTitleMatchRow {
  title: string | null;
  identifier: string;
  modificationDate: number;
}

function formatBearNote(row: NoteContentRow): BearNote {
  const { title, identifier, modificationDate, creationDate, pinned, revision, text } = row;

  if (!identifier) {
    logAndThrow('Database error: Note identifier is missing from database row');
  }
  if (typeof modificationDate !== 'number' || typeof creationDate !== 'number') {
    logAndThrow('Database error: Note date fields are invalid in database row');
  }

  const modification_date = convertCoreDataTimestamp(modificationDate);
  const creation_date = convertCoreDataTimestamp(creationDate);

  // Bear stores pinned as integer; API expects string literal (only needed when pinned is queried)
  const pin: 'yes' | 'no' = pinned ? 'yes' : 'no';

  return {
    title: title || 'Untitled',
    identifier,
    modification_date,
    creation_date,
    pin,
    revision,
    ...(text != null && { text }),
  };
}

/**
 * Retrieves a Bear note with its full content from the database.
 *
 * @param identifier - The unique identifier of the Bear note
 * @returns The note with content, or null if not found
 * @throws Error if database access fails or identifier is invalid
 * Note: Always includes OCR'd text from attached images and PDFs with clear labeling
 */
export function getNoteContent(identifier: string): BearNote | null {
  logger.info(`getNoteContent called with identifier: ${identifier}, includeFiles: always`);

  if (!identifier || typeof identifier !== 'string' || !identifier.trim()) {
    logAndThrow('Database error: Invalid note identifier provided');
  }

  const db = openBearDatabase();

  try {
    logger.debug(`Fetching the note content from the database, note identifier: ${identifier}`);

    // Query with file content - always includes OCR'd text from attached files with clear labeling
    const query = `
      SELECT note.ZTITLE as title,
             note.ZUNIQUEIDENTIFIER as identifier,
             note.ZCREATIONDATE as creationDate,
             note.ZMODIFICATIONDATE as modificationDate,
             note.ZPINNED as pinned,
             note.Z_OPT as revision,
             note.ZTEXT as text,
             f.ZFILENAME as filename,
             f.ZSEARCHTEXT as fileContent
      FROM ZSFNOTE note
      LEFT JOIN ZSFNOTEFILE f ON f.ZNOTE = note.Z_PK
      WHERE note.ZUNIQUEIDENTIFIER = ?
        AND note.ZARCHIVED = 0
        AND note.ZTRASHED = 0
        AND note.ZENCRYPTED = 0
    `;
    const rows = db.prepare(query).all(identifier) as unknown as NoteContentRow[];
    if (rows.length === 0) {
      logger.info(`Note not found for identifier: ${identifier}`);
      return null;
    }

    // Process multiple rows (note + files) into single note object
    const formattedNote = formatBearNote(rows[0]);

    // Collect file content into a structured array — kept separate from note text
    // to prevent the synthetic file section from leaking into write operations (#86)
    const files: AttachedFile[] = [];
    for (const row of rows) {
      if (row.filename) {
        const trimmed = row.fileContent?.trim();
        const content = trimmed
          ? trimmed
          : '*[File content not available — Bear has not extracted text from this file type]*';
        files.push({ filename: row.filename, content });
      }
    }

    if (files.length > 0) {
      formattedNote.files = files;
    }

    logger.info(
      `Retrieved note content with ${files.length} attached files for: ${formattedNote.title}`
    );
    return formattedNote;
  } catch (error) {
    logger.error(`SQLite query failed: ${error}`);
    logAndThrow(
      `Database error: Failed to retrieve note content: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    closeBearDatabase(db);
  }
  return null;
}

/**
 * Finds Bear notes matching an exact title (case-insensitive).
 * Returns lightweight match objects for disambiguation — call getNoteContent()
 * with the chosen identifier to retrieve the full note.
 *
 * @param title - The exact note title to match
 * @returns Array of matching notes (empty if none found)
 * @throws Error if database access fails
 */
export function findNotesByTitle(title: string): NoteTitleMatch[] {
  logger.info(`findNotesByTitle called with title: "${title}"`);

  if (!title || typeof title !== 'string' || !title.trim()) {
    logAndThrow('Database error: Invalid note title provided');
  }

  const db = openBearDatabase();

  try {
    const query = `
      SELECT ZTITLE as title,
             ZUNIQUEIDENTIFIER as identifier,
             ZMODIFICATIONDATE as modificationDate
      FROM ZSFNOTE
      WHERE ZTITLE = ? COLLATE NOCASE
        AND ZARCHIVED = 0
        AND ZTRASHED = 0
        AND ZENCRYPTED = 0
      ORDER BY ZMODIFICATIONDATE DESC
    `;
    const rows = db.prepare(query).all(title.trim()) as unknown as NoteTitleMatchRow[];

    if (rows.length === 0) {
      logger.info(`No notes found with title: "${title}"`);
      return [];
    }

    logger.info(`Found ${rows.length} note(s) with title: "${title}"`);

    return rows.map((row) => ({
      identifier: row.identifier,
      title: row.title || 'Untitled',
      modification_date: convertCoreDataTimestamp(row.modificationDate),
    }));
  } catch (error) {
    logAndThrow(
      `Database error: Failed to find notes by title: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    closeBearDatabase(db);
  }

  return [];
}

/**
 * Searches Bear notes via the in-memory FTS5 index, optionally filtered by tag,
 * date range, and pinned status. Title, body, and OCR text from attached images
 * and PDFs are all indexed and searched together.
 *
 * Resolves user-facing date strings (e.g., "yesterday", "2026-04-15") into Core
 * Data timestamps and delegates to `searchByQuery`. At least one of `searchTerm`,
 * `tag`, a date filter, or `pinned === true` must be supplied.
 *
 * @param searchTerm - FTS5 query string (optional). Term queries are ranked by
 *   BM25 relevance and carry an 80-token snippet with matched terms wrapped in
 *   `[...]`. See `prepareFTS5Term` for tokenization rules.
 * @param tag - Tag to filter notes by (optional). Hierarchical match — `career`
 *   also matches `career/meetings`.
 * @param limit - Maximum number of results to return (default from config).
 * @param dateFilter - Date range filters for creation and modification dates (optional).
 * @param pinned - Restrict to globally-pinned notes, or notes pinned in the given `tag`.
 * @returns Aggregate `{ notes, totalCount }`. `notes` carry a `snippet` field —
 *   FTS5 excerpt for term queries, 200-char body preview for filter-only queries.
 *   `totalCount` is the un-limited match count.
 * @throws Error if database access fails or no search criterion is provided.
 */
export function searchNotes(
  searchTerm?: string,
  tag?: string,
  limit?: number,
  dateFilter?: DateFilter,
  pinned?: boolean
): SearchResults {
  logger.info(
    `searchNotes called with term: "${searchTerm || 'none'}", tag: "${tag || 'none'}", limit: ${limit || DEFAULT_SEARCH_LIMIT}, dateFilter: ${dateFilter ? JSON.stringify(dateFilter) : 'none'}, pinned: ${pinned ?? 'none'}`
  );

  // Operations owns user-facing validation so infra (searchByQuery) stays
  // reusable for any well-formed spec without duplicating "at least one
  // criterion" guards across layers. Trimming up-front keeps the predicate
  // and the spec assembly in agreement — a whitespace-only `searchTerm`
  // would otherwise pass `!!searchTerm` and silently degrade to
  // browse-all-recent-notes after the downstream `.trim()` emptied it.
  const trimmedTerm = searchTerm?.trim();
  const trimmedTag = tag?.trim();
  const hasSearchTerm = !!trimmedTerm;
  const hasTag = !!trimmedTag;
  const hasDateFilter = !!(dateFilter && Object.keys(dateFilter).length > 0);
  const hasPinnedFilter = pinned === true;

  if (!hasSearchTerm && !hasTag && !hasDateFilter && !hasPinnedFilter) {
    logAndThrow(
      'Search error: Please provide a search term, tag, date filter, or pinned filter to search for notes'
    );
  }

  // Resolve user-facing date strings (e.g. "yesterday", "2026-04-01") into Core
  // Data timestamps. The infra layer takes pre-resolved numeric timestamps so it
  // doesn't need to know about Bear's relative-date conventions.
  const spec: SearchSpec = { limit: limit || DEFAULT_SEARCH_LIMIT };
  if (trimmedTerm) spec.term = trimmedTerm;
  if (trimmedTag) spec.tag = trimmedTag;
  if (hasPinnedFilter) spec.pinned = true;
  if (dateFilter) {
    // Snaps the user's date to either start-of-day (inclusive lower bound) or
    // end-of-day (inclusive upper bound) before converting to Core Data's
    // timestamp epoch — keeps the four filter branches in lockstep so any
    // future change to the parse/snap/convert pipeline lands in one place.
    const toCoreDataTimestamp = (value: string, edge: 'start' | 'end'): number => {
      const d = parseDateString(value);
      if (edge === 'start') d.setHours(0, 0, 0, 0);
      else d.setHours(23, 59, 59, 999);
      return convertDateToCoreDataTimestamp(d);
    };
    if (dateFilter.createdAfter)
      spec.createdAfterTimestamp = toCoreDataTimestamp(dateFilter.createdAfter, 'start');
    if (dateFilter.createdBefore)
      spec.createdBeforeTimestamp = toCoreDataTimestamp(dateFilter.createdBefore, 'end');
    if (dateFilter.modifiedAfter)
      spec.modifiedAfterTimestamp = toCoreDataTimestamp(dateFilter.modifiedAfter, 'start');
    if (dateFilter.modifiedBefore)
      spec.modifiedBeforeTimestamp = toCoreDataTimestamp(dateFilter.modifiedBefore, 'end');
  }

  const result = searchByQuery(spec);
  logger.info(
    `Found ${result.notes.length} notes (${result.totalCount} total) matching search criteria`
  );
  return result;
}

/**
 * Polls Bear's SQLite database for the identifier and revision of a recently
 * created note. Designed for use after bear-create-note fires the URL API —
 * the note creation already succeeded, so errors here degrade gracefully to
 * null instead of throwing.
 *
 * Returns both id and revision (OCC inform) in a single tuple because the
 * existing SELECT already reads the note row; projecting Z_OPT is a no-cost
 * change that saves callers a second DB round trip.
 *
 * @param title - Exact title to match (case-sensitive, as Bear stores it)
 * @returns Tuple of created note's identifier and revision, or null on timeout
 */
export async function awaitNoteCreation(
  title: string
): Promise<{ id: string; revision: NoteRevision } | null> {
  if (!title?.trim()) {
    logger.debug('awaitNoteCreation: skipped — no title provided');
    return null;
  }

  logger.debug(`awaitNoteCreation: polling for note "${title}"`);

  const sinceTimestamp = convertDateToCoreDataTimestamp(
    new Date(Date.now() - CREATION_LOOKBACK_MS)
  );

  let db: ReturnType<typeof openBearDatabase> | undefined;

  try {
    db = openBearDatabase();

    const stmt = db.prepare(`
      SELECT ZUNIQUEIDENTIFIER as identifier, Z_OPT as revision
      FROM ZSFNOTE
      WHERE ZTITLE = ? AND ZCREATIONDATE >= ?
        AND ZARCHIVED = 0 AND ZTRASHED = 0 AND ZENCRYPTED = 0
      ORDER BY ZCREATIONDATE DESC LIMIT 1
    `);

    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const row = stmt.get(title, sinceTimestamp) as
        | { identifier: string; revision: number }
        | undefined;
      if (row) {
        logger.debug(`awaitNoteCreation: found note "${title}" at revision ${row.revision}`);
        return { id: row.identifier, revision: row.revision };
      }
      await setTimeout(POLL_INTERVAL_MS);
    }

    logger.info(`awaitNoteCreation: timed out waiting for note "${title}"`);
    return null;
  } catch (error) {
    // Intentionally not using logAndThrow — the note was already created via URL API,
    // failing to retrieve its ID should not turn a successful creation into an error
    logger.error('awaitNoteCreation failed:', error);
    return null;
  } finally {
    if (db) closeBearDatabase(db);
  }
}

/**
 * Polls Bear's SQLite database until ZSFNOTE.Z_OPT for the given note differs
 * from `baseline`, capturing the post-write revision. Used after fire-and-forget
 * writes to convert them into write-confirmed responses (OCC inform half).
 *
 * Compares for inequality (not baseline+1) because Bear can bump Z_OPT by +2 on
 * the first edit after note creation — a subtitle/index recompute save observed
 * empirically in SVA-20. On timeout the caller surfaces the absence honestly via
 * REVISION_TIMEOUT_SENTENCE rather than reporting a stale value.
 *
 * Opens one DB connection for the lifetime of the poll loop (mirrors
 * awaitNoteCreation) to avoid ~33 SQLite opens per write in the worst case.
 *
 * @param identifier - The unique identifier of the Bear note being written to
 * @param baseline - Z_OPT value read before the write fired
 * @returns The new revision when Z_OPT differs from baseline, null on timeout
 */
export async function awaitRevisionIncrement(
  identifier: string,
  baseline: NoteRevision
): Promise<NoteRevision | null> {
  let db: ReturnType<typeof openBearDatabase> | undefined;

  try {
    db = openBearDatabase();
    // The trash/archive/encrypted filters guard against attributing an unrelated
    // mid-poll Z_OPT bump to our write. If a concurrent process trashes/archives/
    // encrypts the note during the 500ms poll window and Bear bumps Z_OPT for
    // THAT row update, our poll would resolve on it and falsely report
    // confirmation of OUR write. With the filters, such a note becomes invisible
    // to this query mid-poll and we fall through to timeout, emitting
    // REVISION_TIMEOUT_SENTENCE honestly. bear-archive-note uses a pre-write
    // snapshot (not this helper), so no interaction.
    const stmt = db.prepare(
      `SELECT Z_OPT as revision FROM ZSFNOTE
       WHERE ZUNIQUEIDENTIFIER = ?
         AND ZARCHIVED = 0
         AND ZTRASHED = 0
         AND ZENCRYPTED = 0`
    );
    const deadline = Date.now() + REVISION_POLL_CAP_MS;

    while (Date.now() < deadline) {
      const row = stmt.get(identifier) as { revision: number } | undefined;
      if (row && row.revision !== baseline) {
        logger.debug(
          `awaitRevisionIncrement: revision ${baseline} → ${row.revision} for ${identifier}`
        );
        return row.revision;
      }
      await setTimeout(REVISION_POLL_INTERVAL_MS);
    }

    logger.info(`awaitRevisionIncrement: timed out waiting for revision change on ${identifier}`);
    return null;
  } catch (error) {
    // Mirrors awaitNoteCreation: the underlying write already fired via
    // x-callback-url, so failing to capture the new revision must not turn a
    // successful write into a thrown error. Caller emits REVISION_TIMEOUT_SENTENCE.
    logger.error('awaitRevisionIncrement failed:', error);
    return null;
  } finally {
    if (db) closeBearDatabase(db);
  }
}

/**
 * Parses a date string and returns a JavaScript Date object.
 * Supports relative dates ("today", "yesterday", "last week", "last month") and ISO date strings.
 *
 * ISO date-only inputs (YYYY-MM-DD) are interpreted in the local timezone so
 * downstream local-time bound snapping (setHours) doesn't cross day boundaries
 * for non-UTC users. Datetime inputs with explicit TZ keep their TZ semantics.
 *
 * @param dateString - Date string to parse (e.g., "today", "2024-01-15", "last week")
 * @returns Parsed Date object
 * @throws Error if the date string is invalid
 */
export function parseDateString(dateString: string): Date {
  const lowerDateString = dateString.trim().toLowerCase();
  const now = new Date();

  // Handle relative dates to provide user-friendly natural language date input
  switch (lowerDateString) {
    case 'today': {
      const today = new Date(now);
      today.setHours(0, 0, 0, 0);
      return today;
    }
    case 'yesterday': {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);
      return yesterday;
    }
    case 'last week':
    case 'week ago': {
      const lastWeek = new Date(now);
      lastWeek.setDate(lastWeek.getDate() - 7);
      lastWeek.setHours(0, 0, 0, 0);
      return lastWeek;
    }
    case 'last month':
    case 'month ago':
    case 'start of last month': {
      // Calculate the first day of last month; month arithmetic handles year transitions correctly via JavaScript Date constructor
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      lastMonth.setHours(0, 0, 0, 0);
      return lastMonth;
    }
    case 'end of last month': {
      // Calculate the last day of last month; day 0 of current month equals last day of previous month
      const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
      endOfLastMonth.setHours(23, 59, 59, 999);
      return endOfLastMonth;
    }
    default: {
      // ECMA-262 §21.4.3.2 parses date-only ISO forms (YYYY-MM-DD) as UTC
      // midnight, but callers snap bounds with local-time setHours — the
      // mismatch produces previous-day bounds for negative-UTC users
      // (PDT user typing 2026-04-15 lands on 2026-04-14 07:00 UTC). Match
      // the relative-date branches above by constructing in local time so
      // parse and snap agree. Datetime forms with explicit TZ
      // ("2026-04-15T10:00:00Z") fall through and keep TZ semantics.
      const dateOnly = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateString.trim());
      if (dateOnly) {
        const y = Number(dateOnly[1]);
        const m = Number(dateOnly[2]);
        const d = Number(dateOnly[3]);
        const localDate = new Date(y, m - 1, d);
        // Date(y, m, d) silently rolls over invalid components (Feb 30 → Mar 2);
        // verify parts round-trip to keep the pre-fix rejection contract.
        if (
          localDate.getFullYear() !== y ||
          localDate.getMonth() !== m - 1 ||
          localDate.getDate() !== d
        ) {
          logAndThrow(
            `Invalid date format: "${dateString}". Use ISO format (YYYY-MM-DD) or relative dates (today, yesterday, last week, last month, start of last month, end of last month).`
          );
        }
        return localDate;
      }

      // Fallback for user-provided explicit datetime strings (RFC 2822, full
      // ISO with timezone offset, etc.) — these carry their own TZ semantics.
      const parsed = new Date(dateString);
      if (isNaN(parsed.getTime())) {
        logAndThrow(
          `Invalid date format: "${dateString}". Use ISO format (YYYY-MM-DD) or relative dates (today, yesterday, last week, last month, start of last month, end of last month).`
        );
      }
      return parsed;
    }
  }
}

/**
 * Strips a matching markdown heading from the start of text to prevent header duplication.
 * Bear's add-text API with mode=replace keeps the original section header, so if the
 * replacement text also starts with that header, it appears twice in the note.
 *
 * @param text - The replacement text that may start with a duplicate heading
 * @param header - The cleaned header name (no # prefix) to match against
 * @returns Text with the leading heading removed if it matched, otherwise unchanged
 */
export function stripLeadingHeader(text: string, header: string): string {
  if (!header) return text;

  const leadingHeaderRegex = new RegExp(String.raw`^#{1,6}\s+${RegExp.escape(header)}\s*\n?`, 'i');
  return text.replace(leadingHeaderRegex, '');
}

/**
 * Checks whether a markdown heading matching the given header text exists in the note.
 * Strips markdown prefix from input (e.g., "## Foo" → "Foo") and matches case-insensitively.
 * Escapes regex special characters so headers like "Q&A" or "Details (v2)" match literally.
 */
export function noteHasHeader(noteText: string, header: string): boolean {
  const cleanHeader = header.replace(/^#+\s*/, '');
  const headerRegex = new RegExp(String.raw`^#{1,6}\s+${RegExp.escape(cleanHeader)}\s*$`, 'mi');
  return headerRegex.test(noteText);
}

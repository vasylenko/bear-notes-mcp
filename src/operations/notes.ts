import { setTimeout } from 'node:timers/promises';

import type { AttachedFile, BearNote, DateFilter, NoteTitleMatch } from '../types.js';
import { DEFAULT_SEARCH_LIMIT } from '../config.js';
import { closeBearDatabase, openBearDatabase } from '../infra/database.js';
import { type SearchResults, type SearchSpec, searchByQuery } from '../infra/fts-index.js';
import { logAndThrow, logger } from '../logging.js';

import {
  convertCoreDataTimestamp,
  convertDateToCoreDataTimestamp,
  decodeTagName,
} from './bear-encoding.js';

const POLL_INTERVAL_MS = 25;
const POLL_TIMEOUT_MS = 2_000;
// Safety window wider than POLL_TIMEOUT_MS to avoid matching a stale note with the same title
const CREATION_LOOKBACK_MS = 10_000;

function formatBearNote(row: Record<string, unknown>): BearNote {
  const title = (row.title as string) || 'Untitled';
  const identifier = row.identifier as string;
  const modificationDate = row.modificationDate as number;
  const creationDate = row.creationDate as number;
  const pinned = row.pinned as number | undefined;
  const text = row.text as string | undefined;
  const rawTags = row.rawTags as string | undefined;

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

  // Tags come from a correlated subquery as comma-separated encoded names (e.g., "+What+is+Gravity")
  const tags = rawTags ? rawTags.split(',').map(decodeTagName) : undefined;

  return {
    title,
    identifier,
    modification_date,
    creation_date,
    pin,
    ...(tags && { tags }),
    ...(text !== undefined && { text }),
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
    const stmt = db.prepare(query);
    const rows = stmt.all(identifier);
    if (!rows || rows.length === 0) {
      logger.info(`Note not found for identifier: ${identifier}`);
      return null;
    }

    // Process multiple rows (note + files) into single note object
    const firstRow = rows[0] as Record<string, unknown>;
    const formattedNote = formatBearNote(firstRow);

    // Collect file content into a structured array — kept separate from note text
    // to prevent the synthetic file section from leaking into write operations (#86)
    const files: AttachedFile[] = [];
    for (const row of rows) {
      const rowData = row as Record<string, unknown>;
      const filename = rowData.filename as string;
      const fileContent = rowData.fileContent as string;

      if (filename) {
        const trimmed = fileContent?.trim();
        const content = trimmed
          ? trimmed
          : '*[File content not available — Bear has not extracted text from this file type]*';
        files.push({ filename, content });
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
    const stmt = db.prepare(query);
    const rows = stmt.all(title.trim());

    if (!rows || rows.length === 0) {
      logger.info(`No notes found with title: "${title}"`);
      return [];
    }

    logger.info(`Found ${rows.length} note(s) with title: "${title}"`);

    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        identifier: r.identifier as string,
        title: (r.title as string) || 'Untitled',
        modification_date: convertCoreDataTimestamp(r.modificationDate as number),
      };
    });
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
 * Searches Bear notes by content or tags with optional filtering.
 * Returns a list of notes without full content for performance.
 *
 * @param searchTerm - Text to search for in note titles and content (optional)
 * @param tag - Tag to filter notes by (optional)
 * @param limit - Maximum number of results to return (default from config)
 * @param dateFilter - Date range filters for creation and modification dates (optional)
 * @param pinned - Filter to only pinned notes (optional)
 * @returns Object with matching notes and total count (before limit applied)
 * @throws Error if database access fails or no search criteria provided
 * Note: Always searches within text extracted from attached images and PDF files via OCR for comprehensive results
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

  // Validate search parameters - at least one must be provided. This stays in the
  // operations layer; the infra layer's searchByQuery is called with whatever spec
  // we hand it.
  const hasSearchTerm = !!(searchTerm && typeof searchTerm === 'string' && searchTerm.trim());
  const hasTag = !!(tag && typeof tag === 'string' && tag.trim());
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
  if (hasSearchTerm) spec.term = searchTerm!.trim();
  if (hasTag) spec.tag = tag!.trim();
  if (hasPinnedFilter) spec.pinned = true;
  if (dateFilter) {
    if (dateFilter.createdAfter) {
      const d = parseDateString(dateFilter.createdAfter);
      d.setHours(0, 0, 0, 0);
      spec.createdAfterTimestamp = convertDateToCoreDataTimestamp(d);
    }
    if (dateFilter.createdBefore) {
      const d = parseDateString(dateFilter.createdBefore);
      d.setHours(23, 59, 59, 999);
      spec.createdBeforeTimestamp = convertDateToCoreDataTimestamp(d);
    }
    if (dateFilter.modifiedAfter) {
      const d = parseDateString(dateFilter.modifiedAfter);
      d.setHours(0, 0, 0, 0);
      spec.modifiedAfterTimestamp = convertDateToCoreDataTimestamp(d);
    }
    if (dateFilter.modifiedBefore) {
      const d = parseDateString(dateFilter.modifiedBefore);
      d.setHours(23, 59, 59, 999);
      spec.modifiedBeforeTimestamp = convertDateToCoreDataTimestamp(d);
    }
  }

  const result = searchByQuery(spec);
  logger.info(
    `Found ${result.notes.length} notes (${result.totalCount} total) matching search criteria`
  );
  return result;
}

/**
 * Polls Bear's SQLite database for the identifier of a recently created note.
 * Designed for use after bear-create-note fires the URL API — the note creation already
 * succeeded, so errors here degrade gracefully to null instead of throwing.
 *
 * @param title - Exact title to match (case-sensitive, as Bear stores it)
 * @returns The created note's identifier, or null if not found within the timeout window
 */
export async function awaitNoteCreation(title: string): Promise<string | null> {
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
      SELECT ZUNIQUEIDENTIFIER as identifier
      FROM ZSFNOTE
      WHERE ZTITLE = ? AND ZCREATIONDATE >= ?
        AND ZARCHIVED = 0 AND ZTRASHED = 0 AND ZENCRYPTED = 0
      ORDER BY ZCREATIONDATE DESC LIMIT 1
    `);

    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const row = stmt.get(title, sinceTimestamp) as { identifier: string } | undefined;
      if (row) {
        logger.debug(`awaitNoteCreation: found note "${title}"`);
        return row.identifier;
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
 * Parses a date string and returns a JavaScript Date object.
 * Supports relative dates ("today", "yesterday", "last week", "last month") and ISO date strings.
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
      // Try parsing as ISO date or other standard formats as fallback for user-provided explicit dates
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

  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const leadingHeaderRegex = new RegExp(`^#{1,6}\\s+${escaped}\\s*\\n?`, 'i');
  return text.replace(leadingHeaderRegex, '');
}

/**
 * Checks whether a markdown heading matching the given header text exists in the note.
 * Strips markdown prefix from input (e.g., "## Foo" → "Foo") and matches case-insensitively.
 * Escapes regex special characters so headers like "Q&A" or "Details (v2)" match literally.
 */
export function noteHasHeader(noteText: string, header: string): boolean {
  const cleanHeader = header.replace(/^#+\s*/, '');
  const escaped = cleanHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerRegex = new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, 'mi');
  return headerRegex.test(noteText);
}

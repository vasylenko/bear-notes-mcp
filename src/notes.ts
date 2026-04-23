import { setTimeout } from 'node:timers/promises';

import type { AttachedFile, BearNote, DateFilter, NoteTitleMatch } from './types.js';
import { DEFAULT_SEARCH_LIMIT } from './config.js';
import { parseDateString } from './utils.js';
import { logAndThrow, logger } from './logging.js';
import {
  convertCoreDataTimestamp,
  convertDateToCoreDataTimestamp,
  decodeTagName,
} from './operations/bear-encoding.js';
import { closeBearDatabase, openBearDatabase } from './infra/database.js';

const POLL_INTERVAL_MS = 25;
const POLL_TIMEOUT_MS = 2_000;
// Safety window wider than POLL_TIMEOUT_MS to avoid matching a stale note with the same title
const CREATION_LOOKBACK_MS = 10_000;

// SQL equivalent of decodeTagName() in operations/bear-encoding.ts — both MUST apply the same transformations
const DECODED_TAG_TITLE = "LOWER(TRIM(REPLACE(t.ZTITLE, '+', ' ')))";

/**
 * Builds a SQL WHERE clause that matches a tag exactly or its nested children.
 * Escapes LIKE wildcards (%, _) in the tag name to prevent unintended pattern matching.
 */
function buildTagMatchClause(tag: string): { sql: string; params: string[] } {
  const normalizedTag = tag.trim().toLowerCase();
  const escapedTag = normalizedTag.replace(/[%_\\]/g, '\\$&');

  return {
    sql: ` AND (
        ${DECODED_TAG_TITLE} = ?
        OR ${DECODED_TAG_TITLE} LIKE ? || '/%' ESCAPE '\\'
      )`,
    params: [normalizedTag, escapedTag],
  };
}

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
): { notes: BearNote[]; totalCount: number } {
  logger.info(
    `searchNotes called with term: "${searchTerm || 'none'}", tag: "${tag || 'none'}", limit: ${limit || DEFAULT_SEARCH_LIMIT}, dateFilter: ${dateFilter ? JSON.stringify(dateFilter) : 'none'}, pinned: ${pinned ?? 'none'}, includeFiles: always`
  );

  // Validate search parameters - at least one must be provided
  const hasSearchTerm = searchTerm && typeof searchTerm === 'string' && searchTerm.trim();
  const hasTag = tag && typeof tag === 'string' && tag.trim();
  const hasDateFilter = dateFilter && Object.keys(dateFilter).length > 0;
  const hasPinnedFilter = pinned === true;

  if (!hasSearchTerm && !hasTag && !hasDateFilter && !hasPinnedFilter) {
    logAndThrow(
      'Search error: Please provide a search term, tag, date filter, or pinned filter to search for notes'
    );
  }

  const db = openBearDatabase();
  const queryLimit = limit || DEFAULT_SEARCH_LIMIT;

  try {
    const queryParams: (string | number)[] = [];

    // Build inner query that handles filtering and DISTINCT
    // CTE ensures window function counts distinct notes, not duplicated rows from JOIN
    let innerQuery = `
      SELECT DISTINCT note.ZTITLE as title,
             note.ZUNIQUEIDENTIFIER as identifier,
             note.ZCREATIONDATE as creationDate,
             note.ZMODIFICATIONDATE as modificationDate,
             note.ZPINNED as pinned,
             (SELECT GROUP_CONCAT(t2.ZTITLE, ',')
              FROM Z_5TAGS nt2
              JOIN ZSFNOTETAG t2 ON t2.Z_PK = nt2.Z_13TAGS
              WHERE nt2.Z_5NOTES = note.Z_PK) as rawTags
      FROM ZSFNOTE note
      LEFT JOIN ZSFNOTEFILE f ON f.ZNOTE = note.Z_PK`;

    // Tag-pinned search requires joining the pinned-in-tags relationship tables
    if (hasPinnedFilter && hasTag) {
      innerQuery += `
      JOIN Z_5PINNEDINTAGS pt ON pt.Z_5PINNEDNOTES = note.Z_PK
      JOIN ZSFNOTETAG t ON t.Z_PK = pt.Z_13PINNEDINTAGS`;
    } else if (hasTag) {
      innerQuery += `
      JOIN Z_5TAGS nt ON nt.Z_5NOTES = note.Z_PK
      JOIN ZSFNOTETAG t ON t.Z_PK = nt.Z_13TAGS`;
    }

    innerQuery += `
      WHERE note.ZARCHIVED = 0
        AND note.ZTRASHED = 0
        AND note.ZENCRYPTED = 0`;

    // Add search term filtering
    if (hasSearchTerm) {
      const searchPattern = `%${searchTerm.trim()}%`;
      // Search in note title, text, and file OCR content
      innerQuery += ' AND (note.ZTITLE LIKE ? OR note.ZTEXT LIKE ? OR f.ZSEARCHTEXT LIKE ?)';
      queryParams.push(searchPattern, searchPattern, searchPattern);
    }

    // Tag clause applies to both pinned+tag and tag-only paths (JOINs differ above)
    if (hasTag) {
      const tagClause = buildTagMatchClause(tag);
      innerQuery += tagClause.sql;
      queryParams.push(...tagClause.params);
    } else if (hasPinnedFilter) {
      // All pinned notes: globally pinned OR pinned in any tag (matches Bear's "Pinned" section)
      innerQuery +=
        ' AND (note.ZPINNED = 1 OR EXISTS (SELECT 1 FROM Z_5PINNEDINTAGS pt WHERE pt.Z_5PINNEDNOTES = note.Z_PK))';
    }

    // Add date filtering
    if (hasDateFilter && dateFilter) {
      if (dateFilter.createdAfter) {
        const afterDate = parseDateString(dateFilter.createdAfter);
        // Set to start of day (00:00:00) to include notes from the entire specified day onwards
        afterDate.setHours(0, 0, 0, 0);
        const timestamp = convertDateToCoreDataTimestamp(afterDate);
        innerQuery += ' AND note.ZCREATIONDATE >= ?';
        queryParams.push(timestamp);
      }
      if (dateFilter.createdBefore) {
        const beforeDate = parseDateString(dateFilter.createdBefore);
        // Set to end of day (23:59:59.999) to include notes through the entire specified day
        beforeDate.setHours(23, 59, 59, 999);
        const timestamp = convertDateToCoreDataTimestamp(beforeDate);
        innerQuery += ' AND note.ZCREATIONDATE <= ?';
        queryParams.push(timestamp);
      }
      if (dateFilter.modifiedAfter) {
        const afterDate = parseDateString(dateFilter.modifiedAfter);
        // Set to start of day (00:00:00) to include notes from the entire specified day onwards
        afterDate.setHours(0, 0, 0, 0);
        const timestamp = convertDateToCoreDataTimestamp(afterDate);
        innerQuery += ' AND note.ZMODIFICATIONDATE >= ?';
        queryParams.push(timestamp);
      }
      if (dateFilter.modifiedBefore) {
        const beforeDate = parseDateString(dateFilter.modifiedBefore);
        // Set to end of day (23:59:59.999) to include notes through the entire specified day
        beforeDate.setHours(23, 59, 59, 999);
        const timestamp = convertDateToCoreDataTimestamp(beforeDate);
        innerQuery += ' AND note.ZMODIFICATIONDATE <= ?';
        queryParams.push(timestamp);
      }
    }

    // Wrap in CTE: inner query gets distinct notes, outer query adds total count and applies limit
    const query = `
      WITH filtered_notes AS (${innerQuery})
      SELECT *, COUNT(*) OVER() as totalCount
      FROM filtered_notes
      ORDER BY modificationDate DESC
      LIMIT ?`;
    queryParams.push(queryLimit);

    logger.debug(`Executing search query with ${queryParams.length} parameters`);

    // Use parameter binding to prevent SQL injection attacks
    const stmt = db.prepare(query);
    const rows = stmt.all(...queryParams);

    if (!rows || rows.length === 0) {
      logger.info('No notes found matching search criteria');
      return { notes: [], totalCount: 0 };
    }

    // Extract totalCount from first row (window function adds same value to all rows)
    const firstRow = rows[0] as Record<string, unknown>;
    const totalCount = (firstRow.totalCount as number) || rows.length;

    const notes = rows.map((row) => formatBearNote(row as Record<string, unknown>));
    logger.info(`Found ${notes.length} notes (${totalCount} total) matching search criteria`);

    return { notes, totalCount };
  } catch (error) {
    logAndThrow(
      `SQLite search query failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    closeBearDatabase(db);
  }

  return { notes: [], totalCount: 0 };
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

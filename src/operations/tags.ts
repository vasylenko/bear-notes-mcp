import type { BearNote, BearTag } from '../types.js';
import { logAndThrow, logger } from '../logging.js';
import { discoverBearSchema } from '../infra/bear-schema.js';
import { closeBearDatabase, openBearDatabase } from '../infra/database.js';

import { convertCoreDataTimestamp, decodeTagName } from './bear-encoding.js';

/**
 * Extracts the display name (leaf) from a full tag path.
 * For "career/content/blog" returns "blog", for "career" returns "career".
 */
function getTagDisplayName(fullPath: string): string {
  const parts = fullPath.split('/');
  return parts[parts.length - 1];
}

/**
 * Builds a hierarchical tree from a flat list of tags.
 * Tags with paths like "career/content" become children of "career".
 * Caller is responsible for excluding zero-count tags before passing data here.
 */
function buildTagHierarchy(
  flatTags: Array<{ name: string; displayName: string; noteCount: number; isRoot: boolean }>
): BearTag[] {
  const tagMap = new Map<string, BearTag>();

  // Two-pass approach: first create nodes, then link parent-child relationships
  for (const tag of flatTags) {
    tagMap.set(tag.name, {
      name: tag.name,
      displayName: tag.displayName,
      noteCount: tag.noteCount,
      children: [],
    });
  }

  const roots: BearTag[] = [];

  // Build parent-child relationships
  for (const tag of flatTags) {
    const tagNode = tagMap.get(tag.name)!;

    if (tag.isRoot) {
      roots.push(tagNode);
    } else {
      // Subtags use path notation (e.g., "career/content"), so extract parent path
      const lastSlash = tag.name.lastIndexOf('/');
      if (lastSlash > 0) {
        const parentName = tag.name.substring(0, lastSlash);
        const parent = tagMap.get(parentName);
        if (parent) {
          parent.children.push(tagNode);
        } else {
          // Orphan subtag - parent has 0 notes or doesn't exist, treat as root
          roots.push(tagNode);
        }
      }
    }
  }

  // Sort children alphabetically at each level
  const sortChildren = (tags: BearTag[]): void => {
    tags.sort((a, b) => a.displayName.localeCompare(b.displayName));
    for (const tag of tags) {
      sortChildren(tag.children);
    }
  };

  sortChildren(roots);

  return roots;
}

/**
 * Retrieves all tags from Bear database as a hierarchical tree.
 * Each tag includes note count and nested children.
 *
 * @returns Object with tags array (tree structure) and total count
 */
export function listTags(): { tags: BearTag[]; totalCount: number } {
  logger.info('listTags called');

  const db = openBearDatabase();

  try {
    const {
      table: tagsJoin,
      noteCol: tagsNoteCol,
      tagCol: tagsTagCol,
    } = discoverBearSchema(db).noteToTagsJoin;

    const query = `
      SELECT t.ZTITLE as name,
             t.ZISROOT as isRoot,
             COUNT(note.Z_PK) as noteCount
      FROM ZSFNOTETAG t
      LEFT JOIN ${tagsJoin} nt ON nt.${tagsTagCol} = t.Z_PK
      LEFT JOIN ZSFNOTE note ON note.Z_PK = nt.${tagsNoteCol}
        AND note.ZTRASHED = 0
        AND note.ZARCHIVED = 0
        AND note.ZENCRYPTED = 0
      GROUP BY t.Z_PK
      HAVING noteCount > 0
      ORDER BY t.ZTITLE
    `;

    const stmt = db.prepare(query);
    const rows = stmt.all() as Array<{ name: string; isRoot: number; noteCount: number }>;

    if (!rows || rows.length === 0) {
      logger.info('No tags found in database');
      return { tags: [], totalCount: 0 };
    }

    // Transform rows: decode names and extract display names
    const flatTags = rows.map((row) => {
      const decodedName = decodeTagName(row.name);
      return {
        name: decodedName,
        displayName: getTagDisplayName(decodedName),
        noteCount: row.noteCount,
        isRoot: row.isRoot === 1,
      };
    });

    const hierarchy = buildTagHierarchy(flatTags);

    logger.info(`Retrieved ${rows.length} tags, ${hierarchy.length} root tags`);
    return { tags: hierarchy, totalCount: rows.length };
  } catch (error) {
    logAndThrow(
      `Database error: Failed to retrieve tags: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    closeBearDatabase(db);
  }

  return { tags: [], totalCount: 0 };
}

/**
 * Finds notes that have no tags assigned.
 *
 * @param limit - Maximum number of results (default: 50)
 * @returns Object with untagged notes and total count (before limit applied)
 */
export function findUntaggedNotes(limit: number = 50): { notes: BearNote[]; totalCount: number } {
  logger.info(`findUntaggedNotes called with limit: ${limit}`);

  const db = openBearDatabase();

  try {
    const { table: tagsJoin, noteCol: tagsNoteCol } = discoverBearSchema(db).noteToTagsJoin;

    // COUNT(*) OVER() calculates total matching rows BEFORE LIMIT is applied
    const query = `
      SELECT ZTITLE as title,
             ZUNIQUEIDENTIFIER as identifier,
             ZCREATIONDATE as creationDate,
             ZMODIFICATIONDATE as modificationDate,
             COUNT(*) OVER() as totalCount
      FROM ZSFNOTE
      WHERE ZARCHIVED = 0 AND ZTRASHED = 0 AND ZENCRYPTED = 0
        AND Z_PK NOT IN (SELECT ${tagsNoteCol} FROM ${tagsJoin})
      ORDER BY ZMODIFICATIONDATE DESC
      LIMIT ?
    `;

    const stmt = db.prepare(query);
    const rows = stmt.all(limit) as Array<{
      title: string;
      identifier: string;
      creationDate: number;
      modificationDate: number;
      totalCount: number;
    }>;

    if (rows.length === 0) {
      logger.info('No untagged notes found');
      return { notes: [], totalCount: 0 };
    }

    // Extract totalCount from first row (window function adds same value to all rows)
    const totalCount = rows[0].totalCount || rows.length;

    const notes: BearNote[] = rows.map((row) => ({
      title: row.title || 'Untitled',
      identifier: row.identifier,
      creation_date: convertCoreDataTimestamp(row.creationDate),
      modification_date: convertCoreDataTimestamp(row.modificationDate),
      pin: 'no' as const,
    }));

    logger.info(`Found ${notes.length} untagged notes (${totalCount} total)`);
    return { notes, totalCount };
  } catch (error) {
    logAndThrow(
      `Database error: Failed to find untagged notes: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    closeBearDatabase(db);
  }

  return { notes: [], totalCount: 0 };
}

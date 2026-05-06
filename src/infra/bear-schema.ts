import type { DatabaseSync } from 'node:sqlite';

import { logAndThrow } from '../logging.js';

/**
 * Resolved name of a Core Data many-to-many join table plus the columns
 * referencing the note PK and the tag PK.
 */
export interface BearSchemaJoin {
  table: string;
  noteCol: string;
  tagCol: string;
}

/**
 * Names of Bear's Core Data join tables as resolved from `Z_PRIMARYKEY` at
 * runtime. See `discoverBearSchema` for why these can't be hardcoded.
 */
export interface BearSchema {
  noteToTagsJoin: BearSchemaJoin;
  pinnedInTagsJoin: BearSchemaJoin;
}

interface PrimaryKeyRow {
  Z_NAME: string;
  Z_ENT: number;
}

interface ColumnInfoRow {
  cid: number;
  name: string;
  type: string;
}

// Z_PRIMARYKEY stores Core Data entity names *without* the 'Z' prefix that the
// generated SQLite tables get (e.g. entity 'SFNote' → table 'ZSFNOTE'). Looking
// up the prefixed form in Z_PRIMARYKEY returns nothing — verified empirically
// against a real Bear DB during initial discovery development.
const NOTE_ENTITY_NAME = 'SFNote';
const TAG_ENTITY_NAME = 'SFNoteTag';

/**
 * Resolves the names of Bear's Core Data many-to-many join tables at runtime.
 *
 * Bear stores note↔tag relations in tables named `Z_<noteEntityId>TAGS` and
 * `Z_<noteEntityId>PINNEDINTAGS`. The entity IDs (5 and 13 in current Bear
 * builds) are assigned when Core Data compiles the data model and can shift
 * across Bear schema migrations. Hardcoded literals silently break for users
 * on renumbered schemas. This utility looks up the IDs in `Z_PRIMARYKEY`
 * (Core Data's entity registry) and verifies the resulting table names exist,
 * so a missing or renamed relation fails loudly at discovery time instead of
 * producing a cryptic SQL error at query time.
 *
 * @param db - An open connection to Bear's source SQLite DB (read-only).
 * @returns Resolved schema with both join-table descriptors.
 * @throws Error if `Z_PRIMARYKEY` lacks the expected entities, or if either
 *   join table is missing or has unexpected columns.
 */
export function discoverBearSchema(db: DatabaseSync): BearSchema {
  // node:sqlite returns Record<string, SQLOutputValue>; double-cast via unknown
  // to match our typed shape without TypeScript's structural-overlap warning.
  const entityRows = db
    .prepare('SELECT Z_ENT, Z_NAME FROM Z_PRIMARYKEY WHERE Z_NAME IN (?, ?)')
    .all(NOTE_ENTITY_NAME, TAG_ENTITY_NAME) as unknown as PrimaryKeyRow[];

  const entityIds = new Map(entityRows.map((row) => [row.Z_NAME, row.Z_ENT]));
  const noteEntityId = entityIds.get(NOTE_ENTITY_NAME);
  const tagEntityId = entityIds.get(TAG_ENTITY_NAME);

  if (noteEntityId === undefined || tagEntityId === undefined) {
    const found = entityRows.map((r) => r.Z_NAME).join(', ') || '(none)';
    logAndThrow(
      'Bear schema discovery failed: required Core Data entities not found in Z_PRIMARYKEY. ' +
        `Expected ${NOTE_ENTITY_NAME} and ${TAG_ENTITY_NAME}; found: ${found}.`
    );
  }

  const noteToTagsJoin: BearSchemaJoin = {
    table: `Z_${noteEntityId}TAGS`,
    noteCol: `Z_${noteEntityId}NOTES`,
    tagCol: `Z_${tagEntityId}TAGS`,
  };

  const pinnedInTagsJoin: BearSchemaJoin = {
    table: `Z_${noteEntityId}PINNEDINTAGS`,
    noteCol: `Z_${noteEntityId}PINNEDNOTES`,
    tagCol: `Z_${tagEntityId}PINNEDINTAGS`,
  };

  verifyJoinExists(db, noteToTagsJoin);
  verifyJoinExists(db, pinnedInTagsJoin);

  return {
    noteToTagsJoin,
    pinnedInTagsJoin,
  };
}

// PRAGMA does not accept bound parameters, so the table name is interpolated.
// Safe here because the value is constructed from integer entity IDs that
// originate in our own SELECT against Z_PRIMARYKEY.Z_ENT (typed INTEGER).
function verifyJoinExists(db: DatabaseSync, join: BearSchemaJoin): void {
  const cols = db.prepare(`PRAGMA table_info(${join.table})`).all() as unknown as ColumnInfoRow[];

  if (cols.length === 0) {
    logAndThrow(
      `Bear schema discovery failed: table ${join.table} not found. ` +
        "Bear's Core Data data model may have renamed the relation suffix."
    );
  }

  const colNames = new Set(cols.map((c) => c.name));
  const missing = [join.noteCol, join.tagCol].filter((c) => !colNames.has(c));

  if (missing.length > 0) {
    logAndThrow(
      `Bear schema discovery failed: table ${join.table} is missing expected columns ${missing.join(', ')}. ` +
        `Found columns: ${cols.map((c) => c.name).join(', ')}.`
    );
  }
}

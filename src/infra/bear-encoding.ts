import { CORE_DATA_EPOCH_OFFSET } from '../config.js';

/**
 * Decodes and normalizes Bear tag names. Single source of truth for tag
 * normalization — `src/infra/fts-index.ts` (insertNoteTags) and the search
 * query path (`buildFilterClauses`) both call this so the index side and
 * the query side use identical Unicode-aware case folding. Doing this in
 * JS rather than SQL is deliberate: SQLite's built-in `LOWER()` is ASCII-
 * only, while JS `toLowerCase()` folds Unicode (e.g. `CAFÉ` → `café`),
 * which is required for non-ASCII tag matching to work.
 */
export function decodeTagName(encodedName: string): string {
  return encodedName.replaceAll('+', ' ').trim().toLowerCase();
}

/**
 * Converts Bear's Core Data timestamp to ISO string format.
 * Bear stores timestamps in seconds since Core Data epoch (2001-01-01).
 *
 * @param coreDataTimestamp - Timestamp in seconds since Core Data epoch
 * @returns ISO string representation of the timestamp
 */
export function convertCoreDataTimestamp(coreDataTimestamp: number): string {
  const unixTimestamp = coreDataTimestamp + CORE_DATA_EPOCH_OFFSET;
  return new Date(unixTimestamp * 1000).toISOString();
}

/**
 * Converts a JavaScript Date object to Bear's Core Data timestamp format.
 * Core Data timestamps are in seconds since 2001-01-01 00:00:00 UTC.
 *
 * @param date - JavaScript Date object
 * @returns Core Data timestamp in seconds
 */
export function convertDateToCoreDataTimestamp(date: Date): number {
  const unixTimestamp = Math.floor(date.getTime() / 1000);
  return unixTimestamp - CORE_DATA_EPOCH_OFFSET;
}

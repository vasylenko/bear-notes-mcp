import { CORE_DATA_EPOCH_OFFSET } from '../config.js';

/**
 * Decodes and normalizes Bear tag names.
 * - Replaces '+' with spaces (Bear's URL encoding)
 * - Converts to lowercase (matches Bear UI behavior)
 * - Trims whitespace
 * Keep in sync with DECODED_TAG_TITLE in notes.ts — both MUST apply the same transformations.
 */
export function decodeTagName(encodedName: string): string {
  return encodedName.replaceAll('+', ' ').trim().toLowerCase();
}

/**
 * Cleans base64 string by removing whitespace/newlines added by base64 command.
 * URLSearchParams in buildBearUrl will handle URL encoding of special characters.
 *
 * @param base64String - Raw base64 string (may contain whitespace/newlines)
 * @returns Cleaned base64 string without whitespace
 */
export function cleanBase64(base64String: string): string {
  // Remove all whitespace/newlines from base64 (base64 command adds line breaks)
  return base64String.trim().replace(/\s+/g, '');
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

import createDebug from 'debug';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { CORE_DATA_EPOCH_OFFSET } from './config.js';
import { getNoteContent } from './notes.js';
import { buildBearUrl, executeBearXCallbackApi } from './bear-urls.js';

export const logger = {
  debug: createDebug('bear-notes-mcp:debug'),
  info: createDebug('bear-notes-mcp:info'),
  error: createDebug('bear-notes-mcp:error'),
};

// Convert UI_DEBUG_TOGGLE boolean set from UI to DEBUG string for debug package
// MCPB has no way to make this in one step with manifest.json
if (process.env.UI_DEBUG_TOGGLE === 'true') {
  process.env.DEBUG = 'bear-notes-mcp:*';
  logger.debug.enabled = true;
}

// Always enable error and info logs
logger.error.enabled = true;
logger.info.enabled = true;

/**
 * Logs an error message and throws an Error to halt execution.
 * Centralizes error handling to ensure consistent logging before failures.
 *
 * @param message - The error message to log and throw
 * @throws Always throws Error with the provided message
 */
export function logAndThrow(message: string): never {
  logger.error(message);
  throw new Error(message);
}

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
 * Creates a standardized MCP tool response with consistent formatting.
 * Centralizes response structure to follow DRY principles.
 *
 * @param text - The response text content
 * @returns Formatted CallToolResult for MCP tools
 */
export function createToolResponse(text: string): Pick<CallToolResult, 'content'> {
  return {
    content: [
      {
        type: 'text' as const,
        text,
        annotations: { audience: ['user', 'assistant'] as const },
      },
    ],
  };
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

/**
 * Shared handler for note text operations (append, prepend, or replace).
 * Consolidates common validation, execution, and response logic.
 *
 * @param mode - Whether to append, prepend, or replace text
 * @param params - Note ID, text content, and optional header
 * @returns Formatted response indicating success or failure
 */
export async function handleNoteTextUpdate(
  mode: 'append' | 'prepend' | 'replace',
  { id, text, header }: { id: string; text: string; header?: string | undefined }
): Promise<CallToolResult> {
  const action = mode === 'append' ? 'appended' : mode === 'prepend' ? 'prepended' : 'replaced';
  logger.info(
    `handleNoteTextUpdate(${mode}) id: ${id}, text length: ${text.length}, header: ${header || 'none'}`
  );

  try {
    const existingNote = getNoteContent(id);

    if (!existingNote) {
      return createToolResponse(`Note with ID '${id}' not found. The note may have been deleted, archived, or the ID may be incorrect.

Use bear-search-notes to find the correct note identifier.`);
    }

    // Strip markdown header syntax once — reused for both validation and Bear API
    const cleanHeader = header?.replace(/^#+\s*/, '');

    // Bear silently ignores replace-with-header when the section doesn't exist — fail early with a clear message
    if (mode === 'replace' && cleanHeader) {
      if (!existingNote.text || !noteHasHeader(existingNote.text, cleanHeader)) {
        return createToolResponse(`Section "${cleanHeader}" not found in note "${existingNote.title}".

Check the note content with bear-open-note to see available sections.`);
      }
    }

    // Bear's replace mode preserves the original heading (section header or note title),
    // so if the AI includes it in the replacement text, the result has a duplicate.
    const cleanText =
      mode === 'replace' ? stripLeadingHeader(text, cleanHeader || existingNote.title) : text;

    const url = buildBearUrl('add-text', {
      id,
      text: cleanText,
      header: cleanHeader,
      mode,
      // Ensures appended/prepended text starts on its own line, not glued to existing content.
      // Not needed for replace — there's no preceding content to separate from.
      new_line: mode !== 'replace' ? 'yes' : undefined,
    });
    logger.debug(`Executing Bear URL: ${url}`);
    await executeBearXCallbackApi(url);

    const preposition = mode === 'replace' ? 'in' : 'to';
    const responseLines = [
      `Text ${action} ${preposition} note "${existingNote.title}" successfully!`,
      '',
    ];

    responseLines.push(`Text: ${text.length} characters`);

    if (cleanHeader) {
      responseLines.push(`Section: ${cleanHeader}`);
    }

    responseLines.push(`Note ID: ${id}`);

    const trailingMessage =
      mode === 'replace'
        ? cleanHeader
          ? 'The section content has been replaced in your Bear note.'
          : 'The note content has been replaced in your Bear note.'
        : 'The text has been added to your Bear note.';

    return createToolResponse(`${responseLines.join('\n')}

${trailingMessage}`);
  } catch (error) {
    logger.error(`handleNoteTextUpdate(${mode}) failed: ${error}`);
    throw error;
  }
}

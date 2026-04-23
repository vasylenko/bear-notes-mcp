import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { getNoteContent, noteHasHeader, stripLeadingHeader } from './operations/notes.js';
import { buildBearUrl, executeBearXCallbackApi } from './infra/bear-urls.js';
import { logger } from './logging.js';
import { createErrorResponse, createToolResponse } from './tools/responses.js';

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
      return createErrorResponse(`Note with ID '${id}' not found. The note may have been deleted, archived, or the ID may be incorrect.

Use bear-search-notes to find the correct note identifier.`);
    }

    // Strip markdown header syntax once — reused for both validation and Bear API
    const cleanHeader = header?.replace(/^#+\s*/, '');

    // Bear silently ignores replace-with-header when the section doesn't exist — fail early with a clear message
    if (mode === 'replace' && cleanHeader) {
      if (!existingNote.text || !noteHasHeader(existingNote.text, cleanHeader)) {
        return createErrorResponse(`Section "${cleanHeader}" not found in note "${existingNote.title}".

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

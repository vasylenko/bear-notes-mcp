import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { ENABLE_CONTENT_REPLACEMENT, ENABLE_NEW_NOTE_CONVENTIONS } from '../config.js';
import { logger } from '../logging.js';
import {
  applyNoteConventions,
  formatTagsAsInlineSyntax,
  parseFrontmatter,
} from '../operations/note-conventions.js';
import { cleanBase64 } from '../operations/bear-encoding.js';
import {
  awaitNoteCreation,
  findNotesByTitle,
  getNoteContent,
  noteHasHeader,
  searchNotes,
  stripLeadingHeader,
} from '../operations/notes.js';
import { findUntaggedNotes } from '../operations/tags.js';
import { buildBearUrl, executeBearXCallbackApi } from '../infra/bear-urls.js';

import { createErrorResponse, createToolResponse } from './responses.js';

/**
 * Shared handler for note text operations (append, prepend, or replace).
 * Consolidates common validation, execution, and response logic across
 * the bear-add-text and bear-replace-text tool handlers.
 *
 * @param mode - Whether to append, prepend, or replace text
 * @param params - Note ID, text content, and optional header
 * @returns Formatted response indicating success or failure
 */
async function handleNoteTextUpdate(
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

/**
 * Registers all note-domain tools (9 total) on the given MCP server.
 * Groups tools that operate on notes: opening, creating, searching,
 * modifying text, attaching files, finding untagged, adding tags,
 * and archiving.
 */
export function registerNoteTools(server: McpServer): void {
  server.registerTool(
    'bear-open-note',
    {
      title: 'Open Bear Note',
      description:
        'Read the full text content of a Bear note by its ID or title. Supports direct title lookup as an alternative to searching first. Always includes text extracted from attached images and PDFs (aka OCR search) with clear labeling.',
      inputSchema: {
        id: z
          .string()
          .trim()
          .optional()
          .describe(
            'Note identifier (ID) from bear-search-notes. Either id or title must be provided.'
          ),
        title: z
          .string()
          .trim()
          .optional()
          .describe(
            'Exact note title for direct lookup (case-insensitive). Either id or title must be provided. If multiple notes share the same title, returns a list for disambiguation.'
          ),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, title }): Promise<CallToolResult> => {
      logger.info(
        `bear-open-note called with id: ${id || 'none'}, title: ${title ? '"' + title + '"' : 'none'}`
      );

      if (!id && !title) {
        return createErrorResponse(
          'Either note ID or title is required. Use bear-search-notes to find the note ID, or provide the exact title.'
        );
      }

      try {
        // Title lookup path: find by title, then fetch full content
        if (!id && title) {
          const matches = findNotesByTitle(title);

          if (matches.length === 0) {
            return createErrorResponse(`No note found with title "${title}". The note may have been deleted, archived, or the title may be different.

Use bear-search-notes to find notes by partial text match.`);
          }

          if (matches.length > 1) {
            const matchList = matches
              .map((m, i) => `${i + 1}. ID: ${m.identifier} (modified: ${m.modification_date})`)
              .join('\n');

            return createToolResponse(`Multiple notes found with title "${title}":

${matchList}

Use bear-open-note with a specific ID to open the desired note.`);
          }

          // Exactly one match — fetch full content by ID
          id = matches[0].identifier;
        }

        const noteWithContent = getNoteContent(id!);

        if (!noteWithContent) {
          return createErrorResponse(`Note with ID '${id}' not found. The note may have been deleted, archived, or the ID may be incorrect.

Use bear-search-notes to find the correct note identifier.`);
        }

        const noteInfo = [
          `**${noteWithContent.title}**`,
          `Modified: ${noteWithContent.modification_date}`,
          `ID: ${noteWithContent.identifier}`,
        ];

        const noteText = noteWithContent.text || '*This note appears to be empty.*';
        const annotations = { audience: ['user', 'assistant'] as ('user' | 'assistant')[] };

        // Body and file metadata are separate content blocks so the synthetic
        // file section can never leak back during write operations (#86)
        const content: CallToolResult['content'] = [
          {
            type: 'text' as const,
            text: `${noteInfo.join('\n')}\n\n---\n\n${noteText}`,
            annotations,
          },
        ];

        if (noteWithContent.files?.length) {
          const fileEntries = noteWithContent.files
            .map((f) => `## ${f.filename}\n\n${f.content}`)
            .join('\n\n---\n\n');
          content.push({
            type: 'text' as const,
            text: `# Attached Files\n\n${fileEntries}`,
            annotations,
          });
        }

        return { content };
      } catch (error) {
        logger.error('bear-open-note failed:', error);
        throw error;
      }
    }
  );

  server.registerTool(
    'bear-create-note',
    {
      title: 'Create New Note',
      description:
        'Create a new note in your Bear library with optional title, content, and tags. Returns the note ID when a title is provided, enabling immediate follow-up operations. The note will be immediately available in Bear app.',
      inputSchema: {
        title: z
          .string()
          .trim()
          .optional()
          .describe('Note title, e.g., "Meeting Notes" or "Research Ideas"'),
        text: z
          .string()
          .trim()
          .optional()
          .describe(
            'Note content in markdown format. Do not include a title heading — Bear adds it automatically from the title parameter.'
          ),
        tags: z
          .string()
          .trim()
          .optional()
          .describe('Tags separated by commas, e.g., "work,project,urgent"'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ title, text, tags }): Promise<CallToolResult> => {
      logger.debug(
        `bear-create-note called with title: ${title ? '"' + title + '"' : 'none'}, text length: ${text ? text.length : 0}, tags: ${tags || 'none'}`
      );

      try {
        const parsed = text ? parseFrontmatter(text) : null;

        let url: string;
        let pollTitle: string | undefined;

        if (parsed?.frontmatter !== null && parsed !== null) {
          // Frontmatter path: assemble the full note content so Bear doesn't
          // insert a title H1 or tags outside the frontmatter block.
          const tagLine = tags ? formatTagsAsInlineSyntax(tags) : '';
          const segments: string[] = [parsed.frontmatter];
          if (title) segments.push(`# ${title}`);
          if (tagLine) segments.push(tagLine);
          if (parsed.body) segments.push(parsed.body);
          const assembled = segments.join('\n');

          url = buildBearUrl('create', { text: assembled });
          pollTitle = title;
        } else {
          // Standard path: no frontmatter detected
          const { text: createText, tags: createTags } = ENABLE_NEW_NOTE_CONVENTIONS
            ? applyNoteConventions({ text, tags })
            : { text, tags };
          url = buildBearUrl('create', { title, text: createText, tags: createTags });
          pollTitle = title;
        }

        await executeBearXCallbackApi(url);

        const createdNoteId = pollTitle ? await awaitNoteCreation(pollTitle) : undefined;

        const responseLines: string[] = ['Bear note created successfully!', ''];

        if (title) {
          responseLines.push(`Title: "${title}"`);
        }

        if (tags) {
          responseLines.push(`Tags: ${tags}`);
        }

        if (createdNoteId) {
          responseLines.push(`Note ID: ${createdNoteId}`);
        }

        const hasContent = title || text || tags;
        const finalMessage = hasContent ? responseLines.join('\n') : 'Empty note created';

        return createToolResponse(`${finalMessage}

The note has been added to your Bear Notes library.`);
      } catch (error) {
        logger.error('bear-create-note failed:', error);
        throw error;
      }
    }
  );

  server.registerTool(
    'bear-search-notes',
    {
      title: 'Find Bear Notes',
      description:
        'Find notes in your Bear library by searching text content, filtering by tags, or date ranges. Always searches within attached images and PDF files via OCR. Returns a list with titles, tags, and IDs - use "Open Bear Note" to read full content.',
      inputSchema: {
        term: z
          .string()
          .trim()
          .optional()
          .describe('Text to search for in note titles and content'),
        tag: z.string().trim().optional().describe('Tag to filter notes by (without # symbol)'),
        limit: z.number().optional().describe('Maximum number of results to return (default: 50)'),
        createdAfter: z
          .string()
          .optional()
          .describe(
            'Filter notes created on or after this date. Supports: relative dates ("today", "yesterday", "last week", "start of last month"), ISO format (YYYY-MM-DD). Use "start of last month" for the beginning of the previous month.'
          ),
        createdBefore: z
          .string()
          .optional()
          .describe(
            'Filter notes created on or before this date. Supports: relative dates ("today", "yesterday", "last week", "end of last month"), ISO format (YYYY-MM-DD). Use "end of last month" for the end of the previous month.'
          ),
        modifiedAfter: z
          .string()
          .optional()
          .describe(
            'Filter notes modified on or after this date. Supports: relative dates ("today", "yesterday", "last week", "start of last month"), ISO format (YYYY-MM-DD). Use "start of last month" for the beginning of the previous month.'
          ),
        modifiedBefore: z
          .string()
          .optional()
          .describe(
            'Filter notes modified on or before this date. Supports: relative dates ("today", "yesterday", "last week", "end of last month"), ISO format (YYYY-MM-DD). Use "end of last month" for the end of the previous month.'
          ),
        pinned: z
          .boolean()
          .optional()
          .describe(
            'Set to true to return only pinned notes: if combined with tag, will return pinned notes with that tag, otherwise only globally pinned notes.'
          ),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      term,
      tag,
      limit,
      createdAfter,
      createdBefore,
      modifiedAfter,
      modifiedBefore,
      pinned,
    }): Promise<CallToolResult> => {
      logger.info(
        `bear-search-notes called with term: "${term || 'none'}", tag: "${tag || 'none'}", limit: ${limit || 'default'}, createdAfter: "${createdAfter || 'none'}", createdBefore: "${createdBefore || 'none'}", modifiedAfter: "${modifiedAfter || 'none'}", modifiedBefore: "${modifiedBefore || 'none'}", pinned: ${pinned ?? 'none'}, includeFiles: always`
      );

      try {
        const dateFilter = {
          ...(createdAfter && { createdAfter }),
          ...(createdBefore && { createdBefore }),
          ...(modifiedAfter && { modifiedAfter }),
          ...(modifiedBefore && { modifiedBefore }),
        };

        const { notes, totalCount } = searchNotes(
          term,
          tag,
          limit,
          Object.keys(dateFilter).length > 0 ? dateFilter : undefined,
          pinned
        );

        if (notes.length === 0) {
          const searchCriteria = [];
          if (term) searchCriteria.push(`term "${term}"`);
          if (tag) searchCriteria.push(`tag "${tag}"`);
          if (createdAfter) searchCriteria.push(`created after "${createdAfter}"`);
          if (createdBefore) searchCriteria.push(`created before "${createdBefore}"`);
          if (modifiedAfter) searchCriteria.push(`modified after "${modifiedAfter}"`);
          if (modifiedBefore) searchCriteria.push(`modified before "${modifiedBefore}"`);
          if (pinned) searchCriteria.push('pinned only');

          return createToolResponse(`No notes found matching ${searchCriteria.join(', ')}.

Try different search criteria or check if notes exist in Bear Notes.`);
        }

        // Show total count when results are truncated
        const hasMore = totalCount > notes.length;
        const countDisplay = hasMore
          ? `${notes.length} notes (${totalCount} total matching)`
          : `${notes.length} note${notes.length === 1 ? '' : 's'}`;

        const resultLines = [`Found ${countDisplay}:`, ''];

        notes.forEach((note, index) => {
          const noteTitle = note.title || 'Untitled';
          const modifiedDate = new Date(note.modification_date).toLocaleDateString();
          const createdDate = new Date(note.creation_date).toLocaleDateString();

          resultLines.push(`${index + 1}. **${noteTitle}**`);
          resultLines.push(`   Created: ${createdDate}`);
          resultLines.push(`   Modified: ${modifiedDate}`);
          if (note.tags && note.tags.length > 0) {
            resultLines.push(`   Tags: ${note.tags.join(', ')}`);
          }
          resultLines.push(`   ID: ${note.identifier}`);
          resultLines.push('');
        });

        resultLines.push('Use bear-open-note with an ID to read the full content of any note.');

        if (hasMore) {
          resultLines.push(`Use bear-search-notes with limit: ${totalCount} to get all results.`);
        }

        return createToolResponse(resultLines.join('\n'));
      } catch (error) {
        logger.error('bear-search-notes failed:', error);
        throw error;
      }
    }
  );

  server.registerTool(
    'bear-add-text',
    {
      title: 'Add Text to Note',
      description:
        'Insert text at the beginning or end of a Bear note, or within a specific section identified by its header. Use bear-search-notes first to get the note ID. To insert without replacing existing text use this tool; to overwrite the direct content under a header use bear-replace-text.',
      inputSchema: {
        id: z
          .string()
          .trim()
          .min(1, 'Note ID is required')
          .describe('Note identifier (ID) from bear-search-notes'),
        text: z
          .string()
          .trim()
          .min(1, 'Text content is required')
          .describe('Text content to add to the note'),
        header: z
          .string()
          .trim()
          .optional()
          .describe(
            'Optional section header to target (adds text within that section). Accepts any heading level, including the note title (H1).'
          ),
        position: z
          .enum(['beginning', 'end'])
          .optional()
          .describe(
            "Where to insert: 'end' (default) for appending, logs, updates; 'beginning' for prepending, summaries, top of mind, etc."
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ id, text, header, position }): Promise<CallToolResult> => {
      const mode = position === 'beginning' ? 'prepend' : 'append';
      return handleNoteTextUpdate(mode, { id, text, header });
    }
  );

  server.registerTool(
    'bear-replace-text',
    {
      title: 'Replace Note Content',
      description:
        'Replace content in an existing Bear note — either the full body or a specific section. Requires content replacement to be enabled in settings. Use bear-search-notes first to get the note ID. To add text without replacing existing content use bear-add-text instead.',
      inputSchema: {
        id: z
          .string()
          .trim()
          .min(1, 'Note ID is required')
          .describe('Note identifier (ID) from bear-search-notes'),
        scope: z
          .enum(['section', 'full-note-body'])
          .describe(
            "Replacement target: 'section' replaces under a specific header (requires header), 'full-note-body' replaces the entire note body (header must not be set)"
          ),
        text: z
          .string()
          .trim()
          .min(1, 'Text content is required')
          .describe(
            'Replacement text content. When scope is "section", provide only the direct content for the targeted header — do not include markdown sub-headers (###). Replace sub-sections with separate calls targeting each sub-header.'
          ),
        header: z
          .string()
          .trim()
          .optional()
          .describe(
            'Section header to target — required when scope is "section", forbidden when scope is "full-note-body". Accepts any heading level, including the note title (H1).'
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, scope, text, header }): Promise<CallToolResult> => {
      if (!ENABLE_CONTENT_REPLACEMENT) {
        return createErrorResponse(`Content replacement is not enabled. Do not retry — this requires a settings change by the user.

To use replace mode, the user must enable "Content Replacement" in the Bear Notes server settings.`);
      }

      if (scope === 'section' && !header) {
        return createErrorResponse(`scope is "section" but no header was provided.

Set the header parameter to the section heading you want to replace.`);
      }

      if (scope === 'full-note-body' && header) {
        return createErrorResponse(`scope is "full-note-body" but a header was provided.

Remove the header parameter to replace the full note body, or change scope to "section".`);
      }

      return handleNoteTextUpdate('replace', { id, text, header });
    }
  );

  server.registerTool(
    'bear-add-file',
    {
      title: 'Add File to Note',
      description:
        'Attach a file to an existing Bear note. Preferred: provide file_path for files on disk — the server reads and encodes them automatically. Alternative: provide base64_content with pre-encoded data. Use bear-search-notes first to get the note ID.',
      inputSchema: {
        file_path: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            'Path to a file on disk. Preferred over base64_content when the file already exists locally.'
          ),
        base64_content: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            'Base64-encoded file content. Use file_path instead when the file exists on disk.'
          ),
        filename: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            'Filename with extension (e.g., budget.xlsx, report.pdf). Required when using base64_content. Auto-inferred from file_path when omitted.'
          ),
        id: z
          .string()
          .trim()
          .optional()
          .describe('Exact note identifier (ID) obtained from bear-search-notes'),
        title: z.string().trim().optional().describe('Note title if ID is not available'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ file_path, base64_content, filename, id, title }): Promise<CallToolResult> => {
      logger.info(
        `bear-add-file called with file_path: ${file_path || 'none'}, base64_content: ${base64_content ? 'provided' : 'none'}, filename: ${filename || 'none'}, id: ${id || 'none'}, title: ${title || 'none'}`
      );

      if (!id && !title) {
        return createErrorResponse(
          'Either note ID or title is required. Use bear-search-notes to find the note ID.'
        );
      }

      if (file_path && base64_content) {
        return createErrorResponse('Provide either file_path or base64_content, not both.');
      }
      if (!file_path && !base64_content) {
        return createErrorResponse('Either file_path or base64_content is required.');
      }
      if (base64_content && !filename) {
        return createErrorResponse('filename is required when using base64_content.');
      }

      try {
        let fileData: string;
        let resolvedFilename: string;

        if (file_path) {
          // Read file from disk and encode — avoids the LLM producing thousands of base64 tokens
          try {
            const buffer = readFileSync(file_path);
            if (buffer.length === 0) {
              return createErrorResponse(`File is empty: ${file_path}`);
            }
            fileData = buffer.toString('base64');
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (code === 'ENOENT') {
              return createErrorResponse(`File not found: ${file_path}`);
            }
            if (code === 'EACCES') {
              return createErrorResponse(`Permission denied: ${file_path}`);
            }
            return createErrorResponse(
              `Cannot read file: ${err instanceof Error ? err.message : String(err)}`
            );
          }
          resolvedFilename = filename || basename(file_path);
        } else {
          // base64_content path — strip whitespace that base64 CLI adds
          fileData = cleanBase64(base64_content!);
          resolvedFilename = filename!;
        }

        // Fail fast with helpful message rather than cryptic Bear error
        let noteTitle: string | undefined;
        if (id) {
          const existingNote = getNoteContent(id);
          if (!existingNote) {
            return createErrorResponse(`Note with ID '${id}' not found. The note may have been deleted, archived, or the ID may be incorrect.

Use bear-search-notes to find the correct note identifier.`);
          }
          noteTitle = existingNote.title;
        }

        const url = buildBearUrl('add-file', {
          id,
          title,
          file: fileData,
          filename: resolvedFilename,
          mode: 'append',
        });

        logger.debug(`Executing Bear add-file URL for: ${resolvedFilename}`);
        await executeBearXCallbackApi(url);

        // Title-only path omits ID: no pre-flight DB lookup, so ID is unavailable
        const noteIdentifier = id ? `Note: "${noteTitle}"\nID: ${id}` : `Note: "${title!}"`;

        return createToolResponse(`File "${resolvedFilename}" added successfully!

${noteIdentifier}

The file has been attached to your Bear note.`);
      } catch (error) {
        logger.error('bear-add-file failed:', error);
        throw error;
      }
    }
  );

  server.registerTool(
    'bear-find-untagged-notes',
    {
      title: 'Find Untagged Notes',
      description:
        'Find notes in your Bear library that have no tags. Useful for organizing and categorizing notes.',
      inputSchema: {
        limit: z.number().optional().describe('Maximum number of results (default: 50)'),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit }): Promise<CallToolResult> => {
      logger.info(`bear-find-untagged-notes called with limit: ${limit || 'default'}`);

      try {
        const { notes, totalCount } = findUntaggedNotes(limit);

        if (notes.length === 0) {
          return createToolResponse('No untagged notes found. All your notes have tags!');
        }

        // Show total count when results are truncated
        const hasMore = totalCount > notes.length;
        const countDisplay = hasMore
          ? `${notes.length} untagged notes (${totalCount} total)`
          : `${notes.length} untagged note${notes.length === 1 ? '' : 's'}`;

        const lines = [`Found ${countDisplay}:`, ''];

        notes.forEach((note, index) => {
          const modifiedDate = new Date(note.modification_date).toLocaleDateString();
          lines.push(`${index + 1}. **${note.title}**`);
          lines.push(`   Modified: ${modifiedDate}`);
          lines.push(`   ID: ${note.identifier}`);
          lines.push('');
        });

        lines.push('You can also use bear-list-tags to see available tags.');

        if (hasMore) {
          lines.push(`Use bear-find-untagged-notes with limit: ${totalCount} to get all results.`);
        }

        return createToolResponse(lines.join('\n'));
      } catch (error) {
        logger.error('bear-find-untagged-notes failed:', error);
        throw error;
      }
    }
  );

  server.registerTool(
    'bear-add-tag',
    {
      title: 'Add Tags to Note',
      description:
        'Add one or more tags to an existing Bear note. Tags are added at the beginning of the note. Use bear-list-tags to see available tags.',
      inputSchema: {
        id: z
          .string()
          .trim()
          .min(1, 'Note ID is required')
          .describe('Note identifier (ID) from bear-search-notes or bear-find-untagged-notes'),
        tags: z
          .array(z.string().trim().min(1, 'Tag name cannot be empty'))
          .min(1, 'At least one tag is required')
          .describe('Tag names without # symbol (e.g., ["career", "career/meetings"])'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, tags }): Promise<CallToolResult> => {
      logger.info(`bear-add-tag called with id: ${id}, tags: [${tags.join(', ')}]`);

      try {
        const existingNote = getNoteContent(id);
        if (!existingNote) {
          return createErrorResponse(`Note with ID '${id}' not found. The note may have been deleted, archived, or the ID may be incorrect.

Use bear-search-notes to find the correct note identifier.`);
        }

        const tagsString = tags.join(',');

        const url = buildBearUrl('add-text', {
          id,
          tags: tagsString,
          mode: 'prepend',
          open_note: 'no',
          show_window: 'no',
          new_window: 'no',
        });

        await executeBearXCallbackApi(url);

        const tagList = tags.map((t) => `#${t}`).join(', ');

        return createToolResponse(`Tags added successfully!

Note: "${existingNote.title}"
ID: ${id}
Tags: ${tagList}

The tags have been added to the beginning of the note.`);
      } catch (error) {
        logger.error('bear-add-tag failed:', error);
        throw error;
      }
    }
  );

  server.registerTool(
    'bear-archive-note',
    {
      title: 'Archive Bear Note',
      description:
        "Move a note to Bear's archive. The note will no longer appear in regular searches but can be found in Bear's Archive section. Use bear-search-notes first to get the note ID.",
      inputSchema: {
        id: z
          .string()
          .trim()
          .min(1, 'Note ID is required')
          .describe('Note identifier (ID) from bear-search-notes or bear-open-note'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id }): Promise<CallToolResult> => {
      logger.info(`bear-archive-note called with id: ${id}`);

      try {
        const existingNote = getNoteContent(id);
        if (!existingNote) {
          return createErrorResponse(`Note with ID '${id}' not found. The note may have been deleted, archived, or the ID may be incorrect.

Use bear-search-notes to find the correct note identifier.`);
        }

        const url = buildBearUrl('archive', {
          id,
          show_window: 'no',
        });

        await executeBearXCallbackApi(url);

        return createToolResponse(`Note archived successfully!

Note: "${existingNote.title}"
ID: ${id}

The note has been moved to Bear's archive.`);
      } catch (error) {
        logger.error('bear-archive-note failed:', error);
        throw error;
      }
    }
  );
}

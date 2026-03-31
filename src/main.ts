#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { APP_VERSION, ENABLE_CONTENT_REPLACEMENT, ENABLE_NEW_NOTE_CONVENTIONS } from './config.js';
import { applyNoteConventions } from './note-conventions.js';
import { cleanBase64, createToolResponse, handleNoteTextUpdate, logger } from './utils.js';
import { awaitNoteCreation, findNotesByTitle, getNoteContent, searchNotes } from './notes.js';
import { findUntaggedNotes, listTags } from './tags.js';
import { buildBearUrl, executeBearXCallbackApi } from './bear-urls.js';
import type { BearTag } from './types.js';

const server = new McpServer(
  {
    name: 'bear-notes-mcp',
    version: APP_VERSION,
  },
  {
    instructions: [
      'This server integrates with Bear, a markdown note-taking app.',
      'Each note has a unique ID, a title, a body, and optional tags.',
      'Notes use markdown headings (##, ###, etc.) to define sections.',
      'Use bear-search-notes to find note IDs before reading or modifying notes, or provide an exact title to bear-open-note for direct lookup.',
      'To modify note content: bear-add-text inserts text without touching existing content; bear-replace-text overwrites content.',
      'When targeting a section by header, operations apply only to the direct content under that header — not nested sub-sections.',
      'To modify sub-sections, make separate calls targeting each sub-header.',
    ].join('\n'),
  }
);

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
      return createToolResponse(
        'Either note ID or title is required. Use bear-search-notes to find the note ID, or provide the exact title.'
      );
    }

    try {
      // Title lookup path: find by title, then fetch full content
      if (!id && title) {
        const matches = findNotesByTitle(title);

        if (matches.length === 0) {
          return createToolResponse(`No note found with title "${title}". The note may have been deleted, archived, or the title may be different.

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
        return createToolResponse(`Note with ID '${id}' not found. The note may have been deleted, archived, or the ID may be incorrect.

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
      // If ENABLE_NOTE_CONVENTIONS is true, embed tags in the text body using Bear's inline tag syntax, rather than passing as URL parameters
      const { text: createText, tags: createTags } = ENABLE_NEW_NOTE_CONVENTIONS
        ? applyNoteConventions({ text, tags })
        : { text, tags };

      const url = buildBearUrl('create', { title, text: createText, tags: createTags });

      await executeBearXCallbackApi(url);

      const createdNoteId = title ? await awaitNoteCreation(title) : undefined;

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
      'Find notes in your Bear library by searching text content, filtering by tags, or date ranges. Always searches within attached images and PDF files via OCR. Returns a list with titles and IDs - use "Open Bear Note" to read full content.',
    inputSchema: {
      term: z.string().trim().optional().describe('Text to search for in note titles and content'),
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
      return createToolResponse(`Content replacement is not enabled.

To use replace mode, enable "Content Replacement" in the Bear Notes server settings.`);
    }

    if (scope === 'section' && !header) {
      return createToolResponse(`scope is "section" but no header was provided.

Set the header parameter to the section heading you want to replace.`);
    }

    if (scope === 'full-note-body' && header) {
      return createToolResponse(`scope is "full-note-body" but a header was provided.

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
          'Absolute path to a file on disk. Preferred over base64_content when the file already exists locally.'
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
      return createToolResponse(
        'Either note ID or title is required. Use bear-search-notes to find the note ID.'
      );
    }

    if (file_path && base64_content) {
      return createToolResponse('Provide either file_path or base64_content, not both.');
    }
    if (!file_path && !base64_content) {
      return createToolResponse('Either file_path or base64_content is required.');
    }
    if (base64_content && !filename) {
      return createToolResponse('filename is required when using base64_content.');
    }

    try {
      let fileData: string;
      let resolvedFilename: string;

      if (file_path) {
        // Read file from disk and encode — avoids the LLM producing thousands of base64 tokens
        try {
          const buffer = readFileSync(file_path);
          if (buffer.length === 0) {
            return createToolResponse(`File is empty: ${file_path}`);
          }
          fileData = buffer.toString('base64');
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === 'ENOENT') {
            return createToolResponse(`File not found: ${file_path}`);
          }
          if (code === 'EACCES') {
            return createToolResponse(`Permission denied: ${file_path}`);
          }
          return createToolResponse(
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
      if (id) {
        const existingNote = getNoteContent(id);
        if (!existingNote) {
          return createToolResponse(`Note with ID '${id}' not found. The note may have been deleted, archived, or the ID may be incorrect.

Use bear-search-notes to find the correct note identifier.`);
        }
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

      const noteIdentifier = id ? `Note ID: ${id}` : `Note title: "${title!}"`;

      return createToolResponse(`File "${resolvedFilename}" added successfully!

${noteIdentifier}

The file has been attached to your Bear note.`);
    } catch (error) {
      logger.error('bear-add-file failed:', error);
      throw error;
    }
  }
);

/**
 * Formats tag hierarchy as tree-style text output.
 * Uses box-drawing characters for visual tree structure.
 */
function formatTagTree(tags: BearTag[], isLast: boolean[] = []): string[] {
  const lines: string[] = [];

  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    const isLastItem = i === tags.length - 1;

    // Build the prefix using box-drawing characters
    let linePrefix = '';
    for (let j = 0; j < isLast.length; j++) {
      linePrefix += isLast[j] ? '    ' : '│   ';
    }
    linePrefix += isLastItem ? '└── ' : '├── ';

    lines.push(`${linePrefix}${tag.name} (${tag.noteCount})`);

    if (tag.children.length > 0) {
      lines.push(...formatTagTree(tag.children, [...isLast, isLastItem]));
    }
  }

  return lines;
}

server.registerTool(
  'bear-list-tags',
  {
    title: 'List Bear Tags',
    description:
      'List all tags in your Bear library as a hierarchical tree. Shows tag names with note counts. Useful for understanding your tag structure and finding tags to apply to untagged notes.',
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (): Promise<CallToolResult> => {
    logger.info('bear-list-tags called');

    try {
      const { tags, totalCount } = listTags();

      if (totalCount === 0) {
        return createToolResponse('No tags found in your Bear library.');
      }

      // Format root tags with their children as trees
      const lines: string[] = [];
      for (const rootTag of tags) {
        lines.push(`${rootTag.name} (${rootTag.noteCount})`);
        if (rootTag.children.length > 0) {
          lines.push(...formatTagTree(rootTag.children));
        }
      }

      const header = `Found ${totalCount} tag${totalCount === 1 ? '' : 's'}:\n`;

      return createToolResponse(header + '\n' + lines.join('\n'));
    } catch (error) {
      logger.error('bear-list-tags failed:', error);
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
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ id, tags }): Promise<CallToolResult> => {
    logger.info(`bear-add-tag called with id: ${id}, tags: [${tags.join(', ')}]`);

    try {
      const existingNote = getNoteContent(id);
      if (!existingNote) {
        return createToolResponse(`Note with ID '${id}' not found. The note may have been deleted, archived, or the ID may be incorrect.

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
        return createToolResponse(`Note with ID '${id}' not found. The note may have been deleted, archived, or the ID may be incorrect.

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

server.registerTool(
  'bear-rename-tag',
  {
    title: 'Rename Tag',
    description:
      'Rename a tag across all notes in your Bear library. Useful for reorganizing tag taxonomy, fixing typos, or restructuring tag hierarchies. Use bear-list-tags first to see existing tags.',
    inputSchema: {
      name: z
        .string()
        .trim()
        .transform((v) => v.replace(/^#/, ''))
        .pipe(z.string().min(1, 'Tag name is required'))
        .describe('Current tag name to rename (without # symbol)'),
      new_name: z
        .string()
        .trim()
        .transform((v) => v.replace(/^#/, ''))
        .pipe(z.string().min(1, 'New tag name is required'))
        .describe(
          'New tag name (without # symbol). Use slashes for hierarchy, e.g., "archive/old-project"'
        ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ name, new_name }): Promise<CallToolResult> => {
    logger.info(`bear-rename-tag called with name: "${name}", new_name: "${new_name}"`);

    try {
      const url = buildBearUrl('rename-tag', {
        name,
        new_name,
        open_note: 'no',
        new_window: 'no',
        show_window: 'no',
      });

      await executeBearXCallbackApi(url);

      return createToolResponse(`Tag renamed successfully!

From: #${name}
To: #${new_name}

The tag has been renamed across all notes in your Bear library.`);
    } catch (error) {
      logger.error('bear-rename-tag failed:', error);
      throw error;
    }
  }
);

server.registerTool(
  'bear-delete-tag',
  {
    title: 'Delete Tag',
    description:
      'Delete a tag from all notes in your Bear library. Removes the tag but preserves the notes themselves. Use bear-list-tags first to see existing tags.',
    inputSchema: {
      name: z
        .string()
        .trim()
        .transform((v) => v.replace(/^#/, ''))
        .pipe(z.string().min(1, 'Tag name is required'))
        .describe('Tag name to delete (without # symbol)'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ name }): Promise<CallToolResult> => {
    logger.info(`bear-delete-tag called with name: "${name}"`);

    try {
      const url = buildBearUrl('delete-tag', {
        name,
        open_note: 'no',
        new_window: 'no',
        show_window: 'no',
      });

      await executeBearXCallbackApi(url);

      return createToolResponse(`Tag deleted successfully!

Tag: #${name}

The tag has been removed from all notes. The notes themselves are not affected.`);
    } catch (error) {
      logger.error('bear-delete-tag failed:', error);
      throw error;
    }
  }
);

async function main(): Promise<void> {
  logger.info(`Bear Notes MCP Server initializing... Version: ${APP_VERSION}`);
  logger.debug(`Debug logs enabled: ${logger.debug.enabled}`);
  logger.debug(`Node.js version: ${process.version}`);
  logger.debug(`App version: ${APP_VERSION}`);

  // Handle process errors
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection at:', promise, 'reason:', reason);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('Bear Notes MCP Server connected and ready');
}

main().catch((error) => {
  logger.error('Server startup failed:', error);
  process.exit(1);
});

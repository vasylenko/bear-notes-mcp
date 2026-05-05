import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { logger } from '../logging.js';
import { listTags } from '../operations/tags.js';
import { buildBearUrl, executeBearXCallbackApi } from '../infra/bear-urls.js';
import type { BearTag } from '../types.js';

import { createToolResponse } from './responses.js';

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

/**
 * Registers all tag-global tools (3 total) on the given MCP server.
 * Groups tools that operate on the tag taxonomy across the whole library:
 * listing the tag tree, renaming a tag everywhere, and deleting a tag
 * from every note that has it.
 */
export function registerTagTools(server: McpServer): void {
  server.registerTool(
    'bear-list-tags',
    {
      title: 'List Bear Tags',
      description:
        'List all tags in your Bear library as a hierarchical tree. Shows tag names with note counts. Useful for understanding your tag structure and finding tags to apply to untagged notes. Counts include only active notes (trashed and archived are excluded). Tags with zero active notes are not shown.',
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
}

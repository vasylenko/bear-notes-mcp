#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { APP_VERSION } from './config.js';
import { logger } from './logging.js';
import { createToolResponse } from './tools/responses.js';
import { registerNoteTools } from './tools/note-tools.js';
import { listTags } from './operations/tags.js';
import { buildBearUrl, executeBearXCallbackApi } from './infra/bear-urls.js';
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

registerNoteTools(server);

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

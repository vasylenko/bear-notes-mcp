#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { APP_VERSION, ENABLE_CONTENT_REPLACEMENT } from './config.js';
import { logger } from './logging.js';
import { registerNoteTools } from './tools/note-tools.js';
import { registerTagTools } from './tools/tag-tools.js';

const baseInstructions = [
  'This server integrates with Bear, a markdown note-taking app.',
  'Each note has a unique ID, a title, a body, and optional tags.',
  'Notes use markdown headings (##, ###, etc.) to define sections.',
  'Use bear-search-notes to find note IDs before reading or modifying notes, or provide an exact title to bear-open-note for direct lookup.',
  'Whenever a tool surfaces a specific note in its response (search results, opened note, etc), the note ID is included. Pass that ID unchanged to any mutation tool that accepts `id`.',
];

const editModeInstructions = [
  'To modify note content: bear-add-text inserts text without touching existing content; bear-replace-text overwrites content.',
  'When targeting a section by header, operations apply only to the direct content under that header — not nested sub-sections.',
  'To modify sub-sections, make separate calls targeting each sub-header.',
];

// When Edit Mode is off, the LLM must not see write tool names — referencing
// unregistered tools would invite hallucinated calls. The unlock guidance
// names the env var and the Claude Desktop toggle path instead.
const readOnlyInstructions = [
  '',
  'Edit Mode is currently off — only the 4 read-only tools (bear-open-note, bear-search-notes, bear-find-untagged-notes, bear-list-tags) are registered.',
  'To enable Edit Mode (note creation, editing, attachments, tag management, archive), set UI_ENABLE_CONTENT_REPLACEMENT=true and restart the server. Claude Desktop users: toggle "Edit Mode" in Settings → Extensions → Configure (Bear Notes).',
];

const modeInstructions = ENABLE_CONTENT_REPLACEMENT ? editModeInstructions : readOnlyInstructions;
const instructions = [...baseInstructions, ...modeInstructions].join('\n');

const server = new McpServer(
  {
    name: 'bear-notes-mcp',
    version: APP_VERSION,
  },
  {
    instructions,
  }
);

registerNoteTools(server);
registerTagTools(server);

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

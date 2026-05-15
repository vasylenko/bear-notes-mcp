#!/usr/bin/env node
// Step 6 failure-path sabotage — to be reverted immediately.
const _failureProbe: number = 'this is not a number';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { APP_VERSION, ENABLE_CONTENT_REPLACEMENT } from './config.js';
import { instructions } from './instructions.js';
import { logger } from './logging.js';
import { registerCapabilityTools } from './tools/capability-tools.js';
import { registerNoteTools } from './tools/note-tools.js';
import { registerTagTools } from './tools/tag-tools.js';

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
// bear-capabilities exists only to surface unlock guidance to clients that
// drop the MCP `instructions` field. Once Edit Mode is on there is nothing
// to unlock and no purpose for the tool — register it OFF-only.
if (!ENABLE_CONTENT_REPLACEMENT) {
  registerCapabilityTools(server);
}

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

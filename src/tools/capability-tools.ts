import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { APP_VERSION } from '../config.js';
import { readOnlyInstructions } from '../instructions.js';
import { logger } from '../logging.js';

import { createToolResponse } from './responses.js';

/**
 * Registers the bear-capabilities tool. Exists because the MCP
 * `initialize.instructions` field is unreliable across clients — Claude Desktop
 * and OpenCode drop it; Codex CLI reroutes it. Without this tool, those clients
 * give the model no path to discover that Edit Mode is locked or how to unlock
 * it. The tool is registered only when Edit Mode is OFF — once unlocked there
 * is nothing for it to advertise.
 */
export function registerCapabilityTools(server: McpServer): void {
  server.registerTool(
    'bear-capabilities',
    {
      title: 'Bear Notes Capabilities',
      description:
        'Report the current Bear Notes MCP server mode and how to unlock additional capabilities. Call this when the user asks what you can do with their Bear notes, when a write operation appears unavailable, or when the user wants to enable note creation, editing, or tag management.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (): Promise<CallToolResult> => {
      logger.info('bear-capabilities called');

      try {
        const body = readOnlyInstructions.filter((line) => line.length > 0).join('\n');

        const response = [
          '# Bear Notes MCP — capabilities',
          '**Edit Mode:** OFF',
          '',
          body,
          '',
          `Server version: ${APP_VERSION}`,
        ].join('\n');

        return createToolResponse(response);
      } catch (error) {
        logger.error('bear-capabilities failed:', error);
        throw error;
      }
    }
  );
}

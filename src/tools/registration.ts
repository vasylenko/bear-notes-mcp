import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ENABLE_CONTENT_REPLACEMENT } from '../config.js';

type RegisteredTool = ReturnType<McpServer['registerTool']>;

/**
 * Calls `RegisteredTool.disable()` when Edit Mode is off — the SDK filters
 * the tool from `tools/list`. Wraps the *result* of `server.registerTool(...)`,
 * not the call: wrapping the call would force `Parameters<McpServer['registerTool']>`
 * and collapse the SDK's input-schema-to-handler-arg inference at every site.
 */
export function applyWriteGate(tool: RegisteredTool): RegisteredTool {
  if (!ENABLE_CONTENT_REPLACEMENT) tool.disable();
  return tool;
}

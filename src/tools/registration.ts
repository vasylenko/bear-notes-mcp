import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ENABLE_CONTENT_REPLACEMENT } from '../config.js';

type RegisteredTool = ReturnType<McpServer['registerTool']>;

/**
 * Disables a write tool when Edit Mode is off. The SDK auto-filters disabled
 * tools from `tools/list`, achieving registration-time read/write gating
 * through the SDK's own API rather than skipping registration entirely.
 *
 * Wraps the result of `server.registerTool(...)`, not the call itself —
 * wrapping the call would force `Parameters<McpServer['registerTool']>` and
 * collapse the SDK's input-schema-to-handler-arg generic inference at every
 * write call site.
 */
export function applyWriteGate(tool: RegisteredTool): RegisteredTool {
  if (!ENABLE_CONTENT_REPLACEMENT) tool.disable();
  return tool;
}

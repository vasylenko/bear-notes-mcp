import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ENABLE_CONTENT_REPLACEMENT } from '../config.js';

type RegisterTool = McpServer['registerTool'];

// The no-op returns undefined; the SDK's RegisterTool returns RegisteredTool.
// Cast through `unknown` because the simpler `(...args: Parameters<RegisterTool>) => void`
// alternative collapses the SDK's generic parameters (`InputArgs`, `OutputArgs`)
// to their constraints — verified by tsc: every write call site loses
// inputSchema-to-handler-args inference and the destructured handler params
// degrade to `any` (errors TS2345 + TS7031). Preserving the SDK's full method
// type at the helper's return site keeps that inference working. No call site
// reads the return value (verified across note-tools.ts and tag-tools.ts), so
// the structural mismatch is safe at runtime.
const noopRegisterTool = (() => undefined) as unknown as RegisterTool;

/**
 * Returns the function for registering write-class tools — `server.registerTool`
 * bound to the server when Edit Mode is on, a no-op when off. Read-only tools
 * call `server.registerTool(...)` directly; the asymmetry makes the read/write
 * classification visible at every registration call site.
 */
export function getWriteToolRegistrar(server: McpServer): RegisterTool {
  if (!ENABLE_CONTENT_REPLACEMENT) return noopRegisterTool;
  return server.registerTool.bind(server) as RegisterTool;
}

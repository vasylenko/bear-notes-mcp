import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ENABLE_CONTENT_REPLACEMENT } from '../config.js';

type RegisterTool = McpServer['registerTool'];

// Cast through `unknown` because no real value structurally satisfies the
// generic call signature — and the no-op never reaches the SDK anyway. The
// short-circuit happens before any registration; the type is preserved purely
// so call-site generic inference stays consistent with the `enabled` branch.
const noopRegisterTool = (() => undefined) as unknown as RegisterTool;

/**
 * Returns the function used to register write-class tools.
 *
 * When `ENABLE_CONTENT_REPLACEMENT` is `true`: returns `server.registerTool`
 * bound to the server. Calls behave identically to `server.registerTool(...)`.
 *
 * When `ENABLE_CONTENT_REPLACEMENT` is `false`: returns a no-op. Calls do
 * nothing — the tool is never advertised in `tools/list`.
 *
 * Read-only tools should call `server.registerTool(...)` directly. The
 * asymmetry makes the read/write classification visible at every call site:
 * a `registerWriteTool(...)` line is a write tool by construction; everything
 * else is read-only.
 *
 * The return type is the SDK's full `registerTool` method type, so call-site
 * generic inference (inputSchema → handler args) works exactly as it does
 * with `server.registerTool` directly.
 */
export function getWriteToolRegistrar(server: McpServer): RegisterTool {
  if (!ENABLE_CONTENT_REPLACEMENT) {
    return noopRegisterTool;
  }
  return server.registerTool.bind(server) as RegisterTool;
}

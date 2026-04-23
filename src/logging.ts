import createDebug from 'debug';

export const logger = {
  debug: createDebug('bear-notes-mcp:debug'),
  info: createDebug('bear-notes-mcp:info'),
  error: createDebug('bear-notes-mcp:error'),
};

// Convert UI_DEBUG_TOGGLE boolean set from UI to DEBUG string for debug package
// MCPB has no way to make this in one step with manifest.json
if (process.env.UI_DEBUG_TOGGLE === 'true') {
  process.env.DEBUG = 'bear-notes-mcp:*';
  logger.debug.enabled = true;
}

// Always enable error and info logs
logger.error.enabled = true;
logger.info.enabled = true;

/**
 * Logs an error message and throws an Error to halt execution.
 * Centralizes error handling to ensure consistent logging before failures.
 *
 * @param message - The error message to log and throw
 * @throws Always throws Error with the provided message
 */
export function logAndThrow(message: string): never {
  logger.error(message);
  throw new Error(message);
}

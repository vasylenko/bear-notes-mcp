import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { BEAR_DATABASE_PATH, ERROR_MESSAGES } from './config.js';
import { logAndThrow, logger } from './logging.js';

function getBearDatabasePath(): string {
  // Environment override for testing
  const envPath = process.env.BEAR_DB_PATH;
  if (envPath) {
    logger.debug(`Using environment override database path: ${envPath}`);
    return envPath;
  }

  const defaultPath = join(homedir(), BEAR_DATABASE_PATH);

  if (!existsSync(defaultPath)) {
    logger.error(`Bear database not found at: ${defaultPath}`);
    logAndThrow(`Database error: ${ERROR_MESSAGES.BEAR_DATABASE_NOT_FOUND}`);
  }

  logger.debug(`Using default Bear database path: ${defaultPath}`);
  return defaultPath;
}

/**
 * Closes a Bear database connection, logging but swallowing close errors.
 * Centralizes the try/catch-close pattern used after every DB operation.
 */
export function closeBearDatabase(db: DatabaseSync): void {
  try {
    db.close();
    logger.debug('Database connection closed');
  } catch (closeError) {
    logger.error(`Failed to close database connection: ${closeError}`);
  }
}

/**
 * Opens a read-only connection to Bear's SQLite database.
 *
 * @returns DatabaseSync instance for querying Bear notes
 * @throws Error if Bear database is not found or cannot be opened
 */
export function openBearDatabase(): DatabaseSync {
  const databasePath = getBearDatabasePath();
  logger.info(`Opening Bear database at: ${databasePath}`);

  try {
    const db = new DatabaseSync(databasePath, { readOnly: true });

    // Bear uses journal_mode=delete (not WAL), so readers and writers block each other.
    // Without busy_timeout, our reads fail instantly if Bear is mid-write.
    // DatabaseSync has no constructor option for this (nodejs/node#57597),
    // so we set it via PRAGMA after opening. Blocks the thread while waiting,
    // which is fine for sequential stdio MCP transport.
    db.exec('PRAGMA busy_timeout = 3000');

    logger.debug('Bear database opened successfully');
    return db;
  } catch (error) {
    logger.error(`Failed to open Bear database: ${error}`);
    logAndThrow(
      `Database error: Failed to open Bear database: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

import { spawn } from 'node:child_process';

import { BEAR_URL_SCHEME } from './config.js';
import { logAndThrow, logger } from './logging.js';

/**
 * Parameters for Bear x-callback-url construction
 */
export interface BearUrlParams {
  title?: string | undefined;
  text?: string | undefined;
  tags?: string | undefined;
  id?: string | undefined;
  header?: string | undefined;
  mode?: 'append' | 'prepend' | 'replace' | undefined;
  new_line?: 'yes' | 'no' | undefined;
  file?: string | undefined;
  filename?: string | undefined;
  name?: string | undefined;
  new_name?: string | undefined;
  open_note?: 'yes' | 'no' | undefined;
  new_window?: 'yes' | 'no' | undefined;
  show_window?: 'yes' | 'no' | undefined;
}

/**
 * Builds a Bear x-callback-url for various actions with proper parameter encoding.
 * Includes required UX parameters for optimal user experience.
 *
 * @param action - Bear API action (e.g., 'create', 'add-text')
 * @param params - Parameters for the specific action
 * @returns Properly encoded x-callback-url string
 */
export function buildBearUrl(action: string, params: BearUrlParams = {}): string {
  logger.debug(`Building Bear URL for action: ${action}`);

  if (!action || typeof action !== 'string' || !action.trim()) {
    logAndThrow('Bear URL error: Action parameter is required and must be a non-empty string');
  }

  const baseUrl = `${BEAR_URL_SCHEME}${action.trim()}`;
  const urlParams = new URLSearchParams();

  // Add provided parameters with proper encoding
  const stringParams = [
    'title',
    'text',
    'tags',
    'id',
    'header',
    'file',
    'filename',
    'name',
    'new_name',
  ] as const;
  for (const key of stringParams) {
    const value = params[key];
    if (value !== undefined && value.trim()) {
      urlParams.set(key, value.trim());
    }
  }

  if (params.mode !== undefined) {
    urlParams.set('mode', params.mode);
  }

  if (params.new_line !== undefined) {
    urlParams.set('new_line', params.new_line);
  }

  // UX params with defaults
  urlParams.set('open_note', params.open_note ?? 'yes');
  urlParams.set('new_window', params.new_window ?? 'no');
  urlParams.set('show_window', params.show_window ?? 'yes');

  // Convert URLSearchParams to proper URL encoding (Bear expects %20 not +)
  const queryString = urlParams.toString().replace(/\+/g, '%20');
  const finalUrl = `${baseUrl}?${queryString}`;

  logger.debug(`Built Bear URL: ${finalUrl}`);

  return finalUrl;
}

/**
 * Executes a Bear x-callback-url using macOS subprocess execution.
 * Platform-specific function that requires macOS with Bear Notes installed.
 *
 * @param url - The x-callback-url to execute
 * @returns Promise that resolves when the command completes successfully
 * @throws Error if platform is not macOS or subprocess execution fails
 */
export function executeBearXCallbackApi(url: string): Promise<void> {
  logger.debug('Executing Bear x-callback-url');

  if (!url || typeof url !== 'string' || !url.trim()) {
    logAndThrow('Bear URL error: URL parameter is required and must be a non-empty string');
  }

  return new Promise((resolve, reject) => {
    logger.debug('Launching Bear Notes via x-callback-url');

    const child = spawn('open', ['-g', url.trim()], {
      stdio: 'pipe',
      detached: false,
    });

    let errorOutput = '';

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });
    }

    child.on('close', (code) => {
      if (code === 0) {
        logger.debug('Bear x-callback-url executed successfully');
        resolve();
      } else {
        const errorMessage = `Bear URL error: Failed to execute x-callback-url (exit code: ${code})`;
        const fullError = errorOutput ? `${errorMessage}. Error: ${errorOutput}` : errorMessage;
        logger.error(fullError);
        reject(new Error(fullError));
      }
    });

    child.on('error', (error) => {
      const errorMessage = `Bear URL error: Failed to spawn subprocess: ${error.message}`;
      logger.error(errorMessage);
      reject(new Error(errorMessage));
    });
  });
}

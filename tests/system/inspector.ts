import { spawnSync } from 'child_process';
import { resolve } from 'path';

import { setTimeout as sleep } from 'node:timers/promises';

import { closeBearDatabase, openBearDatabase } from '../../src/infra/database.js';
export { sleep };

const SERVER_PATH = resolve(import.meta.dirname, '../../dist/main.js');

/** Timeout for a single MCP Inspector CLI tool call (ms). */
export const TOOL_CALL_TIMEOUT = 10_000;

interface CallToolOptions {
  toolName: string;
  args?: Record<string, string>;
  env?: Record<string, string>;
}

export interface ToolResponse {
  content: { type: string; text: string }[];
  isError?: boolean;
}

/**
 * Invokes an MCP tool via the Inspector CLI and returns the full parsed response.
 * Each call spawns a fresh server process — no shared state between calls.
 */
export function callTool({ toolName, args, env }: CallToolOptions): ToolResponse {
  const cliArgs = ['@modelcontextprotocol/inspector', '--cli'];

  // Inspector's -e flag passes env vars to the spawned server process
  for (const [key, value] of Object.entries(env ?? {})) {
    cliArgs.push('-e', `${key}=${value}`);
  }

  cliArgs.push('node', SERVER_PATH, '--method', 'tools/call', '--tool-name', toolName);

  for (const [key, value] of Object.entries(args ?? {})) {
    cliArgs.push('--tool-arg', `${key}=${value}`);
  }

  const result = spawnSync('npx', cliArgs, {
    encoding: 'utf-8',
    timeout: TOOL_CALL_TIMEOUT,
  });

  if (result.error) {
    throw new Error(`Inspector CLI failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Inspector CLI exited with code ${result.status}: ${result.stderr}`);
  }

  const response: ToolResponse = JSON.parse(result.stdout);

  if (!response.content?.length) {
    throw new Error(`Inspector returned empty content for tool "${toolName}": ${result.stdout}`);
  }

  return response;
}

/**
 * Extracts the note body from bear-open-note response text.
 * The response has metadata (title, modified, ID) separated by `---`,
 * then the actual note content.
 */
export function extractNoteBody(openNoteResponse: string): string {
  const sections = openNoteResponse.split('\n\n---\n\n');

  if (sections.length < 2) {
    throw new Error(
      `Expected metadata separator (---) in open-note response, got:\n${openNoteResponse.substring(0, 200)}`
    );
  }

  return sections.slice(1).join('\n\n---\n\n');
}

const NOTE_ID_REGEX = /ID:\s+([A-Fa-f0-9-]+)/;

/** Extracts a note ID from any MCP response containing "ID: <uuid>", or null if absent. */
export function tryExtractNoteId(response: string): string | null {
  const match = response.match(NOTE_ID_REGEX);
  return match ? match[1] : null;
}

/** Trash a note by ID via Bear URL scheme (no MCP tool exists for trashing). */
export function trashNote(id: string): void {
  try {
    const url = `bear://x-callback-url/trash?id=${encodeURIComponent(id)}`;
    spawnSync('open', ['-g', url]);
    spawnSync('sleep', ['1']);
  } catch {
    // Best-effort — don't fail the test
  }
}

/**
 * Trashes all active notes whose title starts with the given prefix.
 * Intended for afterAll cleanup to remove stray test notes from interrupted runs.
 *
 * Queries Bear's SQLite DB directly rather than going through bear-search-notes:
 * under FTS5 the search tool tokenizes the prefix and OR-joins the tokens
 * (so `[Bear-MCP-stest]` becomes `Bear OR MCP OR stest`), which would over-
 * match unrelated developer notes during local runs. Direct prefix LIKE
 * keeps cleanup scoped to the test surface — and applies regardless of how
 * the search tool's tokenizer evolves.
 */
export function cleanupTestNotes(prefix: string): void {
  if (!prefix) return;

  let db: ReturnType<typeof openBearDatabase>;
  try {
    db = openBearDatabase();
  } catch {
    // Best-effort — DB unavailable means there's nothing reachable to clean
    return;
  }

  try {
    // Escape LIKE wildcards in the prefix itself so a TEST_PREFIX containing
    // `%` or `_` (none currently, but cheap insurance) doesn't widen the match.
    const escapedPrefix = prefix.replace(/[%_\\]/g, '\\$&');
    const rows = db
      .prepare(
        'SELECT ZUNIQUEIDENTIFIER as uuid FROM ZSFNOTE ' +
          "WHERE ZTITLE LIKE ? || '%' ESCAPE '\\' " +
          'AND ZTRASHED = 0 AND ZARCHIVED = 0 AND ZENCRYPTED = 0'
      )
      .all(escapedPrefix) as Array<{ uuid: string }>;
    for (const row of rows) {
      trashNote(row.uuid);
    }
  } catch {
    // Best-effort — partial cleanup is fine; the suite still ran assertions
  } finally {
    closeBearDatabase(db);
  }
}

/** Generates a unique note title scoped to a test run, preventing cross-run collisions. */
export function uniqueTitle(prefix: string, label: string, runId: number): string {
  return `${prefix} ${label} ${runId}`;
}

interface PollOptions {
  timeoutMs?: number;
  intervalMs?: number;
  label?: string;
}

/**
 * Polls an action until a predicate is satisfied or the timeout expires.
 * Replaces ad-hoc while loops across system tests.
 */
export async function pollUntil<T>(
  action: () => T,
  predicate: (result: T) => boolean,
  { timeoutMs = 5_000, intervalMs = 1_000, label = 'condition' }: PollOptions = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = action();
    if (predicate(result)) return result;
    await sleep(intervalMs);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

/**
 * Polls bear-open-note until the attached-files content block contains the expected marker.
 * Avoids flaky fixed sleeps by polling for actual content availability (e.g. OCR text or filename).
 */
export async function waitForFileContent(
  noteId: string,
  marker: string,
  timeoutMs = 15_000
): Promise<ToolResponse> {
  return pollUntil(
    () => callTool({ toolName: 'bear-open-note', args: { id: noteId } }),
    (r) => r.content.length > 1 && r.content[1].text.includes(marker),
    { timeoutMs, label: `file content "${marker}" in note ${noteId}` }
  );
}

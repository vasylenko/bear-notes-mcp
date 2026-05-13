import { spawnSync } from 'child_process';
import { resolve } from 'path';

import { setTimeout as sleep } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

// System tests default to Edit Mode ON: most exercise write tools, which
// the registration-time gate hides when off. Tests that need gate-closed
// behavior import GATE_CLOSED_ENV.
//
// Why `'false'` and not empty: MCP Inspector's `-e KEY=VALUE` parser rejects
// empty values; any non-'true' string fails the server-side `=== 'true'`
// check equally well.
const SYSTEM_TEST_EDIT_MODE_ON_DEFAULT: Record<string, string> = {
  UI_ENABLE_CONTENT_REPLACEMENT: 'true',
};

export const GATE_CLOSED_ENV: Record<string, string> = {
  UI_ENABLE_CONTENT_REPLACEMENT: 'false',
};

// Centralizes env-var injection (`-e KEY=VALUE`) so every method caller stays
// consistent. Inspector's `-e` flag forwards env to the spawned server process.
function buildInspectorArgs(
  env: Record<string, string> | undefined,
  methodArgs: string[]
): string[] {
  const cliArgs = ['@modelcontextprotocol/inspector', '--cli'];

  const fullEnv = { ...SYSTEM_TEST_EDIT_MODE_ON_DEFAULT, ...(env ?? {}) };
  for (const [key, value] of Object.entries(fullEnv)) {
    cliArgs.push('-e', `${key}=${value}`);
  }

  cliArgs.push('node', SERVER_PATH, ...methodArgs);
  return cliArgs;
}

// Each method caller parses the stdout itself because response shapes differ
// across tools/call, tools/list, and initialize.
function execInspector(env: Record<string, string> | undefined, methodArgs: string[]): string {
  const result = spawnSync('npx', buildInspectorArgs(env, methodArgs), {
    encoding: 'utf-8',
    timeout: TOOL_CALL_TIMEOUT,
  });

  if (result.error) {
    throw new Error(`Inspector CLI failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Inspector CLI exited with code ${result.status}: ${result.stderr}`);
  }

  return result.stdout;
}

/** Each call spawns a fresh server process — no shared state between calls. */
export function callTool({ toolName, args, env }: CallToolOptions): ToolResponse {
  const methodArgs = ['--method', 'tools/call', '--tool-name', toolName];

  for (const [key, value] of Object.entries(args ?? {})) {
    methodArgs.push('--tool-arg', `${key}=${value}`);
  }

  const stdout = execInspector(env, methodArgs);
  const response: ToolResponse = JSON.parse(stdout);

  if (!response.content?.length) {
    throw new Error(`Inspector returned empty content for tool "${toolName}": ${stdout}`);
  }

  return response;
}

interface ToolListEntry {
  name: string;
  description?: string;
}

interface ToolListResponse {
  tools: ToolListEntry[];
}

export function listTools(env?: Record<string, string>): string[] {
  const stdout = execInspector(env, ['--method', 'tools/list']);
  const response: ToolListResponse = JSON.parse(stdout);

  if (!response.tools) {
    throw new Error(`Inspector returned no tools list: ${stdout}`);
  }

  return response.tools.map((t) => t.name);
}

export interface InitializeResult {
  serverInfo: { name: string; version: string };
  instructions?: string;
}

// Inspector's CLI does not expose `--method initialize` (initialize is part of
// the implicit handshake). We talk to the SDK Client directly instead — connect
// performs the handshake, and the Client caches `instructions` and serverInfo
// for read-back via getInstructions() / getServerVersion().
export async function initialize(env?: Record<string, string>): Promise<InitializeResult> {
  // Both this transport and `execInspector` must forward process.env so the
  // spawned server inherits BEAR_DB_PATH, PATH, HOME, etc. Inspector inherits
  // implicitly via npx; SDK Client replaces process.env wholesale unless we
  // spread it. Both converge on the same effective env.
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_PATH],
    env: {
      ...process.env,
      ...SYSTEM_TEST_EDIT_MODE_ON_DEFAULT,
      ...(env ?? {}),
    } as Record<string, string>,
  });
  const client = new Client(
    { name: 'bear-notes-system-test', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    const serverInfo = client.getServerVersion();

    if (!serverInfo) {
      throw new Error('SDK Client returned no serverInfo after connect');
    }

    return {
      serverInfo: { name: serverInfo.name, version: serverInfo.version },
      instructions: client.getInstructions(),
    };
  } finally {
    await client.close();
  }
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

// Matches both "Revision: 42" and the archive variant "Revision at time of archive: 42".
// Returns null for the timeout sentence ("Revision: unknown (...)") because that
// contains no integer to extract — callers detect that branch by checking for
// the literal "unknown" substring separately.
const NOTE_REVISION_REGEX = /Revision(?:\s+at\s+time\s+of\s+archive)?:\s+(\d+)/;

/** Extracts a numeric revision from any MCP response, or null if not present (or the timeout sentence). */
export function tryExtractRevision(response: string): number | null {
  const match = response.match(NOTE_REVISION_REGEX);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Reads the live Z_OPT value for a note via direct SQL against Bear's DB.
 * Used by OCC system tests to verify response Revision matches the actual
 * source-of-truth value. Returns null if the note doesn't exist or is filtered.
 */
export function readNoteRevision(id: string): number | null {
  let db: ReturnType<typeof openBearDatabase> | undefined;
  try {
    db = openBearDatabase();
    const row = db.prepare('SELECT Z_OPT FROM ZSFNOTE WHERE ZUNIQUEIDENTIFIER = ?').get(id) as
      | { Z_OPT: number }
      | undefined;
    return row ? row.Z_OPT : null;
  } catch {
    return null;
  } finally {
    if (db) closeBearDatabase(db);
  }
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
    const escapedPrefix = prefix.replaceAll(/[%_\\]/g, String.raw`\$&`);
    const rows = db
      .prepare(
        'SELECT ZUNIQUEIDENTIFIER as uuid FROM ZSFNOTE ' +
          String.raw`WHERE ZTITLE LIKE ? || '%' ESCAPE '\' ` +
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

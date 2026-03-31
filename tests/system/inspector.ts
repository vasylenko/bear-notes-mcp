import { spawnSync } from 'child_process';
import { resolve } from 'path';

import { setTimeout as sleep } from 'node:timers/promises';
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

/**
 * Extracts the first note ID from bear-search-notes response text.
 * The response format includes `ID: <uuid>` for each result.
 */
function extractNoteId(searchResponse: string): string {
  const id = tryExtractNoteId(searchResponse);
  if (!id) {
    throw new Error(`No note ID found in search response: ${searchResponse}`);
  }
  return id;
}

/** Archive a note by ID, swallowing errors during cleanup. */
export function archiveNote(id: string): void {
  try {
    callTool({ toolName: 'bear-archive-note', args: { id } });
  } catch {
    // Best-effort cleanup — don't fail the test
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
 * Archives all notes matching a search prefix.
 * Intended for afterAll cleanup to remove stray test notes from interrupted runs.
 */
export function cleanupTestNotes(prefix: string): void {
  try {
    const searchResult = callTool({
      toolName: 'bear-search-notes',
      args: { term: prefix },
    }).content[0].text;
    const idMatches = searchResult.matchAll(new RegExp(NOTE_ID_REGEX, 'g'));
    for (const match of idMatches) {
      trashNote(match[1]);
    }
  } catch {
    // Best-effort — test notes may already be archived
  }
}

/** Generates a unique note title scoped to a test run, preventing cross-run collisions. */
export function uniqueTitle(prefix: string, label: string, runId: number): string {
  return `${prefix} ${label} ${runId}`;
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
  const interval = 1_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = callTool({ toolName: 'bear-open-note', args: { id: noteId } });
    if (response.content.length > 1 && response.content[1].text.includes(marker)) {
      return response;
    }
    await sleep(interval);
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for file content containing "${marker}" in note ${noteId}`
  );
}

/** Search for a note by title and return its ID. */
export function findNoteId(noteTitle: string): string {
  const searchResult = callTool({
    toolName: 'bear-search-notes',
    args: { term: noteTitle },
  }).content[0].text;
  return extractNoteId(searchResult);
}

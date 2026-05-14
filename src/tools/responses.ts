import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { POLL_TIMEOUT_MS, REVISION_POLL_CAP_MS } from '../operations/notes.js';
import type { NoteRevision } from '../types.js';

/**
 * Creates a standardized MCP tool response with consistent formatting.
 * Centralizes response structure to follow DRY principles.
 *
 * @param text - The response text content
 * @returns Formatted CallToolResult for MCP tools
 */
export function createToolResponse(text: string): Pick<CallToolResult, 'content'> {
  return {
    content: [
      {
        type: 'text' as const,
        text,
        annotations: { audience: ['user', 'assistant'] as const },
      },
    ],
  };
}

/**
 * Creates a standardized MCP error response with isError flag.
 * Signals to the LLM that the tool failed and self-correction may be needed.
 * Per the MCP spec, tool errors use isError: true inside the result object
 * so the LLM can see the failure and retry or adjust its approach.
 *
 * @param text - The error description with recovery guidance
 * @returns Formatted CallToolResult with isError: true
 */
export function createErrorResponse(text: string): Pick<CallToolResult, 'content' | 'isError'> {
  return { ...createToolResponse(text), isError: true };
}

// Composed from REVISION_POLL_CAP_MS so the sentence stays in lockstep with the
// runtime cap — per MCP_STANDARDS.md: "Source numeric defaults from runtime
// constants, not string literals."
export const REVISION_TIMEOUT_SENTENCE = `Revision: unknown (write confirmation timed out after ${REVISION_POLL_CAP_MS}ms)`;

// bear-create-note's confirmation path polls via awaitNoteCreation (cap
// POLL_TIMEOUT_MS), not the post-write inequality poll. The default write-
// timeout sentence cites the wrong cap and the wrong operation; a create-
// specific sentinel keeps the cited duration honest and replaces "write
// confirmation" with "creation confirmation" so the failure mode is named
// correctly.
export const REVISION_CREATION_TIMEOUT_SENTENCE = `Revision: unknown (creation confirmation timed out after ${POLL_TIMEOUT_MS}ms)`;

// The write-timeout sentence reads as "the value should exist but we couldn't
// confirm it"; for search-result hydration the truth is different — the note
// vanished from the live DB between the FTS index build and the hydration read
// (deleted, archived, or encrypted concurrently). A read-side miss against the
// write-side sentence would lie about the origin of the unknown.
export const REVISION_UNAVAILABLE_SENTENCE =
  'Revision: unknown (note not found in live database — likely deleted, archived, or encrypted since the search index was built)';

/**
 * Formats the OCC revision line that accompanies every note-scoped tool
 * response. Centralized so numeric and sentinel renderings stay consistent
 * across read responses, search result entries, and write responses.
 *
 * @param revision - Z_OPT value, or null when the revision could not be captured
 * @param unknownSentence - which sentinel to emit on null (defaults to the
 *   write-timeout sentence; pass REVISION_UNAVAILABLE_SENTENCE for read-side misses)
 * @returns "Revision: <n>" or the chosen sentinel sentence
 */
export function formatRevisionLine(
  revision: NoteRevision | null,
  unknownSentence: string = REVISION_TIMEOUT_SENTENCE
): string {
  return revision === null ? unknownSentence : `Revision: ${revision}`;
}

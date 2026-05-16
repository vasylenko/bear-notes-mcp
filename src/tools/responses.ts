import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { POLL_TIMEOUT_MS } from '../operations/notes.js';
import type { NoteRevision } from '../types.js';

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

// isError: true inside the result object is the MCP-spec signal that lets the
// LLM see the failure and self-correct rather than treating it as a transport
// error. Wrapping vs throwing matters here.
export function createErrorResponse(text: string): Pick<CallToolResult, 'content' | 'isError'> {
  return { ...createToolResponse(text), isError: true };
}

// Three failure modes, three sentences. TIMEOUT and UNAVAILABLE are
// duration-free: the post-write safety window is an internal implementation
// choice the caller doesn't act on, so the sentence shouldn't promise a
// specific number that the underlying cap can outgrow. CREATION_TIMEOUT
// keeps its duration because the create-poll cap IS the user-visible budget;
// it's composed from POLL_TIMEOUT_MS (per MCP_STANDARDS "source numeric
// defaults from runtime constants") so the sentence can't drift.
export const REVISION_TIMEOUT_SENTENCE =
  'Revision: unknown (the write was issued but observable confirmation did not arrive within the safety window)';
export const REVISION_CREATION_TIMEOUT_SENTENCE = `Revision: unknown (creation confirmation timed out after ${POLL_TIMEOUT_MS}ms)`;
export const REVISION_UNAVAILABLE_SENTENCE =
  'Revision: unknown (note not found in live database — likely deleted, archived, or encrypted since the search index was built)';

// Default unknownSentence is the post-write timeout — callers on the
// read-miss path pass REVISION_UNAVAILABLE_SENTENCE explicitly.
export function formatRevisionLine(
  revision: NoteRevision | null,
  unknownSentence: string = REVISION_TIMEOUT_SENTENCE
): string {
  return revision === null ? unknownSentence : `Revision: ${revision}`;
}

// The message deliberately omits the live revision value. Including it would
// let an agent satisfy the gate without re-reading the body.
export const STALE_REVISION_MESSAGE =
  'Stale note revision! The note has been edited since your last read, so the cached body you would write from is no longer trustworthy. Re-read the note with `bear-open-note` to capture the current state and revision, then retry with the fresh revision.';

// Single point of policy for the OCC enforce gate. Body-modifying note tools
// delegate here after their pre-flight read, before any tool-specific validation,
// so a stale view of the note's structure surfaces as a stale-revision error
// rather than a misleading downstream pre-flight failure.
export function checkRevisionGate(
  expected: NoteRevision,
  live: NoteRevision
): Pick<CallToolResult, 'content' | 'isError'> | null {
  if (expected !== live) return createErrorResponse(STALE_REVISION_MESSAGE);
  return null;
}

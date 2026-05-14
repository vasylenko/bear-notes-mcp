import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { POLL_TIMEOUT_MS, REVISION_POLL_CAP_MS } from '../operations/notes.js';
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

// Sentinels are composed from runtime caps so the cited durations can't drift
// from the values that actually fire (per MCP_STANDARDS "source numeric
// defaults from runtime constants"). Three failure modes, three sentences:
// - TIMEOUT: post-write inequality poll exhausted (content writes)
// - CREATION_TIMEOUT: create-path poll never saw the new row
// - UNAVAILABLE: search-result hydration didn't find the row (note vanished)
export const REVISION_TIMEOUT_SENTENCE = `Revision: unknown (write confirmation timed out after ${REVISION_POLL_CAP_MS}ms)`;
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

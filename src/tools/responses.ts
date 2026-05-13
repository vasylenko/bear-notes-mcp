import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { REVISION_POLL_CAP_MS } from '../operations/notes.js';
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

/**
 * Formats the OCC revision line that accompanies every note-scoped tool
 * response. Centralized so the format and the timeout fallback are identical
 * across read responses, search result entries, and write responses.
 *
 * @param revision - Z_OPT value, or null when post-write polling timed out
 * @returns "Revision: <n>" or the timeout sentence
 */
export function formatRevisionLine(revision: NoteRevision | null): string {
  return revision === null ? REVISION_TIMEOUT_SENTENCE : `Revision: ${revision}`;
}

import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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

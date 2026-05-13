import { describe, expect, it } from 'vitest';

import { REVISION_POLL_CAP_MS } from '../operations/notes.js';

import { REVISION_TIMEOUT_SENTENCE } from './responses.js';

describe('REVISION_TIMEOUT_SENTENCE', () => {
  // Locks in two contracts: (a) the sentence is composed from the runtime cap
  // constant — string-literal drift would silently desync, exactly the class
  // of bug MCP_STANDARDS.md warns about; (b) the user/LLM-facing prefix is
  // "Revision: unknown" so consumers can parse around it the same way they
  // parse "Revision: <n>".
  it('starts with the literal "Revision: unknown" prefix', () => {
    expect(REVISION_TIMEOUT_SENTENCE.startsWith('Revision: unknown')).toBe(true);
  });

  it(`includes the runtime cap (${REVISION_POLL_CAP_MS}ms)`, () => {
    expect(REVISION_TIMEOUT_SENTENCE).toContain(`${REVISION_POLL_CAP_MS}ms`);
  });
});

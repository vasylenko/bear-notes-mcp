import { describe, expect, it } from 'vitest';

import { convertCoreDataTimestamp, decodeTagName } from './bear-encoding.js';

describe('convertCoreDataTimestamp', () => {
  it('converts Core Data timestamp to correct ISO string', () => {
    // Core Data timestamp 0 = 2001-01-01 00:00:00 UTC
    const result = convertCoreDataTimestamp(0);

    expect(result).toBe('2001-01-01T00:00:00.000Z');
  });
});

// decodeTagName is the single source of truth for tag normalization on both
// the index side (insertNoteTags) and the query side (buildFilterClauses).
// SQLite's built-in LOWER() is ASCII-only, so JS-side toLowerCase() is what
// makes Unicode tag matching work — that contract is pinned here, not at the
// integration level, because it's a pure-function input/output relationship.
describe('decodeTagName', () => {
  it.each([
    {
      name: '+ → space (Bear stores multi-word tags URL-encoded with +)',
      input: 'My+Cool+Tag',
      expected: 'my cool tag',
    },
    { name: 'lowercases ASCII', input: 'Career', expected: 'career' },
    {
      name: 'lowercases Unicode (SQLite LOWER is ASCII-only; JS folds CAFÉ → café)',
      input: 'CAFÉ',
      expected: 'café',
    },
    {
      name: 'preserves hierarchical / between segments',
      input: 'Career/My+Meetings',
      expected: 'career/my meetings',
    },
    { name: 'trims whitespace', input: '  spaced  ', expected: 'spaced' },
  ])('$name', ({ input, expected }) => {
    expect(decodeTagName(input)).toBe(expected);
  });
});

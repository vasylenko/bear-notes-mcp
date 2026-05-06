import { describe, expect, it } from 'vitest';

import { convertCoreDataTimestamp } from './bear-encoding.js';

describe('convertCoreDataTimestamp', () => {
  it('converts Core Data timestamp to correct ISO string', () => {
    // Core Data timestamp 0 = 2001-01-01 00:00:00 UTC
    const result = convertCoreDataTimestamp(0);

    expect(result).toBe('2001-01-01T00:00:00.000Z');
  });
});

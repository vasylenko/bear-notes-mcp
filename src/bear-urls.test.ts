import { describe, expect, it } from 'vitest';

import { buildBearUrl } from './bear-urls.js';

describe('buildBearUrl', () => {
  it('encodes spaces as %20, not +', () => {
    const url = buildBearUrl('create', { title: 'Hello World' });

    expect(url).toContain('Hello%20World');
    expect(url).not.toContain('Hello+World');
  });

  it('preserves literal + by encoding as %2B', () => {
    const url = buildBearUrl('create', { title: '1+1=2' });

    expect(url).toContain('1%2B1%3D2');
  });
});

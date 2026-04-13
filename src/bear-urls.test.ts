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

  it('encodes url param for grab-url action', () => {
    const url = buildBearUrl('grab-url', { url: 'https://example.com/page?q=hello world' });

    expect(url).toContain('grab-url?');
    expect(url).toContain('url=https%3A%2F%2Fexample.com%2Fpage%3Fq%3Dhello%20world');
  });

  it('includes pin and wait params when provided', () => {
    const url = buildBearUrl('grab-url', { url: 'https://example.com', pin: 'no', wait: 'yes' });

    expect(url).toContain('pin=no');
    expect(url).toContain('wait=yes');
  });

  it('omits pin and wait params when undefined', () => {
    const url = buildBearUrl('grab-url', { url: 'https://example.com' });

    expect(url).not.toContain('pin=');
    expect(url).not.toContain('wait=');
  });
});

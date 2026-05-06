import { describe, expect, it } from 'vitest';

import { stripTagPrefix } from './tags.js';

describe('stripTagPrefix', () => {
  it('strips a single leading hash', () => {
    expect(stripTagPrefix('#career')).toBe('career');
  });

  it('strips multiple leading hashes', () => {
    expect(stripTagPrefix('##career')).toBe('career');
  });

  it('leaves a bare tag name unchanged', () => {
    expect(stripTagPrefix('career')).toBe('career');
  });

  it('reduces a lone "#" to an empty string', () => {
    // Downstream Zod .pipe(min(1)) handles the rejection — this assertion
    // only pins the strip output, not the schema-level validation.
    expect(stripTagPrefix('#')).toBe('');
  });

  it('does not strip "#" embedded mid-string', () => {
    // Anchor sentinel: catches a regex regression that drops the ^ anchor.
    expect(stripTagPrefix('foo#bar')).toBe('foo#bar');
  });
});

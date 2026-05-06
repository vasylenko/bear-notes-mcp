import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { noteHasHeader, parseDateString, searchNotes, stripLeadingHeader } from './notes.js';

describe('parseDateString', () => {
  beforeEach(() => {
    // Fix "now" to January 15, 2026 for predictable tests
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('"start of last month" in January returns December of previous year', () => {
    const result = parseDateString('start of last month');

    expect(result.getFullYear()).toBe(2025);
    expect(result.getMonth()).toBe(11); // December (0-indexed)
    expect(result.getDate()).toBe(1);
  });

  it('"end of last month" returns last day with end-of-day time', () => {
    const result = parseDateString('end of last month');

    expect(result.getFullYear()).toBe(2025);
    expect(result.getMonth()).toBe(11); // December
    expect(result.getDate()).toBe(31);
    expect(result.getHours()).toBe(23);
    expect(result.getMinutes()).toBe(59);
    expect(result.getSeconds()).toBe(59);
  });

  // ISO date-only inputs must be interpreted in local time — callers snap
  // bounds with local-time setHours, so a UTC-midnight parse would produce
  // previous-day bounds for negative-UTC users. Asserting local-time
  // components catches the bug for any developer running tests in non-UTC.
  it('parses ISO YYYY-MM-DD as local-time midnight', () => {
    const result = parseDateString('2026-04-15');

    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(3); // April, 0-indexed
    expect(result.getDate()).toBe(15);
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
    expect(result.getSeconds()).toBe(0);
    expect(result.getMilliseconds()).toBe(0);
  });

  it('ISO date-only result equals local-time Date(y, m-1, d)', () => {
    expect(parseDateString('2026-04-15').getTime()).toBe(new Date(2026, 3, 15).getTime());
  });

  it('rejects invalid ISO components instead of rolling over', () => {
    // Date(2026, 1, 30) silently becomes March 2; the round-trip check rejects it.
    expect(() => parseDateString('2026-02-30')).toThrow(/Invalid date format/);
    expect(() => parseDateString('2026-13-01')).toThrow(/Invalid date format/);
    expect(() => parseDateString('2026-04-00')).toThrow(/Invalid date format/);
  });

  it('preserves explicit-timezone datetime semantics (fallthrough path)', () => {
    // Strings with explicit TZ keep their UTC interpretation — only the
    // ambiguous YYYY-MM-DD form was reinterpreted as local-time.
    const utc = parseDateString('2026-04-15T00:00:00Z');
    expect(utc.getTime()).toBe(Date.UTC(2026, 3, 15, 0, 0, 0));
  });
});

describe('noteHasHeader', () => {
  const noteText = [
    '# Title',
    'Intro paragraph',
    '',
    '## Details',
    'Some details here',
    '',
    '### Q&A',
    'Questions and answers',
    '',
    '## Details (v2)',
    'Updated details',
    '',
    '## v1.0 Release',
    'Release notes',
  ].join('\n');

  it('finds an exact header match', () => {
    expect(noteHasHeader(noteText, 'Details')).toBe(true);
  });

  it('strips markdown prefix from header input', () => {
    expect(noteHasHeader(noteText, '## Details')).toBe(true);
    expect(noteHasHeader(noteText, '### Q&A')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(noteHasHeader(noteText, 'details')).toBe(true);
    expect(noteHasHeader(noteText, 'DETAILS')).toBe(true);
  });

  it('rejects partial header name', () => {
    expect(noteHasHeader(noteText, 'Detail')).toBe(false);
  });

  it('handles parentheses in header name', () => {
    expect(noteHasHeader(noteText, 'Details (v2)')).toBe(true);
  });

  it('handles ampersand in header name', () => {
    expect(noteHasHeader(noteText, 'Q&A')).toBe(true);
  });

  it('handles dots in header name', () => {
    expect(noteHasHeader(noteText, 'v1.0 Release')).toBe(true);
  });

  it('returns false for empty note text', () => {
    expect(noteHasHeader('', 'Details')).toBe(false);
  });

  it('returns false for empty header input', () => {
    expect(noteHasHeader(noteText, '')).toBe(false);
  });
});

describe('stripLeadingHeader', () => {
  it('strips matching header with exact case', () => {
    expect(stripLeadingHeader('## Details\nNew content', 'Details')).toBe('New content');
  });

  it('strips matching header case-insensitively', () => {
    expect(stripLeadingHeader('## DETAILS\nNew content', 'Details')).toBe('New content');
    expect(stripLeadingHeader('## details\nNew content', 'Details')).toBe('New content');
  });

  it('strips matching header at any heading level', () => {
    expect(stripLeadingHeader('### Details\nNew content', 'Details')).toBe('New content');
    expect(stripLeadingHeader('#### Details\nNew content', 'Details')).toBe('New content');
  });

  it('does not strip when header text does not match', () => {
    expect(stripLeadingHeader('## Other\nNew content', 'Details')).toBe('## Other\nNew content');
  });

  it('does not strip when text does not start with a header', () => {
    expect(stripLeadingHeader('New content', 'Details')).toBe('New content');
  });

  it('handles special characters in header name', () => {
    expect(stripLeadingHeader('## Details (v2)\nNew content', 'Details (v2)')).toBe('New content');
    expect(stripLeadingHeader('## Q&A\nNew content', 'Q&A')).toBe('New content');
  });

  it('returns text unchanged when header is empty string', () => {
    expect(stripLeadingHeader('## Details\nNew content', '')).toBe('## Details\nNew content');
  });
});

describe('searchNotes validation', () => {
  // The "at least one criterion" check must look at trimmed values; otherwise a
  // whitespace-only term passes `!!searchTerm` then trims to empty and the
  // search silently degrades to browse-all-recent-notes. The throw runs before
  // any FTS5/database contact, so this is unit-test scope by design.
  it.each([
    { name: 'whitespace-only searchTerm', call: () => searchNotes('   ') },
    { name: 'whitespace-only tag', call: () => searchNotes(undefined, '   ') },
    { name: 'all parameters omitted', call: () => searchNotes() },
  ])('throws when no real search criterion is provided: $name', ({ call }) => {
    expect(call).toThrow(/Please provide a search term, tag, date filter, or pinned filter/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { noteHasHeader, parseDateString, stripLeadingHeader } from './utils.js';

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

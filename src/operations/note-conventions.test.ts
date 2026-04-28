import { describe, expect, it } from 'vitest';

import {
  applyNoteConventions,
  formatTagsAsInlineSyntax,
  insertInlineTags,
  parseFrontmatter,
} from './note-conventions.js';

describe('parseFrontmatter', () => {
  it('returns null frontmatter when text does not start with ---', () => {
    const text = '# Title\nbody';
    expect(parseFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });

  it('detects frontmatter when --- is first line with closing ---', () => {
    const result = parseFrontmatter('---\ntitle: Test\n---\nbody');
    expect(result.frontmatter).toBe('---\ntitle: Test\n---');
    expect(result.body).toBe('body');
  });

  it('returns null frontmatter when no closing --- exists', () => {
    const text = '---\nno closing line\ncontent';
    expect(parseFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });

  it('ignores horizontal rules in body — --- not at line 1', () => {
    const text = '# Title\n---\nhorizontal rule\n---\nbody';
    expect(parseFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });

  it('handles empty body after frontmatter', () => {
    const result = parseFrontmatter('---\nkey: val\n---\n');
    expect(result.frontmatter).toBe('---\nkey: val\n---');
    expect(result.body).toBe('');
  });

  it('handles multi-key frontmatter with body including H1', () => {
    const text = '---\ntitle: My Note\ntags: [work]\n---\n# My Note\ncontent';
    const result = parseFrontmatter(text);
    expect(result.frontmatter).toBe('---\ntitle: My Note\ntags: [work]\n---');
    expect(result.body).toBe('# My Note\ncontent');
  });

  it('returns null frontmatter when --- is present but not at line 1', () => {
    const text = '\n---\nkey: val\n---\nbody';
    expect(parseFrontmatter(text)).toEqual({ frontmatter: null, body: text });
  });
});

describe('formatTagsAsInlineSyntax', () => {
  it('converts comma-separated tags to Bear inline syntax', () => {
    expect(formatTagsAsInlineSyntax('work,urgent')).toBe('#work #urgent');
  });

  it('adds closing hash for tags with spaces', () => {
    expect(formatTagsAsInlineSyntax('my tag')).toBe('#my tag#');
  });

  it('returns empty string for all-invalid tags', () => {
    expect(formatTagsAsInlineSyntax('###,,,')).toBe('');
  });
});

describe('applyNoteConventions', () => {
  describe('pass-through when no tags provided', () => {
    it('undefined tags returns text unchanged', () => {
      const result = applyNoteConventions({ text: 'hello', tags: undefined });

      expect(result).toEqual({ text: 'hello', tags: undefined });
    });

    it('empty string tags returns text unchanged', () => {
      const result = applyNoteConventions({ text: 'hello', tags: '' });

      expect(result).toEqual({ text: 'hello', tags: undefined });
    });

    it('both text and tags undefined returns both unchanged', () => {
      const result = applyNoteConventions({ text: undefined, tags: undefined });

      expect(result).toEqual({ text: undefined, tags: undefined });
    });
  });

  describe('tags only, no text', () => {
    it('multiple tags produce tag line without separator', () => {
      const result = applyNoteConventions({ text: undefined, tags: 'work,urgent' });

      expect(result).toEqual({ text: '#work #urgent', tags: undefined });
    });

    it('empty string text treated as no text', () => {
      const result = applyNoteConventions({ text: '', tags: 'work' });

      expect(result).toEqual({ text: '#work', tags: undefined });
    });
  });

  describe('tags + text composition', () => {
    it('multiple tags and text joined with separator', () => {
      const result = applyNoteConventions({ text: 'body', tags: 'work,urgent' });

      expect(result).toEqual({ text: '#work #urgent\n---\nbody', tags: undefined });
    });

    it('single tag and text joined with separator', () => {
      const result = applyNoteConventions({ text: 'body', tags: 'work' });

      expect(result).toEqual({ text: '#work\n---\nbody', tags: undefined });
    });
  });

  describe('closing hash rules', () => {
    it('nested tag without spaces has no closing hash', () => {
      const result = applyNoteConventions({ text: undefined, tags: 'work/meetings' });

      expect(result).toEqual({ text: '#work/meetings', tags: undefined });
    });

    it('tag with space gets closing hash', () => {
      const result = applyNoteConventions({ text: undefined, tags: 'my tag' });

      expect(result).toEqual({ text: '#my tag#', tags: undefined });
    });

    it('nested tag with spaces gets closing hash', () => {
      const result = applyNoteConventions({ text: undefined, tags: 'work/meeting notes' });

      expect(result).toEqual({ text: '#work/meeting notes#', tags: undefined });
    });

    it('simple tag has no closing hash', () => {
      const result = applyNoteConventions({ text: undefined, tags: 'urgent' });

      expect(result).toEqual({ text: '#urgent', tags: undefined });
    });

    it('mixed tags apply closing hash per-tag', () => {
      const result = applyNoteConventions({ text: undefined, tags: 'work/meetings,urgent,my tag' });

      expect(result).toEqual({ text: '#work/meetings #urgent #my tag#', tags: undefined });
    });
  });

  describe('tag cleanup edge cases', () => {
    it('strips leading and trailing hash symbols from tags', () => {
      const result = applyNoteConventions({ text: undefined, tags: '#work,##urgent#' });

      expect(result).toEqual({ text: '#work #urgent', tags: undefined });
    });

    it('all-invalid tags pass text through unchanged', () => {
      const result = applyNoteConventions({ text: 'hello', tags: '###,,,  ' });

      expect(result).toEqual({ text: 'hello', tags: undefined });
    });

    it('empty segments between commas are filtered out', () => {
      const result = applyNoteConventions({ text: undefined, tags: 'work, , ,urgent' });

      expect(result).toEqual({ text: '#work #urgent', tags: undefined });
    });

    it('whitespace around tags is trimmed', () => {
      const result = applyNoteConventions({ text: undefined, tags: ' work , urgent ' });

      expect(result).toEqual({ text: '#work #urgent', tags: undefined });
    });
  });
});

describe('insertInlineTags', () => {
  it('appends tags at the end for default placement', () => {
    const result = insertInlineTags('# Title\nBody', '#work', 'end');

    expect(result).toBe('# Title\nBody\n#work');
  });

  it('inserts tags after the title without a separator by default', () => {
    const result = insertInlineTags('# Title\nBody', '#work', 'after-title');

    expect(result).toBe('# Title\n#work\nBody');
  });

  it('can insert tags after the title with a separator for new note creation', () => {
    const result = insertInlineTags('# Title\nBody', '#work', 'after-title', {
      separatorAfterTags: true,
    });

    expect(result).toBe('# Title\n#work\n---\nBody');
  });

  it('merges tags into an existing tag line after the title without adding a separator', () => {
    const result = insertInlineTags('# Title\n#existing\nBody', '#work', 'after-title', {
      separatorAfterTags: true,
    });

    expect(result).toBe('# Title\n#existing #work\nBody');
  });

  it('preserves an existing separator after an existing tag line', () => {
    const result = insertInlineTags('# Title\n#existing\n---\nBody', '#work', 'after-title', {
      separatorAfterTags: true,
    });

    expect(result).toBe('# Title\n#existing #work\n---\nBody');
  });

  it('does not insert tags before a title when body comes from frontmatter parsing', () => {
    const parsed = parseFrontmatter('---\nstatus: draft\n---\n# Title\nBody');
    const body = insertInlineTags(parsed.body, '#work', 'after-title');

    expect(`${parsed.frontmatter}\n${body}`).toBe('---\nstatus: draft\n---\n# Title\n#work\nBody');
  });

  it('falls back to top-of-body placement without a separator when after-title has no H1', () => {
    const result = insertInlineTags('Body without title', '#work', 'after-title');

    expect(result).toBe('#work\nBody without title');
  });

  it('can include a separator in the no-H1 fallback for new note creation', () => {
    const result = insertInlineTags('Body without title', '#work', 'after-title', {
      separatorAfterTags: true,
    });

    expect(result).toBe('#work\n---\nBody without title');
  });

  it('merges with a leading tag line when after-title fallback has no H1', () => {
    const result = insertInlineTags('#existing\nBody without title', '#work', 'after-title', {
      separatorAfterTags: true,
    });

    expect(result).toBe('#existing #work\nBody without title');
  });

  it('omits separator when inserting after a title-only body', () => {
    const result = insertInlineTags('# Title', '#work', 'after-title');

    expect(result).toBe('# Title\n#work');
  });
});

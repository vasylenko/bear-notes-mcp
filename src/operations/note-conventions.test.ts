import { describe, expect, it } from 'vitest';

import { applyNoteConventions } from './note-conventions.js';

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

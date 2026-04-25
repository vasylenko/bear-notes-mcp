/**
 * Parses YAML frontmatter from note text.
 * Frontmatter is only recognized when `---` is the very first line,
 * followed by a closing `---` on its own line. This prevents horizontal
 * rules inside a note body from being mistaken for frontmatter.
 */
export function parseFrontmatter(text: string): { frontmatter: string | null; body: string } {
  if (!text.startsWith('---\n')) {
    return { frontmatter: null, body: text };
  }

  const rest = text.slice(4); // skip opening ---\n
  const match = rest.match(/^---$/m);
  if (!match || match.index === undefined) {
    return { frontmatter: null, body: text };
  }

  const frontmatter = `---\n${rest.slice(0, match.index)}---`;
  const afterClosing = rest.slice(match.index + 3); // skip closing ---
  const body = afterClosing.startsWith('\n') ? afterClosing.slice(1) : afterClosing;

  return { frontmatter, body };
}

/**
 * Converts a comma-separated tag string into Bear inline tag syntax.
 * Returns an empty string if all tags are invalid.
 */
export function formatTagsAsInlineSyntax(tags: string): string {
  return tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map(toBearTagSyntax)
    .filter(Boolean)
    .join(' ');
}

/**
 * Applies note creation conventions by embedding tags as Bear inline syntax
 * at the start of the text body, rather than passing them as URL parameters
 * (which places them at the bottom of the note).
 */
export function applyNoteConventions(input: {
  text: string | undefined;
  tags: string | undefined;
}): { text: string | undefined; tags: undefined } {
  if (!input.tags) {
    return { text: input.text, tags: undefined };
  }

  const tagLine = formatTagsAsInlineSyntax(input.tags);

  // All tags were invalid (e.g., "###,,,") — pass text through unchanged
  if (!tagLine) {
    return { text: input.text, tags: undefined };
  }

  const text = input.text ? `${tagLine}\n---\n${input.text}` : tagLine;

  return { text, tags: undefined };
}

/**
 * Bear uses `#tag` for simple tags and `#tag#` (closing hash) for
 * multi-word tags containing spaces. Slashes create hierarchy without
 * requiring a closing hash.
 */
function toBearTagSyntax(raw: string): string {
  const cleaned = raw.replace(/^#+|#+$/g, '').trim();
  if (!cleaned) return '';

  const needsClosingHash = cleaned.includes(' ');
  return needsClosingHash ? `#${cleaned}#` : `#${cleaned}`;
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  callTool,
  cleanupTestNotes,
  findNoteId,
  trashNote,
  uniqueTitle,
  waitForFileContent,
} from './inspector.js';

const TEST_PREFIX = '[Bear-MCP-stest-fts5]';
const RUN_ID = Date.now();

function title(label: string): string {
  return uniqueTitle(TEST_PREFIX, label, RUN_ID);
}

const OCR_JPG_BASE64 = readFileSync(
  resolve(import.meta.dirname, '../fixtures/ocr-text.jpg')
).toString('base64');

// Unique synthetic tokens — chosen so they don't collide with any real Bear
// content. Used as marker words inside fixture note bodies so each test can
// assert which of its fixtures is returned.
const PHRASE_NOTE_PHRASE = 'firmandprofessionalexact';
const PHRASE_NOTE_NEAR = 'firmprofessionalbutnot';
const PHRASE_NOTE_PARTIAL = 'professionalalone';

const RANK_TOKEN_TRIAD = 'sva28alpha sva28beta sva28gamma';
const RANK_DENSE_BODY =
  'sva28alpha sva28beta sva28gamma sva28alpha sva28beta sva28alpha sva28gamma sva28beta';
// Sparse note still contains all three tokens (FTS5 implicit-AND requires it),
// just at minimum density. Density difference is what BM25 picks up on.
const RANK_SPARSE_BODY =
  'sva28alpha mentioned. sva28beta also mentioned somewhere. sva28gamma rounds out the otherwise unrelated note.';

const SNIPPET_TOKEN = 'sva28snippetmarker';
const SNIPPET_BODY =
  'Lorem ipsum dolor sit amet consectetur adipiscing elit. The sva28snippetmarker appears here ' +
  'in the middle of plenty of surrounding context that should make for usable snippet width without ' +
  'follow-up bear-open-note round-trips. Sed do eiusmod tempor incididunt ut labore et dolore magna.';

const NOT_TOKEN_A = 'sva28applefruit';
const NOT_TOKEN_B = 'sva28bananafruit';
const NOT_TOKEN_C = 'sva28cherryfruit';

const BRACKET_TITLE_TOKEN = 'sva28brackettoken';
const BRACKET_NOTE_TITLE = `[BRACKET-PFX] ${BRACKET_TITLE_TOKEN}-${RUN_ID}`;

const TAGTERM_TOKEN = 'sva28tagtermshared';
const TAGTERM_TAG_A = `sva28tagterm-a-${RUN_ID}`;
const TAGTERM_TAG_B = `sva28tagterm-b-${RUN_ID}`;

const DRIFT_TOKEN = `sva28driftunique${RUN_ID}`;

const noteIds: string[] = [];

beforeAll(async () => {
  // Phrase fixture
  for (const [label, body] of [
    ['PhraseExact', `we want a firm and professional posture ${PHRASE_NOTE_PHRASE}`],
    ['PhraseNear', `firm but professional, not exact ${PHRASE_NOTE_NEAR}`],
    ['PhrasePartial', `professional standalone ${PHRASE_NOTE_PARTIAL}`],
  ] as const) {
    callTool({ toolName: 'bear-create-note', args: { title: title(label), text: body } });
    noteIds.push(findNoteId(title(label)));
  }

  // Ranking fixture: identical tokens, different densities
  callTool({
    toolName: 'bear-create-note',
    args: { title: title('RankDense'), text: RANK_DENSE_BODY },
  });
  noteIds.push(findNoteId(title('RankDense')));

  callTool({
    toolName: 'bear-create-note',
    args: { title: title('RankSparse'), text: RANK_SPARSE_BODY },
  });
  noteIds.push(findNoteId(title('RankSparse')));

  // Snippet width fixture
  callTool({
    toolName: 'bear-create-note',
    args: { title: title('Snippet'), text: SNIPPET_BODY },
  });
  noteIds.push(findNoteId(title('Snippet')));

  // OCR fixture: note with attached image containing OCR-able text "make it simple"
  callTool({
    toolName: 'bear-create-note',
    args: { title: title('OCR'), text: 'A note with an attached image.' },
  });
  const ocrNoteId = findNoteId(title('OCR'));
  noteIds.push(ocrNoteId);
  callTool({
    toolName: 'bear-add-file',
    args: { id: ocrNoteId, filename: 'ocr-text.jpg', base64_content: OCR_JPG_BASE64 },
  });
  // Wait for Bear to OCR the attachment before tests run
  await waitForFileContent(ocrNoteId, 'simple');

  // Boolean-NOT fixture
  callTool({
    toolName: 'bear-create-note',
    args: { title: title('NotAB'), text: `${NOT_TOKEN_A} and ${NOT_TOKEN_B}` },
  });
  noteIds.push(findNoteId(title('NotAB')));

  callTool({
    toolName: 'bear-create-note',
    args: { title: title('NotAC'), text: `${NOT_TOKEN_A} and ${NOT_TOKEN_C}` },
  });
  noteIds.push(findNoteId(title('NotAC')));

  callTool({
    toolName: 'bear-create-note',
    args: { title: title('NotBC'), text: `${NOT_TOKEN_B} and ${NOT_TOKEN_C}` },
  });
  noteIds.push(findNoteId(title('NotBC')));

  // Bracket-in-title fixture (verifies prepareFTS5Term auto-escape)
  callTool({
    toolName: 'bear-create-note',
    args: { title: BRACKET_NOTE_TITLE, text: 'A note whose title contains brackets.' },
  });
  noteIds.push(findNoteId(BRACKET_NOTE_TITLE));

  // Tag+term fixture: two notes share a body token but have different tags
  callTool({
    toolName: 'bear-create-note',
    args: { title: title('TagTermA'), text: TAGTERM_TOKEN, tags: TAGTERM_TAG_A },
  });
  noteIds.push(findNoteId(title('TagTermA')));

  callTool({
    toolName: 'bear-create-note',
    args: { title: title('TagTermB'), text: TAGTERM_TOKEN, tags: TAGTERM_TAG_B },
  });
  noteIds.push(findNoteId(title('TagTermB')));
}, 180_000);

// Each trashNote sleeps 1s to give Bear time to process the URL callback;
// with this many fixture notes, cleanup needs > the default 10s hook timeout.
afterAll(() => {
  for (const id of noteIds) {
    trashNote(id);
  }
  cleanupTestNotes(TEST_PREFIX);
}, 60_000);

describe('bear-search-notes via FTS5', () => {
  it('phrase query returns only the note containing the exact sequence', () => {
    // The synthetic token PHRASE_NOTE_PHRASE is unique to the exact-phrase fixture
    const result = callTool({
      toolName: 'bear-search-notes',
      args: { term: PHRASE_NOTE_PHRASE },
    }).content[0].text;

    expect(result).toContain(title('PhraseExact'));
    expect(result).not.toContain(title('PhraseNear'));
    expect(result).not.toContain(title('PhrasePartial'));
  });

  it('multi-word query ranks dense matches above sparse ones (BM25, not mod-date)', () => {
    // Both notes contain the multi-word query. RankDense has many occurrences;
    // RankSparse has one. RankDense was created BEFORE RankSparse — so a
    // mod-date ordering would put RankSparse first; BM25 puts RankDense first.
    const result = callTool({
      toolName: 'bear-search-notes',
      args: { term: RANK_TOKEN_TRIAD },
    }).content[0].text;

    const denseIdx = result.indexOf(title('RankDense'));
    const sparseIdx = result.indexOf(title('RankSparse'));

    expect(denseIdx).toBeGreaterThan(0);
    expect(sparseIdx).toBeGreaterThan(0);
    expect(denseIdx).toBeLessThan(sparseIdx);
  });

  it('result snippet is wide enough (>= 64 chars) and highlights the match in brackets', () => {
    const result = callTool({
      toolName: 'bear-search-notes',
      args: { term: SNIPPET_TOKEN },
    }).content[0].text;

    const titleIdx = result.indexOf(title('Snippet'));
    expect(titleIdx).toBeGreaterThanOrEqual(0);

    // Snippet line is rendered immediately under the title with a 3-space indent
    const afterTitle = result.slice(titleIdx);
    const snippetLineMatch = afterTitle.match(/^.+\n {3}(.+)/);
    expect(snippetLineMatch).not.toBeNull();
    const snippet = snippetLineMatch![1];
    expect(snippet).toContain(`[${SNIPPET_TOKEN}]`);
    expect(snippet.length).toBeGreaterThanOrEqual(64);
  });

  it('OCR-extracted text from attached images is searchable via the same tool', () => {
    // The OCR fixture contains the word "simple" extracted from the attached JPG.
    // Use a word + the run-scoped title fragment so we don't collide with other
    // notes in the user's library.
    const result = callTool({
      toolName: 'bear-search-notes',
      args: { term: 'simple' },
    }).content[0].text;

    expect(result).toContain(title('OCR'));
  });

  it('boolean NOT operator excludes notes containing the negated term', () => {
    // NotAB = applefruit + bananafruit, NotAC = applefruit + cherryfruit, NotBC = bananafruit + cherryfruit
    // Query: applefruit NOT bananafruit → should return NotAC only (has applefruit, no bananafruit)
    const result = callTool({
      toolName: 'bear-search-notes',
      args: { term: `${NOT_TOKEN_A} NOT ${NOT_TOKEN_B}` },
    }).content[0].text;

    expect(result).toContain(title('NotAC'));
    expect(result).not.toContain(title('NotAB'));
    expect(result).not.toContain(title('NotBC'));
  });

  it('terms with brackets and hyphens (FTS5-special chars) match by stripped tokens', () => {
    // Without auto-handling, '[BRACKET-PFX]' in the query would produce
    // 'fts5: syntax error near "["'. prepareFTS5Term tokenizes via \w+\*?,
    // which already drops the brackets and hyphens, then OR-joins the
    // resulting tokens so BM25 ranks the note by overlap density.
    const result = callTool({
      toolName: 'bear-search-notes',
      args: { term: `[BRACKET-PFX] ${BRACKET_TITLE_TOKEN}` },
    }).content[0].text;

    expect(result).toContain(BRACKET_NOTE_TITLE);
  });

  it('term + tag composition narrows results to the intersection', () => {
    // Both TagTermA and TagTermB contain TAGTERM_TOKEN. Filtering by tag A
    // should isolate just the A note.
    const result = callTool({
      toolName: 'bear-search-notes',
      args: { term: TAGTERM_TOKEN, tag: TAGTERM_TAG_A },
    }).content[0].text;

    expect(result).toContain(title('TagTermA'));
    expect(result).not.toContain(title('TagTermB'));
  });

  it('search finds a note created mid-suite (build-on-first-search path)', () => {
    // NOTE: this verifies the index reflects current Bear-DB contents on every
    // server invocation — but it cannot exercise drift detection per se,
    // because each `callTool` spawns a fresh server process and the index is
    // rebuilt from `state === null` regardless of whether checkDrift would
    // have signaled. End-to-end drift in a single-process scenario is covered
    // by the unit tests in src/infra/fts-index.test.ts ("fts-index checkDrift"),
    // which exercise the MAX+COUNT signal directly.
    const driftTitle = title('Drift');
    let driftId: string | undefined;
    try {
      callTool({
        toolName: 'bear-create-note',
        args: { title: driftTitle, text: `body containing ${DRIFT_TOKEN}` },
      });
      driftId = findNoteId(driftTitle);

      const result = callTool({
        toolName: 'bear-search-notes',
        args: { term: DRIFT_TOKEN },
      }).content[0].text;

      expect(result).toContain(driftTitle);
    } finally {
      if (driftId) trashNote(driftId);
    }
  });

  it('malformed FTS5 query returns a structured error with operator hint', () => {
    // Unbalanced opening quote in user input survives prepareFTS5Term (the
    // function trusts terms that already contain "). FTS5 errors out, and
    // executeQuery rewraps with a helpful hint.
    const response = callTool({
      toolName: 'bear-search-notes',
      args: { term: '"unbalanced' },
    });

    expect(response.isError).toBe(true);
    const errorText = response.content[0].text;
    expect(errorText).toContain('Search query syntax error');
    expect(errorText).toContain('Supported operators');
  });
});

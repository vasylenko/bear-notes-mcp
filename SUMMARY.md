# Branch Summary: yaml-frontmatter-fix

## What Changed

8 commits on top of `main` (26fd648 was split into two atomic commits; see FINDINGS.md for why the expected 3-way split became 2 commits from that mixed change):

| SHA | Description |
|-----|-------------|
| d86067b | feat(note-conventions): add parseFrontmatter and formatTagsAsInlineSyntax helpers; add replace_all to BearUrlParams.mode |
| 6b66bc0 | test(note-conventions): add unit tests for parseFrontmatter and formatTagsAsInlineSyntax |
| 88b6951 | feat(bear-create-note): auto-detect and preserve YAML frontmatter |
| a318830 | feat(bear-add-tag): preserve frontmatter when adding tags |
| 8878bf1 | test(system): add frontmatter integration tests for create-note and add-tag |
| 8bfc620 | docs: add Frontmatter handling section to README and update CHANGELOG |
| 0a21763 | chore: add SUMMARY.md / PROGRESS.md |
| a76da24 | chore: update progress and summary after API validation and commit split |

## Files Modified

- **`src/operations/note-conventions.ts`** — added `parseFrontmatter` and `formatTagsAsInlineSyntax`; refactored `applyNoteConventions` to use the extracted helper
- **`src/infra/bear-urls.ts`** — added `'replace_all'` to `BearUrlParams.mode` union type
- **`src/tools/note-tools.ts`** — Fix 1 (bear-create-note) and Fix 2 (bear-add-tag)
- **`src/operations/note-conventions.test.ts`** — 10 new unit tests for the two new helpers
- **`tests/system/frontmatter.test.ts`** — new integration test suite (4 tests, requires Bear)
- **`README.md`** — new "Frontmatter Handling" section under Configuration
- **`CHANGELOG.md`** — [Unreleased] entries for both fixes

## Fix 1: bear-create-note

When `text` starts with `---\n…\n---`, the handler now:
1. Parses the frontmatter block using `parseFrontmatter`
2. Assembles the note as `frontmatter → # title → #tag line → body` (joined with `\n`)
3. Passes the assembled string as `text` only — no separate `title` or `tags` URL params — so Bear uses the H1 as the title and does not insert anything outside the frontmatter block

Backward compat: if no frontmatter is detected, the original code path runs unchanged.

## Fix 2: bear-add-tag

When the existing note text (read from SQLite) starts with `---\n`, the handler:
1. Parses the frontmatter block
2. Builds a new full-note text: `frontmatter\n<tag line>\n<body>`
3. Writes it back using `add-text?mode=replace_all` (replaces entire note content)

When no frontmatter: original `mode=prepend` + `tags` URL param, unchanged.

## API Validation (Task 1)

`mode=replace_all` is **officially documented** in the Bear x-callback-url docs. The original concern in TASK.md was unfounded — no redesign is needed. See FINDINGS.md for the full verification.

The `/replace-note` endpoint mentioned in BRIEF.md as an alternative does not exist in the Bear API.

## Test Results

```
Unit tests:  47 passed / 0 failed  (includes 10 new parseFrontmatter/formatTagsAsInlineSyntax tests)
Build:       tsc clean, 0 errors
Integration: tests/system/frontmatter.test.ts — NOT run (requires Bear app running)
```

## Blockers / Open Questions

1. **ZTEXT storage format**: the implementation assumes that for notes created with frontmatter (via Fix 1), Bear stores ZTEXT starting with `---` (i.e., Bear does not prepend a `# Title` line automatically). This needs system test validation.

2. **Note title after replace_all**: the Bear docs don't specify whether `replace_all` updates ZTITLE from the first H1. If it doesn't, the SQLite title remains unchanged (which is fine — the title hasn't changed). Either way, the operation is safe.

## Suggested PR Description

### Summary
- `bear-create-note`: auto-detects YAML frontmatter (`---`…`---` at start of `text`) and assembles the note content so frontmatter, title (H1), and tags appear in the right order without Bear interfering
- `bear-add-tag`: detects frontmatter in the existing note text and inserts new tags immediately after the closing `---` instead of clobbering it with a blind prepend
- `mode=replace_all` is an officially documented Bear API parameter — verified against the Bear x-callback-url documentation
- Backward compatible: notes without frontmatter follow the exact same code paths as before

### Test plan
- [x] All 47 unit tests pass (`npm test`)
- [x] TypeScript build clean (`npm run build`)
- [ ] Run `npm run test:system` with Bear open to validate integration tests in `tests/system/frontmatter.test.ts`
- [ ] Manually verify a note created with frontmatter shows the correct structure in Bear
- [ ] Manually verify `bear-add-tag` on a frontmatter note places tags after the `---` block

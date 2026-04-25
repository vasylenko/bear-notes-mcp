# Progress: yaml-frontmatter-fix

## Status: In progress — implementing fixes

## Plan

### Fix 1: bear-create-note
- Add `parseFrontmatter` + `formatTagsAsInlineSyntax` helpers to note-conventions.ts
- Update handler: detect frontmatter, assemble full note (frontmatter→title→tags→body), pass as `text` only without separate title/tags params
- Backward compat: no frontmatter → existing behavior unchanged

### Fix 2: bear-add-tag
- When note text starts with frontmatter: read full text, insert tags after closing `---`, write back via `add-text?mode=replace_all`
- When no frontmatter: current prepend behavior unchanged
- Need to add `'replace_all'` to BearUrlParams.mode type

### Tests
- Unit tests for parseFrontmatter in note-conventions.test.ts
- Integration (system) test in tests/system/frontmatter.test.ts

### Docs
- README.md: add "Frontmatter handling" section
- CHANGELOG.md: add [Unreleased] entry

## Files Changed
- src/operations/note-conventions.ts — add parseFrontmatter, formatTagsAsInlineSyntax
- src/operations/note-conventions.test.ts — parseFrontmatter tests
- src/infra/bear-urls.ts — add replace_all to mode type
- src/tools/note-tools.ts — update bear-create-note and bear-add-tag handlers
- tests/system/frontmatter.test.ts — new integration tests
- CHANGELOG.md
- README.md

## Blockers / Risks
- `replace_all` mode: unsure if Bear's add-text supports it — system tests will reveal this
- Bear's ZTEXT storage format: assumption that frontmatter notes start ZTEXT with `---` (not `# Title`)

# API Validation Findings

## Task 1: Bear x-callback `/add-text` mode=replace_all

**Source:** https://bear.app/faq/x-callback-url-scheme-documentation/  
**Date verified:** 2026-04-28

### Is `mode=replace_all` documented?

**Yes.** The Bear x-callback-url docs explicitly list four supported mode values for `/add-text`:

> "the allowed values are `prepend`, `append`, `replace_all` and `replace` (keep the note's title untouched)"

The current implementation in `bear-add-tag` (using `add-text?mode=replace_all` when a note has YAML frontmatter) is correct and uses a fully documented, supported API.

### Does `/replace-note` exist?

**No.** There is no `/replace-note` endpoint in the Bear x-callback-url API. The BRIEF.md mentioned it as "the most likely candidate" for a redesign, but it does not exist. Full-note replacement is handled entirely via `add-text` with `mode=replace_all`.

### Does Bear update ZTITLE from H1 when using `replace_all`?

**Unknown from docs.** The API documentation does not specify this behavior. The `replace` mode is explicitly documented to "keep the note's title untouched", but `replace_all` behavior regarding title is undocumented.

**Implication for current implementation:** The `bear-add-tag` tool uses `replace_all` to rewrite the note body preserving frontmatter. If Bear derives ZTITLE from the first H1 in the replacement text, the title remains correct (the H1 is preserved in `parsed.body`). If Bear ignores the H1 on `replace_all`, the SQLite ZTITLE would remain unchanged from before — which is also fine, since the title hasn't changed. Either way, the operation is safe.

### Does `mode=replace` preserve YAML frontmatter at line 1?

**No.** A throwaway Bear note was created and then rewritten via `/add-text` with `mode=replace`, using replacement text that began with a YAML frontmatter block followed by a new inline tag. Bear stored the result with a leading blank line before the opening `---`:

```text

---
status: draft
project: replace-mode-probe
---
#replace-mode-tag
# [Bear-MCP-replace-mode-probe] 1777361347436
Original body.
```

Because the opening `---` is no longer the first line, this is not valid frontmatter for the server's `parseFrontmatter` rules and will also fail in parsers that require frontmatter at byte/line 1. This confirms `mode=replace` is not suitable for frontmatter-safe tag insertion. The current `replace_all` implementation is the correct choice.

### Conclusion

No code changes required. The implementation is correct.

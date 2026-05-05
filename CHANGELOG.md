# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Search ranks results by relevance** — `bear-search-notes` now ranks notes by how well they match your query across titles, body, and OCR-extracted text from attachments, so the most relevant notes surface first instead of the most recently edited. Multi-word natural-language queries like `quarterly planning offsite notes` work as expected: notes covering more of the query rank higher.
- **Tag features keep working through Bear schema updates** — tag search and pinned-tag filters previously relied on hardcoded internal IDs that a future Bear release could silently break. They now resolve those IDs at runtime, so tag-aware search keeps working across Bear updates.
- **License changed from MIT to Apache 2.0** — Apache 2.0 keeps the same broadly-permissive posture as MIT but adds an explicit patent grant and requires downstream redistributors to propagate the project's `NOTICE` attribution. End users and direct npm/MCPB consumers see no functional change. See `LICENSE.md` for the full license text and `NOTICE` for the attribution that derivative works must keep visible.

### Added
- **Search results include matching snippets** — each result carries a short excerpt around the matched terms so you can judge relevance without opening every note.
- **Plain-language errors for unprocessable search queries** — when a query can't be parsed, the response says so in plain language and points at the offending input instead of leaking a raw SQLite error.

### Removed
- **`bear-add-file` no longer accepts `base64_content`** (breaking) — pass `file_path` instead. Sending base64 through tool input wasted thousands of LLM tokens per attachment for no benefit; the server has read files from disk natively since 2.9.0. Existing callers that built base64 blobs must write them to a file on disk and pass the path.
- **Substring matching in `bear-search-notes`** (breaking) — search now matches whole words rather than partial fragments, so a query for `engin` no longer matches `engineering`. Use the full word (`engineering`) instead, or pick a more specific keyword from the same note. Existing search prompts that relied on partial-word matches may return different result sets under v3.0.0.

## [2.12.0] - 2026-04-21

### Removed
- **`bear-grab-url`** tool — removed to keep the server network-free and eliminate prompt-injection risk from fetched content.

## [2.11.0] - 2026-04-21

### Added
- **`bear-search-notes` now includes tags in results** — each search result with tags shows a `Tags:` line alongside existing metadata (title, dates, ID). This lets LLMs cross-reference tags across multiple notes without opening each one individually.

### Changed
- **Soft errors now signal `isError: true` in tool responses** — for recoverable failures handled inside tool implementations (such as a missing note, handler-level parameter validation, a disabled feature, or a file error), the tool response now sets `isError: true` instead of returning the error message as a normal result. This lets MCP clients distinguish failures from successful empty results (like "no notes found") and gives LLMs a clear signal to self-correct. Permanent conditions (e.g., feature disabled) include explicit "do not retry" guidance.
- **`bear-add-tag` correctly marked as idempotent** — the tool's MCP annotation now reflects that adding an already-present tag is a no-op. MCP clients can safely retry `bear-add-tag` calls on transient failures without risk of unintended side effects.

### Fixed
- **`bear-add-tag` and `bear-add-file` now return complete note metadata** — mutation tool responses previously had gaps: `bear-add-tag` omitted the note ID, and `bear-add-file` (when called with an ID) omitted the note title. Both tools now consistently return the note title and ID, matching all other mutation tools. This gives LLM clients the metadata they need for follow-up operations without an extra lookup step.

## [2.10.0] - 2026-04-13

### Added
- **`bear-grab-url`** tool — save a web page as a Bear note. Bear fetches the page and converts it to markdown. Supports optional comma-separated tags. The note is created in the background without bringing Bear to the foreground.

### Fixed
- **Database reads no longer fail when Bear is writing** — the SQLite connection now sets a 3-second `busy_timeout`, so read queries wait briefly instead of failing instantly with "database is locked" when Bear happens to be mid-write.

## [2.9.0] - 2026-04-01

### Changed
- **`bear-add-file` accepts `file_path` as alternative to `base64_content`** ([#88](https://github.com/vasylenko/bear-notes-mcp/issues/88)): When the file exists on disk, provide its path instead of base64-encoded content. The server reads and encodes the file internally, avoiding the cost of the LLM producing thousands of base64 output tokens. The `filename` parameter is auto-inferred from the path when omitted. The two input modes (`file_path` and `base64_content`) are mutually exclusive.
- **`bear-open-note` accepts title as an alternative to ID** ([#60](https://github.com/vasylenko/bear-notes-mcp/issues/60)): The tool now takes an optional `title` parameter, so AI agents can open a note by its exact title without needing to know the ID upfront. Title matching is case-insensitive. When multiple notes share the same title, the tool returns a disambiguation list with each note's ID and last modification date instead of picking one arbitrarily. When no match is found, the response suggests using `bear-search-notes` for partial text search.

## [2.8.2] - 2026-03-29

### Changed
- **Repository renamed to `bear-notes-mcp`** ([#75](https://github.com/vasylenko/bear-notes-mcp/issues/75)): The project identity is now client-neutral — "Bear Notes MCP Server" instead of "Claude Desktop Extension". README, package metadata, and all repository URLs have been updated. GitHub redirects the old URL automatically, but update your bookmarks and clones when convenient.

**No feature- or client-facing changes in this release**

## [2.8.1] - 2026-03-14

### Fixed
- **File attachment data no longer contaminates note body during write operations** ([#86](https://github.com/vasylenko/claude-desktop-extension-bear-notes/issues/86)): `bear-open-note` previously appended a synthetic `# Attached Files` section directly into the note text. When an AI agent then used `bear-replace-text`, this synthetic section could be written back into the note as real content. File metadata is now returned as a separate MCP content block, keeping the note body clean for downstream edits.

## [2.8.0] - 2026-03-13

### Added
- **`bear-rename-tag`** tool ([#63](https://github.com/vasylenko/claude-desktop-extension-bear-notes/issues/63)) — rename a tag across all notes in your Bear library. Useful for reorganizing tag taxonomy, fixing typos, or restructuring tag hierarchies.
- **`bear-delete-tag`** tool ([#64](https://github.com/vasylenko/claude-desktop-extension-bear-notes/issues/64)) — delete a tag from all notes without affecting the notes themselves.

### Fixed
- **`bear-list-tags` no longer shows ghost tags from excluded notes** ([#77](https://github.com/vasylenko/claude-desktop-extension-bear-notes/issues/77)): Tag counts previously included trashed, archived, and encrypted notes, causing tags that existed only on those notes to appear in the list with inflated counts. Tag results now match what Bear's UI shows.
- **Attachments without OCR text no longer silently disappear** ([#79](https://github.com/vasylenko/claude-desktop-extension-bear-notes/issues/79)): When a note had attachments that Bear could not extract text from (e.g., MHTML files), those attachments were omitted entirely — making it look like the note had no files. Attachment filenames now always appear, with a note indicating when file content is not available.

## [2.7.0] - 2026-03-06

### Changed
- **`bear-create-note` returns the note ID** ([#66](https://github.com/vasylenko/claude-desktop-extension-bear-notes/issues/66)): When a title is provided, the tool now polls Bear's database after creation and returns the note's unique identifier. This lets AI agents reference the newly created note in follow-up operations (add text, add tag, etc.) without a separate search step. When no title is given or the lookup times out, the tool still succeeds — returning the ID is best-effort.

## [2.6.0] - 2026-03-04

### Added
- **Server instructions for MCP clients**: MCP clients now receive orientation at initialization — Bear's note structure, section model, and how tools relate to each other. This helps AI agents understand that section-level operations apply only to direct content under a header (not nested sub-sections) before they attempt any edits.

### Changed
- **Improved tool descriptions for `bear-add-text` and `bear-replace-text`**  ([#73](https://github.com/vasylenko/claude-desktop-extension-bear-notes/issues/73)): Descriptions now cross-reference each other so AI agents can choose the right tool (insert vs. overwrite). The `bear-replace-text` text parameter explicitly warns against including sub-headers in the replacement text to prevent section duplication.

## [2.5.0] - 2026-02-22

### Added
- **bear-replace-text** tool — replace content in an existing Bear note, either the full body or a specific section by header (**disabled by default**, opt-in).

  Two replacement scopes:
  - `section` — replaces content under a specific header while preserving the rest of the note
  - `full-note-body` — replaces the entire note body (everything below the title)

  **HOW TO ENABLE**:
    - For Claude Extension: Claude Settings -> Extensions -> Configure (next to the extension name) -> toggle the "Content Replacement" switch and click save. Restart Claude.
    - For standalone MCP server: add the following ENV to your mcp configuration
      ```
        "env": {
          "UI_ENABLE_CONTENT_REPLACEMENT": "true"
        },
      ```

## [2.4.1] - 2026-02-21

### Fixed
- **Tag search no longer matches false positives** ([#67](https://github.com/vasylenko/claude-desktop-extension-bear-notes/issues/67)): Searching by tag (e.g., `car`) previously matched unrelated tags sharing a prefix (`career`), as well as tag-like text in code blocks and URLs. Tag filtering now uses Bear's relational tag tables for exact matching. Nested child tags still match as expected (e.g., `career` returns notes tagged `career` and `career/meetings`).
- **Read-only database connection** ([#68](https://github.com/vasylenko/claude-desktop-extension-bear-notes/issues/68)): The SQLite connection to Bear's database now enforces read-only mode at the driver level, preventing any possibility of accidental writes.

## [2.4.0] - 2026-02-16

### Added
- **New note convention** -- UI configuration (**disabled by default**, opt-in) to enforce the specific format for the new notes:
  ```
  ┌──────────────────────────────┐
  │ # Meeting Notes              │  ← Note title
  │ #work #meetings              │  ← Tags right after title
  │                              │ 
  │ ---                          │  ← Horizontal rule separating title and tags from body
  │                              │
  │ Lorem Ipsum...               │  ← Note body
  └──────────────────────────────┘
  ```
  **HOW TO ENABLE**: 
    - For Claude Extension: Claude Settings -> Extensions -> Configure (next to the extension name) -> toggle the "New Note Convention" switch and click save. Restart Claude.
    - For standalone MCP server: add the following ENV to your mcp configuration
      ```
        "env": {
          "UI_ENABLE_NEW_NOTE_CONVENTION": "true"
        },
      ```

- e2e test suite as a Claude Code skill that runs scenarios for all MCP-server tools
- system tests for the new feature with ability to expand to others 

## [2.3.0] - 2026-02-13

### Added
- **bear-archive-note** tool -- archive a Bear note to remove it from active lists without deleting it. Authored by [@wasuregusa18](https://github.com/wasuregusa18)

## [2.2.0] - 2026-01-18

### Added
- **Pinned Notes Filter**: New `pinned` parameter for `bear-search-notes` tool ([#37](https://github.com/vasylenko/claude-desktop-extension-bear-notes/issues/37)).
  Matches Bear's UI:
  - `pinned: true` alone works as the pinned section in UI – show all pinned notes, no mater where they were pinned
  - `pinned: true` with `tag` returns notes pinned within that tag
  - Combines with other filters (search term, dates) for refined searches

- **Total Count in Search Results**: Search tools now report total matching count when results are truncated ([#36](https://github.com/vasylenko/claude-desktop-extension-bear-notes/issues/36)).

  AI agents can now make informed decisions about fetching more results instead of guessing.

  **Before:**
  ```
  Found 50 notes:
  1. Meeting Notes
     ...
  ```

  **After:**
  ```
  Found 50 notes (114 total matching):
  1. Meeting Notes
     ...

  Use bear-search-notes with limit: 114 to get all results.
  ```

  Applies to `bear-search-notes` and `bear-find-untagged-notes`.

  _Implementation: Uses SQLite window function `COUNT(*) OVER()` with CTE for accurate distinct count in a single query – no extra database round trip. Pagination was considered but skipped (YAGNI) – exposing total count lets agents simply request higher limit when needed, no code complications._

### Changed 
- Dependencies and dev dependencies; notably - zod package

### Removed
- **`--experimental-sqlite` flag**: No longer required b/c Claude ships with 22.21.1 (as of Jan'26) that has SQLite enabled by default.


## [2.1.1] - 2025-12-30

### Internal
- **Preparation for Desktop Extension Catalog submission**
  - adjustments to the extension manifest
  - updates to README.md
  - demo screenshot


**No features/tools changes in this release**

## [2.1.0] - 2025-12-30

### Added
- **Use bear-mcp-server standalone**: You can now use the MCP server from this extension separately, e.g., for your Claude Code, Cursor, Codex or other AI tool
  - npmjs publishing with additional GH action
  - updated task for versions to process version changes in package-lock.json

Standalone MCP usage instructions -- [NPM.md](./docs/NPM.md)

**No features/tools changes in this release**

## [2.0.0] - 2025-12-26

### Changed
- **Migrated from DXT to MCPB**: Anthropic renamed Desktop Extensions (DXT) to MCP Bundles (MCPB)
  - Package extension changed from `.dxt` to `.mcpb`
  - Updated to `@anthropic-ai/mcpb` v2.1.2
  - Manifest updated to MCPB 0.3 specification

mcpb is a core tool for the extension and together with manifest schema update, these changes together mark the v2.0 of the extension

**Features (MCP tools) are the same as in 1.4.0 – no changes to business logic in this release**

If you experience difficulties installing the new extension format *mcpb*, please use [v1.4.0](https://github.com/vasylenko/claude-desktop-extension-bear-notes/releases/tag/v1.4.0) for now and let me know through GitHub issue.

## [1.4.0] - 2025-12-25

### Added
- **Tag Management Tools**:
  - `bear-list-tags` - List all tags as hierarchical tree with note counts
  - `bear-find-untagged-notes` - Find notes without any tags
  - `bear-add-tag` - Add one or more tags to existing notes

### Changed
- **Merged text tools**: Combined `bear-add-text-append` and `bear-add-text-prepend` into single `bear-add-text` tool with `position` parameter ('beginning' or 'end')

### Fixed
- Bear no longer steals focus when executing URL commands (uses `open -g` flag)

### Internal
- Refactored `database.ts` into separate `notes.ts` and `tags.ts` modules
- Added UX parameters (`open_note`, `new_window`, `show_window`) to Bear URL builder

## [1.3.0] - 2025-11-17
Authored by @bborysenko (_thank you, Borys!_)

### Added
- **Date-based search**: 
  - supports filtering by note's creation and modification date
  - supports relative dates, e.g., 'yesterday' or 'last week', etc or exact dates
  - notes can be searched by date alone, without requiring a search term or tag


## [1.2.0] - 2025-11-02

### Added
- **File Attachment Support**: New `bear-add-file` tool for attaching files to Bear notes
  - Accepts base64-encoded file content (works with Claude Desktop's files feature)
  - Supports all file types supported by Claude Desktop

### Technical
- Optimized for Claude Desktop's sandbox architecture - no external filesystem access required
- Base64 encoding happens in Claude's sandbox via built-in shell commands

### Known limitation
- Tool streaming passes base64 to the MCP tool call very slow – not a bug, just the way it works in Claude :-(

## [1.1.0] - 2025-09-08

### Added
- **File Search**: Extended search functionality to include OCR'd text from images and PDFs ([#4](https://github.com/vasylenko/claude-desktop-extension-bear-notes/issues/4))

  Prioritize completeness over context window efficiency - better to have full information upfront than incomplete results requiring multiple API calls and confused MCP client or an end user.

    - Always search files: searchNotes() hardcoded to include OCR content from attachments - no includeFiles parameter
    - Always retrieve files: getNoteContent() hardcoded to include OCR content - no includeFiles parameter
    - Clear content separation: OCR content labeled with `# Attached Files` and `## filename` headers
    - LLM and user experience: Complete context with clear source distinction between note text and file content  

### Internal
- For Claude Code:
    - Comprehensive Bear database schema documentation
    - Enhanced development tooling with KISS/DRY code validation commands
    - Tool documentation best practices guidelines
- Small refactoring

## [1.0.0] - 2025-09-02

First release. 

Bear Notes MCP Bundle - Claude Desktop extension for comprehensive Bear Notes integration.

Features:
- 5 MCP tools: search, read, create, and append/prepend to Bear notes
- Tool annotations for client safety and UX hints
- Native Node.js SQLite for read oprations
- Bear's X-callback-URL API integration for write operations
- Debug logging with UI toggle

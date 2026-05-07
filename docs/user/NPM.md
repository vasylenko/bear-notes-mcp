# Bear Notes MCP Server

An unofficial, opinionated MCP for Bear Notes — built around relevance-ranked search across titles, bodies, and hierarchical tags. Reads run direct against Bear's SQLite database. Offline-first, network-free.

**Full documentation and source code: [bear-notes-mcp](https://github.com/vasylenko/bear-notes-mcp)**

## Key Features

- **12 MCP tools** for full Bear Notes integration
- **Relevance-ranked search** across titles, bodies, and hierarchical tags — finds the right note, not just literal-match ones
- **Library-wide tag operations** — rename or delete a tag everywhere, atomically
- **Sectioned writes** — append at a specific heading or replace a fenced block
- **Date-based search** with relative dates ("yesterday", "last week", etc.)
- **Content replacement** for replacing note body or specific sections (opt-in)
- **Configurable new note convention** for tag placement (opt-in)
- **Local-first** — direct read-only SQLite, no network, no telemetry, no Bear app needed to query
- **Supply-chain clean** — native node:sqlite, no unsigned third-party binaries

## Tools

<!-- TOOLS:START -->
- **`bear-open-note`** - Read the full text content of a Bear note including OCR'd text from attached images and PDFs
- **`bear-create-note`** - Create a new note in your Bear library with optional title, content, and tags
- **`bear-search-notes`** - Find notes by relevance across titles, body, and OCR-extracted text from attached images and PDFs. Use a phrase or a few keywords describing what you're looking for; results are ranked by relevance and each includes a context snippet. Also supports tag, date-range, and pinned-only filters — combine with a search term or use them on their own to browse.
- **`bear-add-text`** - Insert text at the beginning or end of a Bear note, or within a specific section identified by its header
- **`bear-replace-text`** - Replace content in an existing Bear note — either the full body or a specific section. Requires content replacement to be enabled in settings.
- **`bear-add-file`** - Attach a local file (image, PDF, document) to an existing Bear note. Bear extracts text from images and PDFs via OCR, making attachment content searchable.
- **`bear-list-tags`** - List all tags in your Bear library as a hierarchical tree with note counts
- **`bear-find-untagged-notes`** - Find notes in your Bear library that have no tags assigned
- **`bear-add-tag`** - Add one or more tags to an existing Bear note
- **`bear-archive-note`** - Archive a Bear note to remove it from active lists without deleting it
- **`bear-rename-tag`** - Rename a tag across all notes in your Bear library
- **`bear-delete-tag`** - Delete a tag from all notes in your Bear library without affecting the notes
<!-- TOOLS:END -->

**Requirements**: Node.js 24.13.0+

## Quick Start - Claude Code (One Command)

```bash
claude mcp add bear-notes --transport stdio -- npx -y bear-notes-mcp@latest
```

That's it! The server will be downloaded from npm and configured automatically.

## Quick Start - Other AI Assistants

Add to your MCP configuration file:
```json
{
  "mcpServers": {
    "bear-notes": {
      "command": "npx",
      "args": ["-y", "bear-notes-mcp@latest"]
    }
  }
}
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `UI_DEBUG_TOGGLE` | `false` | Enable debug logging for troubleshooting |
| `UI_ENABLE_NEW_NOTE_CONVENTION` | `false` | Place tags right after the note title instead of at the bottom |
| `UI_ENABLE_CONTENT_REPLACEMENT` | `false` | Enable the `bear-replace-text` tool for replacing note content |

Example with configuration:
```json
{
  "mcpServers": {
    "bear-notes": {
      "command": "npx",
      "args": ["-y", "bear-notes-mcp@latest"],
      "env": {
        "UI_ENABLE_NEW_NOTE_CONVENTION": "true",
        "UI_ENABLE_CONTENT_REPLACEMENT": "true",
        "UI_DEBUG_TOGGLE": "true"
      }
    }
  }
}
```

## Advanced: Local Development Build

**Step 1: Clone and build**
```bash
git clone https://github.com/vasylenko/bear-notes-mcp.git
cd bear-notes-mcp
npm install
npm run build
```

**Step 2: Configure with local path**

For Claude Code:
```bash
claude mcp add bear-notes --transport stdio -- node /absolute/path/to/dist/main.js
```

For other AI assistants:
```json
{
  "mcpServers": {
    "bear-notes": {
      "command": "node",
      "args": ["/absolute/path/to/dist/main.js"]
    }
  }
}
```

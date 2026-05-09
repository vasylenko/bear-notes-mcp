import { ENABLE_CONTENT_REPLACEMENT } from './config.js';

export const baseInstructions = [
  'This server integrates with Bear, a markdown note-taking app.',
  'Each note has a unique ID, a title, a body, and optional tags.',
  'Notes use markdown headings (##, ###, etc.) to define sections.',
  'Use bear-search-notes to find note IDs before reading or modifying notes, or provide an exact title to bear-open-note for direct lookup.',
  'Whenever a tool surfaces a specific note in its response (search results, opened note, etc), the note ID is included. Pass that ID unchanged to any mutation tool that accepts `id`.',
];

export const editModeInstructions = [
  'To modify note content: bear-add-text inserts text without touching existing content; bear-replace-text overwrites content.',
  'When targeting a section by header, operations apply only to the direct content under that header — not nested sub-sections.',
  'To modify sub-sections, make separate calls targeting each sub-header.',
];

// When Edit Mode is off, the LLM must not see write tool names — referencing
// disabled tools would invite hallucinated calls. The unlock guidance names
// the env var and the Claude Desktop toggle path instead.
export const readOnlyInstructions = [
  '',
  'Edit Mode is currently off — only the 5 read-only tools (bear-open-note, bear-search-notes, bear-find-untagged-notes, bear-list-tags, bear-capabilities) are advertised and available via tools/list.',
  'To enable Edit Mode (note creation, editing, attachments, tag management, archive), set UI_ENABLE_CONTENT_REPLACEMENT=true and restart the server. Claude Desktop users: toggle "Edit Mode" in Settings → Extensions → Configure (Bear Notes).',
];

const modeInstructions = ENABLE_CONTENT_REPLACEMENT ? editModeInstructions : readOnlyInstructions;
export const instructions = [...baseInstructions, ...modeInstructions].join('\n');

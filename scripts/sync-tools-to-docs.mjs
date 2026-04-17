#!/usr/bin/env node

/**
 * Syncs the tools list from manifest.json into README.md and docs/user/NPM.md.
 * Replaces content between <!-- TOOLS:START --> and <!-- TOOLS:END --> markers.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8'));

const toolsMarkdown = manifest.tools
  .map(t => `- **\`${t.name}\`** - ${t.description}`)
  .join('\n');

const START_MARKER = '<!-- TOOLS:START -->';
const END_MARKER = '<!-- TOOLS:END -->';
const pattern = new RegExp(`${START_MARKER}[\\s\\S]*?${END_MARKER}`, 'g');
const replacement = `${START_MARKER}\n${toolsMarkdown}\n${END_MARKER}`;

const docs = ['README.md', 'docs/user/NPM.md'];

for (const file of docs) {
  const path = join(root, file);
  const content = readFileSync(path, 'utf-8');

  if (!content.includes(START_MARKER)) {
    console.error(`⚠ ${file}: missing ${START_MARKER} marker, skipping`);
    continue;
  }

  const updated = content.replace(pattern, replacement);
  writeFileSync(path, updated);
  console.log(`✓ ${file}: synced ${manifest.tools.length} tools from manifest.json`);
}

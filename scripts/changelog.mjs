#!/usr/bin/env node
// CHANGELOG.md for releases. New entries go under "## Unreleased"; releasing turns that into the version's section.
//
//   node scripts/changelog.mjs check          fails if "Unreleased" is empty (run by `npm version`, before it bumps)
//   node scripts/changelog.mjs stamp          "## Unreleased" → "## v<package.json version> (date)", and a new empty
//                                             "## Unreleased" above it (run by `npm version`, which then commits it)
//   node scripts/changelog.mjs notes <tag>    prints that version's section (the release workflow's notes)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'CHANGELOG.md');
const die = (m) => { console.error(`\n✘ ${m}\n`); process.exit(1); };

/** The body of the section whose heading matches `heading` (up to the next "## "), and where it is. */
function section(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return { start, end, body: lines.slice(start + 1, end).join('\n').trim(), lines };
}
const UNRELEASED = /^## Unreleased\s*$/i;

const [cmd, arg] = process.argv.slice(2);
const text = readFileSync(FILE, 'utf8');

if (cmd === 'check') {
  const s = section(text, UNRELEASED);
  if (!s) die('CHANGELOG.md has no "## Unreleased" section.');
  if (!/^\s*[-*] /m.test(s.body)) die('Nothing under "## Unreleased" in CHANGELOG.md. Add what changed before releasing.');
} else if (cmd === 'stamp') {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const s = section(text, UNRELEASED);
  if (!s) die('CHANGELOG.md has no "## Unreleased" section.');
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  s.lines.splice(s.start, 1, '## Unreleased', '', `## v${version} (${date})`);
  writeFileSync(FILE, s.lines.join('\n'));
  console.log(`CHANGELOG.md: "Unreleased" is now v${version}.`);
} else if (cmd === 'notes') {
  const v = (arg || '').replace(/^v/, '');
  if (!v) die('Usage: node scripts/changelog.mjs notes <tag>');
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const s = section(text, new RegExp(`^## v?${esc}(\\s|$)`));
  if (s?.body) process.stdout.write(`${s.body}\n`);
} else {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 7).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

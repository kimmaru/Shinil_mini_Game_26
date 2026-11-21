#!/usr/bin/env node
// Fails the build when a contract file changes without the lead re-freezing.
//
// 58 game modules import these files. A one-line edit to a threshold or a type
// silently changes behaviour in games written by authors who are long gone from
// the conversation, and the symptom shows up as "game 37 feels wrong".
//
//   npm run check:frozen      verify
//   npm run freeze            accept the current contents as the new baseline
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FROZEN } from './frozen-list.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = resolve(ROOT, '.frozen.json');
const write = process.argv.includes('--write');

const hashes = {};
for (const rel of FROZEN) {
  try {
    hashes[rel] = createHash('sha256').update(await readFile(resolve(ROOT, rel))).digest('hex');
  } catch {
    console.error(`✗ frozen file missing: ${rel}`);
    process.exit(1);
  }
}

if (write) {
  await writeFile(LOCK, JSON.stringify(hashes, null, 2) + '\n');
  console.log(`✓ froze ${FROZEN.length} contract files -> .frozen.json`);
  process.exit(0);
}

let prev;
try {
  prev = JSON.parse(await readFile(LOCK, 'utf8'));
} catch {
  console.error('✗ .frozen.json missing. Run `npm run freeze` (lead only).');
  process.exit(1);
}

const drift = FROZEN.filter((f) => prev[f] !== hashes[f]);
const added = Object.keys(hashes).filter((f) => !(f in prev));

if (drift.length === 0 && added.length === 0) {
  console.log(`✓ frozen contract intact (${FROZEN.length} files)`);
  process.exit(0);
}

console.error('✗ FROZEN CONTRACT CHANGED:\n');
for (const f of drift) console.error(`    modified  ${f}`);
for (const f of added) console.error(`    new       ${f}`);
console.error(`
These files are imported by every game. If you are a game author, revert them:
    git checkout -- ${drift.concat(added).join(' ')}
and write src/games/<id>/NEEDS.md describing the engine feature you need.

If you are the lead and this change is intended:
    npm run freeze && npm run test
`);
process.exit(1);

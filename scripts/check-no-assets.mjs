#!/usr/bin/env node
// No binary assets in src/games/**.
//
// All art is shapes + emoji, all audio is synthesized. That is what gives 58
// parallel authors a merge surface of zero and the page zero third-party
// requests — one checked-in PNG starts the slide away from both.
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BAD = /\.(png|jpe?g|gif|webp|svg|avif|mp3|wav|ogg|m4a|webm|mp4|ttf|otf|woff2?|glb|json)$/i;
const bad = [];

async function walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p);
    else if (BAD.test(e.name)) bad.push(p.replace(ROOT + '/', ''));
  }
}
await walk(resolve(ROOT, 'src/games'));

if (bad.length) {
  console.error(`✗ asset files found in src/games (${bad.length}):\n`);
  for (const f of bad) console.error(`    ${f}`);
  console.error('\nUse g.emoji() and shapes for art, SFX_IDS for sound. See AGENTS.md § No assets.');
  process.exit(1);
}
console.log('✓ no assets in src/games');

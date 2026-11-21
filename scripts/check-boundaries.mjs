#!/usr/bin/env node
// Enforces the import boundary that makes parallel authoring safe.
//
// This is file topology, not style: if a game can import another game, or a
// shared mutable module, then 58 authors are no longer independent and the
// merge surface stops being zero.
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GAMES = resolve(ROOT, 'src/games');
const errs = [];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/g;
const DYN_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Globals a game must never touch: they break headless tests and the
 *  no-asset / no-network guarantees. */
const BANNED_TOKENS = [
  ['Math.random(', 'use ctx.rng() — a round must be reproducible from a seed'],
  ['Date.now(', 'use the dt / frame.t you are given'],
  ['performance.now(', 'use the dt / frame.t you are given'],
  ['document.', 'games draw through the Renderer interface, not the DOM'],
  ['window.', 'games must run headless in Node'],
  ['localStorage', 'the engine owns persistence'],
  ['fetch(', 'there is no network path out of this app'],
  ['new Image(', 'no asset files — use g.emoji() and shapes'],
  ['new Audio(', 'no asset files — use ctx.audio.play() with an SFX_ID'],
  ['CanvasRenderingContext2D', 'the Renderer interface has no ctx escape hatch'],
  ['g.emoji(', 'emoji were removed: use g.sprite() — see src/engine/render/sprites.ts'],
  ['getContext(', 'the Renderer interface has no ctx escape hatch'],
  ['toDataURL', 'banned: would break the privacy guarantee'],
  ['toBlob', 'banned: would break the privacy guarantee'],
  ['MediaRecorder', 'banned: would break the privacy guarantee'],
];

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

try {
  await stat(GAMES);
} catch {
  console.log('✓ boundaries: no games yet');
  process.exit(0);
}

for (const folder of await readdir(GAMES, { withFileTypes: true })) {
  if (!folder.isDirectory()) continue;
  const id = folder.name;
  // __tests__ is engine-owned; _-prefixed folders are templates.
  if (id.startsWith('_') || id.startsWith('__')) continue;

  const files = await walk(join(GAMES, id));
  const names = files.map((f) => relative(join(GAMES, id), f).replaceAll('\\', '/'));

  for (const extra of names.filter((n) => !/^(manifest|index|locale|NEEDS)\.(ts|md)$/.test(n))) {
    errs.push(`${id}/${extra}: a game folder holds only manifest.ts, index.ts, locale.ts (+ NEEDS.md)`);
  }

  for (const f of files) {
    const rel = relative(ROOT, f).replaceAll('\\', '/');
    const src = await readFile(f, 'utf8');
    const isManifest = f.endsWith('manifest.ts');

    const specs = [
      ...[...src.matchAll(IMPORT_RE)].map((m) => m[1]),
      ...[...src.matchAll(DYN_RE)].map((m) => m[1]),
    ];
    for (const spec of specs) {
      if (isManifest) {
        if (spec !== '@/engine/types') {
          errs.push(`${rel}: manifest.ts may import only "@/engine/types" (found "${spec}")`);
        }
        continue;
      }
      const okEngine = spec === '@/engine/types' || spec.startsWith('@/engine/');
      const okLocal = spec.startsWith('./') && !spec.includes('..');
      if (!okEngine && !okLocal) {
        errs.push(`${rel}: may import only "@/engine/*" or "./*" (found "${spec}")`);
      }
      if (spec.includes('/games/')) {
        errs.push(`${rel}: games must never import other games (found "${spec}")`);
      }
    }

    // Strip comments and string literals before scanning for banned tokens,
    // so documentation that *names* a banned API does not fail the build.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    for (const [tok, why] of BANNED_TOKENS) {
      if (code.includes(tok)) errs.push(`${rel}: "${tok}" is banned — ${why}`);
    }

    // Emoji anywhere in a game file. They render as three different artworks
    // across macOS, Windows and Android and cannot be recoloured, so a single
    // one breaks the visual unity the whole sprite system exists to provide.
    // Checked on the RAW source, because an emoji in a comment or a Korean
    // string is just as visible to a child as one in a draw call.
    const emoji = src.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu);
    if (emoji) {
      errs.push(`${rel}: contains emoji ${[...new Set(emoji)].slice(0, 5).join(' ')} — use a sprite id instead (see docs/GAME_AUTHORING.md)`);
    }
  }
}

// ─── Shell: no emoji in anything the player sees ────────────────────────────
//
// Same reason as the games: an emoji is a different artwork on every OS and
// cannot be recoloured, so a lobby of emoji can never match the game it
// launches. Comments are exempt — the rule is about what a child sees.
const SHELL = resolve(ROOT, 'src/shell');
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

async function checkShell() {
  let files;
  try { files = await walk(SHELL); } catch { return; }
  for (const f of files) {
    const rel = relative(ROOT, f).replaceAll('\\', '/');
    if (/\.test\.tsx?$/.test(rel)) continue;
    const src = await readFile(f, 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = EMOJI_RE.exec(lines[i]);
      if (m) {
        errs.push(`${rel}:${i + 1}: emoji ${m[0]} in UI — use <SpriteIcon id="…"/> or a sprite id`);
      }
    }
  }
}
await checkShell();

if (errs.length) {
  console.error(`✗ boundary violations (${errs.length}):\n`);
  for (const e of errs) console.error(`    ${e}`);
  console.error('\nSee AGENTS.md § Hard prohibitions.');
  process.exit(1);
}
console.log('✓ boundaries clean');

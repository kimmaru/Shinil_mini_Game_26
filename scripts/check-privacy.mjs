#!/usr/bin/env node
// Post-build audit: prove the production bundle cannot capture or exfiltrate.
//
// The 개인정보 안내 page tells children and their guardians that camera frames
// never leave the device. This script is what makes that claim auditable rather
// than aspirational, and it is why it is a build step and not a wiki page.
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');

const BANNED = [
  [/\.toDataURL\s*\(/, 'canvas capture'],
  [/\.toBlob\s*\(/, 'canvas capture'],
  [/\bMediaRecorder\b/, 'recording'],
  [/\bnavigator\.sendBeacon\b/, 'beacon exfiltration'],
  [/\bnew\s+WebSocket\b/, 'socket'],
  [/\bnew\s+EventSource\b/, 'server-sent events'],
  // Any absolute http(s) request target that is not a doc comment.
  [/fetch\s*\(\s*["'`]https?:\/\//, 'cross-origin fetch'],
  [/XMLHttpRequest/, 'XHR'],
];

try {
  await stat(DIST);
} catch {
  console.error('✗ no dist/ — run `npm run build` first');
  process.exit(1);
}

// The MediaPipe wasm runtime is vendored verbatim and uses Emscripten's
// XMLHttpRequest loader to fetch its own .wasm from OUR origin. Scanning it for
// request APIs is a false positive — but exempting a directory by name would be
// a hole, so instead we prove those files are byte-identical to the npm package
// and audit everything else.
const VENDORED = 'dist/wasm/';

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(js|mjs|css|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Verify dist/wasm/* is exactly what npm shipped — no edits, no additions. */
async function verifyVendored() {
  const src = resolve(ROOT, 'node_modules/@mediapipe/tasks-vision/wasm');
  const out = resolve(ROOT, 'dist/wasm');
  let names;
  try {
    names = await readdir(out);
  } catch {
    return []; // nothing vendored into dist
  }
  const problems = [];
  for (const n of names) {
    try {
      const a = createHash('sha256').update(await readFile(join(src, n))).digest('hex');
      const b = createHash('sha256').update(await readFile(join(out, n))).digest('hex');
      if (a !== b) problems.push(`dist/wasm/${n}: does not match the @mediapipe/tasks-vision package`);
    } catch {
      problems.push(`dist/wasm/${n}: no counterpart in @mediapipe/tasks-vision — where did this come from?`);
    }
  }
  return problems;
}

const hits = [...(await verifyVendored())];
for (const f of await walk(DIST)) {
  // Forward slashes on every OS, or the vendored prefix never matches on Windows.
  const rel = relative(ROOT, f).replaceAll('\\', '/');
  if (rel.startsWith(VENDORED)) continue; // hash-verified above instead
  const src = await readFile(f, 'utf8');
  for (const [re, what] of BANNED) {
    const m = re.exec(src);
    if (m) {
      hits.push(`${rel}: ${what} — matched ${JSON.stringify(m[0])}`);
    }
  }
}

if (hits.length) {
  console.error(`✗ privacy audit FAILED (${hits.length}):\n`);
  for (const h of hits) console.error(`    ${h}`);
  console.error(`
The site promises that camera frames never leave the device and are never
recorded. Something in the shipped bundle contradicts that. Remove it — do not
relax this check.`);
  process.exit(1);
}
console.log('✓ privacy audit clean: no capture, no recording, no outbound requests');
console.log('  (dist/wasm/* verified byte-identical to @mediapipe/tasks-vision)');

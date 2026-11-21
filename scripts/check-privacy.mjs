#!/usr/bin/env node
// Post-build audit: prove the production bundle cannot capture or exfiltrate.
//
// The 개인정보 안내 page tells children and their guardians that camera frames
// never leave the device. This script is what makes that claim auditable rather
// than aspirational, and it is why it is a build step and not a wiki page.
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(js|mjs|css|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

const hits = [];
for (const f of await walk(DIST)) {
  const src = await readFile(f, 'utf8');
  for (const [re, what] of BANNED) {
    const m = re.exec(src);
    if (m) {
      hits.push(`${f.replace(ROOT + '/', '')}: ${what} — matched ${JSON.stringify(m[0])}`);
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

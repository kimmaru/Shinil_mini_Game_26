#!/usr/bin/env node
// Launch the game the way you actually play it: a window with no browser in it.
//
// The dev server is for development — HMR, source maps, an unminified bundle.
// For playing on this machine none of that helps, so this serves the
// production build from a ~40-line static server and opens Chrome in app mode:
// no tabs, no address bar, no bookmarks. It looks like an application because
// everything that says "browser" is gone.
//
//   npm run play          build if needed, then open
//   npm run play -- --fresh   rebuild first
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PORT = 4300;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.map': 'application/json; charset=utf-8',
};

async function ensureBuild() {
  const fresh = process.argv.includes('--fresh');
  if (!fresh) {
    try {
      await stat(join(DIST, 'index.html'));
      return;
    } catch { /* fall through and build */ }
  }
  console.log('• 빌드 중…');
  await new Promise((res, rej) => {
    const p = spawn('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`build exited ${c}`))));
  });
}

function serve() {
  return new Promise((ready) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      // Normalize away any ../ before touching the filesystem.
      let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      if (path.endsWith('/')) path += 'index.html';
      let file = join(DIST, path);
      if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
      try {
        const body = await readFile(file);
        res.writeHead(200, {
          'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
          // The privacy guarantee, enforced here too: nothing may call out.
          'Content-Security-Policy':
            "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; " +
            "connect-src 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
            "style-src 'self' 'unsafe-inline'; font-src 'self'; worker-src 'self' blob:",
          'Permissions-Policy': 'camera=(self), microphone=()',
          'Cache-Control': 'no-cache',
        });
        res.end(body);
      } catch {
        // SPA fallback.
        try {
          res.writeHead(200, { 'Content-Type': TYPES['.html'] });
          res.end(await readFile(join(DIST, 'index.html')));
        } catch { res.writeHead(404).end('not found'); }
      }
    });
    server.listen(PORT, '127.0.0.1', () => ready(server));
  });
}

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

async function openApp(url) {
  for (const bin of CHROME) {
    try {
      await stat(bin);
      // --app strips the tab strip, address bar and bookmarks: the page gets
      // the whole window, which is the only thing standing between this and
      // feeling like a real application.
      spawn(bin, [`--app=${url}`, '--start-fullscreen'], { detached: true, stdio: 'ignore' }).unref();
      return bin;
    } catch { /* try the next one */ }
  }
  execFile('open', [url]);
  return 'default browser';
}

await ensureBuild();
await serve();
const url = `http://127.0.0.1:${PORT}/`;
const via = await openApp(url);
console.log(`
  ▶ 몸으로 놀자!  ${url}
    ${via.split('/').pop()} 앱 모드로 열었어요. 창을 닫으면 끝납니다.
    (이 터미널을 닫으면 서버도 멈춰요)
`);

#!/usr/bin/env node
// Launch the game the way you actually play it: a window with no browser in it.
//
// The dev server is for development — HMR, source maps, an unminified bundle.
// For playing on this machine none of that helps, so this serves the
// production build from a ~40-line static server and opens Chrome in app mode:
// no tabs, no address bar, no bookmarks. It looks like an application because
// everything that says "browser" is gone.
//
//   npm run play              build if the build is missing or older than the source, then open
//   npm run play -- --fresh   always rebuild first
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PORT = 4300;
const URL_ = `http://127.0.0.1:${PORT}/`;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // Without application/wasm, instantiateStreaming refuses the module.
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.map': 'application/json; charset=utf-8',
};

/** Newest mtime under `dir`, in ms. */
async function newest(dir) {
  let t = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? await newest(p) : (await stat(p)).mtimeMs);
  }
  return t;
}

async function ensureBuild() {
  if (!process.argv.includes('--fresh')) {
    try {
      const built = (await stat(join(DIST, 'index.html'))).mtimeMs;
      const inputs = await Promise.all([
        newest(join(ROOT, 'src')),
        ...['index.html', 'vite.config.ts', 'package.json'].map(async (f) => (await stat(join(ROOT, f))).mtimeMs),
      ]);
      // A stale build is the worst kind of "it still doesn't work": the fix is
      // on disk and the window is running last week's bundle.
      if (Math.max(...inputs) <= built) return;
      console.log('• 소스가 바뀌어서 다시 빌드해요…');
    } catch { /* no build yet: fall through and build */ }
  }
  console.log('• 빌드 중…');
  // Re-use the npm that launched us, with the node that is running us. A bare
  // `npm` is not on PATH when node comes from nvm/fnm and the shell that
  // started this was not a login shell.
  const cli = process.env.npm_execpath;
  const [cmd, pre, shell] = cli && /\.[cm]?js$/.test(cli)
    ? [process.execPath, [cli], false]
    : [process.platform === 'win32' ? 'npm.cmd' : 'npm', [], process.platform === 'win32'];
  await new Promise((res, rej) => {
    // node's own bin dir on PATH too, for the nested `npm run` calls in "build".
    // (Not on Windows, where the variable is `Path` and a second `PATH` key
    // makes which one wins undefined.)
    const env = process.platform === 'win32'
      ? process.env
      : { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` };
    const p = spawn(cmd, [...pre, 'run', 'build'], { cwd: ROOT, stdio: 'inherit', shell, env });
    p.on('error', rej);
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`build exited ${c}`))));
  });
}

const HEADERS = {
  // The privacy guarantee, enforced here too: nothing may call out.
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; " +
    "connect-src 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline'; font-src 'self'; worker-src 'self' blob:",
  'Permissions-Policy': 'camera=(self), microphone=()',
  'Cache-Control': 'no-cache',
};

function serve() {
  return new Promise((ready, fail) => {
    const server = createServer(async (req, res) => {
      let path;
      try {
        const url = new URL(req.url ?? '/', 'http://x');
        // Normalize away any ../ before touching the filesystem.
        path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (path.endsWith('/') || path.endsWith('\\')) path += 'index.html';
      const file = join(DIST, path);
      if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', ...HEADERS });
        res.end(body);
      } catch {
        // SPA fallback for routes only. A missing .wasm/.task/.js must be a
        // 404: served as index.html it surfaces as an unreadable parse error
        // deep inside MediaPipe instead of "file not found".
        if (extname(path)) { res.writeHead(404, HEADERS).end('not found'); return; }
        try {
          res.writeHead(200, { 'Content-Type': TYPES['.html'], ...HEADERS });
          res.end(await readFile(join(DIST, 'index.html')));
        } catch { res.writeHead(404).end('not found'); }
      }
    });
    server.on('error', fail);
    server.listen(PORT, '127.0.0.1', () => ready(server));
  });
}

/** True if what is already listening on PORT is this game (a second launch). */
async function alreadyServing() {
  try {
    const html = await (await fetch(URL_)).text();
    return html.includes('몸으로 놀자');
  } catch {
    return false;
  }
}

/**
 * App-mode flags. A dedicated profile is what makes them apply at all: Chrome
 * ignores command-line flags when it hands the URL to an instance that is
 * already running with the default profile. It also keeps the player's
 * extensions out of the game, and the camera permission granted once on setup
 * persists in it. --use-fake-ui-for-media-stream is deliberately absent: the
 * camera prompt is the person's to answer.
 */
function chromeFlags() {
  const profile = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'MiniGameParty', 'chrome-profile')
    : join(tmpdir(), 'mini-game-party-chrome-profile');
  return [
    `--app=${URL_}`,
    `--user-data-dir=${profile}`,
    '--start-fullscreen',
    '--no-first-run',
    '--no-default-browser-check',
    // Sound with no click first: the booth's guests never touch anything.
    '--autoplay-policy=no-user-gesture-required',
    // An app window behind a notification or another window must not be
    // throttled into a 1fps slideshow, nor its timers into 1Hz.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    // No "translate this page?" bar over the game on a non-Korean Chrome.
    '--disable-features=Translate',
  ];
}

function run(cmd, args, detached = false) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { stdio: 'ignore', detached });
    p.on('error', () => res(false));
    if (detached) { p.unref(); setTimeout(() => res(true), 500); return; }
    p.on('exit', (c) => res(c === 0));
  });
}

async function openApp() {
  const flags = chromeFlags();
  if (process.platform === 'darwin') {
    // LaunchServices finds the app wherever it is installed; -n starts a new
    // instance (our own profile) even if the person's Chrome is already open.
    for (const app of ['Google Chrome', 'Chromium', 'Microsoft Edge']) {
      if (await run('open', ['-na', app, '--args', ...flags])) return app;
    }
    await run('open', [URL_]);
    return 'default browser';
  }
  // Development machines only.
  const bins = process.platform === 'win32'
    ? [
        join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
        join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
      ]
    : ['google-chrome', 'chromium', 'chromium-browser'];
  for (const bin of bins) {
    if (await run(bin, flags, true)) return bin;
  }
  return 'nothing — open the address above in Chrome';
}

await ensureBuild();
try {
  await serve();
} catch (e) {
  if (e?.code !== 'EADDRINUSE' || !(await alreadyServing())) {
    console.error(`✗ 포트 ${PORT}을 쓸 수 없어요: ${e?.message ?? e}`);
    process.exit(1);
  }
  console.log(`• 이미 실행 중인 서버(${PORT})를 그대로 써요.`);
}
// Body-only play never touches the keyboard or mouse, so macOS would dim and
// sleep the display mid-game. caffeinate (built into macOS) holds it awake for
// exactly as long as this server runs (-w: until this process exits).
if (process.platform === 'darwin') {
  spawn('caffeinate', ['-di', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {});
}
const via = await openApp();
console.log(`
  ▶ 몸으로 놀자!  ${URL_}
    ${String(via).split(/[\\/]/).pop()} 앱 모드로 열었어요. 창을 닫으면 끝납니다.
    (이 터미널을 닫으면 서버도 멈춰요)
`);

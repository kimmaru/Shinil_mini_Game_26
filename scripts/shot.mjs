// npm run shot -- [<game-id> ...]        (no ids = every game in the registry)
//
// Renders real frames of real games to SVG, with no browser and no camera, and
// writes a contact sheet so a whole wave can be reviewed in one look.
//
// Why SVG rather than a screenshot. Both obvious routes are closed:
//   - A browser screenshot needs requestAnimationFrame, which the review pane
//     suspends whenever it is hidden, so a t=5s frame never arrives.
//   - canvas.toDataURL / toBlob are banned by scripts/check-privacy.mjs, and
//     that ban is load-bearing: it is what makes "no frame ever leaves this
//     machine" provable instead of promised.
// Re-rendering the same draw calls into SVG needs neither, and the output is
// text — greppable for off-screen geometry, diffable between two runs of one
// seed. A PNG is neither.
//
// Options:
//   --at=1.5,6,20   round times to capture, seconds (default 1.5,6,20)
//   --out=dir       output directory (default shots/)
//   --w= --h=       view size (default 1280x720)
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { createServer } from 'vite';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const ids = argv.filter((a) => !a.startsWith('--'));
const times = flag('at', '1.5,6,20').split(',').map(Number).filter(Number.isFinite);
const outDir = resolve(flag('out', 'shots'));
const view = { w: Number(flag('w', 1280)), h: Number(flag('h', 720)) };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const pad = (n, w) => String(n).padStart(w);

const server = await createServer({
  configFile: 'vite.config.ts',
  server: { middlewareMode: true },
  logLevel: 'silent',
});
const load = (p) => server.ssrLoadModule(p);

try {
  const { ALL } = await load('/src/engine/registry.ts');
  const { runGame } = await load('/src/engine/testing/harness.ts');
  const { SvgRenderer } = await load('/src/engine/testing/svgRenderer.ts');

  const targets = ids.length > 0 ? ids : [...ALL.keys()];
  const missing = targets.filter((id) => !ALL.has(id));
  if (missing.length > 0) {
    console.error(`unknown game id(s): ${missing.join(', ')}`);
    process.exitCode = 1;
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const rows = [];
  for (const id of targets.filter((i) => ALL.has(i))) {
    const manifest = ALL.get(id);
    const g = new SvgRenderer(view.w, view.h, { snapAt: times });
    // The game's own dev clip when it names one, so the shot shows the game
    // being PLAYED. reach-grid is the honest fallback: both hands sweep the
    // whole screen, which exercises most games at least a little.
    const clip = manifest.dev?.clip ?? 'reach-grid';
    let report;
    try {
      report = await runGame(id, {
        clip, seed: 7, view, renderer: g,
        durationMs: Math.max(...times) * 1000 + 500,
      });
    } catch (e) {
      rows.push({ id, nameKo: manifest.nameKo, error: String(e?.message ?? e), shots: [] });
      continue;
    }

    const shots = [];
    for (const t of times) {
      const svg = g.shots.get(t);
      if (!svg) continue;
      const file = `${id}-${String(t).replace('.', '_')}s.svg`;
      await writeFile(resolve(outDir, file), svg, 'utf8');
      shots.push({ t, file });
    }
    rows.push({
      id,
      nameKo: manifest.nameKo,
      hue: manifest.theme?.hue ?? 0,
      enabled: manifest.enabled !== false,
      score: report.result.rawScore,
      maxScore: report.result.maxScore,
      stars: report.result.stars,
      opsPerFrame: report.audit.frames > 0 ? report.audit.ops / report.audit.frames : 0,
      blank: report.audit.framesWithNoDraw,
      frames: report.audit.frames,
      nan: report.audit.nanOps,
      off: report.audit.offscreenOps,
      threw: report.threw ? `${report.threwIn}: ${report.threw.message}` : null,
      shots,
    });
  }

  // ── contact sheet ────────────────────────────────────────────────────────
  const card = (r) => {
    const flags = [
      r.threw ? `<b class="bad">THREW ${esc(r.threw)}</b>` : '',
      r.error ? `<b class="bad">${esc(r.error)}</b>` : '',
      r.blank > 0 ? `<b class="bad">blank ${r.blank}/${r.frames}</b>` : '',
      r.nan > 0 ? `<b class="bad">NaN ${r.nan}</b>` : '',
      r.off > 0 ? `<b class="warn">offscreen ${r.off}</b>` : '',
      r.score === 0 ? '<b class="bad">score 0</b>' : '',
      r.enabled === false ? '<b class="dim">off</b>' : '',
    ].filter(Boolean).join(' ');
    return `<figure class="card">
  <figcaption>
    <strong>${esc(r.nameKo ?? r.id)}</strong> <code>${esc(r.id)}</code><br>
    ${r.score ?? '–'}/${r.maxScore ?? '–'} · ★${r.stars ?? 0} ·
    ${(r.opsPerFrame ?? 0).toFixed(0)} ops/frame ${flags}
  </figcaption>
  <div class="strip">${r.shots.map((s) =>
    `<div><span>${s.t}s</span><img src="./${s.file}" alt="${esc(r.id)} at ${s.t}s"></div>`,
  ).join('')}</div>
</figure>`;
  };

  await writeFile(resolve(outDir, 'index.html'), `<!doctype html>
<meta charset="utf-8"><title>shots — ${targets.length} games</title>
<style>
  :root { color-scheme: light }
  body { margin:0; padding:16px; background:#F3F4F8; font:13px/1.5 system-ui,sans-serif; color:#1A1D2E }
  h1 { font-size:16px; margin:0 0 12px }
  .card { margin:0 0 18px; background:#fff; border:1px solid #DDE1EC; border-radius:10px; padding:10px }
  figcaption { margin-bottom:8px }
  code { color:#4A5068 }
  .strip { display:flex; gap:8px; overflow-x:auto }
  .strip div { position:relative; flex:0 0 auto }
  .strip span { position:absolute; top:4px; left:6px; background:#000A; color:#fff; padding:1px 5px; border-radius:4px; font-size:11px }
  img { display:block; width:360px; height:auto; border-radius:6px; background:#FFF8EC }
  .bad { color:#C62828 } .warn { color:#B26A00 } .dim { color:#7C8398; font-weight:400 }
</style>
<h1>${targets.length} games · t = ${times.join(', ')}s · seed 7 · ${view.w}×${view.h}</h1>
${rows.map(card).join('\n')}
`, 'utf8');

  // ── terminal summary ─────────────────────────────────────────────────────
  console.log(`\n  ${pad('game', 24)} ${pad('score', 9)} ★  ops/f  blank  nan  off`);
  for (const r of rows) {
    const bad = r.threw || r.error || r.blank > 0 || r.nan > 0 || r.score === 0;
    console.log(
      `  ${bad ? '✗' : '·'} ${pad(r.id, 22)} ` +
      `${pad(`${r.score ?? '–'}/${r.maxScore ?? '–'}`, 9)} ${r.stars ?? 0}  ` +
      `${pad((r.opsPerFrame ?? 0).toFixed(0), 5)}  ${pad(r.blank ?? 0, 5)}  ` +
      `${pad(r.nan ?? 0, 3)}  ${pad(r.off ?? 0, 3)}` +
      (r.threw ? `   ${r.threw}` : '') + (r.error ? `   ${r.error}` : ''),
    );
  }
  console.log(`\n  → ${relative(process.cwd(), resolve(outDir, 'index.html'))}\n`);
} finally {
  await server.close();
}

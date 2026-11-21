
| package | version | note |
|---|---|---|
| `vite` | **8.3.8** | engines `^20.19.0 \|\| >=22.12.0` |
| `typescript` | **7.0.2** | native (Go) compiler line; if any plugin chokes, fall back to the 5.x line |
| `@mediapipe/tasks-vision` | **1.2.3** | `nightly` = `1.3.0-rc.20261120` — pin exact, model `.task` files must match |
| `pixi.js` | **8.23.0** | |
| `phaser` | **4.2.1** | Phaser 4 = ground-up WebGL2 renderer rewrite |
| `react` / `react-dom` | **19.3.1** | |
| `@vitejs/plugin-react` | **6.3.0** | peer `vite ^8.0.0` |
| `zustand` | **5.1.0** | if you need shell state |
| `howler` | **2.2.4** | **not recommended** (see §4) |
| `tone` | **15.1.22** | optional; ~200 KB + own clock |
| `zod` | **4.6.7** | dev-only manifest validation |
| `vitest` | **5.1.1** | |
| `vite-plugin-pwa` | **2.0.0** | peer includes `^8.0.0`; school Wi-Fi insurance |
| `pretendard` | **1.3.9** | OFL-1.1 |
| `@tensorflow-models/pose-detection` | 2.1.3 | fallback only; heavier, tfjs peer chain |

---

## 1) Stack choice → **(a) Vite + vanilla TS + one shared Canvas2D renderer**

**Recommendation: (a), with React scoped strictly to the shell (lobby / roulette / results / settings) if the team wants it. Game runtime stays React-free, Phaser-free, Pixi-free.**

Why, against your five constraints:

**40+ independent modules.** Phaser 3/4 scenes (c) and Pixi display objects (d) both impose a *framework-shaped* game: scene lifecycle, asset loader, texture atlases, display-object trees. For a 30–60 s microgame whose entire content is "draw 6 circles, a bar and a number," that's pure overhead — and every game author must learn it. A `MiniGame` interface with `update(dt, poseFrame)` + `render(ctx)` is something an agent can author correctly from the type signature alone with zero framework knowledge. Phaser 4 is the right call when you want physics/tilemaps/tweens/input out of the box; you need almost none of that, and you *do* need a custom pose-input layer that would fight Phaser's input system.

**60 fps render while inference runs 20–30 fps.** This is a *scheduling* problem, not a renderer problem. Canvas2D with a flat draw list handles your content budget (hundreds of primitives, a few thousand particles) at 60 fps trivially; Pixi's advantage only shows up in the thousands-of-sprites regime you will never hit. Meanwhile a single `requestAnimationFrame` loop you own is what lets you decouple: pose source pushes at ~25 Hz, the loop extrapolates (§3) and renders at 60. Pixi/Phaser add their own ticker you'd be working around.

**React per-game (b) is the one to actively reject.** Per-frame React reconciliation for gameplay is wasted work, it pushes authors toward `useEffect` lifecycle bugs in a 30-second game, and `ref`-based canvas escape hatches mean you get React's merge surface (shared providers, hook ordering, shared state files) *without* its benefits. React's value here is the lobby: declarative, accessible DOM, keyboard focus management, Korean text layout. Use it there only.

**Parallel agents without merge conflicts.** This is decided by *file topology*, not framework. Rule: **one folder per game, no barrel files, no central registry list, no shared-mutable files.** `import.meta.glob` (§2) makes "add a folder" the entire integration step. Any design that requires editing a central `games.ts` serializes 40 agents behind one file.

**Static deploy on Vercel.** All four options work; (a) ships the smallest first paint. Budget: shell + engine ≈ 60–90 KB gz; each game 3–10 KB gz; MediaPipe vision wasm + pose model is the real weight (~3–8 MB depending on `lite`/`full`/`heavy`) — load it once, lazily, behind the priming screen.

### Bundle splitting / lazy loading
Two-tier module pattern is the crux (details §2): **`manifest.ts` is eagerly globbed (tiny, data only), `index.ts` is lazily globbed (one Rollup chunk per game).** The lobby can render 40 game cards with full metadata while shipping zero game code.

```ts
// vite.config.ts
import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Do NOT put games here — let them stay natural dynamic chunks.
        manualChunks(id) {
          if (id.includes('@mediapipe')) return 'vision';
          if (id.includes('/src/engine/')) return 'engine';
          if (id.includes('/node_modules/react')) return 'react';
        },
      },
    },
  },
  worker: { format: 'es' },
});
```

Preload the next game's chunk during the 3-2-1 countdown: `registry.preload(nextId)` → calls the glob loader but discards the result; Rollup chunk is then warm in the module cache. Also `<link rel="modulepreload">` for the roulette's top-3 candidates.

`vercel.json`:
```json
{
  "cleanUrls": true,
  "headers": [
    { "source": "/assets/(.*)", "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }] },
    { "source": "/(.*)", "headers": [
      { "key": "Permissions-Policy", "value": "camera=(self), microphone=()" },
      { "key": "Content-Security-Policy", "value": "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'" },
      { "key": "Referrer-Policy", "value": "no-referrer" }
    ]}
  ],
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```
`connect-src 'self'` is doing double duty: it's a *provable* non-exfiltration guarantee you can cite in the privacy copy (§7). This is why you must **self-host fonts and the MediaPipe wasm/model**, not CDN them.

### Pose layer placement
Start **main thread** with `FilesetResolver.forVisionTasks` + `delegate: 'GPU'` + `runningMode: 'VIDEO'`, driven by `video.requestVideoFrameCallback` and throttled to ~25–30 Hz. GPU delegate consumes the `<video>` frame as an existing GPU texture (no CPU↔GPU copy); CPU/wasm-only lands at 10–15 fps and is not viable. `PoseLandmarker` instances are not safe for concurrent calls — one instance, reused. Move to a Worker + `OffscreenCanvas` + `createImageBitmap` **only if** you measure frame hitches; keep `PoseSource` behind an interface so the swap is invisible to games.

---

## 2) Mini-game plugin architecture

### Prior art worth copying
- **WarioWare (GBA) internal structure** — the canonical answer to your exact problem: *"The main game has a common include file, but authors write games in their own private C files and submit them. The common interface has things like the key presses and the time remaining."* Plus a per-microgame struct giving the host access to each subgame's functions. That is literally: shared header (your `engine/types.ts`), private file per game, function-pointer table (your `MiniGame` object). 24 microgames per level, randomized, speed ramps, boss game at the end — copy the *pacing* model too. ([gamestudies.org](https://www.gamestudies.org/0501/gingold/), [tcrf.net](https://tcrf.net/WarioWare,_Inc.:_Mega_Microgame$!))
- **NitoriWare** (Unity, 300+ microgames, large volunteer team) — per-microgame prefab + a `Microgame` metadata asset (duration in beats, difficulty 1-3, control scheme, command text, credits) validated by an editor-time scanner. The lesson: **metadata is a separate, validated artifact from the game code**, and CI rejects a game whose metadata is malformed. ([github.com/NitorInc/NitoriWare](https://github.com/NitorInc/NitoriWare))
- **little-warioware** (Godot, collectively developed) — randomized gauntlet, <10 s games, contributor template folder. ([github.com/NEW-CYLANDIA/little-warioware](https://github.com/NEW-CYLANDIA/little-warioware))
- **캣타워 오르기 / mgahn0706/microgames** (Next.js + Canvas, Korean) — closest web analogue: a `data/` folder holding the microgame registry with control instructions and asset-preload lists, and a `games/` folder with the canvas implementations. ([github.com/mgahn0706/microgames](https://github.com/mgahn0706/microgames))
- **pcie-microgames** (Vite + React + TS, WarioWare-style) — same stack shape, worth skimming for the host/scene boundary. ([github.com/Einse57/pcie-microgames](https://github.com/Einse57/pcie-microgames))
- **AGDCWare** (game-club collection) and **Mega-MicroPygames** — both use "base microgame class + subclass per game + central random picker." ([AGDCWare](https://github.com/vgdcuci1516/AGDCWare), [Mega-MicroPygames](https://github.com/ChristianD37/Mega-MicroPygames))

Converging pattern across all of them: **(1) thin shared interface, (2) one private file/folder per game, (3) declarative metadata separate from code, (4) host owns time/input/audio/score, (5) a validator that runs over all metadata at build time.**

### Repo layout

```
src/
  engine/              # owned by 1-2 people; games import from here only
    types.ts           # MiniGameManifest, MiniGame, PoseFrame, GameResult...
    loop.ts  pose/  gestures/  juice/  audio/  hud/  registry.ts
  shell/               # React (optional): lobby, roulette, results, settings
  games/
    jump-dodge/
      manifest.ts      # data only, zero heavy imports  -> eager glob
      index.ts         # default export factory          -> lazy glob
      locale.ts        # this game's Korean strings (never a shared i18n file)
      assets/          # optional, imported from index.ts only
    clap-rhythm/ ...
```

Zero-conflict rules (enforce in CI): a game folder may import from `@/engine/*` and its own folder **only**; `manifest.ts` may import *nothing* except types; no file outside `games/<id>/` may be edited to add a game; each game owns its own locale file.

### The interface

```ts
// src/engine/types.ts
export type GameId = string;            // kebab-case, === folder name
export type PlayerId = number;          // stable across frames within a round

export type LandmarkGroup =
  | 'head' | 'arms' | 'hands' | 'torso' | 'legs' | 'feet' | 'fullBody';

export type GestureKind =
  | 'jump' | 'squat' | 'clap' | 'swingL' | 'swingR' | 'punch'
  | 'raiseL' | 'raiseR' | 'raiseBoth' | 'lean' | 'holdPose'
  | 'limbAngle' | 'zone' | 'stepLR' | 'spin' | 'stillness';

export interface MiniGameManifest {
  id: GameId;
  nameKo: string;                 // "점프 피하기"
  taglineKo: string;              // one line, <= 18 chars, shown on the card
  howToKo: string[];              // 1-3 imperative lines, read aloud + shown
  icon: string;                   // emoji or sprite key
  theme?: { hue: number };        // 0-360, tints the card + in-game accents

  difficulty: 1 | 2 | 3;          // 1 = anyone, 3 = needs timing
  intensity: 1 | 2 | 3;           // physical exertion; scheduler avoids 3,3,3
  space: 'seated' | 'standing' | 'room';   // room = needs ~2m of floor
  players: { min: 1 | 2 | 3 | 4; max: 1 | 2 | 3 | 4; mode: 'coop' | 'versus' | 'solo' | 'hotseat' };

  requiredLandmarks: LandmarkGroup[];
  gestures: GestureKind[];        // powers "camera off?" filtering + tutorials

  durationMs: number;             // 30_000 .. 60_000
  scoring: { kind: 'count' | 'time' | 'accuracy' | 'survival'; maxScore: number;
             starCuts: [number, number, number] };  // normalized 0..1 thresholds

  a11y: { keyboardFallback: boolean; noFlashing: boolean; colorBlindSafe: boolean;
          audioOptional: boolean };  // audioOptional=false => needs a visual beat cue
  tags: string[];                 // '리듬','반사신경','협동','파티'
  version: number;
  author?: string;
  enabled?: boolean;              // false = authored but not in the pool
}

export interface GameContext {
  readonly manifest: MiniGameManifest;
  readonly view: { w: number; h: number; dpr: number };  // CSS px logical size
  readonly rng: () => number;        // seeded; same seed => same round (replays, tests)
  readonly audio: AudioService;      // §4
  readonly gestures: GestureService; // §3 - detectors are rented, not constructed
  readonly fx: FxService;            // particles, shake, hitstop, flash
  readonly hud: HudService;          // setGoal/ setScore/ toast/ announce (aria-live)
  readonly t: (k: string) => string; // this game's locale.ts
  readonly profiles: ReadonlyMap<PlayerId, CalibrationProfile>;
  emit(ev: GameEvent): void;         // 'scored' | 'combo' | 'fail' | 'clearEarly'
}

export type EndReason = 'timeUp' | 'cleared' | 'failed' | 'aborted' | 'noPlayers';

export interface MiniGame {
  /** Allocate everything here. Called once, may be async (assets/decode). */
  init(ctx: GameContext): void | Promise<void>;
  /** Countdown finished, clock starts now. Never allocate here. */
  start(): void;
  /** Fixed timestep. dt is ALWAYS 1/60. Never allocate here. */
  update(dt: number, frame: PoseFrame): void;
  /** interp = 0..1 fraction into the next fixed step, for smooth rendering. */
  render(g: Renderer, interp: number): void;
  /** Must be pure-ish and synchronous. Engine owns the results screen. */
  end(reason: EndReason): GameResult;
  dispose?(): void;
  onPause?(): void;
  onResume?(): void;
  onResize?(w: number, h: number): void;
}

export type MiniGameFactory = () => MiniGame;   // default export of index.ts

export interface GameResult {
  gameId: GameId;
  cleared: boolean;
  rawScore: number;
  maxScore: number;
  normalized: number;              // 0..1, engine clamps
  stars: 0 | 1 | 2 | 3;            // engine computes from manifest.scoring.starCuts
  durationMs: number;
  perPlayer: Array<{
    playerId: PlayerId; slot: 0 | 1 | 2 | 3;
    score: number; hits: number; misses: number; bestCombo: number;
    mvp?: boolean;
  }>;
  highlightsKo?: string[];         // "콤보 12연속!" — shown on the results card
  telemetry?: Record<string, number>; // local only, never sent
}
```

Design notes that matter: `update` gets a **fixed** `dt` so physics is deterministic and seeded replays work; `render` gets `interp` so 60 fps looks smooth even though logic steps at 60 and pose arrives at 25; `end()` returns the result rather than calling a callback, so a game cannot leak the round; `stars` is computed by the engine from `starCuts`, so 40 authors cannot invent 40 star curves.

### Registry + `import.meta.glob` auto-discovery

```ts
// src/engine/registry.ts
import type { GameId, MiniGameManifest, MiniGameFactory } from './types';

const manifests = import.meta.glob<MiniGameManifest>(
  '../games/*/manifest.ts',
  { eager: true, import: 'manifest' },
);

const loaders = import.meta.glob<MiniGameFactory>(
  '../games/*/index.ts',
  { import: 'default' },                 // lazy: () => Promise<MiniGameFactory>
);

const idOf = (p: string) => p.split('/').at(-2)!;

export const ALL: ReadonlyMap<GameId, MiniGameManifest> = (() => {
  const m = new Map<GameId, MiniGameManifest>();
  for (const [path, man] of Object.entries(manifests)) {
    const folder = idOf(path);
    if (import.meta.env.DEV) {
      if (man.id !== folder) throw new Error(`[registry] ${path}: id "${man.id}" !== folder "${folder}"`);
      if (!loaders[`../games/${folder}/index.ts`]) throw new Error(`[registry] ${folder}: missing index.ts`);
      if (m.has(man.id)) throw new Error(`[registry] duplicate id "${man.id}"`);
      validateManifest(man);             // zod, dev-only, tree-shaken in prod
    }
    if (man.enabled !== false) m.set(man.id, man);
  }
  return m;
})();

const cache = new Map<GameId, Promise<MiniGameFactory>>();
export function load(id: GameId): Promise<MiniGameFactory> {
  let p = cache.get(id);
  if (!p) { p = loaders[`../games/${id}/index.ts`]!(); cache.set(id, p); }
  return p;
}
export const preload = (id: GameId) => { void load(id).catch(() => cache.delete(id)); };

export function pickPool(f: {
  players: number; space: MiniGameManifest['space'][];
  cameraOn: boolean; maxIntensity?: 1 | 2 | 3;
}): MiniGameManifest[] {
  return [...ALL.values()].filter(m =>
    f.players >= m.players.min && f.players <= m.players.max &&
    f.space.includes(m.space) &&
    (f.cameraOn || m.a11y.keyboardFallback) &&
    (!f.maxIntensity || m.intensity <= f.maxIntensity));
}
```

Default (lazy) globs compile to `{ './dir/foo.js': () => import('./dir/foo.js') }` and **each matched file becomes its own build chunk**; `eager: true` inlines into the current chunk and loses the split — which is exactly why manifests are eager (you want them in the shell chunk) and `index.ts` is not. ([vite.dev glob import](https://vite.dev/guide/features#glob-import), [DevToolbox auto-discovery write-up](https://dev.to/dan_f8d850ce77481b/how-devtoolbox-auto-discovers-browser-tools-with-vite-importmetaglob-3d6o))

Add a **CI guard** that fails the build if `games/*/manifest.ts` has any import other than `../../engine/types`, and a Vitest test that asserts every manifest parses, every `index.ts` default-exports a function, and `ALL.size === folderCount`. Plus a session **shuffle bag** (not `Math.random()` per pick) so no game repeats until the bag empties — kids notice repeats within two minutes.

---

## 3) Shared gameplay services (write once, 40 games consume)

### 3.1 Fixed-timestep loop with render interpolation

```ts
// src/engine/loop.ts
const STEP = 1 / 60;            // seconds
const MAX_STEPS = 5;            // ~83ms of catch-up, then drop time (no death spiral)

export function createLoop(game: MiniGame, pose: PoseSource, g: Renderer) {
  let acc = 0, prev = performance.now() / 1000, raf = 0, running = false;
  let timeScale = 1;            // hitstop / slow-mo juice

  const tick = (nowMs: number) => {
    raf = requestAnimationFrame(tick);
    const now = nowMs / 1000;
    let frameTime = now - prev; prev = now;
    if (frameTime > 0.25) frameTime = 0.25;        // tab was backgrounded
    acc += frameTime * timeScale;

    let steps = 0;
    while (acc >= STEP && steps++ < MAX_STEPS) {
      game.update(STEP, pose.sample(now));          // extrapolated to `now`
      acc -= STEP;
    }
    if (steps >= MAX_STEPS) acc = 0;
    game.render(g, acc / STEP);
  };

  return {
    start() { running = true; prev = performance.now() / 1000; acc = 0; raf = requestAnimationFrame(tick); },
    stop() { running = false; cancelAnimationFrame(raf); },
    hitstop(sec: number) { timeScale = 0.08; setTimeout(() => (timeScale = 1), sec * 1000); },
    get running() { return running; },
  };
}
```
Pair with `document.visibilitychange` → `onPause()` + `stop()`, and the **Wake Lock API** (`navigator.wakeLock.request('screen')`) so a tablet doesn't sleep during a 60 s game.

### 3.2 Normalized pose frame + calibration profile

```ts
export interface PlayerPose {
  id: PlayerId; slot: 0|1|2|3; present: boolean; conf: number;
  /** Normalized: origin = hip centre, +x right, +y DOWN, 1 unit = shoulder width. */
  n: Float32Array;     // 33 * 2
  v: Float32Array;     // 33 * 2  velocity, units/sec (filtered)
  px: Float32Array;    // 33 * 2  canvas px, for overlays/skeleton draw
  vis: Float32Array;   // 33
  box: { x: number; y: number; w: number; h: number };  // normalized-to-view 0..1
  rollDeg: number;     // shoulder-line tilt; exposed, NOT corrected
  calib: CalibrationProfile;
}
export interface PoseFrame {
  t: number;                  // seconds
  inferenceAgeMs: number;     // >0 means these are extrapolated positions
  fps: number;                // inference fps, for the debug HUD
  players: PlayerPose[];
  byId: ReadonlyMap<PlayerId, PlayerPose>;
}
```

Normalization (the single most important shared function — it makes every threshold camera-distance-independent):

```ts
const L = { nose:0, shL:11, shR:12, elL:13, elR:14, wrL:15, wrR:16,
            hipL:23, hipR:24, knL:25, knR:26, ankL:27, ankR:28 } as const;

function normalize(raw: Float32Array, vis: Float32Array, calib: CalibrationProfile) {
  const cx = (raw[L.hipL*2] + raw[L.hipR*2]) / 2;
  const cy = (raw[L.hipL*2+1] + raw[L.hipR*2+1]) / 2;
  let s = Math.hypot(raw[L.shL*2]-raw[L.shR*2], raw[L.shL*2+1]-raw[L.shR*2+1]);
  if (s < 1e-3 || vis[L.shL] < 0.5 || vis[L.shR] < 0.5) {
    // fallback: torso length * 0.9 ~= shoulder width; then last good value
    const tl = Math.hypot(((raw[L.shL*2]+raw[L.shR*2])/2) - cx,
                          ((raw[L.shL*2+1]+raw[L.shR*2+1])/2) - cy);
    s = tl > 1e-3 ? tl * 0.9 : calib.shoulderW;
  }
  s = s * 0.3 + calib.shoulderW * 0.7;   // heavy temporal smoothing of scale only
  return { cx, cy, s };                   // n[i] = (raw[i] - c) / s
}
```
Smooth **scale and centre far more than positions** — a jumpy scale makes every threshold jitter, and it is genuinely near-constant for a kid standing in front of a camera.

Calibration (one 4-second screen, once per session per player, framed as a game: "선을 맞춰 서 볼까요?"):

```ts
export interface CalibrationProfile {
  shoulderW: number;      // px, median over ~60 frames
  armSpan: number;        // units (≈2.0 for most, but measure)
  standHipY: number;      // normalized-to-view y while standing
  squatHipY: number;      // from a single demo squat; fallback standHipY + 0.12
  reachUpY: number;       // wrist y when both hands raised
  floorY: number;         // ankle y
  handednessBias: number; // -1..1, which hand they raise first
  mirrored: boolean;      // selfie view (default true)
  capturedAt: number;
}
```
Derive everything else from this: jump threshold = `0.045 * (standHipY - reachUpY)`, zone sizes in arm-span units, etc. Persist to `localStorage` under the nickname, with a "다시 맞추기" button. Never persist landmark arrays.

### 3.3 One Euro filter (actual code)

The 1€ filter is a first-order low-pass with a *speed-adaptive* cutoff: low speed → low cutoff → jitter killed; high speed → high cutoff → lag killed. ([Casiez, Roussel & Vogel, CHI 2012](https://www.researchgate.net/publication/254005010_1_Filter_A_Simple_Speed-based_Low-pass_Filter_for_Noisy_Input_in_Interactive_Systems))

```ts
// src/engine/pose/oneEuro.ts
class LowPass {
  private s: number | null = null;
  filter(x: number, a: number) { this.s = this.s === null ? x : a * x + (1 - a) * this.s; return this.s; }
  get primed() { return this.s !== null; }
  reset() { this.s = null; }
}

export class OneEuroFilter {
  private xf = new LowPass();
  private dxf = new LowPass();
  private lastT: number | null = null;
  private lastX = 0;
  private dxHat = 0;

  constructor(
    private freq = 30,        // nominal Hz, used only before the first dt
    private minCutoff = 1.5,  // Hz — LOWER = less jitter, more lag
    private beta = 0.08,      // speed coefficient — HIGHER = less lag, more jitter
    private dCutoff = 1.0,    // Hz — cutoff for the derivative estimate
  ) {}

  private alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** x in NORMALIZED units (shoulder widths), t in seconds. */
  filter(x: number, t: number): number {
    let dt = 1 / this.freq;
    if (this.lastT !== null && t > this.lastT) dt = t - this.lastT;
    this.lastT = t;

    const dx = this.xf.primed ? (x - this.lastX) / dt : 0;
    this.lastX = x;

    this.dxHat = this.dxf.filter(dx, this.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxHat);
    return this.xf.filter(x, this.alpha(cutoff, dt));
  }

  /** Filtered velocity, units/sec — free, and exactly what gesture detectors want. */
  get velocity() { return this.dxHat; }
  reset() { this.xf.reset(); this.dxf.reset(); this.lastT = null; this.dxHat = 0; }
}

/** 33 landmarks x 2 axes = 66 scalar filters per player. ~3µs/frame. */
export class PoseFilterBank {
  private f: OneEuroFilter[];
  constructor(n = 33, cfg = { minCutoff: 1.5, beta: 0.08, dCutoff: 1.0 }) {
    this.f = Array.from({ length: n * 2 },
      () => new OneEuroFilter(30, cfg.minCutoff, cfg.beta, cfg.dCutoff));
  }
  apply(n: Float32Array, out: Float32Array, vel: Float32Array, t: number) {
    for (let i = 0; i < this.f.length; i++) {
      out[i] = this.f[i].filter(n[i], t);
      vel[i] = this.f[i].velocity;
    }
  }
  reset() { this.f.forEach(f => f.reset()); }
}
```

Tuning (normalized shoulder-width units, ~25–30 Hz input), ship these as three presets and let a manifest opt in:
- `steady` — hold-pose, aiming, zone games: `minCutoff 0.8, beta 0.02`
- `default` — most games: `minCutoff 1.5, beta 0.08`
- `snappy` — punch/swing/clap/rhythm: `minCutoff 2.5, beta 0.30`

Then **extrapolate** so 25 Hz input looks 60 Hz:
```ts
sample(now: number): PoseFrame {
  const age = Math.min(now - this.lastInferenceT, 0.06);   // cap at 60ms
  for (const p of this.players)
    for (let i = 0; i < p.n.length; i++) p.n[i] = p.nFiltered[i] + p.v[i] * age;
  ...
}
```
Capping at 60 ms is important: uncapped extrapolation overshoots badly when a frame is dropped.

### 3.4 Gesture detectors — hysteresis + cooldown

One generic Schmitt trigger, then every detector is ~10 lines on top:

```ts
// src/engine/gestures/trigger.ts
export class Trigger {
  private on = false; private lastFire = -1e9; private heldSince = -1;
  constructor(private cfg: { enter: number; exit: number;      // enter > exit
                             cooldownMs: number; minHoldMs?: number }) {}
  /** returns true exactly once per rising edge that satisfies hold+cooldown */
  update(value: number, tMs: number): boolean {
    if (!this.on && value >= this.cfg.enter) { this.on = true; this.heldSince = tMs; }
    else if (this.on && value <= this.cfg.exit) { this.on = false; this.heldSince = -1; }
    if (!this.on) return false;
    if (tMs - this.heldSince < (this.cfg.minHoldMs ?? 0)) return false;
    if (tMs - this.lastFire < this.cfg.cooldownMs) return false;
    this.lastFire = tMs; this.heldSince = tMs + 1e9;   // one shot per rising edge
    return true;
  }
  get active() { return this.on; }
  reset() { this.on = false; this.lastFire = -1e9; this.heldSince = -1; }
}
```

```ts
// src/engine/gestures/detectors.ts
const ms = (t: number) => t * 1000;

/** JUMP — hip-centre upward velocity, in shoulder-widths/sec. */
export class JumpDetector {
  private tr = new Trigger({ enter: 1.5, exit: 0.6, cooldownMs: 450 });
  private peak = 0;
  update(p: PlayerPose, t: number) {
    const vUp = -(p.v[L.hipL*2+1] + p.v[L.hipR*2+1]) / 2;   // y is down
    const bothFeetVis = p.vis[L.ankL] > 0.4 || p.vis[L.ankR] > 0.4;
    const fired = this.tr.update(bothFeetVis ? vUp : 0, ms(t));
    if (this.tr.active) this.peak = Math.max(this.peak, vUp);
    if (fired) { const h = this.peak; this.peak = 0; return { fired: true, power: Math.min(h / 3.5, 1) }; }
    return { fired: false, power: 0 };
  }
}

/** SQUAT — hip drop relative to the calibrated standing height. */
export class SquatDetector {
  private tr: Trigger;
  constructor(c: CalibrationProfile) {
    const range = Math.max(c.squatHipY - c.standHipY, 0.08);
    this.tr = new Trigger({ enter: range * 0.55, exit: range * 0.3, cooldownMs: 500, minHoldMs: 90 });
  }
  update(p: PlayerPose, t: number, c: CalibrationProfile) {
    const hipY = (p.box.y + p.box.h * 0.5);            // view-normalized
    return this.tr.update(hipY - c.standHipY, ms(t));
  }
}

/** CLAP — wrists converge fast AND end close, in front of the torso. */
export class ClapDetector {
  private tr = new Trigger({ enter: 1, exit: 0, cooldownMs: 260 });
  update(p: PlayerPose, t: number) {
    const dx = p.n[L.wrL*2] - p.n[L.wrR*2], dy = p.n[L.wrL*2+1] - p.n[L.wrR*2+1];
    const d = Math.hypot(dx, dy);                        // shoulder widths
    const closing = -( (p.v[L.wrL*2] - p.v[L.wrR*2]) * dx
                     + (p.v[L.wrL*2+1] - p.v[L.wrR*2+1]) * dy ) / (d || 1);
    const ok = d < 0.35 && closing > 1.8 &&
               p.vis[L.wrL] > 0.5 && p.vis[L.wrR] > 0.5;
    return this.tr.update(ok ? 1 : 0, ms(t));
  }
}

/** SWING — wrist tangential speed above threshold, with a direction. */
export class SwingDetector {
  private tr = new Trigger({ enter: 2.2, exit: 1.0, cooldownMs: 300 });
  constructor(private side: 'L' | 'R') {}
  update(p: PlayerPose, t: number) {
    const w = this.side === 'L' ? L.wrL : L.wrR;
    const vx = p.v[w*2], vy = p.v[w*2+1], sp = Math.hypot(vx, vy);
    const fired = this.tr.update(p.vis[w] > 0.4 ? sp : 0, ms(t));
    return fired ? { fired: true, dir: Math.atan2(vy, vx), speed: sp } : { fired: false };
  }
}

/** HOLD POSE — mean per-joint distance to a target pose, under tolerance, for N ms. */
export class HoldPoseDetector {
  private t0 = -1;
  constructor(private target: Float32Array, private joints: number[],
              private tol = 0.22, private holdMs = 800) {}
  update(p: PlayerPose, tMs: number) {
    let err = 0;
    for (const j of this.joints)
      err += Math.hypot(p.n[j*2] - this.target[j*2], p.n[j*2+1] - this.target[j*2+1]);
    err /= this.joints.length;
    const inPose = err < this.tol;
    if (!inPose) { this.t0 = -1; return { inPose, progress: 0, done: false }; }
    if (this.t0 < 0) this.t0 = tMs;
    const progress = Math.min((tMs - this.t0) / this.holdMs, 1);
    return { inPose, progress, done: progress >= 1, error: err };
  }
}

/** LIMB ANGLE — signed joint angle in degrees, e.g. elbow = (shoulder, elbow, wrist). */
export function limbAngle(p: PlayerPose, a: number, b: number, c: number) {
  const abx = p.n[a*2]-p.n[b*2], aby = p.n[a*2+1]-p.n[b*2+1];
  const cbx = p.n[c*2]-p.n[b*2], cby = p.n[c*2+1]-p.n[b*2+1];
  let d = Math.atan2(aby, abx) - Math.atan2(cby, cbx);
  return ((d * 180 / Math.PI) + 540) % 360 - 180;
}

/** ZONE OCCUPANCY — debounced "is this joint inside this screen rect/circle". */
export class ZoneDetector {
  private tr: Trigger;
  constructor(private zone: {x:number;y:number;r:number}, private joint: number,
              opts = { dwellMs: 150, cooldownMs: 250 }) {
    this.tr = new Trigger({ enter: 1, exit: 0, cooldownMs: opts.cooldownMs, minHoldMs: opts.dwellMs });
  }
  update(p: PlayerPose, t: number) {
    const x = p.px[this.joint*2], y = p.px[this.joint*2+1];
    const inside = Math.hypot(x - this.zone.x, y - this.zone.y) < this.zone.r
                   && p.vis[this.joint] > 0.4;
    return { inside, entered: this.tr.update(inside ? 1 : 0, t * 1000) };
  }
}
```

Hard rules for authors (put them in the engine README): **never threshold on raw landmark deltas**, always on normalized units; **never fire on a single frame** without a `Trigger`; minimum cooldown 250 ms for any scoring gesture (a 7-year-old flailing will otherwise score 40 points in one swing). Cooldowns under ~220 ms also fight the audio polyphony cap and sound like a machine gun.

Also ship a **gesture debug overlay** (`?debug=1`): skeleton, live gesture bars with enter/exit lines, trigger flashes, inference fps, extrapolation age. Agents authoring games cannot tune thresholds without it.

### 3.5 Player identity tracking across frames

MediaPipe's multi-pose output has no stable IDs. Greedy nearest-centroid with gating + a short grace period is enough for 1–4 kids:

```ts
interface Track { id: PlayerId; cx: number; cy: number; s: number;
                  missed: number; slot: 0|1|2|3; filters: PoseFilterBank; }

const MAX_MISSED = 20;         // ~0.8s at 25Hz
const GATE = 0.9;              // cost gate in shoulder-width units

function assign(tracks: Track[], dets: Det[]) {
  const pairs: [number, number, number][] = [];
  tracks.forEach((tr, ti) => dets.forEach((d, di) => {
    const pos = Math.hypot(d.cx - tr.cx, d.cy - tr.cy) / tr.s;
    const size = Math.abs(Math.log(d.s / tr.s));          // scale similarity
    const cost = pos + size * 1.5;
    if (cost < GATE) pairs.push([cost, ti, di]);
  }));
  pairs.sort((a, b) => a[0] - b[0]);
  const tUsed = new Set<number>(), dUsed = new Set<number>();
  for (const [, ti, di] of pairs) {
    if (tUsed.has(ti) || dUsed.has(di)) continue;
    tUsed.add(ti); dUsed.add(di); bind(tracks[ti], dets[di]);
  }
  tracks.forEach((tr, i) => { if (!tUsed.has(i)) tr.missed++; });
  dets.forEach((d, i) => { if (!dUsed.has(i)) tracks.push(newTrack(d)); });
  // keep lost tracks alive (and keep rendering them ghosted) for MAX_MISSED frames
  return tracks.filter(t => t.missed < MAX_MISSED);
}
```
**Slot assignment is separate and sticky:** sort tracks by `cx` once at round start, assign slots 0..3 (left→right), and never re-sort mid-round — kids cross in front of each other and swapping colours/scores mid-game is the single most upsetting bug in this genre. A re-identified track within the grace window keeps its slot. Expose `present: false` + ghost rendering rather than deleting a player, and never zero a score on track loss.

### 3.6 Particles, shake, procedural juice

```ts
// Struct-of-arrays, pooled, zero allocation in update.
export class Particles {
  private x: Float32Array; private y: Float32Array;
  private vx: Float32Array; private vy: Float32Array;
  private life: Float32Array; private max: Float32Array;
  private size: Float32Array; private hue: Float32Array; private kind: Uint8Array;
  private n = 0;
  constructor(private cap = 2000) { /* allocate all 9 arrays once */ }

  burst(x: number, y: number, count: number, o: {
    speed: number; spread?: number; angle?: number; hue: number;
    life: number; size: number; kind?: 0|1|2;  // 0 dot 1 spark 2 confetti
  }) {
    for (let i = 0; i < count && this.n < this.cap; i++) {
      const a = (o.angle ?? 0) + (Math.random() - 0.5) * (o.spread ?? Math.PI * 2);
      const sp = o.speed * (0.6 + Math.random() * 0.8);
      const j = this.n++;
      this.x[j]=x; this.y[j]=y; this.vx[j]=Math.cos(a)*sp; this.vy[j]=Math.sin(a)*sp;
      this.max[j]=this.life[j]=o.life*(0.7+Math.random()*0.6);
      this.size[j]=o.size; this.hue[j]=o.hue+(Math.random()-.5)*24; this.kind[j]=o.kind??0;
    }
  }
  update(dt: number, gravity = 900, drag = 0.88) {
    for (let i = 0; i < this.n; i++) {
      this.vy[i] += gravity * dt;
      this.vx[i] *= Math.pow(drag, dt * 60); this.vy[i] *= Math.pow(drag, dt * 60);
      this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt;
      if ((this.life[i] -= dt) <= 0) { this.swapRemove(i--); }    // O(1) compaction
    }
  }
}
```

```ts
/** Trauma-based screen shake (Eiserloh): shake = trauma², decays linearly. */
export class Shake {
  private trauma = 0;
  add(amount: number) { this.trauma = Math.min(this.trauma + amount, 1); }
  update(dt: number) { this.trauma = Math.max(this.trauma - dt * 1.6, 0); }
  apply(ctx: CanvasRenderingContext2D, t: number, maxPx = 28, maxRotDeg = 2.2) {
    if (this.trauma <= 0) return;
    const s = this.trauma * this.trauma;
    const n = (seed: number) => Math.sin(t * 37.1 + seed) * Math.sin(t * 13.7 + seed * 2.3);
    ctx.translate(n(0) * maxPx * s, n(9) * maxPx * s);
    ctx.rotate(n(17) * (maxRotDeg * Math.PI / 180) * s);
  }
}
```
`add()` amounts: UI tap 0.05, score 0.12, big combo 0.3, fail 0.45, boss hit 0.7. **Clamp total translation to 28 px and gate the whole thing behind reduced-motion** — camera shake is a nausea trigger and these kids are already moving.

Sprite-free juice toolkit (all procedural, all shared):
- `squash(scaleX, scaleY)` driven by `easeOutBack` — the single highest-value effect; apply to every spawned/scored object.
- `pop(t)` = `1 + 0.35 * Math.sin(Math.min(t/0.18,1)*Math.PI) ` scale punch on score.
- Hit flash: `ctx.globalCompositeOperation='lighter'` white overlay at `alpha = 0.6 * (1-t/0.08)`.
- Hitstop: `loop.hitstop(0.06)` on impacts — 60 ms of near-frozen time reads as weight.
- Trail: ring buffer of 8 past positions, drawn with decreasing alpha + width.
- Fake chromatic: draw the same path 3× offset ±2 px in `#FF3B6B` / `#2FD6FF` / `#fff` at low alpha only during a combo.
- Rubber-band number counter: `displayed += (target - displayed) * (1 - Math.pow(0.001, dt))`.
- Shape-only visuals: rounded rects, circles, 5-point stars (`starPath(cx,cy,r,spikes)`), chevrons, 2-px dark outline on everything (gives the "sticker" look and solves contrast).

### 3.7 Countdown / HUD overlay (engine-owned, never per-game)

One DOM overlay above the canvas (DOM, not canvas: free Korean text shaping, free `aria-live`, free font loading):
- `pre` state: game name + `howToKo` lines + animated gesture demo + "준비됐어요!" / auto-advance after 4 s
- `3 · 2 · 1 · 시작!` with `ease-out-back` scale pop, one beep per tick on the audio clock (not `setTimeout`), `aria-live="assertive"`
- in-game: time ring (SVG `stroke-dashoffset`), per-player score chips in slot colours, combo counter, goal text line, "카메라 켜짐" indicator
- last 5 s: ring turns `--c-danger`, tick SFX accelerates, 1.02× pulse
- `post`: stars fly in with 160 ms stagger + `ease-out-back`, score counts up over 700 ms, `highlightsKo`, then `다시 하기 / 다음 게임 / 그만하기`

```ts
export function stars(normalized: number, cuts: [number,number,number]): 0|1|2|3 {
  return (normalized >= cuts[2] ? 3 : normalized >= cuts[1] ? 2 : normalized >= cuts[0] ? 1 : 0);
}
```
Default `starCuts: [0.35, 0.6, 0.85]`. Kid-UX rule: **floor at 1 star whenever the kid did anything at all** (`rawScore > 0`), and never show a 0 of 3 without an encouraging line. Ship a session-level "파티 결과" screen aggregating stars, with a per-player MVP badge and a silly title ("점프 대장", "손박수 장인").

### 3.8 Sound manager

```ts
class AudioService {
  ctx = new AudioContext({ latencyHint: 'interactive' });
  private buses = {
    master: this.ctx.createGain(), sfx: this.ctx.createGain(),
    music: this.ctx.createGain(), voice: this.ctx.createGain(),
  };
  private buffers = new Map<string, AudioBuffer>();
  private lastPlay = new Map<string, number>();   // per-id polyphony throttle

  async unlock() { if (this.ctx.state !== 'running') await this.ctx.resume(); }  // on first pointerdown

  play(id: string, o: { bus?: 'sfx'|'voice'|'music'; gain?: number;
                        rate?: number; at?: number; detune?: boolean } = {}) {
    const b = this.buffers.get(id); if (!b) return;
    const now = this.ctx.currentTime, when = o.at ?? now;
    if (when - (this.lastPlay.get(id) ?? -1) < 0.035) return;   // de-machine-gun
    this.lastPlay.set(id, when);
    const src = this.ctx.createBufferSource(); src.buffer = b;
    src.playbackRate.value = (o.rate ?? 1) * (o.detune === false ? 1 : 0.94 + Math.random() * 0.12);
    const g = this.ctx.createGain(); g.gain.value = o.gain ?? 1;
    src.connect(g).connect(this.buses[o.bus ?? 'sfx']); src.start(when);
  }
  duckForVoice(ms = 900) {   // music dips while a Korean prompt plays
    const t = this.ctx.currentTime, g = this.buses.music.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0.25, t, 0.05); g.setTargetAtTime(1, t + ms/1000, 0.12);
  }
}
```

---

## 4) Audio

### 4.1 Beat-accurate scheduling — the two-clocks lookahead pattern

Non-negotiable rule: **`setTimeout` schedules nothing audible; it only decides what to hand to the audio clock.** A `setTimeout` metronome drifts because the JS timer and the audio clock are two different clocks, and the main thread is blocked by your render loop. The fix (Chris Wilson, *A Tale of Two Clocks*, 2013) is a self-rescheduling timer that wakes every ~25 ms and queues every event due within the next ~100 ms via `source.start(exactTime)`. ([web.dev/articles/audio-scheduling](https://web.dev/articles/audio-scheduling), [Ableton/web-audio-sequencing](https://github.com/Ableton/web-audio-sequencing/blob/main/README.md))

```ts
// src/engine/audio/scheduler.ts
export class BeatScheduler {
  private next = 0;          // audio-clock time of the next beat
  private beat = 0;
  private timer: number | null = null;
  readonly lookaheadMs = 25;
  readonly scheduleAheadSec = 0.12;

  constructor(private ctx: AudioContext, public bpm = 110,
              private onBeat: (beat: number, time: number) => void) {}

  start(atSec = this.ctx.currentTime + 0.1) {
    this.next = atSec; this.beat = 0;
    const tick = () => {
      while (this.next < this.ctx.currentTime + this.scheduleAheadSec) {
        this.onBeat(this.beat, this.next);          // -> audio.play(id, { at: time })
        this.queue.push({ beat: this.beat, time: this.next });
        this.next += 60 / this.bpm; this.beat++;
      }
      this.timer = setTimeout(tick, this.lookaheadMs) as unknown as number;
    };
    tick();
  }
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; this.queue.length = 0; }

  /** Visuals: ask the AUDIO clock where we are, every rAF. Never count frames. */
  queue: { beat: number; time: number }[] = [];
  beatPosition(nowAudio = this.ctx.currentTime) {
    return (nowAudio - this.startTime) * this.bpm / 60;   // fractional beats
  }
  /** Judging a player's hit. Compensate for output latency. */
  judge(inputPerfNowMs: number, calibrationMs = 0) {
    const t = this.ctx.currentTime
            - (this.ctx.outputLatency || this.ctx.baseLatency || 0)
            + calibrationMs / 1000;
    const b = this.beatPosition(t);
    const err = (b - Math.round(b)) * 60 / this.bpm * 1000;   // ms, signed
    const a = Math.abs(err);
    return { err, grade: a < 60 ? 'perfect' : a < 120 ? 'great' : a < 200 ? 'good' : 'miss' };
  }
  private startTime = 0;
}
```
Kid-calibrated hit windows: **perfect ±60 ms, great ±120 ms, good ±200 ms.** Adult rhythm games use ±30/±60; 7-year-olds plus ~40 ms of pose-inference latency plus Bluetooth speaker latency will miss everything at those windows. Subtract the pose pipeline's measured latency (`inferenceAgeMs` + filter group delay, typically 50–90 ms) from motion-triggered judgements — this is the single biggest "feels broken" bug in webcam rhythm games. Offer an A/V calibration screen (clap along 8 beats, take the median offset) and a ±150 ms slider; default 0.

**Library verdict: raw Web Audio + the ~60-line scheduler above.** `howler@2.2.4` is a great *playback* library but it does not expose sample-accurate scheduling, so it cannot do rhythm. `tone@15.1.22` has a correct `Transport` but costs ~200 KB and introduces a second clock/time abstraction your games would have to learn. Use raw Web Audio; add Tone only if you later want synthesis.

Also: for music loops, use **two alternating `AudioBufferSourceNode`s scheduled back-to-back on the audio clock** (`loop = true` plus `loopStart/loopEnd` works, but cross-scheduling lets you do seamless intensity layers), and pre-`decodeAudioData` everything during the priming screen. Never `new Audio()` for gameplay.

### 4.2 Free, license-clean kid-friendly audio

Ranked by "least legal homework":

| source | license | notes |
|---|---|---|
| **kenney.nl/assets** (audio packs: UI, Impact, Digital, Interface, Casino, RPG) | **CC0** | ~40k assets, one person, no sign-up, **no attribution required**. Start here; it covers 80% of your UI/SFX needs and already sounds "kid game." |
| **Pixabay** (/sound-effects, /music) | Pixabay Content License | No attribution required, commercial OK. **Not literally CC0** — forbids redistributing files standalone and reselling unaltered copies. Fine for a game; don't ship an "assets download." |
| **Freesound.org** | **per file**: CC0 / CC-BY 4.0 / CC-BY-NC / legacy Sampling+ | 600k+ sounds, filter by licence *before* downloading. **Reject CC-BY-NC** (ads/sponsorship/school licensing later would breach it) and legacy Sampling+. Record author + URL + licence per file. |
| **OpenGameArt.org** | **per file**: CC0 / CC-BY / CC-BY-SA / GPL | Filter by licence up front. **Avoid CC-BY-SA and GPL audio** — share-alike can be argued to reach the bundled work. CC0 and CC-BY only. |
| **Mixkit** (Envato) | Mixkit free licence | No attribution, but it's a bespoke licence: no redistribution, no use in a standalone audio product, Envato can revoke. Acceptable, not ideal. |
| **incompetech.com** (Kevin MacLeod) | **CC-BY 4.0** (paid no-attribution option) | Huge library of exactly the right bouncy/playful tone. Attribution in a visible credits screen is mandatory on the free licence. |
| **Sonniss GDC Game Audio Bundle** (yearly, free) | royalty-free, commercial OK | Hundreds of GB of pro SFX; great for impacts/whooshes. Heavy download, needs editing. |
| **ZapSplat** | free with attribution (paid removes it) | Good coverage; attribution required. |
| **itch.io CC0 asset packs** | per pack | Lots of kid-friendly chiptune loops. Check each pack's page. |

Avoid: Fesliyan (restrictive terms), YouTube Audio Library (terms tied to YouTube), anything where the page doesn't state a licence.

**The critical operational caveat:** licences on Freesound and OpenGameArt are **per-file, not per-site**. Treat it as a build artifact, not a vibe:

```
public/audio/<bus>/<id>.webm        (+ .m4a fallback for older Safari)
assets/AUDIO_LICENSES.json          # { id, file, source, url, author, license, modified }
public/credits.html                 # generated from the JSON, linked from the footer
```
CI test: every file under `public/audio/` has an entry; every entry has a `license` in an allowlist (`CC0`, `CC-BY-4.0`, `Pixabay`, `Kenney-CC0`); fail the build otherwise. That one test is what keeps 40 parallel agents from importing a CC-BY-NC sound.

Encoding: Opus-in-WebM at 64–96 kbps mono for SFX (tiny, fast decode), 128 kbps stereo for music; ship `.m4a` (AAC) alongside for Safari ≤ 14 if you care. Keep total audio under ~4 MB; lazy-load music per game.

### 4.3 Korean TTS — `speechSynthesis` verdict: **fallback only, pre-record the real thing**

Reality check on ko-KR:
- **Chrome desktop/Android**: "Google 한국의" (ko-KR) exists but is **network-backed** on desktop — offline or flaky school Wi-Fi gives you silence. Voice list loads **asynchronously**; you must wait for `voiceschanged` before `getVoices()` returns anything (the "set `utterance.voice`" code that works in Firefox/Safari silently does nothing in Chrome if run too early).
- **Safari macOS/iOS**: "Yuna" (ko-KR), on-device, reliable, but the first utterance requires a user gesture and `cancel()`/navigation kills queued speech.
- **Edge**: Microsoft SunHi/InJoon (ko-KR), good quality, network-backed.
- **Firefox**: depends on the OS speech stack (`speech-dispatcher` on Linux) — frequently **zero Korean voices**.
- Everywhere: no way to schedule an utterance on the audio clock, no duration known in advance, 100–600 ms variable start latency, pitch/rate differ per engine, and it does not route through your `AudioContext` so you cannot duck music against it or apply your volume slider.

([browser support matrix](https://www.testmuai.com/learning-hub/speech-synthesis-api-browser-support/), [known pitfalls](https://talkrapp.com/speechSynthesis.html), [deep dive](https://blog.addpipe.com/a-deep-dive-into-the-web-speech-api/))

**Therefore: pre-record.** Your prompt set is small and fixed — roughly 150–250 short lines ("준비!", "시작!", "점프!", "손 들어요!", "따라 해 봐요!", "좋아요!", "조금만 더!", "최고예요!", 40 game names, 3-2-1, star fanfares). Pre-rendered files give you: beat-schedulable via Web Audio, identical on every browser, works offline, duckable, volume-controllable, and consistent character. Generate once with a cloud TTS (Google/Azure/ElevenLabs Korean neural voices — **check the provider's terms for redistributing synthesized audio as static assets**; Google Cloud TTS and Azure both permit it on paid tiers) or record a real Korean voice actor for ~2 hours, which will sound dramatically better to kids.

Keep `speechSynthesis` behind a tiny wrapper used **only** for dynamic strings (nicknames: "민준이 차례!"), with feature detection, a `ko` voice-exists check, and silent no-op fallback to a generic pre-recorded line. Never let a voice line be the only channel for required information — always mirror it as on-screen Korean text (§7).

```ts
export const tts = {
  ready: new Promise<SpeechSynthesisVoice | null>(res => {
    if (!('speechSynthesis' in window)) return res(null);
    const pick = () => speechSynthesis.getVoices().find(v => v.lang.startsWith('ko')) ?? null;
    const v = pick(); if (v) return res(v);
    speechSynthesis.addEventListener('voiceschanged', () => res(pick()), { once: true });
    setTimeout(() => res(pick()), 1500);
  }),
  async say(text: string) {
    const v = await this.ready; if (!v) return false;
    const u = new SpeechSynthesisUtterance(text);
    u.voice = v; u.lang = 'ko-KR'; u.rate = 1.0; u.pitch = 1.1;
    speechSynthesis.cancel(); speechSynthesis.speak(u); return true;
  },
};
```

---

## 5) Roulette / lobby selector

### The three-step rule
1. **Decide the winner first**, before any animation. Weighted/unbiased pick with `crypto.getRandomValues` + **rejection sampling** (avoid modulo bias), then wrap it in a **shuffle bag** so nothing repeats until the bag empties. The animation is *purely cosmetic* and cannot disagree with the result.
2. **Compute the exact target rotation** from the winner index.
3. **Animate one easing curve** to that rotation.

([picking fairly: modulo bias / rejection sampling / shuffle bag](https://dev.to/bestspinnerwheel/picking-a-winner-fairly-in-a-browser-spin-wheel-modulo-bias-rejection-sampling-and-a-shuffle-bag-4aik), [Winwheel.js for reference](https://github.com/TheLarkInn/javascript-winwheel))

### Rotation math (pointer at 12 o'clock, canvas angles clockwise from +x)

```ts
const TAU = Math.PI * 2;
const POINTER = -Math.PI / 2;                 // 12 o'clock in canvas angle space

/** Rotation (radians, monotonically increasing) that parks slice `i` under the pointer. */
function targetRotation(i: number, n: number, current: number, spins = 6, rng = Math.random) {
  const slice = TAU / n;
  const centre = i * slice + slice / 2;       // slice centre at rotation 0
  const jitter = (rng() - 0.5) * slice * 0.62; // organic, still safely inside the slice
  const base = ((POINTER - centre - jitter) % TAU + TAU) % TAU;   // 0..TAU
  // always spin FORWARD from wherever we are now
  const k = Math.ceil((current - base) / TAU) + spins;
  return base + k * TAU;
}

// Dev-only inverse assertion: the visual MUST match the chosen index.
function sliceUnderPointer(rotation: number, n: number) {
  const slice = TAU / n;
  return Math.floor((((POINTER - rotation) % TAU + TAU) % TAU) / slice);
}
console.assert(sliceUnderPointer(targetRotation(i, n, cur), n) === i);
```

### Easing + suspense

```ts
const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);
const easeOutBack  = (t: number, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);

/** Spin-up -> cruise -> long decelerate -> micro-overshoot settle. */
function spinCurve(t: number) {
  if (t < 0.10) return 0.055 * (t / 0.10) * (t / 0.10);              // ease-in launch
  if (t < 0.62) { const u = (t - 0.10) / 0.52; return 0.055 + 0.60 * u; }  // near-linear cruise
  const u = (t - 0.62) / 0.38;
  return 0.655 + 0.345 * easeOutQuint(u);                            // the suspense
}
```
Duration **3.4 s** (not 6 — kids). Spins ≥ 6 so the launch reads as fast. Then:

- **Tick SFX on boundary crossings**: between frames, count how many slice boundaries `rotation` passed and play one tick per crossing (cap 4 per frame, pitch rising with `1/dt`). This is what produces the slot-machine feeling; it's ~8 lines and it is the whole effect.
  ```ts
  const b0 = Math.floor(prevRot / slice), b1 = Math.floor(rot / slice);
  for (let k = b0 + 1, c = 0; k <= b1 && c < 4; k++, c++)
    audio.play('tick', { rate: 0.9 + Math.min(speed / 40, 0.5) });
  ```
- **Near-miss**: with ~25% probability, pick `jitter` so the wheel decelerates *through* a boundary in the last 300 ms, landing just past it. Kids gasp.
- **Settle**: after the main curve, a 170 ms `easeOutBack` of `+0.22 * slice` then back — a physical pawn bounce.
- **Zoom/vignette** in the last 500 ms: scale 1.0 → 1.06, darken everything but the pointer; drum-roll loop ducked out on landing; confetti + the game's `nameKo` slamming in with `easeOutBack`.

### Canvas vs CSS — use **CSS for the lobby wheel**
```css
.wheel { transform: rotate(var(--rot)); transition: transform 3400ms cubic-bezier(.12,.76,.06,1); }
```
Reasons: GPU-composited, zero main-thread cost (your pose pipeline may already be warming up), crisp DOM Korean text in each slice (no canvas text shaping), each slice is a real focusable element for keyboard users, and screen readers can read the list. Keep a monotonically increasing `--rot` (never reset to 0) so it always spins forward, and read the result on `transitionend` (with a `setTimeout` safety net — `transitionend` does not fire if the tab is hidden). Only go to canvas if you need per-slice artwork or >16 slices; with 40 games, don't put all 40 on the wheel — **shortlist 8** (filtered by player count/space/intensity, shuffled) and spin those. A 40-slice wheel is illegible and the "I didn't want that one" rate goes up.

**Slot-machine alternative** (good for choosing 3 things at once: game + modifier + team): three columns of `translateY`, each a CSS transition with staggered durations (2.2 s / 2.6 s / 3.0 s) and `cubic-bezier(.1,.8,.1,1)`; duplicate the item list 8× vertically so it looks infinite, land on the copy nearest the target.

**Reduced motion**: skip the spin entirely — 450 ms crossfade to the result card, one chime, `aria-live="polite"` announcement. Same for the "건너뛰기" button (kids will mash it; always allow skipping to the result).

---

## 6) Visual design direction + full token set

### Reference reads
- **Duolingo** — one saturated brand green `#58CC02`, chunky display weight, and a **4 px solid bottom shadow on every interactive element** so it reads as a 3 D button waiting to be pressed; pill/chunky radii, thick borders, display sizes starting ~48 px. The point: it's *bright and confident*, not pastel and not infantilized. ([nexu-io/open-design Duolingo DESIGN.md](https://github.com/nexu-io/open-design/blob/main/design-systems/duolingo/DESIGN.md), [dembrandt token extract](https://www.dembrandt.com/explorer/duolingo))
- **Kahoot** — the 4-answer system pairs **colour with shape** (red triangle / blue diamond / yellow circle / green square): redundancy that doubles as colour-blind accessibility and as a shouted instruction ("빨간 세모!"). Dark neutral chrome lets the four colours scream. Steal this exactly for player slots and for choice prompts.
- **Nintendo (Switch home / Mario Party)** — near-neutral chrome, colour reserved for content; enormous focus states; a distinct sound for every navigation event; and *every* state change is animated, never cut.
- **Toss (TDS)** — restraint: one blue, near-neutral surfaces, obsessive 8 pt spacing consistency, motion used as feedback (confirming a tap) rather than decoration. This is the discipline that keeps a 40-game site from looking like a flea market.

Synthesis for your site: **neutral-cool surfaces + saturated colour only on (a) the primary action and (b) rewards + enormous type + chunky pressable depth + feedback inside 100 ms + celebrate everything.** Each game gets *one* hue (`manifest.theme.hue`) that tints its card and in-game accents — that's how 40 games feel distinct without 40 palettes.

### Color tokens

```css
/* ---------- brand / semantic (hue-stable across modes) ---------- */
:root {
  /* primary — electric blue: actions, focus, progress */
  --c-primary-50:  #EEF2FF;  --c-primary-100: #DCE4FF; --c-primary-200: #BDCCFF;
  --c-primary-300: #93AAFF;  --c-primary-400: #6B8AFF; --c-primary-500: #4C6FFF;
  --c-primary-600: #2F4FE0;  --c-primary-700: #243CB0; --c-primary-800: #1B2C80;

  /* secondary — violet: special rounds, boss games, premium-ish moments */
  --c-secondary-100:#F3E9FF; --c-secondary-400:#B983FF; --c-secondary-500:#A259FF;
  --c-secondary-600:#8433E6;

  /* accent — amber: stars, rewards, XP. Use SPARINGLY (<5% of pixels) */
  --c-accent-100:#FFF3D6; --c-accent-400:#FFC53D; --c-accent-500:#FFB300; --c-accent-600:#E09400;

  /* accent-2 — hot pink: combos, highlights, "지금!" cues */
  --c-accent2-100:#FFE4EE; --c-accent2-400:#FF6FA3; --c-accent2-500:#FF4D8D; --c-accent2-600:#E02C6E;

  /* semantic */
  --c-success-100:#DEF9EE; --c-success-500:#16C47F; --c-success-600:#0FA668;
  --c-warn-100:#FFF1DB;    --c-warn-500:#FF9F1C;    --c-warn-600:#E0820A;
  --c-danger-100:#FFE5E5;  --c-danger-500:#FF4D4D;  --c-danger-600:#E02B2B;
  --c-info-500:#19B5FE;

  /* player slots — hue + shape + number, never hue alone (Kahoot rule) */
  --c-p1:#2FA8FF; --c-p2:#FF7A45; --c-p3:#39D98A; --c-p4:#C77DFF;
  --c-p-outline:#0B0F20;   /* 3px outline on every player-coloured element */
}

/* ---------- light (default) ---------- */
:root {
  --c-canvas:        #F5F7FD;   /* page background */
  --c-surface:       #FFFFFF;   /* cards */
  --c-surface-2:     #EDF0F9;   /* nested / inactive */
  --c-surface-3:     #E2E7F4;   /* track, inset */
  --c-game-bg:       #101733;   /* the GAME canvas stays dark in both modes */
  --c-border:        #D5DBEA;
  --c-border-strong: #AEB8D0;
  --c-text:          #131A33;   /* 16.1:1 on surface */
  --c-text-2:        #4A5678;   /*  7.4:1 */
  --c-text-3:        #7A86A8;   /*  3.9:1 — decorative/large only */
  --c-on-primary:    #FFFFFF;
  --c-on-accent:     #3A2600;   /* amber needs DARK text, never white */
  --c-link:          var(--c-primary-600);  /* 6.2:1 — never -500 for text */
  --c-overlay:       rgb(13 18 38 / .56);
  --c-focus:         #FFB300;   /* amber ring reads on both blue and white */
}

/* ---------- dark ---------- */
:root[data-theme="dark"] {
  --c-canvas:        #0B0F20;
  --c-surface:       #151B33;
  --c-surface-2:     #1E2641;
  --c-surface-3:     #28314F;
  --c-game-bg:       #080C1A;
  --c-border:        #333D5E;
  --c-border-strong: #4A5679;
  --c-text:          #F2F5FF;   /* 15.8:1 on surface */
  --c-text-2:        #B7C0DC;   /*  8.9:1 */
  --c-text-3:        #8390B2;   /*  4.6:1 */
  --c-on-primary:    #0B0F20;
  --c-on-accent:     #2A1B00;
  --c-link:          var(--c-primary-300);
  --c-overlay:       rgb(4 6 14 / .68);
  --c-focus:         #FFC53D;

  /* lift brand lightness, trim saturation a touch so it doesn't bloom on OLED */
  --c-primary-500:#6B8AFF; --c-primary-600:#8FA6FF; --c-primary-50:#1B2550;
  --c-secondary-500:#B983FF; --c-accent-500:#FFC53D; --c-accent2-500:#FF6FA3;
  --c-success-500:#2EE39B; --c-warn-500:#FFB454; --c-danger-500:#FF6B6B;
}
```

Contrast rules to write into the engine's CSS review checklist:
- `--c-primary-500` on white is ~4.0:1 → **fill only, with white text** (white on `#4C6FFF` ≈ 4.3:1, which passes AA for ≥24 px bold — which is all your text anyway). For blue *text* on light surfaces, use `--c-primary-600`.
- `--c-accent-500` (amber) **never** carries white text. `--c-on-accent` is dark brown.
- Every player-coloured element gets a 3 px `--c-p-outline` stroke + a slot number + a shape badge (▲ ◆ ● ■). Hue is never the only cue.
- The in-game canvas is **dark in both themes** (`--c-game-bg`) so particles, glows and skeleton overlays read consistently and so the camera preview doesn't blow out the UI.

### Typography

**Primary: Pretendard Variable 1.3.9** — SIL **OFL-1.1** ("글꼴 단독 판매를 제외한 모든 상업적 행위 및 수정, 재배포 가능"), a `system-ui` replacement with excellent Hangul + Latin harmony and 9 weights in one variable file.
```
https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css
https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css
```
**Self-host it** (`npm i pretendard@1.3.9`, copy `dist/web/variable/*` into `public/fonts/`, rewrite the `@font-face` URLs). The dynamic-subset build splits into `unicode-range` chunks so you only download the Hangul blocks actually used — but CDN-loading breaks your `connect-src 'self'`/no-third-party privacy claim (§7) and adds a cross-origin dependency on a school network. ([orioncactus/pretendard](https://github.com/orioncactus/pretendard))

**Display (game titles, scores, countdown): Gmarket Sans Bold** — OFL, chunky and playful, exactly the register you want for big numbers.
```
https://cdn.jsdelivr.net/gh/leetaewook/gmarket-sans-dynamic-subset/GmarketSans.css
```
Caveat: that's a community-maintained GitHub-backed dynamic subset — **mirror the woff2 files locally**. ([leetaewook/gmarket-sans-dynamic-subset](https://github.com/leetaewook/gmarket-sans-dynamic-subset))

Alternates, all free for commercial web embedding: **Cafe24 Ssurround / Ssurround Air** (OFL-style, very round and kid-friendly — strongest "초등학교" character), **Noto Sans KR** via Google Fonts `https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400..900&display=swap` (OFL; safe, characterless, good last resort), **BMJUA / 배달의민족 주아** (very playful; licence allows web use but **forbids modification/resale of the font file** — read 우아한형제들's terms, and it has no Latin to speak of). General caveat for Korean free fonts: many permit embedding but prohibit modifying/redistributing the font *file*; OFL ones (Pretendard, Gmarket, Noto, Cafe24) are the safe set. Always keep a copy of the licence text in `public/fonts/LICENSE-*.txt`.

```css
:root {
  --font-ui: "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont,
             system-ui, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif;
  --font-display: "GmarketSansBold", var(--font-ui);
  --font-num: var(--font-display);
}
body { font-family: var(--font-ui); word-break: keep-all; overflow-wrap: anywhere; }
.score, .timer { font-family: var(--font-num); font-feature-settings: "tnum" 1; font-variant-numeric: tabular-nums; }
```
Two Korean-specific rules that matter more than the font choice: **`word-break: keep-all`** (the default `break-word` splits 어절 mid-word and looks broken in Korean) with `overflow-wrap: anywhere` as the escape hatch, and **line-height ≥ 1.5** for Korean body text (Hangul needs more leading than Latin). For large display Korean, tighten `letter-spacing: -0.02em`. And `tabular-nums` on every counter so scores don't jitter as digits change.

### Type scale — 10-foot UI at ~2 m

TV/10-foot guidance: nothing below ~22 px, body text 34–36 px at 1080p, multiply mobile sizes by 2.5–3×, and **never thin weights** (100–300) at body size — thin strokes vanish at distance. ([Opera TV / tvOS summaries](https://uiuxatlas.com/lessons/responsive/tv-and-10-foot-ui-design/), [Adobe 10-foot UI](https://blogs.adobe.com/creativecloud/designing-user-experiences-for-the-10-foot-ui/))

Scale the root to the viewport so one scale serves a 13" laptop at 0.6 m and a living-room TV at 3 m:
```css
html { font-size: clamp(16px, 0.55vw + 0.45vh + 9px, 28px); }
```

| token | size | line | weight | tracking | use |
|---|---|---|---|---|---|
| `--fs-display-1` | `6rem` (96 px @16) | 1.02 | 800 | -.03em | 카운트다운 "3", 게임 이름 slam-in |
| `--fs-display-2` | `4.5rem` (72) | 1.06 | 800 | -.025em | 결과 점수, 룰렛 결과 |
| `--fs-title-1` | `3.5rem` (56) | 1.14 | 700 | -.02em | 화면 제목 |
| `--fs-title-2` | `2.75rem` (44) | 1.2 | 700 | -.02em | 카드 제목, 게임 이름 |
| `--fs-heading` | `2.125rem` (34) | 1.3 | 700 | -.01em | **2 m readability floor** |
| `--fs-body-lg` | `1.75rem` (28) | 1.5 | 500 | 0 | **default body on game screens** |
| `--fs-body` | `1.5rem` (24) | 1.55 | 500 | 0 | 설명문, 리스트 |
| `--fs-label` | `1.25rem` (20) | 1.4 | 600 | .01em | 버튼, 칩, 탭 |
| `--fs-caption` | `1.125rem` (18) | 1.45 | 500 | .01em | 보조 설명 (setup screens only) |
| `--fs-legal` | `1rem` (16) | 1.6 | 400 | 0 | 개인정보 안내 본문 (read up close) |

Hard rule: **on any screen a kid reads while standing 2 m away, minimum is 24 px (`--fs-body`)**, instruction text is 28 px, and anything a kid must react to is ≥ 34 px / weight 700. 16–18 px is permitted only on the setup/privacy screens.

### Spacing, radius, shadow, size

```css
:root {
  /* 4px base; 8pt rhythm above 16 */
  --sp-0:0; --sp-1:4px; --sp-2:8px; --sp-3:12px; --sp-4:16px; --sp-5:24px;
  --sp-6:32px; --sp-7:40px; --sp-8:48px; --sp-9:64px; --sp-10:80px; --sp-11:120px;

  --r-xs:8px; --r-sm:12px; --r-md:16px; --r-lg:24px; --r-xl:32px; --r-2xl:40px; --r-pill:999px;
  --r-button: var(--r-lg);     /* kid UI leans BIG radius */
  --r-card:   var(--r-xl);

  --bw-1:2px;  --bw-2:3px;  --bw-focus:4px;

  /* touch targets: 44px is the adult minimum; kids need more */
  --hit-min:56px; --hit-primary:72px; --hit-huge:96px;  /* huge = lobby game cards */

  --sh-1: 0 1px 2px rgb(17 24 51 / .06), 0 1px 3px rgb(17 24 51 / .10);
  --sh-2: 0 2px 4px rgb(17 24 51 / .06), 0 4px 10px rgb(17 24 51 / .09);
  --sh-3: 0 4px 8px rgb(17 24 51 / .08), 0 12px 24px rgb(17 24 51 / .12);
  --sh-4: 0 8px 16px rgb(17 24 51 / .10), 0 24px 48px rgb(17 24 51 / .18);
  --sh-focus: 0 0 0 var(--bw-focus) var(--c-focus), 0 0 0 8px rgb(255 179 0 / .28);
  --sh-glow-primary: 0 0 24px rgb(76 111 255 / .45);

  /* the Duolingo trick: solid-colour bottom shadow = pressable 3D slab */
  --press-depth: 6px;
}
:root[data-theme="dark"] {
  --sh-1: 0 1px 2px rgb(0 0 0 / .4), inset 0 1px 0 rgb(255 255 255 / .05);
  --sh-2: 0 4px 10px rgb(0 0 0 / .45), inset 0 1px 0 rgb(255 255 255 / .06);
  --sh-3: 0 12px 24px rgb(0 0 0 / .5),  inset 0 1px 0 rgb(255 255 255 / .07);
  --sh-4: 0 24px 48px rgb(0 0 0 / .6),  inset 0 1px 0 rgb(255 255 255 / .08);
}

.btn {
  min-height: var(--hit-primary); padding: 0 var(--sp-6);
  font: 600 var(--fs-label)/1 var(--font-ui);
  border-radius: var(--r-button);
  border: var(--bw-1) solid rgb(0 0 0 / .10);
  background: var(--c-primary-500); color: var(--c-on-primary);
  box-shadow: 0 var(--press-depth) 0 var(--c-primary-600), var(--sh-2);
  transition: transform var(--dur-fast) var(--ease-out-quint),
              box-shadow var(--dur-fast) var(--ease-out-quint);
}
.btn:active { transform: translateY(var(--press-depth));
              box-shadow: 0 0 0 var(--c-primary-600), var(--sh-1); }
.btn:focus-visible { outline: none; box-shadow: 0 var(--press-depth) 0 var(--c-primary-600), var(--sh-focus); }
```
That `:active { translateY }` + solid bottom shadow is ~6 lines and delivers most of the "kid game UI feels good" sensation. Pair it with a 40 ms click SFX and you're done.

### Motion tokens

```css
:root {
  --dur-instant:80ms; --dur-fast:140ms; --dur-base:220ms;
  --dur-slow:360ms; --dur-slower:560ms; --dur-celebrate:900ms;
  --dur-wheel:3400ms;

  --ease-out-quint: cubic-bezier(.22,1,.36,1);     /* default exit */
  --ease-out-back:  cubic-bezier(.34,1.56,.64,1);  /* pop-in: buttons, stars, badges */
  --ease-in-out:    cubic-bezier(.4,0,.2,1);       /* moves between two states */
  --ease-in-quint:  cubic-bezier(.64,0,.78,0);     /* exits off-screen */
  --ease-spring:    cubic-bezier(.16,1.1,.3,1);
  --ease-wheel:     cubic-bezier(.12,.76,.06,1);   /* roulette */
  --stagger: 60ms;                                  /* list items, max 8 */
}
@media (prefers-reduced-motion: reduce) {
  :root { --dur-instant:1ms; --dur-fast:1ms; --dur-base:1ms; --dur-slow:1ms;
          --dur-slower:1ms; --dur-celebrate:120ms; --dur-wheel:450ms;
          --ease-out-back: linear; --press-depth: 0px; }
  *, *::before, *::after { animation-duration:1ms !important; animation-iteration-count:1 !important;
                           transition-duration:1ms !important; scroll-behavior:auto !important; }
}
```
Rules: feedback within `--dur-fast`; never animate a kid's *wait* longer than `--dur-slower`; `--ease-out-back` only on things that should feel alive (never on panels); everything that enters does so with scale 0.86→1 + opacity, nothing cuts.

---

## 7) Accessibility + privacy copy

### 7.1 Permission priming screen

Never call `getUserMedia` on load — you *can't* (it needs a user gesture), and users who don't understand the context block or ignore the prompt. Pre-permission overlays that explain the "why" push grant rates near 100%. Explain the **benefit**, not the feature, and always provide a route to an alternative so the page never looks frozen. ([web.dev media recording](https://web.dev/articles/media-recording-video), [permission priming](https://www.dogtownmedia.com/the-ask-when-and-how-to-request-mobile-app-permissions-camera-location-contacts/))

Screen 1 — 아이용 (big type, `--fs-title-1` heading, `--fs-body-lg` body):

> ## 카메라를 켜면 몸으로 게임할 수 있어요! 🕺
> - 🔒 **카메라 화면은 이 컴퓨터 안에서만 봐요.** 인터넷으로 보내지 않아요.
> - 🚫 **녹화하지 않아요.** 사진도, 영상도 남지 않아요.
> - 🦴 게임이 보는 건 **몸의 관절 위치(점과 선)** 뿐이에요.
> - 🎹 **카메라 없이 키보드로도** 놀 수 있어요!
>
> `[ 🎥 카메라 켜고 시작하기 ]`  `[ ⌨️ 카메라 없이 하기 ]`
> `보호자님께 안내 ▸`

Screen 1b — the pre-prompt nudge, shown for ~1.2 s before `getUserMedia()` fires:
> 잠시 후 브라우저가 **"카메라를 사용하도록 허용하시겠습니까?"** 라고 물어봐요.
> **[허용]** 을 눌러 주세요! 👆

Denied / error state (never a dead end):
> ## 카메라를 못 찾았어요 😅
> 괜찮아요! **키보드로도 똑같이 재미있게** 할 수 있어요.
> `[ ⌨️ 키보드로 놀기 ]`  `[ 🔄 다시 시도하기 ]`  `카메라 허용 방법 보기 ▸`
> (브라우저 주소창 왼쪽 🎥 아이콘 → '허용' → 새로고침)

Handle `navigator.permissions.query({name:'camera'})` up front to skip priming when already granted, and `NotAllowedError` / `NotFoundError` / `NotReadableError` (another app has the camera) with distinct copy.

While the camera is live: a persistent, always-visible indicator — `🔴 카메라 켜짐 · [끄기]` — in a fixed corner, plus `track.stop()` on every exit path (route change, `pagehide`, round end, tab hidden for >60 s).

### 7.2 On-device processing disclosure (Korean, ready to paste)

Footer/settings link `개인정보 안내`:

> ## 개인정보 안내 (아이와 보호자 모두를 위한 안내)
>
> ### 한눈에 보기
> - 이 사이트는 **회원가입이 없습니다.** 이름, 이메일, 전화번호를 묻지 않습니다.
> - 카메라 영상은 **기기 안(브라우저 내부)에서만 처리**되며, **서버로 전송되거나 저장되지 않습니다.**
> - 영상을 **녹화·캡처하지 않으며**, 얼굴을 인식하거나 누구인지 알아내지 않습니다.
> - 게임은 영상에서 **관절 위치 좌표(숫자)** 만 실시간으로 계산해 바로 사용하고 **즉시 버립니다.**
> - 이 모든 계산은 여러분의 기기에서 동작하는 자세 인식 모델(MediaPipe)이 수행합니다. **인터넷 연결이 끊겨도 게임은 동작합니다.**
>
> ### 기기에 남는 정보 (이 브라우저에만 저장)
> | 항목 | 내용 | 저장 위치 | 삭제 방법 |
> |---|---|---|---|
> | 별명 | 결과 화면에 표시할 이름 | 이 브라우저(localStorage) | 설정 → 전체 삭제 |
> | 최고 점수·별 개수 | 게임 기록 | 이 브라우저(localStorage) | 설정 → 전체 삭제 |
> | 화면/소리 설정 | 밝기, 효과 줄이기 등 | 이 브라우저(localStorage) | 설정 → 전체 삭제 |
>
> 위 정보는 **이 브라우저에만 저장되고 외부로 전송되지 않습니다.** 브라우저의 방문 기록 삭제로도 함께 지워집니다.
>
> ### 수집하지 않는 것
> 카메라 영상 · 사진 · 음성 · 얼굴 정보(생체정보) · 위치 · 연락처 · 광고 식별자 — **하나도 수집하지 않습니다.** 외부 광고나 분석 도구(트래커)를 심지 않았습니다.
>
> ### 보호자님께
> 이 사이트는 개인정보를 수집·전송·저장하지 않으므로 별도의 동의 절차가 없습니다. 자녀의 카메라 영상은 네트워크를 통해 전송되지 않으며, 브라우저를 닫으면 즉시 사라집니다. 안전을 위해 **주변에 사람이나 물건이 없는 2m 이상의 공간**에서 놀도록 지도해 주세요.
>
> 문의: (이메일) · 최종 수정일: YYYY-MM-DD

Keep an English mirror. Write it at a 초등 3-4학년 reading level for the kid-facing parts — **PIPA 제22조의2 ③ requires that notices to children under 14 use "이해하기 쉬운 양식과 명확하고 알기 쉬운 언어"**, which applies to your wording even in the no-collection case. ([개인정보 보호법 제22조의2](https://lawplayer.com/kr/article/011357/002202))

### 7.3 Legal posture — COPPA + 개인정보보호법

**COPPA (US, under 13).** COPPA attaches to *collecting, using or disclosing* personal information **online**. The FTC has recognized that where a child's image is **processed locally on the device and not uploaded**, that local processing does not trigger COPPA, because the statute requires the information to be collected/used/stored over the internet. With no accounts, no uploads, no analytics identifiers and no third-party SDKs, you have **no verifiable-parental-consent obligation**. ([DLA Piper on the 2025 amendments](https://www.dlapiper.com/en/insights/publications/2025/01/ftc-finalizes-changes-to-coppa), [Federal Register, Apr 2025](https://www.federalregister.gov/documents/2025/04/22/2025-05904/childrens-online-privacy-protection-rule))

That posture is **fragile by design**. It breaks the instant anyone adds: an online leaderboard with nicknames, screenshot/video sharing, any analytics with a persistent identifier, push notifications, a third-party embed that sets cookies, or ads. The amended Rule also tightened disclosure consent (separate consent to disclose to third parties), added data-retention limits, and **biometric identifiers are now explicitly personal information** — so *never* persist raw frames, face embeddings, or landmark histories, anywhere, even locally. Write this into the engine as a lint rule, not a wiki page.

**개인정보보호법 (Korea).** 제22조의2 requires a 개인정보처리자 to obtain and **verify** the 법정대리인's consent before processing the personal information of a child **under 14**, allows collecting only the minimum information needed to contact the legal guardian directly from the child, and mandates plain, easy-to-understand language when notifying children. If you genuinely process no 개인정보, the consent duty doesn't arise — but practice is:
1. publish the no-collection notice above (it *is* your 개인정보처리방침 equivalent) and date it;
2. keep the design that way (nickname + score in `localStorage` only, zero network transmission);
3. avoid **민감정보** entirely — 얼굴·생체인식정보 is sensitive, so **use pose landmarks only, never the face landmarker**, and never store landmark arrays. That removes the argument before it starts;
4. if schools will use it, provide a 1-page 교사·보호자 안내문 (PDF) covering camera use, space safety, and "no data leaves the device."

**Engineering guarantees that make the copy true** (and auditable):
- `connect-src 'self'` in CSP — provably cannot exfiltrate. Self-host fonts, the MediaPipe wasm, and the `.task` model.
- `Permissions-Policy: camera=(self), microphone=()`.
- Zero third-party scripts. No Google Fonts, no analytics (or self-hosted, cookieless, aggregate-count-only).
- `MediaRecorder`, `canvas.toBlob`, `toDataURL` must not appear in the bundle — add a CI grep over `dist/`.
- `track.stop()` on every teardown path; visible camera-on indicator with an off switch.
- `localStorage` keys namespaced `mg:` with a single "전체 삭제" button that clears them all.

### 7.4 Reduced motion, flashing, and sensory load

- Honour `prefers-reduced-motion: reduce` (tokens in §6) **and** ship an in-app toggle "화면 효과 줄이기" — kids' devices almost never have the OS setting on, and this is the audience most likely to need it. Reduced mode: no screen shake, no parallax, no camera zoom, confetti becomes a single static burst, the roulette becomes a crossfade, score counters snap instead of counting.
- **WCAG 2.3.1**: no more than 3 flashes per second. Combo/hit flashes are the realistic offender — cap full-viewport luminance flashes at 3/s, keep any flashing region under 25% of the viewport, and never flash saturated red. Add an engine-level `fx.flash()` that enforces this so 40 authors can't each get it wrong.
- Also honour `prefers-contrast: more` (drop gradients, thicken borders to 3 px, force `--c-text` on `--c-surface`) and offer "글자 크게" (bumps the root clamp ceiling to 34 px).
- Audio is never load-bearing: every voice prompt is mirrored as on-screen Korean text, every beat cue has a visual pulse (`manifest.a11y.audioOptional: false` forces the engine to render a beat ring), and there's a master mute.

### 7.5 Keyboard / mouse fallback — do it at the pose layer, once

The architectural point: **games must never branch on input source.** Implement a `VirtualPoseSource` that synthesizes a `PoseFrame` from keyboard/mouse/gamepad, emitting the same normalized landmarks a real body would.

```ts
// src/engine/pose/virtual.ts — one implementation serves all 40 games
export class VirtualPoseSource implements PoseSource {
  // Space = 점프 (hip impulse + 450ms arc), ArrowDown = 앉기 (hip drop),
  // Arrow←/→ = 좌우 이동/기울기, Z/X = 왼손/오른손 들기 (wrist to reachUpY),
  // C = 박수 (wrists converge for 120ms), mouse/touch = dominant hand position,
  // Gamepad: A=점프, B=앉기, LB/RB=손, left stick = 몸 이동.
  // Produces velocities consistent with positions so every gesture detector fires
  // exactly as it does for a real body. No detector changes. No game changes.
}
```
With this, `manifest.a11y.keyboardFallback: true` is almost free for most games, and `pickPool({cameraOn:false})` filters out the handful that genuinely cannot work (e.g. a "whole-room zone occupancy" game). Gamepad support comes along for free via the Gamepad API.

Plus the baseline DOM accessibility on the shell: `<html lang="ko">`, visible `:focus-visible` rings at `--bw-focus` 4 px (`--sh-focus`), all lobby interactions reachable by Tab/Enter/Arrow keys, roulette slices as real list items, `aria-live="assertive"` for the 3-2-1 countdown and `aria-live="polite"` for score/result announcements, 56 px minimum hit targets (72 px for primary, 96 px for lobby cards), no hover-only affordances, no time limits in the lobby, and a `자동 넘기기 끄기` option so a kid who needs longer to read instructions isn't rushed.

### 7.6 Also ship
- Fullscreen + `screen.orientation.lock('landscape')` on tablets; `navigator.wakeLock` during rounds.
- A 15-second "놀 준비" safety screen before the first standing game: 2 m 공간 확보, 주변 물건 치우기, 미끄러운 바닥 주의, 맨발보다 운동화, 목 마르면 쉬기 — and a mandatory "쉬는 시간" prompt every 8 games or 10 minutes (intensity-weighted, using `manifest.intensity`).
- Round scheduler constraint: never three `intensity: 3` games in a row; insert a `seated`/`intensity: 1` game after every two high-intensity ones.

---

## Sources

[gamestudies.org — WarioWare review (microgame structure)](https://www.gamestudies.org/0501/gingold/) · [The Cutting Room Floor — WarioWare Mega Microgame$](https://tcrf.net/WarioWare,_Inc.:_Mega_Microgame$!) · [NitoriWare](https://github.com/NitorInc/NitoriWare) · [little-warioware](https://github.com/NEW-CYLANDIA/little-warioware) · [mgahn0706/microgames (Korean, Next.js + Canvas, registry pattern)](https://github.com/mgahn0706/microgames) · [Einse57/pcie-microgames (Vite + React + TS)](https://github.com/Einse57/pcie-microgames) · [vgdcuci1516/AGDCWare](https://github.com/vgdcuci1516/AGDCWare) · [ChristianD37/Mega-MicroPygames](https://github.com/ChristianD37/Mega-MicroPygames) · [Vite — Glob Import](https://vite.dev/guide/features#glob-import) · [DevToolbox: auto-discovery with import.meta.glob](https://dev.to/dan_f8d850ce77481b/how-devtoolbox-auto-discovers-browser-tools-with-vite-importmetaglob-3d6o) · [Phaser 4 renderer announcement](https://phaser.io/news/2026/04/phaser-4-renderer-faster-cleaner-and-built-for-modern-games) · [Phaser 4 vs PixiJS 8 vs Kaplay (2026)](https://playfox.org/news/html5-engine-2026/) · [Phaser vs PixiJS comparison](https://generalistprogrammer.com/comparisons/phaser-vs-pixijs) · [MediaPipe Pose Landmarker docs](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker) · [MediaPipe GPU acceleration setup](https://theneuralbase.com/mediapipe/learn/advanced/gpu-acceleration-setup/) · [MediaPipe consent for camera use](https://theneuralbase.com/mediapipe/learn/advanced/consent-for-camera-use/) · [1€ Filter paper (Casiez et al.)](https://www.researchgate.net/publication/254005010_1_Filter_A_Simple_Speed-based_Low-pass_Filter_for_Noisy_Input_in_Interactive_Systems) · [OneEuroFilter API reference (Needle)](https://engine.needle.tools/docs/api/@needle-tools/engine/3.48.1/classes/engine_api.OneEuroFilter.html) · [one-euro-filter.js gist](https://gist.github.com/3846masa/5628f711e86fd62bea56b18e32177c60) · [web.dev — A tale of two clocks](https://web.dev/articles/audio-scheduling) · [Ableton/web-audio-sequencing](https://github.com/Ableton/web-audio-sequencing/blob/main/README.md) · [Why setTimeout is a bad metronome](https://dev.to/sendotltd/why-settimeout-is-a-bad-metronome-and-what-to-use-instead-1n83) · [Web audio scheduling drift](https://abchaudary.me/blog/web-audio-scheduling-drift) · [Speech Synthesis API browser support & limitations](https://www.testmuai.com/learning-hub/speech-synthesis-api-browser-support/) · [Lessons learned using speechSynthesis](https://talkrapp.com/speechSynthesis.html) · [Deep dive into the Web Speech API](https://blog.addpipe.com/a-deep-dive-into-the-web-speech-api/) · [Where to get free sound effects in 2026](https://assethoard.com/blog/free-sound-effects-2026) · [Free game audio: CC0 sound libraries](https://egmatic.com/blog/free-game-audio-tools-cc0-sound-libraries) · [Top 20 free SFX & music libraries (2026)](https://gamineai.com/blog/top-20-free-sfx-music-libraries-game-developers-2026-edition) · [Picking a winner fairly in a spin wheel](https://dev.to/bestspinnerwheel/picking-a-winner-fairly-in-a-browser-spin-wheel-modulo-bias-rejection-sampling-and-a-shuffle-bag-4aik) · [Winwheel.js](https://github.com/TheLarkInn/javascript-winwheel) · [Spin the Wheel canvas snippet](https://fwdtools.com/ui-snippets/spin-wheel/) · [Pretendard](https://github.com/orioncactus/pretendard) · [Gmarket Sans dynamic subset](https://github.com/leetaewook/gmarket-sans-dynamic-subset) · [무료 상업용 한글 폰트 라이선스 정리](https://flowworks.io/blog/free-commercial-fonts) · [Duolingo DESIGN.md (open-design)](https://github.com/nexu-io/open-design/blob/main/design-systems/duolingo/DESIGN.md) · [Duolingo design tokens](https://www.dembrandt.com/explorer/duolingo) · [Adobe — Designing for the 10-foot UI](https://blogs.adobe.com/creativecloud/designing-user-experiences-for-the-10-foot-ui/) · [TV & 10-foot UI design](https://uiuxatlas.com/lessons/responsive/tv-and-10-foot-ui-design/) · [Font size for TV menus by distance](https://www.signstream.net/post/font-size-for-tv-menus) · [web.dev — Recording video from the user](https://web.dev/articles/media-recording-video) · [Permission request timing & strategy](https://www.dogtownmedia.com/the-ask-when-and-how-to-request-mobile-app-permissions-camera-location-contacts/) · [FTC finalizes COPPA changes (DLA Piper)](https://www.dlapiper.com/en/insights/publications/2025/01/ftc-finalizes-changes-to-coppa) · [COPPA Rule, Federal Register Apr 2025](https://www.federalregister.gov/documents/2025/04/22/2025-05904/childrens-online-privacy-protection-rule) · [16 CFR 312.5 parental consent](https://dposchool.com/coppa/section/312.5) · [개인정보 보호법 제22조의2](https://lawplayer.com/kr/article/011357/002202) · [14세 미만 법정대리인 동의 실무](https://datalaw.kr/posts/under-14-signup-consent/)
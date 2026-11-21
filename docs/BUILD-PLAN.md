
---

# Build plan: 신일 모션 미니게임 파티

Repo root: `/Users/newuser/Github_kimmaru/Shinil_mini_Game_26`

## 0. The one thing that decides whether this works

Both briefs are strong on *mechanism* and have a specific gap: they name `Renderer`, `FxService`, `HudService`, `GestureService`, `AudioService`, `PoseSource` in `GameContext` but **only define `MiniGame`, `MiniGameManifest`, `PoseFrame`, `GameResult` and `AudioService` concretely**. Fifty parallel agents will each invent the undefined ones. So the highest-risk, must-be-first task is not the pose pipeline — it is writing the **signature-complete stub of every engine file in one sitting, freezing it, and only then fanning out.**

Technique for the whole build: **stub-first, fan-out-second.** The lead writes every engine file with full types and `throw new Error('TODO')` bodies (~2 hours, ~1200 lines of signatures), freezes it, and then parallel agents fill bodies and author games against a contract that cannot move under them.

---

## 1. Scaffold order and the frozen contract

### 1.1 Phase 0A — serial, lead only, nothing can be parallelised before this

Config and asset plumbing:

```
package.json            vite@8.3.8  typescript@7.0.2 (fallback 5.9 if plugins choke)
                        react@19.3.1  @vitejs/plugin-react@6.3.0
                        @mediapipe/tasks-vision@1.2.3 (EXACT, no caret)
                        vitest@5.1.1  zod@4.6.7 (devDep)  pretendard@1.3.9
                        vite-plugin-pwa@2.0.0
tsconfig.json           strict, noUncheckedIndexedAccess, target es2022, paths { "@/*": ["src/*"] }
vite.config.ts          manualChunks(vision|engine|react); worker.format 'es'
vitest.config.ts        environment 'node' (games must run headless), setupFiles
index.html              <html lang="ko">, self-hosted @font-face, no CDN
.gitignore  vercel.json (CSP from arch.md §1, verbatim)
.claude/launch.json     { name:"mini-game", runtimeExecutable:"npm", runtimeArgs:["run","dev"], port:5173 }
scripts/copy-vision-assets.mjs   prebuild: node_modules/@mediapipe/tasks-vision/wasm/* -> public/wasm/
                                 + download the 3 .task files -> public/models/  (pinned sha256)
public/warmup/person.jpg         256x256 bundled figure — the shader-compile warm frame
```

`git init` now; every later wave is a branch.

### 1.2 Phase 0B — the FROZEN CONTRACT files, in strict dependency order

Write these as complete signatures + doc comments, no bodies. Each gets a header:

```ts
// ══ FROZEN CONTRACT ══ imported by 50+ game modules.
// Changing anything here requires: lead approval + `npm run migrate:games` + a full replay re-run.
```

| # | File | Contains | Why frozen |
|---|---|---|---|
| F1 | `src/engine/types.ts` | `MiniGameManifest`, `MiniGame`, `GameContext`, `PoseFrame`, `PlayerPose`, `GameResult`, `CalibrationProfile`, `GestureKind`, `EndReason` — exactly as arch.md §2, **plus** `dev?: { clip?: string; notes?: string }` on the manifest (see §5.3 — add it now so the freeze holds) | every game imports it |
| F2 | `src/engine/pose/landmarks.ts` | the `L` constant (33 names), `Joint` type, `palm(p, side)`, `jointPx(p, j)`, `jointDist(p, a, b)`, `mid()`, `visible(p, ...j)` | every game reads joints |
| F3 | `src/engine/math.ts` | `clamp lerp smoothstep easeOutBack easeOutQuint approach`, `hitCircle`, `hitRect`, `angleDeg`, `limbAngle` | every game |
| F4 | `src/engine/render/renderer.ts` | **the `Renderer` interface — not defined anywhere in the briefs** | 50 agents will otherwise each use raw ctx differently |
| F5 | `src/engine/gestures/index.ts` | `GestureService` with the **rent-in-init** API (below) + every `Signal` result type | the single biggest source of agent divergence |
| F6 | `src/engine/fx/index.ts` | `FxService`: `burst, confetti, shake, flash, pop, trail, hitstop, squash` | |
| F7 | `src/engine/hud/index.ts` | `HudService`: `setGoal, setScore, setCombo, setBar, toast, announce, beatRing` | |
| F8 | `src/engine/audio/index.ts` + `src/engine/audio/sfx.ts` | `AudioService` (arch.md §3.8) + **`SFX_IDS` as a closed union type** | stops 50 agents referencing 200 nonexistent sound files |
| F9 | `src/engine/entities.ts` + `src/engine/spawn.ts` | pooled struct-of-arrays entity list, seeded `Spawner`, speed-gated hit tests | ~22 games need the identical loop |
| F10 | `src/engine/registry.ts` + `src/engine/validate.ts` + `src/engine/catalog.ts` | glob registry (arch.md §2) with the **negative glob** below; zod schema; `catalog.ts` = the 58 ids as the completeness source of truth | the integration point |
| F11 | `src/engine/testing/harness.ts` + `nullRenderer.ts` + `synth.ts` | `runGame()`, clip types, `PoseClip` format | every agent runs it before handing back |

Two details that must be right on the first write:

```ts
// F10 registry.ts — the `_template` folder must NOT be globbed
const manifests = import.meta.glob<MiniGameManifest>(
  ['../games/*/manifest.ts', '!../games/_*/**'], { eager: true, import: 'manifest' });
const loaders   = import.meta.glob<MiniGameFactory>(
  ['../games/*/index.ts',    '!../games/_*/**'], { import: 'default' });
```

```ts
// F4 render/renderer.ts — shapes only, no images, no ctx escape hatch.
// This is why 50 games look like one product and why there are zero asset merge conflicts.
export interface Renderer {
  readonly w: number; readonly h: number; readonly t: number;   // t = seconds since start
  save(): void; restore(): void;
  translate(x: number, y: number): void; rotate(r: number): void; scale(x: number, y: number): void;
  alpha(a: number): void;
  clear(hue?: number): void;                                    // --c-game-bg tinted by manifest hue
  circle(x: number, y: number, r: number, c: Paint): void;
  roundRect(x: number, y: number, w: number, h: number, r: number, c: Paint): void;
  line(x0: number, y0: number, x1: number, y1: number, width: number, c: Paint): void;
  poly(pts: Float32Array, n: number, c: Paint, close?: boolean): void;
  star(x: number, y: number, r: number, spikes: number, c: Paint): void;
  chevron(x: number, y: number, r: number, dir: number, c: Paint): void;
  text(s: string, x: number, y: number, o?: TextOpts): void;    // Korean-safe, keep-all, tabular-nums
  emoji(s: string, x: number, y: number, size: number, rot?: number): void;  // all "art" is emoji + shapes
  skeleton(p: PlayerPose, o?: SkeletonOpts): void;              // engine-owned mirror + outline
  ghostBody(p: PlayerPose, alpha: number): void;
  // NOTE: there is deliberately no `ctx` getter. If you think you need one, you need an engine feature.
}
export type Paint = { fill?: string; stroke?: string; sw?: number; glow?: number };
```

```ts
// F5 gestures/index.ts — detectors are RENTED IN init(), READ IN update(). Zero allocation per frame.
export interface GestureService {
  use<K extends GestureKind>(kind: K, opts?: GestureOpts[K]): Detector<K>;
  // engine resets every rented detector on start() and on resume(); the game never calls reset()
}
export interface Detector<K extends GestureKind> { read(f: PoseFrame): SignalOf<K>; }

// examples of SignalOf
type JumpSignal  = { fired: boolean; power: number; airborne: boolean };
type ClapSignal  = { fired: boolean; at: Pt };                    // at = palm midpoint, px
type LeanSignal  = { value: number; dir: -1 | 0 | 1 };            // value continuous -1..1
type ZoneSignal  = { inside: boolean; entered: boolean; dwellMs: number };
type HoldSignal  = { inPose: boolean; progress: number; done: boolean; error: number };
type RepSignal   = { reps: number; phase: number; justCounted: boolean };
```

**Why `use()` in `init()` and not `gestures.clap(p)` per frame:** the per-frame-call shape in arch.md §3 would either leak a detector per frame or need callsite keying. `use()` makes the detector lifetime explicit, makes resets engine-owned, and makes the "never allocate in update" rule enforceable by review.

### 1.3 Phase 0C — engine bodies, 4 parallel agents, disjoint directories

Only after F1–F11 are frozen and committed. Four agents, no overlap:

| Agent | Owns | Files |
|---|---|---|
| **E1 pose** | `src/engine/pose/**` | `source.ts` (PoseSource iface), `mediapipe.ts`, `pose.worker.ts`, `oneEuro.ts`, `normalize.ts`, `identity.ts`, `calibration.ts`, `virtual.ts` (VirtualPoseSource), `replay.ts`, `capability.ts` (WebGL2/SwiftShader tier detection), `warmup.ts` |
| **E2 gestures** | `src/engine/gestures/**` | `trigger.ts`, `detectors.ts` (jump squat clap swing raise lean step angle zone), `reps.ts`, `stillness.ts`, `balance.ts`, `service.ts` |
| **E3 juice** | `src/engine/fx/**`, `src/engine/audio/**`, `src/engine/render/canvas2d.ts` | `particles.ts`, `shake.ts`, `flash.ts` (3-flash/s cap enforced), `service.ts`; `audio/engine.ts`, `audio/scheduler.ts` (BeatScheduler), `audio/latency.ts` |
| **E4 shell** | `src/shell/**`, `src/styles/**` | `tokens.css` + `base.css` (arch.md §6 verbatim), `App.tsx`, `screens/*.tsx` (Priming, Camera, Warmup, Calibration, Safety, Attract, Roulette, Intro, Results, PartySummary, Settings, Privacy), `Roulette.tsx` (CSS wheel + rotation math + dev inverse assertion), `HudOverlay.tsx`, `DebugOverlay.tsx` |

Lead, in parallel with them, writes the pieces that stitch everything: `src/engine/loop.ts`, `src/engine/session.ts` (state machine), `src/engine/rng.ts`, `src/engine/shuffleBag.ts`, `src/engine/scheduler.ts` (intensity pacing), `src/engine/registry.ts` body, `src/engine/testing/**` bodies.

### 1.4 Phase 0D — guardrails (lead, before any game agent runs)

```
scripts/check-boundaries.mjs   fails if src/games/*/** imports anything but @/engine/* or ./*
                               fails if manifest.ts imports anything but @/engine/types
                               fails if any game file imports CanvasRenderingContext2D / document / window
scripts/check-frozen.mjs       sha256 of F1..F11 vs .frozen.json — build fails on drift
scripts/check-privacy.mjs      greps dist/ for toDataURL|toBlob|MediaRecorder|fetch(http -> fail
scripts/check-no-assets.mjs    fails if src/games/** contains png/jpg/svg/mp3/wav/webm
npm run gate                   tsc --noEmit && check-* && vitest run
```

`AGENTS.md` at the repo root (every agent reads it first) + `docs/GAME_AUTHORING.md` + `src/games/_template/{manifest.ts,index.ts,locale.ts,README.md}`.

### 1.5 Phase 0E — the three hand-built games (§2)

---

## 2. The reference game: `mosquito-clap` (모기 박수)

### Why this one, over the alternatives

It is the only easy game that exercises **both** loop shapes at once — a discrete `Trigger` gesture *and* continuous screen-space joint positions *and* a hit test between them — while being physically trivial (no gravity, no scrolling, no multi-player, no beat, no pose library).

Concretely it forces the author through every engine surface exactly once:

| Required by the brief | How mosquito-clap uses it |
|---|---|
| a gesture detector | `gestures.use('clap')` — a `Trigger` with cooldown, the canonical "never fire on a single frame" case |
| continuous joint read | `palm(p,'L')` / `palm(p,'R')` midpoint in **px**, which is what ~22 of the other games need |
| scoring | `kind:'count'`, combo multiplier, miss penalty, engine-computed stars |
| HUD | `setGoal`, `setScore`, `setCombo`, `announce` |
| fx | `burst` on hit, `shake(0.12)`, `pop`, `hitstop(0.05)`, `flash` through the 3/s cap |
| countdown / lifecycle | `init` allocates, `start` arms, `update` fixed dt, `render(g, interp)`, `end` returns result |
| keyboard fallback | `C` = clap, mouse/trackpad = hand position → **zero game-side code**; it is all `VirtualPoseSource` |
| seeded determinism | `ctx.rng()` spawn → same seed, same round, replay-testable |

Rejected alternatives, briefly: `scan-hold-still` is simpler but exercises no discrete trigger and no spawner; `fruit-slash` needs swing-direction + a slice polyline (two new concepts); `candy-rain-catch` has gravity and miss-handling but no discrete trigger; `air-whack-mole` is nearly identical but its hit test is zone-based, which hides the px-coordinate work.

**Build two more by hand in Phase 0E**, because there are exactly three distinct update-loop shapes in the catalog and agents copying across shapes is where errors happen:

- `candy-rain-catch` — continuous overlap + object physics + miss penalty (archetype for ~12 games)
- `wave-jump` — locomotion gesture vs a scrolling world + survival scoring (archetype for ~10 games)

`docs/GAME_AUTHORING.md` tells each agent: *"Your game is one of three shapes. Read the matching reference in full before writing a line."*

### 2.1 `src/games/mosquito-clap/manifest.ts`

```ts
import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'mosquito-clap',                 // MUST equal the folder name — registry throws otherwise
  nameKo: '모기 박수',
  taglineKo: '모기를 박수로 잡아요!',    // <= 18 chars
  howToKo: ['모기가 두 손 사이로 오면', '손뼉을 짝! 치세요'],
  icon: '🦟',
  theme: { hue: 142 },

  difficulty: 1,
  intensity: 1,
  space: 'seated',                     // playable sitting down -> good "rest" game for the scheduler
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['clap'],

  durationMs: 40_000,
  scoring: { kind: 'count', maxScore: 24, starCuts: [0.25, 0.5, 0.75] },

  a11y: { keyboardFallback: true, noFlashing: true, colorBlindSafe: true, audioOptional: true },
  tags: ['반사신경', '파티', '앉아서'],
  version: 1,
  author: 'lead',
  enabled: true,                       // agent-authored games ship `false` until the lead plays them
  dev: { clip: 'clap-x12' },           // which recorded replay clip must produce score > 0
};
```

### 2.2 `src/games/mosquito-clap/index.ts` (shape, with the rules it demonstrates)

```ts
import type { GameContext, MiniGame, PoseFrame, EndReason, GameResult, Renderer } from '@/engine/types';
import type { Detector } from '@/engine/gestures';
import { palm, mid } from '@/engine/pose/landmarks';
import { hitCircle, clamp } from '@/engine/math';
import { EntityPool } from '@/engine/entities';
import { manifest } from './manifest';
import { t } from './locale';

const CAP = 12;
const HIT_R = 92;                 // px at 1080-logical; engine scales via ctx.view
const SPAWN_MS = [1400, 900, 650]; // ramps with elapsed time — WarioWare pacing

export default function create(): MiniGame {
  let ctx!: GameContext;
  let clap!: Detector<'clap'>;
  const bugs = new EntityPool(CAP);          // SoA pool: x y vx vy phase alive — allocated in init ONLY
  let score = 0, combo = 0, bestCombo = 0, hits = 0, misses = 0;
  let elapsed = 0, nextSpawn = 0;
  let flashT = -1, lastHit = { x: 0, y: 0 };

  return {
    init(c) {
      ctx = c;
      clap = ctx.gestures.use('clap', { preset: 'snappy', cooldownMs: 300 });
      ctx.hud.setGoal(t('goal'));            // "모기를 잡아요!"
    },

    start() { elapsed = 0; nextSpawn = 0.6; bugs.clear(); },

    update(dt, f: PoseFrame) {
      elapsed += dt;
      const p = f.players[0];

      // 1) spawn — ALWAYS ctx.rng(), never Math.random(), or replays and seeds break
      if ((nextSpawn -= dt) <= 0) {
        const ramp = elapsed < 12 ? 0 : elapsed < 26 ? 1 : 2;
        nextSpawn = SPAWN_MS[ramp] / 1000;
        bugs.spawn({ x: ctx.rng() * ctx.view.w, y: 0.2 * ctx.view.h + ctx.rng() * 0.5 * ctx.view.h,
                     vx: (ctx.rng() - 0.5) * 120, vy: (ctx.rng() - 0.5) * 120 });
      }

      bugs.integrateWander(dt, ctx.view, ctx.rng);     // no allocation

      // 2) gesture — read once per frame, never construct a detector here
      if (!p?.present) return;                          // gate, don't guess (pose.md §5.4)
      const c = clap.read(f);
      const hand = mid(palm(p, 'L'), palm(p, 'R'));

      if (c.fired) {
        const i = bugs.nearestWithin(hand.x, hand.y, HIT_R);
        if (i >= 0) {
          bugs.kill(i); hits++; combo++; bestCombo = Math.max(bestCombo, combo);
          score += 1 + Math.min(combo >> 2, 3);         // combo multiplier, capped
          ctx.fx.burst(hand.x, hand.y, 18, { hue: manifest.theme!.hue, speed: 520, life: 0.5, size: 7 });
          ctx.fx.shake(0.12); ctx.fx.hitstop(0.05);
          ctx.audio.play(combo >= 8 ? 'pop_big' : 'pop');   // ids from the closed SFX_IDS union
          ctx.hud.setScore(score); ctx.hud.setCombo(combo);
          ctx.emit({ kind: 'scored', value: score });
          flashT = 0; lastHit = hand;
        } else {
          combo = 0; misses++;
          ctx.audio.play('whiff'); ctx.hud.setCombo(0);
        }
      }
      if (flashT >= 0) flashT = flashT > 0.3 ? -1 : flashT + dt;
    },

    render(g: Renderer, interp) {
      g.clear(manifest.theme!.hue);
      g.ghostBody(ctx.lastFrame.players[0], 0.22);       // kids must see themselves to aim
      bugs.each((x, y, ph) => g.emoji('🦟', x, y, 64, Math.sin(ph) * 0.3));
      if (flashT >= 0) g.circle(lastHit.x, lastHit.y, 60 + flashT * 500,
                                { stroke: '#fff', sw: 6 - flashT * 18 });
      // HUD/score/timer are the ENGINE's job — never draw them here
    },

    end(reason: EndReason): GameResult {
      const normalized = clamp(score / manifest.scoring.maxScore, 0, 1);
      return {
        gameId: manifest.id, cleared: reason === 'timeUp', rawScore: score,
        maxScore: manifest.scoring.maxScore, normalized, stars: 0, // engine overwrites from starCuts
        durationMs: manifest.durationMs,
        perPlayer: [{ playerId: 0, slot: 0, score, hits, misses, bestCombo }],
        highlightsKo: bestCombo >= 8 ? [`콤보 ${bestCombo}연속!`] : undefined,
      };
    },

    dispose() { bugs.clear(); },
  };
}
```

`locale.ts` holds every Korean string this game uses. There is no shared i18n file — that is the #1 merge-conflict source in this kind of repo.

---

## 3. Parallel agent work breakdown

### 3.1 The three batching rules, in priority order

1. **Batch by shared *signal*, not by mechanic family or difficulty.** An agent assigned 3 games that all read `gestures.use('clap')`-class signals tunes one detector once and reuses the threshold intuition. An agent given one jump game, one rhythm game and one pose-match game has to learn three subsystems and will do all three badly. Difficulty is irrelevant to batching — it correlates with nothing an agent needs.
2. **Wave boundaries are engine-feature boundaries.** A wave may only contain games whose required services were merged and replay-tested in a previous wave. This is the only hard scheduling constraint.
3. **One agent owns N whole folders, exclusively, for the whole wave.** No two agents ever share a file, because the only shared files are frozen engine files and nobody may touch those. There are no shared asset directories (all visuals are shapes + emoji; all sounds come from the closed `SFX_IDS` list), so the merge surface is literally zero.

**3 games per agent.** Each game is 150–350 lines; three is about one solid agent session including self-verification. Two is wasteful setup overhead (each agent must read `AGENTS.md` + the archetype reference, ~8k tokens of context); four starts producing a rushed third and fourth game.

**6–7 agents per wave.** That is 18–21 games per wave, which is the most a lead can review in one sitting given the review method in §3.4 (~90 s per game in the Browser pane ≈ 30 min, plus automated gates that already passed).

### 3.2 The waves

**Wave 0C — lead, by hand (3 games).** `mosquito-clap`, `candy-rain-catch`, `wave-jump`. These are the three archetype references. Nothing fans out until all three pass the gate and look good in the browser.

**Wave 1 — 7 agents × 3 = 21 games.** Requires only the Phase-0 core (palm/zone/clap/swing/raise + spawn + fx/hud/audio + repCounter). Zero new engine work.

| Agent | Shared signal | Games |
|---|---|---|
| A1 | palm zone hit + speed gate | `air-whack-mole`, `balloon-pop-party`, `castle-defense` |
| A2 | falling/moving catch (gravity spawner) | `shooting-star-grab`, `snowball-fight` (solo vs CPU), `goalkeeper-save` |
| A3 | swing direction + path | `fruit-slash`, `web-cut`, `color-shield-block` |
| A4 | aim/trace, `steady` filter preset | `wrist-aim-target`, `wrist-maze`, `connect-dots-order` |
| A5 | reach extent + joint-to-joint distance | `spider-touch`, `koko-ko-touch`, `max-reach-stretch` |
| A6 | raise L/R/both + cue list | `cheer-combo`, `blue-flag-white-flag`, `ox-quiz-zone` |
| A7 | rep counter over a scalar | `arm-pump-inflate`, `run-in-place-sprint`, `bike-pedal` |

**Wave 2 — 6 agents × 3 = 18 games.** Lead builds `scroller`, `cue`, `zones`, `stillness`, `balance` during Wave 1's review window.

| Agent | Shared signal | Games |
|---|---|---|
| B1 | scroller + jump/step | `lane-runner`, `jump-rope-king`, `hopscotch-zones` |
| B2 | scroller + duck/lean | `limbo-king`, `laser-corridor`, `airplane-lean` |
| B3 | cue → reaction window | `reflex-ridge`, `ice-tag-freeze`, `red-light-green-light` |
| B4 | stillness / hold timer | `statue-hold`, `scan-hold-still`, `flamingo-balance` |
| B5 | balance + sway + knee lift | `tightrope-walk`, `tree-pose-yoga`, `stair-climb-tower` |
| B6 | limb cycle phase + stroke path | `swim-crawl`, `sky-draw`, `body-simon` |

**Wave 3 — 4 agents × ~3 = 11 games.** Requires `poseSimilarity` + the pose-target library + `jointTargets` + `audio.beat` + the A/V latency calibration screen, all built by the lead during Wave 2's review window.

| Agent | Shared signal | Games |
|---|---|---|
| C1 | cosine pose similarity vs a target pose | `pose-match-shadow`, `animal-mimic`, `constellation-pose` |
| C2 | joint-target coverage (N points, specific joints) | `human-tetris`, `body-hangul`, `body-number` |
| C3 | beat scheduler + judge windows | `beat-clap`, `step-rhythm`, `air-drums` |
| C4 | sequence memory + choreography timeline | `move-memory-chain`, `cover-dance` |

**Wave 4 — lead + 2 agents, last, 5 games, all `enabled:false` at launch.** These need engine features *nobody else needs*, which is exactly why they go last:

| Game | Exclusive engine need | Verdict |
|---|---|---|
| `high-touch-jump`, `mirror-the-leader`, `body-rock-paper-scissors` | **multi-player identity** — greedy nearest-centroid tracking, sticky slots, two-ROI cropped passes, versus scoring. pose.md is explicit that `numPoses:2` is out of the model's scope and swaps identity on crossing | build on the spatial-halves pattern (left/right of the mirrored frame = P1/P2), ship `enabled:false`, enable only after on-hardware testing |
| `shadow-puppet-theater` | **`poseRig`** — a bone-weighted puppet renderer driven by the skeleton. ~200 lines of engine used by one game | cut candidate #1 |
| `photo-pose-booth` | **frame capture** — directly contradicts the privacy guarantee (`check-privacy.mjs` bans `toDataURL`/`toBlob`/`MediaRecorder` in `dist/`) and the COPPA posture in arch.md §7.3 | **re-spec as "stickers on a live, never-saved frame" or drop.** Do not quietly add a capture path |

Total: 3 + 21 + 18 + 11 + 5 = **58**, every id in the catalog placed exactly once.

### 3.3 The agent prompt template (every field is load-bearing)

```
ROLE: You are authoring 3 mini-games for an existing engine. You are one of 7 agents
working in parallel on the same repo.

READ FIRST, IN THIS ORDER (do not skip, do not skim):
  1. /Users/newuser/Github_kimmaru/Shinil_mini_Game_26/AGENTS.md
  2. src/engine/types.ts and src/engine/render/renderer.ts and src/engine/gestures/index.ts
  3. THE ARCHETYPE REFERENCE FOR YOUR SHAPE: src/games/<mosquito-clap|candy-rain-catch|wave-jump>/
     Your 3 games are all shape <N>. Read that reference in full.
  4. docs/GAME_AUTHORING.md  (thresholds, Korean copy rules, SFX_IDS list, star-cut guidance)

YOU OWN EXACTLY THESE FOLDERS AND NOTHING ELSE:
  src/games/<id-1>/   src/games/<id-2>/   src/games/<id-3>/
Each contains: manifest.ts, index.ts, locale.ts   (and nothing else — no assets)

ABSOLUTE PROHIBITIONS (a violation fails the gate and the whole batch is rejected):
  - Do not create, edit, read-then-rewrite, or even reformat ANY file outside your 3 folders.
    The engine is a frozen contract. `npm run gate` verifies its sha256.
  - Do not import anything except `@/engine/*` and `./*`. manifest.ts imports ONLY @/engine/types.
  - No Math.random() — use ctx.rng(). No Date.now() — use the dt/frame time you are given.
  - No allocation inside update() or render(). Allocate in init().
  - No raw CanvasRenderingContext2D. No document/window. No images, audio files, or fonts.
  - No new sound ids. Only members of SFX_IDS.
  - Never threshold on raw landmark pixels. Normalized units (shoulder widths) only.
  - Never fire a scoring event on a single frame. Use a rented Detector. Min cooldown 250 ms.
  - Ship every manifest with `enabled: false`. The lead flips it after playing it.

IF YOU NEED AN ENGINE FEATURE THAT DOES NOT EXIST: stop, do not add it to the engine, do not
work around it with a 300-line local copy. Write src/games/<id>/NEEDS.md stating the signal you
need and why, implement the simplest honest version of the game without it, and say so in your
hand-back. The lead promotes repeated NEEDS into the engine between waves.

YOUR 3 GAMES  (spec, Korean name, target feel, scoring shape, and the gesture each uses):
  <id-1>: <4–6 sentence spec incl. nameKo, howToKo intent, win condition, maxScore, dev.clip>
  <id-2>: ...
  <id-3>: ...

VERIFY BEFORE HANDING BACK (all four, from the repo root):
  npx tsc --noEmit
  npm run gate                                  # boundaries, frozen hashes, no-assets, privacy
  npx vitest run src/games/__tests__ -t "<id-1>|<id-2>|<id-3>"   # replay smoke harness
  npm run shot -- <id-1> <id-2> <id-3>          # headless screenshot at t=5s; look at the PNGs

HAND BACK: for each game, one paragraph — what the player does, which Detector + thresholds you
used and why, what score a competent 9-year-old gets, what you could not make work, and any NEEDS.md
you wrote. Do not write a report file.
```

### 3.4 Review gate per wave

1. **Automated (already green before hand-back):** `tsc`, boundary/frozen/asset/privacy checks, manifest zod, registry completeness vs `catalog.ts`, replay smoke test per game × 4 clips, no-NaN renderer, star-cut sanity (`cuts[0] ∈ [0.2,0.4]`, `cuts[1] ∈ [0.45,0.7]`, `cuts[2] ∈ [0.7,0.95]` — otherwise every agent awards 3 stars for existing).
2. **Diff gate:** `git diff --stat wave-N..agent-branch` must list only that agent's folders. Any other path → reject the batch, no negotiation.
3. **Human-equivalent gate (the lead, in the Browser pane):** for each id, `?game=<id>&pose=virtual&seed=7&debug=1&skip=calib`, 6–10 keypresses, screenshot, `read_console_messages({onlyErrors:true})`. ~90 s/game.
4. **Promotion pass:** read every `NEEDS.md`; anything requested by ≥2 agents becomes an engine service in the next wave; delete the local workarounds.
5. **Enable pass:** flip `enabled:true` only on games that are actually fun at the right difficulty. This is the quality valve, and because the pool is filtered on `enabled`, a half-tuned game can sit in the repo indefinitely without hurting anyone.

---

## 3b. Engine feature → game dependency matrix

Build order is top to bottom. A batch cannot start until every service it needs is merged **and** has passing detector tests.

| Service | File | Needed before | # games |
|---|---|---|---|
| `Renderer`, `fx`, `hud`, `audio.sfx`, `entities`/`spawn`, `rng` | F4, F6–F9 | **everything** | 58 |
| `pose` (normalize, One Euro, extrapolate, identity, calibration) | `engine/pose/**` | everything | 58 |
| `VirtualPoseSource` | `engine/pose/virtual.ts` | **everything** — it is how 50 games get verified without a camera, and how `keyboardFallback:true` is free | 58 |
| `gestures.palm` + `hitCircle` + speed gate | F2, F3, `detectors.ts` | 0C, Wave 1 A1–A5 | 22 |
| `gestures.clap` | `detectors.ts` | `mosquito-clap`, `beat-clap`, `cheer-combo`, `air-drums` | 4 |
| `gestures.swing` (dir + speed) | `detectors.ts` | `fruit-slash`, `web-cut`, `snowball-fight`, `color-shield-block`, `castle-defense` | 5 |
| `gestures.raise` + `cue` list | `detectors.ts`, `cue.ts` | `cheer-combo`, `blue-flag-white-flag`, `high-touch-jump` | 3 |
| `gestures.jump` | `detectors.ts` | **`attract` state (jump-to-start)** + `wave-jump`, `lane-runner`, `jump-rope-king`, `high-touch-jump`, `hopscotch-zones`, `reflex-ridge` | 6 + shell |
| `gestures.squat` | `detectors.ts` | `limbo-king`, `laser-corridor`, `lane-runner`, `reflex-ridge` | 4 |
| `gestures.lean` / `step` | `detectors.ts` | `airplane-lean`, `tightrope-walk`, `lane-runner`, `laser-corridor`, `ox-quiz-zone`, `reflex-ridge` | 6 |
| `repCounter` (generic hysteresis over any scalar) | `gestures/reps.ts` | Wave 1 A7, Wave 2 B5/B6 | 8 |
| `zones` (floor/screen zone defs + occupancy + rendering) | `engine/zones.ts` | `ox-quiz-zone`, `hopscotch-zones`, `step-rhythm`, `color-shield-block`, `body-rock-paper-scissors` | 5 |
| `scroller` (obstacle track, h/v, seeded) | `engine/scroller.ts` | **Wave 2 B1, B2** | 6 |
| `cue` (Simon-says announcer + reaction window) | `engine/cue.ts` | **Wave 2 B3, B6** | 6 |
| `stillness` (motion energy over a window) | `gestures/stillness.ts` | **Wave 2 B4** — `statue-hold`, `scan-hold-still`, `red-light-green-light`, `ice-tag-freeze` | 4 |
| `balance` (single-leg + sway metric) | `gestures/balance.ts` | **Wave 2 B4/B5** — `flamingo-balance`, `tightrope-walk`, `tree-pose-yoga` | 3 |
| `strokeMatch` (path/shape similarity) | `engine/stroke.ts` | `sky-draw`, `connect-dots-order` | 2 |
| `poseSimilarity` + `PoseTarget` + `poses/` library | `gestures/similarity.ts`, `assets/poses/*.json` | **Wave 3 C1, C4** — `pose-match-shadow`, `animal-mimic`, `cover-dance`, `mirror-the-leader`, `tree-pose-yoga` | 5 |
| `jointTargets` (N points each covered by a named joint) | `engine/jointTargets.ts` | **Wave 3 C2** — `human-tetris`, `body-hangul`, `body-number`, `constellation-pose` | 4 |
| `audio.beat` (BeatScheduler) + `hud.beatRing` + A/V latency calibration | `audio/scheduler.ts`, `audio/latency.ts` | **Wave 3 C3, C4** — `beat-clap`, `step-rhythm`, `air-drums`, `cover-dance`, `jump-rope-king`(opt), `mirror-the-leader`(opt) | 6 |
| `multiPlayer` identity (2-ROI passes, sticky slots, versus scoring) | `pose/identity.ts` + `pose/dualRoi.ts` | **Wave 4** — `high-touch-jump`, `mirror-the-leader`, `body-rock-paper-scissors`, `snowball-fight`(2p mode) | 4 |
| `poseRig` (bone-weighted puppet) | `engine/poseRig.ts` | `shadow-puppet-theater` only | 1 |
| frame capture | *none — forbidden* | `photo-pose-booth` | 1 |

The pose-target library is the schedule risk nobody expects. Do **not** plan on recording kids for `pose-match-shadow` / `animal-mimic` targets. Generate them parametrically from `engine/testing/synth.ts` (`armAt(side, deg)`, `legAt(side, deg)`, `leanBy(deg)`) so a target pose is 10 lines of declarative geometry, reviewable in a diff, and tunable without a camera. Keep 3–4 hand-recorded targets only for poses geometry can't express.

---

## 4. Flow / shell spec

### 4.1 State machine (`src/engine/session.ts`)

```
boot
 └─> priming            PRIVACY COPY (arch.md §7.1 verbatim). ⚑ POSE WARMUP STAGE A starts here:
     │                  fetch /wasm/* + /models/pose_landmarker_lite.task into the Cache API with a
     │                  progress bar. No camera, no user gesture needed. ~20 MB — this is the slowest
     │                  thing in the app and it must overlap with the kid reading the privacy screen.
     ├─"⌨️ 카메라 없이 하기"─> inputFallback ──> calibrationSkip ──> attract   (VirtualPoseSource)
     └─"🎥 카메라 켜고 시작하기"
          └─> prePrompt  1.2 s "곧 브라우저가 물어봐요. [허용]을 눌러 주세요 👆"
               └─> cameraRequest   getUserMedia({video:{facingMode:'user', width:{ideal:…}, …}})
                    ├─ NotAllowedError/NotFoundError/NotReadableError ──> cameraHelp ──> (retry | fallback)
                    └─ ok
                        └─> warmup   ⚑ POSE WARMUP STAGE B — the one that must not be skipped:
                            │  capability.ts picks a tier (WebGL2? SwiftShader? hardwareConcurrency)
                            │  create PoseLandmarker in the module worker, GPU delegate, CPU fallback
                            │  run 3× detectForVideo(/warmup/person.jpg, ts=0/33/66)
                            │  ← compiles the LANDMARK-stage shaders, which a blank frame does NOT.
                            │    pose.md measured ~20 s on a cold cache; 60 s timeout, animated screen.
                            │  in parallel: decodeAudioData all SFX, await document.fonts.ready
                            └─> calibration   4 s, framed as a game: "선을 맞춰 서 볼까요?"
                                │  ⚑ STAGE C: discard the first 10 live frames (they also warm the
                                │  real-resolution path). Median over ~60 frames -> CalibrationProfile
                                │  (shoulderW, standHipY, reachUpY, squatHipY, floorY, armSpan).
                                │  Requires ankle visibility > 0.5 -> "발이 보이게 뒤로 가 볼까요?"
                                └─> safety   15 s, first standing game only: 2 m 공간, 물건 치우기
                                     └─> attract ◀──────────────────────────────┐
                                          │  "점프하면 시작!" (§4.2)            │
                                          └─> roulette                          │
                                               │  decide winner FIRST; shortlist 8 from
                                               │  pickPool(); CSS wheel 3.4 s; tick SFX on
                                               │  boundary crossings; 25% near-miss; 건너뛰기
                                               └─> intro                        │
                                                    │  nameKo slam-in + howToKo + looping
                                                    │  gesture demo (VirtualPoseSource driving
                                                    │  g.skeleton — free, no video assets).
                                                    │  ⚑ registry.load(id) resolves HERE, and
                                                    │  modulepreload for the next 2 candidates.
                                                    │  auto-advance 4 s, or 자동 넘기기 끄기
                                                    └─> countdown  3·2·1·시작! on the AUDIO clock
                                                         └─> play ⇄ paused (visibilitychange, Esc)
                                                              └─> results   stars, highlightsKo,
                                                                   │        [다시 하기][다음 게임][그만하기]
                                                                   ├─> breakPrompt  (every 8 games or
                                                                   │   10 min, intensity-weighted)
                                                                   ├─> partySummary (MVP, silly titles)
                                                                   └─────────────────────────────────┘
```

Transitions are a plain discriminated-union reducer in `session.ts`; the React shell renders off it and owns zero game state. `paused` stops the loop, pauses audio, stops posting to the worker, and on resume sets `lastVideoTime = -1` and resets `dt` (pose.md §4.7).

`track.stop()` fires on: route away from play, `pagehide`, tab hidden > 60 s, and the always-visible `🔴 카메라 켜짐 · [끄기]` chip.

### 4.2 Jump-to-start — the same detector, a stricter preset

```ts
// src/shell/screens/Attract.tsx — no bespoke jump code anywhere in the shell
const jump = gestures.use('jump', {
  enter: 1.9,          // vs 1.5 in games: a false start is more annoying than a missed one
  exit: 0.6,
  cooldownMs: 900,
  confirmFrames: 2,
  requireFeetVisible: false,   // kids stand close to a laptop; feet are often cropped
});
```

Three properties this buys:

- **One tuning surface.** If jumps feel unresponsive in `wave-jump`, the same change fixes the start button. If the start button false-triggers on a Chromebook at 12 fps, you found a bug that would also have broken six games. The attract screen is, in effect, a permanent end-to-end test of the jump detector that every user runs.
- **Probation before arming.** A person must be present and upright for **0.45 s** (`camera-games` pattern) before the button arms; a filling ring shows that. Prevents a passing teacher or a chair from launching a game.
- **Never a dead end.** Keyboard `Space`, click/tap, and after 25 s with no jump: "스페이스바를 눌러도 돼요". Under `prefers-reduced-motion` or `inputFallback`, the primary affordance is the button and the jump is the bonus.

The attract screen also runs the live skeleton overlay at low alpha, which is the honest "the camera sees you, here is exactly what it sees" demonstration that makes the privacy copy credible to a parent standing behind the kid.

---

## 5. Verification strategy

This is where the project is won. Fifty games cannot be validated with fifty camera sessions.

### 5.1 Four layers

| Layer | Tool | Catches | Needs camera? |
|---|---|---|---|
| L1 detector unit tests | Vitest + `synth.ts` | wrong thresholds, double-fire, scale/fps non-invariance | no |
| L2 static/manifest/registry | Vitest + zod + scripts | id drift, missing index, boundary violations, star-cut inflation, missing games | no |
| L3 replay smoke harness | Vitest + `fixtures/replay/*.json` | crashes, NaN, unreachable scoring, phantom scoring, leaks | no (recorded once) |
| L4 visual/interactive | Browser pane + `VirtualPoseSource` | "is it actually fun", layout, Korean text, HUD, fx | no |

### 5.2 L1 — synthetic landmark sequences

`src/engine/testing/synth.ts` builds landmark streams from declarative keyframes:

```ts
// a parametric standing skeleton, then pose it
const stand = basePose({ shoulderW: 0.15, heightFrac: 0.8, cx: 0.5 });
const clip = animate(30 /*Hz*/, [
  { at: 0.0,  pose: stand },
  { at: 1.0,  pose: stand },
  { at: 1.10, pose: hipDy(stand, +0.05) },   // the crouch before a jump
  { at: 1.26, pose: hipDy(stand, -0.22) },   // apex
  { at: 1.44, pose: stand },                 // landing
  { at: 2.5,  pose: stand },
]);
```

Modifiers, applied as a pipeline: `withNoise(σ=0.004)` (Gaussian, per-landmark), `withOutliers(p=0.01)` (a wrist teleports to a reflection — this is what median-of-3 is for), `withDropout(joints, frames)` (occlusion), `withLowVis(joints, 0.2)` (gate-don't-guess path), `atFps(15)` (Chromebook), `atScale(0.08 | 0.30)` (kid far away / kid up close).

The four assertions that matter, for every detector:

1. **exactly-once** — fires 1× per true event in the clip, 0 extra;
2. **latency ≤ 2 frames** from the true takeoff frame (fire on takeoff, not apex — pose.md is explicit that waiting for peak adds 100–150 ms of felt lag);
3. **zero false positives** over a 10 s noisy `idle` clip and over a 10 s `fidget` clip (arm scratching, weight shifting);
4. **invariance** — identical event counts across `atScale(0.08|0.15|0.30)` × `atFps(15|30)`. This single parameterised matrix is the test that keeps the game playable for a short kid 4 m from a Chromebook, and it is the one you cannot get from a camera session on the developer's MacBook.

### 5.3 L2 — manifest + registry completeness

`src/engine/__tests__/registry.test.ts`:

- every `games/*/manifest.ts` parses against the zod schema; `manifest.id === folderName`; a matching `index.ts` exists whose default export is a function; no duplicate ids;
- `ALL.size + disabledCount === folderCount`;
- **every id in `catalog.ts` (the 58) is either implemented or explicitly listed as `planned`** — so a dropped game is a visible, reviewed decision, never a silent omission;
- `howToKo.length ≤ 3`, `taglineKo.length ≤ 18`, `durationMs ∈ [25_000, 60_000]`, star cuts in the sane bands, `gestures[]` non-empty and every entry a real `GestureKind`;
- `a11y.keyboardFallback === true` unless the id is on an explicit allowlist (forces authors to justify a camera-only game);
- `dev.clip` names a file that exists in `fixtures/replay/`.

### 5.4 L3 — the recorded-landmark replay harness (the keystone)

**Record once.** `?record=1`, DEV-only and tree-shaken from production (`if (import.meta.env.DEV)`), accumulates `{t, lm:Int16Array(66), vis:Uint8Array(33)}` and offers a JSON download. One 20-minute session with one consenting adult produces the entire corpus:

```
fixtures/replay/idle-1p.json        10 s standing still, small fidgets   -> false-positive floor
fixtures/replay/fidget.json         10 s scratching, weight shifting     -> false-positive floor
fixtures/replay/reach-grid.json     40 s both hands raster-sweep the whole frame
                                        ⚑ the magic clip: guarantees a hit in every reach/catch/
                                          aim/zone game, i.e. ~25 games get a reachability test free
fixtures/replay/jump-x8.json        8 jumps, varied height
fixtures/replay/squat-x8.json       8 squats, varied depth
fixtures/replay/clap-x12.json       12 claps at varied height and speed
fixtures/replay/swing-wide.json     big arm swings both directions
fixtures/replay/step-lr.json        stepping/leaning left-right, feet in/out
fixtures/replay/knee-run.json       running in place, knee lifts, bike/stair motion
fixtures/replay/hold-poses.json     T / Y / star / one-leg, each held 3 s
fixtures/replay/two-cross.json      2 people walking through each other -> identity-swap regression
fixtures/replay/far-small.json      same person 4 m away, shoulderW ~0.07 -> scale regression
fixtures/replay/README.md           provenance, consent note, "adults only, never a child's data"
```

Privacy posture on this: arch.md §7.3 says never persist landmark arrays. The recorder is DEV-only, the corpus is consenting-adult data checked in as test fixtures, and `check-privacy.mjs` asserts the recorder does not appear in `dist/`. Write that in the README so nobody "helpfully" ships it.

**Replay headlessly.** `ReplayPoseSource implements PoseSource` feeds the clip through the *same* normalize → median → One Euro → extrapolate path as the camera, so it exercises real code, and it runs in Node because `PoseSource` only ever produces `Float32Array`s — no DOM.

**One test file smoke-tests every game:**

```ts
// src/games/__tests__/all-games.smoke.test.ts
const CLIPS = ['idle-1p', 'fidget', 'reach-grid', 'jump-x8', 'clap-x12', 'far-small'];
describe.each([...ALL_INCLUDING_DISABLED.keys()])('%s', (id) => {
  it.each(CLIPS)('survives %s', async (clip) => {
    const r = await runGame(id, { clip, seed: 7, renderer: new NullRenderer() });
    expect(r.threw).toBeNull();
    expect(r.result.normalized).toBeGreaterThanOrEqual(0);
    expect(r.result.normalized).toBeLessThanOrEqual(1);
    expect(r.nanDrawOps).toBe(0);           // NullRenderer throws on NaN/Infinity coords
    expect(r.framesWithNoDraw).toBe(0);     // a game that draws nothing is a black screen
    expect(r.allocGrowthKb).toBeLessThan(256);  // allocation in update()
  });
  it('is reachable on its own clip', async () => {              // the anti-dead-game test
    const r = await runGame(id, { clip: manifestOf(id).dev!.clip!, seed: 7 });
    expect(r.result.rawScore).toBeGreaterThan(0);
  });
  it('does not score on idle', async () => {                     // the anti-phantom-score test
    const r = await runGame(id, { clip: 'idle-1p', seed: 7 });
    expect(r.result.normalized).toBeLessThan(0.15);
  });
  it('is deterministic', async () => {                           // seeded replay integrity
    const a = await runGame(id, { clip: 'reach-grid', seed: 7 });
    const b = await runGame(id, { clip: 'reach-grid', seed: 7 });
    expect(a.result.rawScore).toBe(b.result.rawScore);
  });
});
```

`runGame` drives the real lifecycle at a true fixed timestep — `init → start → update×(durationMs/1000×60) → render(NullRenderer) → end` — so a 40 s game is ~2400 steps, ~30 ms of CPU. **58 games × 9 assertions runs in well under a minute**, which is why this can be an agent's pre-hand-back gate rather than a nightly job.

`NullRenderer` is the highest-value 80 lines in the test suite: it implements `Renderer`, throws on any non-finite coordinate, counts ops per frame, records the draw-call histogram, and asserts nothing is drawn outside `[-w, 2w] × [-h, 2h]` (catching off-screen-forever bugs that look like an empty game).

### 5.5 L4 — Browser-pane verification with no camera

`VirtualPoseSource` is the pivot: it synthesizes a full `PoseFrame` from keys, so **the Browser pane can play every game**. Routing flags: `?game=<id>&pose=virtual&seed=7&debug=1&skip=calib&dur=12&all=1&replay=<clip>`.

Lead's per-game loop:

```
mcp__Claude_Browser__preview_start({ name: 'mini-game' })
mcp__Claude_Browser__browser_batch([
  { name:'navigate', input:{ url:'http://localhost:5173/?game=air-whack-mole&pose=virtual&seed=7&debug=1&skip=calib&dur=12' }},
  { name:'computer', input:{ action:'key', text:'space' }},                   // through the countdown
  { name:'computer', input:{ action:'key', text:'z x z x c', repeat: 4 }},    // hands, claps
  { name:'computer', input:{ action:'screenshot', scale: 0.5 }},
])
mcp__Claude_Browser__read_console_messages({ onlyErrors: true })
mcp__Claude_Browser__javascript_tool({ text: "window.__mg.debug()" })  // {state, score, fps, detectors[]}
```

`window.__mg` (DEV-only) exposes `debug()`, `setState()`, `forceGesture('jump')` and `screenshotAt(ms)`, which makes `npm run shot -- <ids>` possible as a headless screenshot script agents run themselves.

The `?debug=1` overlay is not optional — arch.md §3.4 is right that nobody can tune a threshold without it. It renders: skeleton + landmark indices, per-detector bars with enter/exit lines drawn in and a flash on fire, inference fps + render fps + `inferenceAgeMs`, frame-time graph, per-player slot/id/present, calibration values, the current `Renderer` op count, and the seed. A teacher can also use it to diagnose a classroom machine.

Also verify with `resize_window({preset:'tablet'})` and `colorScheme:'dark'` once per wave — the 10-foot type scale and the dark in-game canvas are the two things that silently break.

### 5.6 What still requires real hardware (do not pretend otherwise)

Reserve one half-day session, after Wave 2, on: the oldest school Chromebook, one base iPad in Safari, one Windows laptop with hardware acceleration *off* (to hit the SwiftShader path deliberately). Measure: cold-load time on school Wi-Fi, warmup stall duration, steady-state fps at `lite×1`, whether `numPoses:2` or two cropped ROI passes wins, and the A/V+pose latency figure that sets the rhythm games' default offset. Those six numbers decide the cut lines in §6 — and none of them can be obtained from the replay harness.

---

## 6. Risks and cut lines

### 6.1 Risk register, ordered by probability × damage

| Risk | Why it bites | Mitigation | If it still bites |
|---|---|---|---|
| **20 MB cold load** (14.7 MB wasm + 5.8 MB model) on school Wi-Fi | the single worst first-run experience | self-host + Brotli + `immutable` + Cache API + progress bar during the privacy screen; `vite-plugin-pwa` precache so round 2 is instant | at >20 s, auto-offer keyboard mode and keep loading in the background |
| **Lazy shader compile stalls the first round** | the landmark subgraph compiles only when a body first appears — pose.md measured ~20 s cold | the `warmup` state's 3 passes over `/warmup/person.jpg`; 60 s timeout; an animated screen, never a frozen one | show "준비 중… 조금만 기다려 주세요" with a progress ring; never let the countdown start before warmup resolves |
| **Hardware acceleration off → SwiftShader → ~10 fps** | very common on locked-down school machines, and it looks like "the site is broken" | `capability.ts` reads `UNMASKED_RENDERER_WEBGL`; force 480×360 + `numPoses:1`; show a teacher-facing hint | if fps < 12 for 5 s, offer keyboard mode with one tap; disable all `intensity:3` games |
| **Multi-person identity swaps** | the model card lists multi-person as out of scope; `numPoses:2` degrades on crossing | 1-player default everywhere; versus games use spatial halves / two cropped ROI passes, not free-form `numPoses:2`; sticky slots, never re-sorted mid-round, never zero a score on track loss | ship all 4 versus games `enabled:false` |
| **Rhythm games feel broken** | ~50–90 ms pose latency + Bluetooth speaker latency + 7-year-olds | kid windows ±60/120/200 ms; subtract measured `inferenceAgeMs` + filter group delay from every motion judgement; A/V calibration screen (clap 8 beats, take the median); always a visual beat ring | if the calibration screen slips, set all 6 rhythm games `enabled:false` — an uncalibrated rhythm game is worse than no rhythm game |
| **iPad home-screen PWA camera deadlock** | WebKit #252465, reported through iOS 18.5, often needs a device restart | ship as a normal Safari tab; suppress the install prompt; re-acquire on `visibilitychange`; watch `track.muted` | documented as unsupported in the teacher PDF |
| **iPad Low Power Mode halves fps silently** | no API to detect it | permanent fps readout in `?debug`, and an automatic "기기가 느려요" toast below 15 fps | one player per iPad |
| **Pose-target library becomes a bottleneck** | 10 games depend on target poses | generate parametrically from `synth.ts`; only 3–4 hand-recorded targets | cut the similarity family (see below) |
| **An agent edits the engine** | silently breaks 20 games | `check-frozen.mjs` sha256 + diff-path gate + the explicit NEEDS.md escape valve | reject the whole batch; it is cheaper than archaeology |
| **Everyone awards 3 stars** | 50 authors, 50 difficulty curves | engine computes stars from `starCuts`; test asserts cuts fall in sane bands; replay harness reports the score a mediocre clip achieves | lead re-tunes cuts during the enable pass — a 1-line manifest change, no code |
| **`photo-pose-booth` breaks the privacy guarantee** | needs capture; `check-privacy.mjs` bans it; arch.md §7.3 says biometric data is now explicitly personal information | re-spec as live stickers with no save path, or drop | drop |
| **Physical safety** | kids jumping into furniture, into each other | the 15 s safety screen; `space:'room'` games gated on it; never 3× `intensity:3` in a row; a seated game after every two high-intensity ones; mandatory break every 8 games / 10 min | drop `space:'room'` games to `enabled:false` for classroom deployments |
| **58 games is more than can be polished** | the real risk | target **~34 enabled at launch**, everything else `enabled:false` in the repo | §6.2 |

### 6.2 Cut lines, in the exact order to cut

Cut from the bottom up. `enabled:false` rather than delete, always — the code keeps compiling, keeps passing the replay harness, stays out of the roulette pool, and `?all=1` still reaches it for later tuning. Deleting a game throws away a working asset and breaks the `catalog.ts` completeness story.

1. **Cut first — bespoke engine for one game.** `shadow-puppet-theater` (`poseRig`), `photo-pose-booth` (forbidden capture), `cover-dance` (choreography timeline + long duration). Three games, three exclusive subsystems. Never start these before Wave 3 lands.
2. **Cut second — the versus/multi-player four.** `high-touch-jump`, `mirror-the-leader`, `body-rock-paper-scissors`, `snowball-fight` 2P mode. Their dependency (reliable 2-person identity) is the one thing the research says the model does not do. They should be `enabled:false` on day one regardless, and only enabled after on-hardware validation.
3. **Cut third — the rhythm six**, if the beat scheduler or the latency calibration screen slips: `beat-clap`, `step-rhythm`, `air-drums`, plus the optional beat modes of `jump-rope-king` and `mirror-the-leader`, plus `cover-dance`.
4. **Cut fourth — the glyph three.** `body-hangul`, `body-number`, `human-tetris` need a target-shape library per letter/digit/piece. High authoring cost per unit of fun.
5. **Cut fifth — the similarity family**, if the pose library slips: `pose-match-shadow`, `animal-mimic`, `constellation-pose`, `tree-pose-yoga`.
6. **Cut audio polish before cutting games.** Silence is survivable (every voice line is mirrored as on-screen Korean text, every beat cue has a visual pulse). A missing visual cue is not. If audio sourcing/licensing runs long, ship with Kenney CC0 SFX only and no music.

**Never cut, in any scenario** — the 12-game launch set, chosen for coverage (seated/standing, 4 mechanic families, intensity 1–3) and because none needs a service beyond Wave 1:

`mosquito-clap` · `candy-rain-catch` · `air-whack-mole` · `balloon-pop-party` · `fruit-slash` · `wrist-aim-target` · `spider-touch` · `max-reach-stretch` · `cheer-combo` · `wave-jump` · `limbo-king` · `scan-hold-still`

Spares one tier out, enabled as soon as they pass review: `castle-defense`, `goalkeeper-save`, `web-cut`, `connect-dots-order`, `statue-hold`, `red-light-green-light`, `lane-runner`, `airplane-lean`.

### 6.3 Disabled-by-default policy, stated once

Every agent-authored manifest ships `enabled: false`. The lead flips it to `true` only after playing it. Consequences, all good: the pool is always playable mid-build; the roulette never serves a broken game; "we cut it" and "we haven't tuned it yet" are the same cheap, reversible state; and the registry completeness test still validates everything, enabled or not.

---

### Critical Files for Implementation

- `/Users/newuser/Github_kimmaru/Shinil_mini_Game_26/src/engine/types.ts` — FROZEN CONTRACT #1; add the `dev?: { clip?: string }` manifest field before freezing
- `/Users/newuser/Github_kimmaru/Shinil_mini_Game_26/src/engine/render/renderer.ts` — the `Renderer` interface, which neither brief defines and 50 agents will otherwise each invent; shapes + emoji only, no `ctx` escape hatch
- `/Users/newuser/Github_kimmaru/Shinil_mini_Game_26/src/engine/gestures/index.ts` — `GestureService.use()` rent-in-init contract plus every `Signal` type
- `/Users/newuser/Github_kimmaru/Shinil_mini_Game_26/src/games/mosquito-clap/index.ts` — the canonical reference every game agent copies
- `/Users/newuser/Github_kimmaru/Shinil_mini_Game_26/src/engine/testing/harness.ts` — `runGame()` + `ReplayPoseSource` + `NullRenderer`; the reason 50 games can be validated without 50 camera sessions
- `/Users/newuser/Github_kimmaru/Shinil_mini_Game_26/src/engine/pose/virtual.ts` — `VirtualPoseSource`; makes `keyboardFallback` free and makes Browser-pane verification possible
- `/Users/newuser/Github_kimmaru/Shinil_mini_Game_26/AGENTS.md` — the prohibition list and the NEEDS.md escape valve; the file that keeps the parallel waves from corrupting the engine
# 미니게임 작성 가이드

Read `AGENTS.md` first for the rules. This document is the *craft*: how to make
a 40-second game that a 9-year-old finds delightful, using only this engine.

---

## 1. Your game is one of three shapes

Every game in the 58-game catalogue is one of three update-loop shapes. Read
the reference for your shape **in full** before writing a line. Copying across
shapes is where mistakes happen.

| Shape | Reference | Loop | Catalogue count |
|---|---|---|---|
| **A — Trigger** | `src/games/mosquito-clap/` | A discrete gesture fires; test it against on-screen objects | ~22 |
| **B — Overlap** | `src/games/candy-rain-catch/` | Objects move continuously; body parts overlap them | ~12 |
| **C — Locomotion** | `src/games/wave-jump/` | A world scrolls; body signals dodge/clear it | ~10 |

The rest (pose-match, rhythm, memory, balance) are variations on A and B with a
different signal source.

---

## 2. The skeleton of a game

```ts
// src/games/my-game/index.ts
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { L, palm, visible } from '@/engine/pose/landmarks';
import { hitSegCircle } from '@/engine/math';
import { Entities } from '@/engine/entities';
import { Spawner } from '@/engine/spawn';
import { C } from '@/engine/render/palette';
import { t } from './locale';

class MyGame implements MiniGame {
  private ctx!: GameContext;
  private clap!: Detector<'clap'>;
  private bugs = new Entities(64);
  private spawner!: Spawner;
  // Pre-allocated scratch. NOTHING is allocated in update() or render().
  private readonly pL: Pt = { x: 0, y: 0 };
  private readonly pR: Pt = { x: 0, y: 0 };
  private score = 0;
  private combo = 0;
  private best = 0;
  private hits = 0;
  private misses = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.clap = ctx.gestures.use('clap', { cooldownMs: 280 });
    this.spawner = new Spawner(
      { startInterval: 1.5, endInterval: 0.6 },
      ctx.rng,
      ctx.manifest.durationMs / 1000,
    );
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
  }

  update(dt: number, f: PoseFrame): void {
    const p = f.p1;
    for (let i = 0, k = this.spawner.tick(dt); i < k; i++) this.spawnBug();
    this.bugs.step(dt);
    this.bugs.cullOutside(-50, -50, 1e4, 1e4);

    if (p) {
      const s = this.clap.read(f);
      if (s.fired) this.resolveClap(s.at.x, s.at.y, s.power);
    }
    this.bugs.sweep();
  }

  render(g: Renderer, _interp: number): void {
    g.clear(this.ctx.manifest.theme?.hue);
    for (let i = 0; i < this.bugs.n; i++) {
      g.sprite('mosquito', this.bugs.x[i]!, this.bugs.y[i]!, this.bugs.r[i]! * 2, { rot: this.bugs.rot[i]! });
    }
  }

  end(_reason: EndReason): GameResult {
    return {
      gameId: this.ctx.manifest.id,
      cleared: this.score > 0,
      rawScore: this.score,
      maxScore: this.ctx.manifest.scoring.maxScore,
      normalized: 0,  // the ENGINE computes this and `stars`
      stars: 0,
      durationMs: this.ctx.manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score: this.score,
        hits: this.hits, misses: this.misses, bestCombo: this.best,
      }],
      highlightsKo: this.best >= 5 ? [`콤보 ${this.best}연속!`] : undefined,
    };
  }
  // ...
}

export default (): MiniGame => new MyGame();
```

### The lifecycle contract
- `init()` — allocate **everything**. Rent every detector here.
- `start()` — the countdown is over; arm things. Do not allocate.
- `update(dt, frame)` — `dt` is **always** 1/60. Do not allocate.
- `render(g, interp)` — `interp` is 0..1 into the next step, for smoothing fast
  motion. Call `g.clear()` first; the engine does not clear for you.
- `end(reason)` — return the result. Leave `normalized` and `stars` at 0; the
  engine computes them from `starCuts` so the rating means the same thing in
  every game.

---

## 3. Coordinates — the bug you will otherwise ship

There are two spaces and mixing them is the most common error.

| | Use for | Access |
|---|---|---|
| **`px`** view pixels, already mirrored | drawing, hit tests against screen objects | `jx(p,j)`, `jy(p,j)`, `palm(p,'L',out)` |
| **`n`** normalized: hip-centred, **1 unit = shoulder width**, +y down | every threshold and comparison | `nx(p,j)`, `ny(p,j)`, `jointDist(p,a,b)` |

**Never threshold on `px`.** A child 1m from a laptop has a shoulder width of
~380px; the same child 3m from a TV has ~90px. A `px` threshold means your game
works for exactly one camera distance and one body size. `npm run gate` runs
your game against the `far-small` clip specifically to catch this.

Scale your *drawing* with `g.s` (= `min(w,h)/1000`), never hard pixels:
```ts
const r = 48 * g.s;             // good
const r = 48;                   // breaks on a TV and on a 13" laptop
```

Remember: the preview is mirrored, so it behaves like a real mirror — a child
raising their left hand sees it on the **left** of the screen. `L.LEFT_WRIST`
is the subject's left hand and it is the screen-left one, so a game prompting
"왼손을 들어요" watches `L.LEFT_WRIST`. Decided once, in `landmarks.ts`.

---

## 4. Thresholds that work

Start from these. They come from the measured values in `docs/RESEARCH-POSE.md`
§5.5 and are what the engine's detector defaults use.

| Signal | Value | Note |
|---|---|---|
| Jump takeoff | hip v < **-1.5** shoulder-widths/sec | Fire on the **first** upward frame. Waiting for the apex adds 100–150ms and children read it as broken. |
| Jump re-arm | hip within **0.1** of baseline | Never re-arm on a timer. |
| Squat enter / exit | **0.45** / **0.22** below baseline | Hip displacement, not knee angle: knee angle is unreliable head-on, which is how a party game is played. |
| Clap close / open | **0.42** / **0.75** wrist separation | Plus a minimum closing speed, or slowly folded hands register. |
| Raise arm | wrist **0.25** above shoulder | Shoulder-relative, never nose-relative. |
| Swing | palm speed > **2.2** units/sec | Use `hitSegCircle(from→to)`: a fast swing covers 100+px between frames, so a point test misses exactly when the player is trying hardest. |
| Lean enter / exit | **0.30** / **0.15** | |
| Step enter / exit | **0.55** / **0.30** | Baseline must **freeze while triggered** or it drifts into the step. |
| Hold a pose | **0.3–0.8s** | A passing arm swing must not count. |
| Dwell to select | **1.0s** with a visible ring | The ring is the only way a player knows a selection is happening. |
| Stillness | **3×** the player's own `calib.idleEnergy` | Children cannot hold still. A global constant fails them; this is the single most important fairness decision in the freeze games. |
| Any scoring cooldown | **≥ 250ms** | |
| Target radius | **≥ 8%** of view width | Kinect's own guidelines found 100px buttons with 50px gaps still mis-triggered. Go bigger than feels necessary. |

**Use a rented detector instead of rolling your own.** `ctx.gestures.use(...)`
gives you hysteresis, cooldown, confirm-frames, visibility gating and
engine-owned resets. Hand-rolled threshold code is where double-scoring lives.

---

## 5. Fairness — this is not optional

Mixed-age groups lose interest within seconds if the taller child always wins.

```ts
// BAD: a fixed screen position. Tall children win; short children cannot reach.
const target = { x: g.w * 0.9, y: g.h * 0.1 };

// GOOD: placed at 95% of THIS player's own reach.
const reach = this.reach.read(f);
const limit = p.calib.armLen * p.scalePx * 0.95;
```

Same for every vertical: limbo bar height, jump-touch height, hold duration.
Scale them from `ctx.profiles` / `p.calib`, so every child is asked for the same
*effort*, not the same *distance*. `limbo-king`, `max-reach-stretch` and
`high-touch-jump` are the model cases.

---

## 6. Safety

Never require:
- more than ~10 jumps in a round, or sustained jumping for more than ~30s
- arms held overhead for more than ~10s
- spinning (pose estimation flips left/right, and it makes children dizzy)
- floor contact — the body leaves the camera frame, and classrooms
- deep one-legged reaches (slipping)
- repeated asymmetric load: alternate sides

Set `intensity: 3` honestly. The scheduler uses it to refuse serving two hard
games back to back and to time the break prompt. Under-reporting intensity to
look impressive makes a child's afternoon worse.

---

## 7. Feel — where the delight actually comes from

Budget your effort here, not on mechanics. A simple game with great feedback
beats a clever game with none.

```ts
// A hit should produce, within 100ms:
// ONE call, one grade. Particles, ring, shake, hitstop, squash and the
// floating score all land together at the catalogue's standard weight.
ctx.fx.impact(x, y, 'hit', { label: '+10', sprite: 'sparkle', squashKey: id });
ctx.audio.playLadder('pop', this.combo);     // pitch rises with the combo
```

Rules learned from this genre:
- **A rising pitch per combo step** is the cheapest and strongest reward signal
  that exists. Use `playLadder`.
- **Misses are quiet.** Break the combo, play nothing or something soft, show no
  red X. Repeated failure indicators make 7-year-olds quit.
- **Everything enters with scale 0.86→1 + fade** (`easeOutBack`). Nothing cuts.
- **Always show the body.** Draw `g.skeleton(p)` or `g.ghostBody(p)` somewhere,
  always. Even with 100ms of latency, visible response to movement reads as "it
  can see me"; a game that shows nothing reads as broken.
- **Partial success is feedback.** If a pose is 3/4 correct, show which 3. Use
  the `perJoint` arrays.
- Reserve `fx.confetti()` for the end of a round, not every hit.

---

## 8. Scoring and star cuts

```ts
scoring: { kind: 'count', maxScore: 24, starCuts: [0.25, 0.5, 0.75] }
```

`maxScore` is what a **strong player** reaches, not a theoretical maximum. Then:
- `starCuts[0]` ≈ 0.25 — "you played and it worked". Must be easy.
- `starCuts[1]` ≈ 0.50 — "you are getting it".
- `starCuts[2]` ≈ 0.75 — "that was good". **Must be reachable** by a competent
  9-year-old, or the third star means nothing.

`npm run gate` rejects cuts outside sane bands. The replay harness reports what
a mediocre clip actually scores; if `reach-grid` already gets three stars, your
`maxScore` is too low.

---

## 9. Korean copy

| Field | Limit | Guidance |
|---|---|---|
| `nameKo` | ≤ 20 chars | Fun and concrete: "모기 박수", "사탕비 받아요" |
| `taglineKo` | ≤ 18 reads best | What you *do*: "모기를 박수로 잡아요!" |
| `howToKo` | 1–3 lines, ≤ 40 chars each | Imperative, 2nd-grade vocabulary, one action per line |

Put every string in `locale.ts`, never inline. Avoid 한자어 and English
loanwords where a plain word exists. Prefer 해요체 ("잡아요", "뛰어요") — it is
the register children are taught in.

```ts
// src/games/my-game/locale.ts
const S = {
  goal: '모기를 잡아요!',
  perfect: '완벽해요!',
} as const;
export const t = (k: keyof typeof S): string => S[k];
```

---

## 10. Sound

Only ids from `SFX_IDS` (`src/engine/audio/sfx.ts`). There are no audio files
and new ids are rejected by the gate. A rough map:

| Situation | Ids |
|---|---|
| Normal hit | `hit.soft`, `pop`, `pop.high` |
| Big hit | `hit.hard`, `hit.crit`, `break` |
| Combo | `combo.up` via `playLadder`, `combo.break` |
| Miss | `miss` (soft), `buzz` (only for a real penalty) |
| Motion | `swing`, `clap`, `jump`, `land`, `step`, `whoosh`, `splash` |
| Round | `round.start`, `round.win`, `round.lose`, `star.1/2/3`, `fanfare` |
| Melody | `note.c` … `note.b`, `chime`, `sparkle` |

### Impact grades

| grade | when |
|---|---|
| `tap` | collecting, touching |
| `hit` | **the default** |
| `big` | a break, a 10-combo |
| `huge` | a boss, a milestone — once or twice a round |

`ctx.fx.miss(x, y)` for a miss. It is quiet by construction: no shake, no
flash, no red — the engine refuses to make a miss loud even if you ask.

**Audio is never load-bearing.** Every spoken or sung cue must have a visual
twin. If your game is unplayable muted, set `a11y.audioOptional: false` and the
engine will render a beat ring for you.

---

## 11. Keyboard fallback is free — do not write it

`VirtualPoseSource` synthesizes a complete `PoseFrame` from keys, with
velocities consistent with the positions, so **every detector fires exactly as
it does for a real body**. Games must never branch on input source.

`Space` jump · `↓` squat · `←/→` lean-step · `Z`/`X` raise hand · `C` clap ·
mouse = dominant hand.

So `a11y.keyboardFallback: true` is usually just true. Set it `false` only if
your game genuinely needs something the keyboard cannot express (whole-room
zone occupancy, for instance) — the pool filter will then hide it in keyboard
mode instead of serving a broken round.

---

## 12. Test your game

```bash
npx tsc --noEmit
npm run gate
npx vitest run src/games/__tests__ -t "my-game"
npm run shot -- my-game        # look at the PNG. A black image is a bug.
```

The shared smoke test asserts, for every game:
1. survives 8 clips with no crash, no NaN coordinate, no blank frame, no
   allocation growth
2. **scores > 0** on its own `dev.clip` — the anti-dead-game test
3. **scores < 0.15** on `idle` — the anti-phantom-score test
4. the same seed gives the same score — replay integrity

Set `dev: { clip: 'clap-x12' }` to the clip that exercises your main gesture.
Clips available: `idle`, `fidget`, `reach-grid`, `jump-x8`, `squat-x8`,
`clap-x12`, `swing-wide`, `step-lr`, `knee-run`, `hold-poses`, `two-cross`,
`far-small`, `no-legs`, `laggy`.

`reach-grid` sweeps both hands across the whole frame, so it answers "can the
player actually reach my targets?" for free. If your game scores 0 on
`reach-grid`, your targets are unreachable.

In the browser:
`?game=my-game&pose=virtual&seed=7&debug=1&skip=calib&dur=12`

---

## 13. Checklist before you hand back

- [ ] No allocation in `update()`/`render()` (no `{}`, `[]`, `.map`, template strings)
- [ ] Every threshold in normalized units; passes the `far-small` clip
- [ ] A rented detector, or hysteresis + ≥250ms cooldown, for every scoring event
- [ ] The body is drawn on screen at all times
- [ ] Target radius ≥ 8% of view width
- [ ] Sizes scaled by `g.s`
- [ ] Hit feedback within 100ms: burst + sound + (shake or hitstop)
- [ ] Misses are quiet
- [ ] Korean strings all in `locale.ts`; 2nd-grade vocabulary
- [ ] Only `SFX_IDS` sounds
- [ ] Honest `intensity`, honest `space`, honest `requiredLandmarks`
- [ ] `starCuts` reachable; `maxScore` = a strong player's score
- [ ] `dev.clip` set, and the game scores > 0 on it
- [ ] `enabled: false`
- [ ] `npm run gate` green


---

## 14. Art: sprites, not emoji

All art is vector sprites drawn from SVG path data. **`ART.md` is the full
guide**; the three rules that catch people out:

1. **Reuse before you draw.** `spriteIds()` lists what exists — 77 sprites,
   including `star heart circle ring target balloon candy rock basket mosquito
   bee wave bubble droplet check cross burst` plus `ui-*` and `g-*` sets. Many
   needs are an existing sprite with a `tint`: a snowball is `circle` tinted
   white, a meteor is `rock` with a glow.
2. **At most 2 new sprites per game**, in `src/games/<id>/sprites.ts`, with ids
   namespaced `<game-id>:<name>`. Three means the design needs rethinking or
   the shape belongs in the shared set.
3. **Colour comes from palette ROLES**, never a literal hex — that is what lets
   one sprite serve games of different hues.

```ts
g.sprite('balloon', x, y, 72 * g.s, { rot, hue: 320 });
```

The canvas is **light** (warm cream). Sprite keylines are near-black ink;
plain white fills are invisible. Scale every size by `g.s`.

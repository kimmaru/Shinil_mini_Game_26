// createFxService(): the FxService 58 games call, plus the draw pass the loop
// calls.
//
// HOW THE LOOP DRIVES THIS (the lead's src/engine/loop.ts)
//
//   fx.setView(g.w, g.h, g.s);        // on resize, or let draw() infer it
//   fx.update(dtReal);                // ALWAYS real dt: fx keeps animating
//                                     // during hitstop, which is the point
//   if (fx.timeScale > 0) game.update(1/60, frame);
//
//   g.beginFrame(t);
//   g.save();
//   fx.applyCamera(g);                // shake the world, not the chrome
//   game.render(g, interp);
//   g.restore();
//   fx.draw(g);                       // particles (shaken), then flash (not)
//   g.endFrame();
//
// A game never manages a particle list, never owns a shake decay, and never
// gets to decide how often the screen may flash.
import { C } from '../render/palette';
import type { FxService, BurstOpts, TrailOpts } from './index';
import type { Renderer, Slot } from '../types';
import { Flash } from './flash';
import {
  KIND_CONFETTI,
  KIND_DOT,
  KIND_EMOJI,
  KIND_SPARK,
  PopTexts,
  Particles,
  Rings,
  Trails,
  parseColor,
} from './particles';
import { Hitstop, Shake } from './shake';

const TAU = Math.PI * 2;

/** fx has its OWN rng, seeded from a constant.
 *
 *  It must not draw from `ctx.rng()`: adding a particle burst to a game would
 *  then shift every subsequent spawn, and the replay tests that make 58 games
 *  verifiable would break for a cosmetic change. */
const FX_SEED = 0x6a7_51ce;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FxStats {
  particles: number;
  rings: number;
  trails: number;
  popTexts: number;
  particlesDropped: number;
  flashesFired: number;
  flashesDropped: number;
  trauma: number;
  hitstopSec: number;
}

/** What the loop gets back. Games only ever see the `FxService` half. */
export interface FxRuntime extends FxService {
  /** Advance every effect. Always pass REAL dt, never the hitstop-scaled dt. */
  update(dtRealSec: number): void;
  /** Apply camera shake. Call between `g.save()` and the game's `render()`. */
  applyCamera(g: Renderer): void;
  /** Draw the fx pass on top of the game. Call after `g.restore()`. */
  draw(g: Renderer): void;
  /** 0 while a hitstop is freezing the fixed-step clock, else 1. */
  readonly timeScale: number;
  readonly hitstopRemaining: number;
  /** Logical px + Renderer.s. `draw()` also infers these, so this is only
   *  needed to get the very first frame's default sizes right. */
  setView(w: number, h: number, s: number): void;
  /** `true`/`false` to override, `null` to follow `prefers-reduced-motion`. */
  setReducedMotion(on: boolean | null): void;
  /** Wire to `manifest.a11y.noFlashing`. */
  setFlashEnabled(on: boolean): void;
  /** Between rounds. Leaves nothing from the last game on screen. */
  resetAll(): void;
  readonly stats: FxStats;
}

export interface FxOptions {
  seed?: number;
  /** `null` = follow the OS/browser setting. */
  reducedMotion?: boolean | null;
  flashing?: boolean;
  particleCap?: number;
}

function prefersReducedMotion(): boolean {
  const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  if (typeof mm !== 'function') return false;
  try {
    return !!mm('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

interface Squash {
  amt: number;
  t: number;
  dur: number;
}

class FxImpl implements FxRuntime {
  private readonly rng: () => number;
  private readonly parts: Particles;
  private readonly rings = new Rings(48);
  private readonly trails = new Trails(120);
  private readonly pops = new PopTexts(24);
  private readonly shaker = new Shake();
  private readonly stop = new Hitstop();
  private readonly fl = new Flash();

  /** Keyed squash timers. One Map entry per distinct key, allocated on first
   *  use and reused forever after — this is why `squash` takes a string key
   *  instead of returning a handle a game would have to store. */
  private readonly squashes = new Map<string, Squash>();

  private rmOverride: boolean | null;
  private rmSystem = false;

  private vw = 1280;
  private vh = 720;
  private vs = 0.72;

  private readonly _stats: FxStats = {
    particles: 0, rings: 0, trails: 0, popTexts: 0,
    particlesDropped: 0, flashesFired: 0, flashesDropped: 0,
    trauma: 0, hitstopSec: 0,
  };

  constructor(o?: FxOptions) {
    this.rng = mulberry32(o?.seed ?? FX_SEED);
    this.parts = new Particles(this.rng, o?.particleCap);
    this.rmOverride = o?.reducedMotion ?? null;
    this.rmSystem = prefersReducedMotion();
    this.fl.setEnabled(o?.flashing ?? true);
    this.fl.setReduced(this.reducedMotion);
  }

  // ─── Settings ────────────────────────────────────────────────────────────

  get reducedMotion(): boolean {
    return this.rmOverride ?? this.rmSystem;
  }

  setReducedMotion(on: boolean | null): void {
    this.rmOverride = on;
    if (on === null) this.rmSystem = prefersReducedMotion();
    this.fl.setReduced(this.reducedMotion);
  }

  setFlashEnabled(on: boolean): void {
    this.fl.setEnabled(on);
  }

  setView(w: number, h: number, s: number): void {
    if (w > 0) this.vw = w;
    if (h > 0) this.vh = h;
    if (s > 0) this.vs = s;
    this.shaker.setScale(this.vs);
  }

  // ─── Frame ───────────────────────────────────────────────────────────────

  update(dt: number): void {
    const d = Number.isFinite(dt) ? Math.min(0.1, Math.max(0, dt)) : 0;
    this.parts.beginFrame();
    this.parts.update(d);
    this.rings.update(d);
    this.trails.update(d);
    this.pops.update(d);
    this.shaker.update(d);
    this.stop.update(d);
    this.fl.update(d);
    // Map.forEach, not `for..of entries()`: the iterator form allocates a
    // two-element tuple per entry per frame.
    this.dtTmp = d;
    this.squashes.forEach(this.tickSquash);
  }

  private dtTmp = 0;
  private readonly tickSquash = (s: Squash, k: string): void => {
    s.t += this.dtTmp;
    if (s.t >= s.dur) this.squashes.delete(k);
  };

  get timeScale(): number {
    return this.stop.timeScale;
  }

  get hitstopRemaining(): number {
    return this.stop.remaining;
  }

  applyCamera(g: Renderer): void {
    if (!this.shaker.active) return;
    g.translate(this.shaker.x, this.shaker.y);
    const r = this.shaker.rot;
    if (r !== 0) {
      // Rotate about the centre, not the origin, or the whole frame swings out
      // of view instead of shuddering.
      g.translate(g.w / 2, g.h / 2);
      g.rotate(r);
      g.translate(-g.w / 2, -g.h / 2);
    }
  }

  draw(g: Renderer): void {
    this.setView(g.w, g.h, g.s);
    g.save();
    this.applyCamera(g);
    this.trails.draw(g);
    this.rings.draw(g);
    this.parts.draw(g);
    this.pops.draw(g, Math.max(26, 44 * this.vs));
    g.restore();
    // Screen space: a flash locked to the shaking world reads as a glitch.
    this.fl.draw(g);
  }

  resetAll(): void {
    this.parts.clear();
    // Reopen the per-frame spawn budget too, or the first burst of the new
    // round is silently truncated by the last frame of the old one.
    this.parts.beginFrame();
    this.rings.clear();
    this.trails.clear();
    this.pops.clear();
    this.shaker.reset();
    this.stop.reset();
    this.fl.reset();
    this.squashes.clear();
  }

  get stats(): FxStats {
    const s = this._stats;
    s.particles = this.parts.count;
    s.rings = this.rings.count;
    s.trails = this.trails.count;
    s.popTexts = this.pops.count;
    s.particlesDropped = this.parts.dropped;
    s.flashesFired = this.fl.fired;
    s.flashesDropped = this.fl.dropped;
    s.trauma = this.shaker.amount;
    s.hitstopSec = this.stop.remaining;
    return s;
  }

  // ─── FxService ───────────────────────────────────────────────────────────

  burst(x: number, y: number, o?: BurstOpts): void {
    const emoji = o?.emoji;
    const isEmoji = !!emoji;
    const count = o?.count ?? (isEmoji ? 6 : 18);
    const col = o?.color ?? C.accent;
    const c0 = parseColor(col);
    const c1 = o?.color2 ? parseColor(o.color2) : c0;
    // Tuned against a real 1280x720 canvas, not in the abstract: at the old
    // 480*s with 0.86 drag a burst travelled ~40px and read as a smudge rather
    // than a spray. A hit burst wants ~90-120px of throw at 720p.
    const speed = o?.speed ?? 620 * this.vs;
    const spread = o?.spread ?? TAU;
    const dir = o?.dir ?? 0;
    const life = o?.life ?? 0.6;
    const size = o?.size ?? (isEmoji ? 30 * this.vs : 6 * this.vs);
    const grav = o?.gravity ?? 0;
    // Sparks (no gravity) streak; debris (gravity) tumbles as dots.
    const kind = isEmoji ? KIND_EMOJI : grav > 400 ? KIND_DOT : KIND_SPARK;
    this.parts.emit(
      count, x, y, speed, dir, spread, life, size,
      grav, grav > 0 ? 0.95 : 0.92, kind, c0, c1, emoji ?? '',
    );
    // A slower inner ring of round dots gives the burst a core, so it reads as
    // one impact rather than as a scatter of unrelated streaks.
    if (!isEmoji) {
      this.parts.emit(
        Math.max(2, Math.round(count * 0.3)), x, y, speed * 0.5, dir, spread,
        life * 1.25, size * 1.25, grav * 0.5, 0.93, KIND_DOT, c0, c1, '',
      );
    }
  }

  confetti(o?: BurstOpts): void {
    const count = o?.count ?? 150;
    const c0 = parseColor(o?.color ?? C.accent);
    const c1 = parseColor(o?.color2 ?? C.hot);
    const life = o?.life ?? 2.2;
    const size = o?.size ?? 9 * this.vs;
    if (this.reducedMotion) {
      // "confetti becomes a single static burst" — one gentle puff from the
      // centre, no two-second rain of moving objects across the whole screen.
      this.parts.emit(
        Math.min(40, count), this.vw / 2, this.vh * 0.42,
        300 * this.vs, -Math.PI / 2, TAU, 0.7, size,
        260 * this.vs, 0.88, KIND_DOT, c0, c1, '',
      );
      return;
    }
    if (o?.emoji) {
      this.parts.emitLine(
        Math.min(40, Math.round(count * 0.25)),
        0, -this.vh * 0.06, this.vw, -this.vh * 0.02,
        140 * this.vs, Math.PI / 2, 1.2, life, o.size ?? 34 * this.vs,
        300 * this.vs, 0.985, KIND_EMOJI, c0, c1, o.emoji,
      );
    }
    this.parts.emitLine(
      count, 0, -this.vh * 0.08, this.vw, -this.vh * 0.02,
      200 * this.vs, Math.PI / 2, 1.4, life, size,
      320 * this.vs, 0.985, KIND_CONFETTI, c0, c1, '',
    );
  }

  shake(power: number, durationSec?: number): void {
    // Suppressed, not reduced. Motion sickness is not a volume knob, and these
    // children are already moving their whole bodies.
    if (this.reducedMotion) return;
    this.shaker.setScale(this.vs);
    this.shaker.add(power, durationSec ?? 0.3);
  }

  flash(color?: string, power?: number): void {
    this.fl.request(color, power);
  }

  pop(x: number, y: number, r: number, color?: string): void {
    this.rings.add(x, y, r, parseColor(color ?? C.white), 0.36);
  }

  trail(x0: number, y0: number, x1: number, y1: number, o?: TrailOpts): void {
    this.trails.add(
      x0, y0, x1, y1,
      o?.width ?? 10 * this.vs,
      parseColor(o?.color ?? C.primaryLo),
      o?.life ?? 0.25,
    );
  }

  hitstop(seconds: number): void {
    this.stop.add(seconds);
  }

  squash(key: string, amount = 0.35): void {
    if (!key) return;
    const cur = this.squashes.get(key);
    const amt = Math.min(1, Math.max(0, amount));
    if (cur) {
      cur.amt = Math.max(cur.amt, amt);
      cur.t = 0;
      return;
    }
    // Cap the key space: a game keying by entity id with a pool of 500 would
    // otherwise grow this Map without bound.
    if (this.squashes.size >= 64) this.squashes.clear();
    this.squashes.set(key, { amt, t: 0, dur: 0.26 });
  }

  squashAt(key: string): number {
    const s = this.squashes.get(key);
    if (!s) return 0;
    const t = 1 - s.t / s.dur;
    if (t <= 0) return 0;
    return s.amt * (1 - Math.pow(1 - t, 3)); // easeOutCubic decay
  }

  popText(x: number, y: number, text: string, color?: string): void {
    this.pops.add(x, y, text, parseColor(color ?? C.accentHi), 0.95, -150 * this.vs);
  }

  slotColor(slot: Slot): string {
    return C.slot[slot] ?? C.slot[0];
  }
}

export function createFxService(o?: FxOptions): FxRuntime {
  return new FxImpl(o);
}

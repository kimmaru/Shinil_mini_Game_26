// Pooled particles, struct-of-arrays, zero allocation per frame.
//
// Budget, and why it is this low:
//
//   PARTICLE_CAP        900   every live particle is one Renderer draw call,
//                             and the target device is a school Chromebook on
//                             integrated graphics already spending ~8ms/frame
//                             on pose inference. 900 round dots is ~2-3ms;
//                             3000 is a dropped frame, every frame.
//   MAX_PER_BURST       300   the contract says "asking for 5000 gets you
//                             ~300". One hit cannot own the whole pool.
//   MAX_SPAWN_PER_FRAME 450   a game that calls burst() in update() for every
//                             entity (and one will) is capped at half a pool
//                             per frame instead of refilling it 60 times a
//                             second.
//   soft pressure       >70%  past 70% full, new bursts are scaled down rather
//                             than truncated, so the LAST hit of a big combo
//                             still shows something instead of nothing.
//
// Randomness comes from an injected seeded rng, never Math.random: fx must be
// reproducible in replay tests, and it must NOT draw from the game's own rng
// stream or adding a particle effect would change the game's spawn pattern.
import type { Paint, Renderer, TextOpts } from '../types';

export const PARTICLE_CAP = 900;
export const MAX_PER_BURST = 300;
export const MAX_SPAWN_PER_FRAME = 450;
const PRESSURE_FROM = 0.7;

export const KIND_DOT = 0;
export const KIND_SPARK = 1;
export const KIND_CONFETTI = 2;
export const KIND_EMOJI = 3;

export type Rng = () => number;

// ─── Colour ──────────────────────────────────────────────────────────────────
//
// Games hand us CSS colour strings (`C.accent`, `hue(210)`, `fade(...)`). We
// need numeric RGB to interpolate per particle, and a colour string again to
// draw. Both directions are cached, so after the first frame of a given effect
// there is no parsing and no string building at all.

const parseCache = new Map<string, number>();

/** Parse a CSS colour to 0xRRGGBB. Handles #rgb, #rgba, #rrggbb, #rrggbbaa,
 *  rgb()/rgba() and hsl()/hsla() — which covers everything palette.ts emits.
 *  Anything unrecognised comes back white, which is visible and therefore
 *  debuggable. */
export function parseColor(css: string): number {
  if (!css) return 0xffffff;
  const hit = parseCache.get(css);
  if (hit !== undefined) return hit;
  let out = 0xffffff;
  const s = css.trim();
  if (s.charCodeAt(0) === 35) {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = Number.parseInt(hex[0]! + hex[0]!, 16);
      const g = Number.parseInt(hex[1]! + hex[1]!, 16);
      const b = Number.parseInt(hex[2]! + hex[2]!, 16);
      out = (r << 16) | (g << 8) | b;
    } else if (hex.length >= 6) {
      out = Number.parseInt(hex.slice(0, 6), 16);
    }
  } else {
    const open = s.indexOf('(');
    if (open > 0) {
      const fn = s.slice(0, open).toLowerCase();
      const body = s.slice(open + 1, s.lastIndexOf(')'));
      const parts = body.split(/[\s,/]+/).filter((v) => v !== '');
      if (fn === 'rgb' || fn === 'rgba') {
        const r = num(parts[0], 255);
        const g = num(parts[1], 255);
        const b = num(parts[2], 255);
        out = (clampByte(r) << 16) | (clampByte(g) << 8) | clampByte(b);
      } else if (fn === 'hsl' || fn === 'hsla') {
        out = hslToRgb(num(parts[0], 0), pct(parts[1], 100), pct(parts[2], 50));
      }
    }
  }
  if (!Number.isFinite(out)) out = 0xffffff;
  if (parseCache.size > 256) parseCache.clear();
  parseCache.set(css, out);
  return out >>> 0;
}

const num = (v: string | undefined, dflt: number): number => {
  if (v === undefined) return dflt;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return dflt;
  return v.endsWith('%') ? (n / 100) * 255 : n;
};
const pct = (v: string | undefined, dflt: number): number => {
  if (v === undefined) return dflt;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
};
const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

function hslToRgb(h: number, s: number, l: number): number {
  const hh = ((h % 360) + 360) % 360 / 360;
  const ss = Math.min(1, Math.max(0, s / 100));
  const ll = Math.min(1, Math.max(0, l / 100));
  if (ss === 0) {
    const v = clampByte(ll * 255);
    return (v << 16) | (v << 8) | v;
  }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const f = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return (
    (clampByte(f(hh + 1 / 3) * 255) << 16) |
    (clampByte(f(hh) * 255) << 8) |
    clampByte(f(hh - 1 / 3) * 255)
  );
}

const strCache = new Map<number, string>();

/**
 * `rgb(r g b / a)` from components, cached on a quantised key.
 *
 * Colour is quantised to 5 bits per channel and alpha to 5 bits, so a fading
 * burst reuses ~32 strings instead of allocating one per particle per frame.
 * The banding is invisible on a 4px dot.
 */
export function colorStr(r: number, g: number, b: number, a: number): string {
  const rq = (r & 0xf8) | 4;
  const gq = (g & 0xf8) | 4;
  const bq = (b & 0xf8) | 4;
  const aq = Math.max(0, Math.min(31, Math.round(a * 31)));
  const key = ((rq >> 3) << 16) | ((gq >> 3) << 11) | ((bq >> 3) << 6) | aq;
  let s = strCache.get(key);
  if (s === undefined) {
    if (strCache.size > 4096) strCache.clear();
    s = `rgb(${rq} ${gq} ${bq} / ${(aq / 31).toFixed(3)})`;
    strCache.set(key, s);
  }
  return s;
}

/** Opaque `rgb(r g b)` from a packed 0xRRGGBB. Cached. */
export function packedStr(packed: number, a: number): string {
  return colorStr((packed >> 16) & 255, (packed >> 8) & 255, packed & 255, a);
}

// ─── The pool ────────────────────────────────────────────────────────────────

export class Particles {
  readonly cap: number;
  private n = 0;
  private spawnLeft = MAX_SPAWN_PER_FRAME;

  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly life: Float32Array;
  private readonly max: Float32Array;
  private readonly size: Float32Array;
  private readonly rot: Float32Array;
  private readonly vrot: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;
  private readonly c0: Int32Array;
  private readonly c1: Int32Array;
  private readonly kind: Uint8Array;
  /** Pre-filled with '' so assigning an existing string never allocates. */
  private readonly glyph: string[];

  private readonly paint: Paint = {};
  private rng: Rng;

  /** How many spawn requests were refused. Surfaced in the debug overlay so
   *  "my particles disappeared" has an answer. */
  dropped = 0;

  constructor(rng: Rng, cap = PARTICLE_CAP) {
    this.cap = Math.max(16, cap | 0);
    this.rng = rng;
    const n = this.cap;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.life = new Float32Array(n);
    this.max = new Float32Array(n);
    this.size = new Float32Array(n);
    this.rot = new Float32Array(n);
    this.vrot = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.c0 = new Int32Array(n);
    this.c1 = new Int32Array(n);
    this.kind = new Uint8Array(n);
    this.glyph = new Array<string>(n).fill('');
  }

  get count(): number { return this.n; }
  get fill(): number { return this.n / this.cap; }

  setRng(rng: Rng): void { this.rng = rng; }

  clear(): void {
    this.n = 0;
    this.dropped = 0;
  }

  /** Call once per frame, before any burst, to reopen the spawn budget. */
  beginFrame(): void {
    this.spawnLeft = MAX_SPAWN_PER_FRAME;
  }

  /** How many of `want` this pool will actually accept right now. */
  allow(want: number): number {
    let n = Math.min(Math.max(0, Math.floor(want)), MAX_PER_BURST);
    const f = this.fill;
    if (f > PRESSURE_FROM) {
      // Linear taper from 100% of the request at 70% full to ~10% at full.
      const t = Math.min(1, (f - PRESSURE_FROM) / (1 - PRESSURE_FROM));
      n = Math.max(1, Math.floor(n * (1 - t * 0.9)));
    }
    n = Math.min(n, this.cap - this.n, this.spawnLeft);
    return Math.max(0, n);
  }

  /**
   * Emit particles. Positional args, not an options object: `burst()` can be
   * called many times per frame and an options literal per call is exactly the
   * per-frame allocation this file exists to avoid.
   *
   * `dir`/`spread` are a cone in radians; `spread >= TAU` is a full circle.
   */
  emit(
    count: number,
    x: number, y: number,
    speed: number, dir: number, spread: number,
    life: number, size: number,
    gravity: number, drag: number,
    kind: number, col0: number, col1: number,
    glyph: string,
  ): number {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    const want = Math.max(0, Math.floor(count));
    const n = this.allow(want);
    if (n < want) this.dropped += want - n;
    if (n <= 0) return 0;
    const rng = this.rng;
    for (let i = 0; i < n; i++) {
      const j = this.n++;
      const a = dir + (rng() - 0.5) * spread;
      const sp = speed * (0.55 + rng() * 0.9);
      this.x[j] = x;
      this.y[j] = y;
      this.vx[j] = Math.cos(a) * sp;
      this.vy[j] = Math.sin(a) * sp;
      const lf = life * (0.7 + rng() * 0.6);
      this.life[j] = lf;
      this.max[j] = lf;
      this.size[j] = size * (0.72 + rng() * 0.56);
      this.rot[j] = rng() * Math.PI * 2;
      this.vrot[j] = (rng() - 0.5) * 12;
      this.grav[j] = gravity;
      this.drag[j] = drag;
      this.c0[j] = col0 | 0;
      this.c1[j] = col1 | 0;
      this.kind[j] = kind;
      this.glyph[j] = glyph;
    }
    this.spawnLeft -= n;
    return n;
  }

  /** Emit along a line instead of from a point — used by confetti, which falls
   *  from the whole top edge rather than erupting from one spot. */
  emitLine(
    count: number,
    x0: number, y0: number, x1: number, y1: number,
    speed: number, dir: number, spread: number,
    life: number, size: number,
    gravity: number, drag: number,
    kind: number, col0: number, col1: number,
    glyph: string,
  ): number {
    const want = Math.max(0, Math.floor(count));
    const n = this.allow(want);
    if (n < want) this.dropped += want - n;
    if (n <= 0) return 0;
    const rng = this.rng;
    for (let i = 0; i < n; i++) {
      const t = rng();
      this.emitOne(
        x0 + (x1 - x0) * t, y0 + (y1 - y0) * t,
        speed, dir, spread, life, size, gravity, drag, kind, col0, col1, glyph,
      );
    }
    this.spawnLeft -= n;
    return n;
  }

  private emitOne(
    x: number, y: number,
    speed: number, dir: number, spread: number,
    life: number, size: number,
    gravity: number, drag: number,
    kind: number, col0: number, col1: number,
    glyph: string,
  ): void {
    if (this.n >= this.cap) return;
    const rng = this.rng;
    const j = this.n++;
    const a = dir + (rng() - 0.5) * spread;
    const sp = speed * (0.55 + rng() * 0.9);
    this.x[j] = x;
    this.y[j] = y;
    this.vx[j] = Math.cos(a) * sp;
    this.vy[j] = Math.sin(a) * sp;
    const lf = life * (0.7 + rng() * 0.6);
    this.life[j] = lf;
    this.max[j] = lf;
    this.size[j] = size * (0.72 + rng() * 0.56);
    this.rot[j] = rng() * Math.PI * 2;
    this.vrot[j] = (rng() - 0.5) * 12;
    this.grav[j] = gravity;
    this.drag[j] = drag;
    this.c0[j] = col0 | 0;
    this.c1[j] = col1 | 0;
    this.kind[j] = kind;
    this.glyph[j] = glyph;
  }

  /** Integrate and compact. O(1) removal by swapping the tail down. */
  update(dt: number): void {
    if (!(dt > 0)) return;
    const f60 = dt * 60;
    for (let i = 0; i < this.n; i++) {
      const d = Math.pow(this.drag[i]!, f60);
      let vx = this.vx[i]! * d;
      let vy = this.vy[i]! * d + this.grav[i]! * dt;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.x[i] = this.x[i]! + vx * dt;
      this.y[i] = this.y[i]! + vy * dt;
      this.rot[i] = this.rot[i]! + this.vrot[i]! * dt;
      const lf = this.life[i]! - dt;
      if (lf <= 0) {
        this.swapRemove(i);
        i--;
        continue;
      }
      this.life[i] = lf;
    }
  }

  private swapRemove(i: number): void {
    const last = --this.n;
    if (i === last) {
      this.glyph[i] = '';
      return;
    }
    this.x[i] = this.x[last]!;
    this.y[i] = this.y[last]!;
    this.vx[i] = this.vx[last]!;
    this.vy[i] = this.vy[last]!;
    this.life[i] = this.life[last]!;
    this.max[i] = this.max[last]!;
    this.size[i] = this.size[last]!;
    this.rot[i] = this.rot[last]!;
    this.vrot[i] = this.vrot[last]!;
    this.grav[i] = this.grav[last]!;
    this.drag[i] = this.drag[last]!;
    this.c0[i] = this.c0[last]!;
    this.c1[i] = this.c1[last]!;
    this.kind[i] = this.kind[last]!;
    this.glyph[i] = this.glyph[last]!;
    this.glyph[last] = '';
  }

  /** Draw every live particle through the Renderer vocabulary. */
  draw(g: Renderer): void {
    const paint = this.paint;
    for (let i = 0; i < this.n; i++) {
      const t = this.life[i]! / (this.max[i]! || 1); // 1 -> 0
      const k = this.kind[i]!;
      // Colour lerps c0 -> c1 over life; alpha eases out so the tail is soft.
      const a = t * t * (3 - 2 * t);
      const p0 = this.c0[i]!;
      const p1 = this.c1[i]!;
      const mix = 1 - t;
      const r = ((p0 >> 16) & 255) + (((p1 >> 16) & 255) - ((p0 >> 16) & 255)) * mix;
      const gg = ((p0 >> 8) & 255) + (((p1 >> 8) & 255) - ((p0 >> 8) & 255)) * mix;
      const b = (p0 & 255) + ((p1 & 255) - (p0 & 255)) * mix;
      const col = colorStr(r | 0, gg | 0, b | 0, a);
      const x = this.x[i]!;
      const y = this.y[i]!;
      const sz = this.size[i]!;

      if (k === KIND_EMOJI) {
        g.emoji(this.glyph[i]!, x, y, sz * (0.6 + t * 0.4), this.rot[i]!);
        continue;
      }
      if (k === KIND_SPARK) {
        // Stretch along the velocity: a streak reads as speed, a dot does not.
        const kk = 0.045;
        paint.stroke = col;
        paint.fill = undefined;
        paint.glow = 0;
        g.line(x, y, x - this.vx[i]! * kk, y - this.vy[i]! * kk, Math.max(1, sz * 0.5), paint);
        continue;
      }
      if (k === KIND_CONFETTI) {
        paint.fill = col;
        paint.stroke = undefined;
        paint.glow = 0;
        g.save();
        g.translate(x, y);
        g.rotate(this.rot[i]!);
        g.rect(-sz, -sz * 0.45, sz * 2, sz * 0.9, paint);
        g.restore();
        continue;
      }
      paint.fill = col;
      paint.stroke = undefined;
      paint.glow = 0;
      g.circle(x, y, Math.max(0.5, sz * (0.35 + t * 0.65)), paint);
    }
  }
}

// ─── Small sibling pools ─────────────────────────────────────────────────────
//
// Rings, trails and floating text have different shapes and much smaller
// counts, so they get their own fixed pools rather than more particle kinds.

export class Rings {
  private n = 0;
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly r0: Float32Array;
  private readonly r1: Float32Array;
  private readonly life: Float32Array;
  private readonly max: Float32Array;
  private readonly col: Int32Array;
  private readonly paint: Paint = {};

  constructor(readonly cap = 48) {
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.r0 = new Float32Array(cap);
    this.r1 = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.max = new Float32Array(cap);
    this.col = new Int32Array(cap);
  }

  get count(): number { return this.n; }
  clear(): void { this.n = 0; }

  add(x: number, y: number, r: number, col: number, life = 0.34): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(r > 0)) return;
    // A full pool overwrites the OLDEST, never drops the newest: the newest ring
    // is the one the player just caused, so it is the one they are looking for.
    const i = this.n < this.cap ? this.n++ : this.oldest();
    this.x[i] = x;
    this.y[i] = y;
    this.r0[i] = r * 0.35;
    this.r1[i] = r * 1.65;
    this.life[i] = life;
    this.max[i] = life;
    this.col[i] = col | 0;
  }

  private oldest(): number {
    let best = 0;
    let bv = Infinity;
    for (let i = 0; i < this.n; i++) {
      const v = this.life[i]! / (this.max[i]! || 1);
      if (v < bv) {
        bv = v;
        best = i;
      }
    }
    return best;
  }

  update(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      const lf = this.life[i]! - dt;
      if (lf <= 0) {
        const last = --this.n;
        if (i !== last) {
          this.x[i] = this.x[last]!;
          this.y[i] = this.y[last]!;
          this.r0[i] = this.r0[last]!;
          this.r1[i] = this.r1[last]!;
          this.life[i] = this.life[last]!;
          this.max[i] = this.max[last]!;
          this.col[i] = this.col[last]!;
        }
        i--;
        continue;
      }
      this.life[i] = lf;
    }
  }

  draw(g: Renderer): void {
    const paint = this.paint;
    for (let i = 0; i < this.n; i++) {
      const t = 1 - this.life[i]! / (this.max[i]! || 1); // 0 -> 1
      const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
      const r = this.r0[i]! + (this.r1[i]! - this.r0[i]!) * e;
      paint.stroke = packedStr(this.col[i]!, (1 - t) * 0.85);
      paint.fill = undefined;
      paint.sw = Math.max(1.5, r * 0.1 * (1 - t) + 1.5);
      paint.glow = 0;
      g.circle(this.x[i]!, this.y[i]!, r, paint);
    }
  }
}

export class Trails {
  private n = 0;
  private readonly x0: Float32Array;
  private readonly y0: Float32Array;
  private readonly x1: Float32Array;
  private readonly y1: Float32Array;
  private readonly wid: Float32Array;
  private readonly life: Float32Array;
  private readonly max: Float32Array;
  private readonly col: Int32Array;
  private readonly paint: Paint = {};

  constructor(readonly cap = 120) {
    this.x0 = new Float32Array(cap);
    this.y0 = new Float32Array(cap);
    this.x1 = new Float32Array(cap);
    this.y1 = new Float32Array(cap);
    this.wid = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.max = new Float32Array(cap);
    this.col = new Int32Array(cap);
  }

  get count(): number { return this.n; }
  clear(): void { this.n = 0; }

  add(
    x0: number, y0: number, x1: number, y1: number,
    width: number, col: number, life: number,
  ): void {
    if (!Number.isFinite(x0) || !Number.isFinite(y0)) return;
    if (!Number.isFinite(x1) || !Number.isFinite(y1)) return;
    // Trails are emitted every frame by a swinging hand: when full, overwrite
    // the oldest slot in a ring rather than dropping the newest segment.
    const i = this.n < this.cap ? this.n++ : this.oldest();
    this.x0[i] = x0;
    this.y0[i] = y0;
    this.x1[i] = x1;
    this.y1[i] = y1;
    this.wid[i] = width;
    this.life[i] = life;
    this.max[i] = life;
    this.col[i] = col | 0;
  }

  private oldest(): number {
    let best = 0;
    let bv = Infinity;
    for (let i = 0; i < this.n; i++) {
      const v = this.life[i]! / (this.max[i]! || 1);
      if (v < bv) {
        bv = v;
        best = i;
      }
    }
    return best;
  }

  update(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      const lf = this.life[i]! - dt;
      if (lf <= 0) {
        const last = --this.n;
        if (i !== last) {
          this.x0[i] = this.x0[last]!;
          this.y0[i] = this.y0[last]!;
          this.x1[i] = this.x1[last]!;
          this.y1[i] = this.y1[last]!;
          this.wid[i] = this.wid[last]!;
          this.life[i] = this.life[last]!;
          this.max[i] = this.max[last]!;
          this.col[i] = this.col[last]!;
        }
        i--;
        continue;
      }
      this.life[i] = lf;
    }
  }

  draw(g: Renderer): void {
    const paint = this.paint;
    for (let i = 0; i < this.n; i++) {
      const t = this.life[i]! / (this.max[i]! || 1);
      paint.stroke = packedStr(this.col[i]!, t * 0.8);
      paint.fill = undefined;
      paint.glow = 0;
      g.line(this.x0[i]!, this.y0[i]!, this.x1[i]!, this.y1[i]!, Math.max(1, this.wid[i]! * t), paint);
    }
  }
}

export class PopTexts {
  private n = 0;
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly vy: Float32Array;
  private readonly life: Float32Array;
  private readonly max: Float32Array;
  private readonly col: Int32Array;
  private readonly txt: string[];
  /** Reused so the draw pass allocates nothing. */
  private readonly opts: TextOpts = {
    weight: 900, align: 'center', baseline: 'middle', display: true,
  };

  constructor(readonly cap = 24) {
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.max = new Float32Array(cap);
    this.col = new Int32Array(cap);
    this.txt = new Array<string>(cap).fill('');
  }

  get count(): number { return this.n; }
  clear(): void { this.n = 0; }

  add(x: number, y: number, text: string, col: number, life = 0.95, rise = -150): void {
    if (!text || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const i = this.n < this.cap ? this.n++ : 0;
    this.x[i] = x;
    this.y[i] = y;
    this.vy[i] = rise;
    this.life[i] = life;
    this.max[i] = life;
    this.col[i] = col | 0;
    this.txt[i] = text;
  }

  update(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      this.y[i] = this.y[i]! + this.vy[i]! * dt;
      this.vy[i] = this.vy[i]! * Math.pow(0.9, dt * 60); // drifts, then hangs
      const lf = this.life[i]! - dt;
      if (lf <= 0) {
        const last = --this.n;
        if (i !== last) {
          this.x[i] = this.x[last]!;
          this.y[i] = this.y[last]!;
          this.vy[i] = this.vy[last]!;
          this.life[i] = this.life[last]!;
          this.max[i] = this.max[last]!;
          this.col[i] = this.col[last]!;
          this.txt[i] = this.txt[last]!;
        }
        this.txt[last] = '';
        i--;
        continue;
      }
      this.life[i] = lf;
    }
  }

  draw(g: Renderer, size: number): void {
    const o = this.opts;
    for (let i = 0; i < this.n; i++) {
      const t = this.life[i]! / (this.max[i]! || 1);
      const a = t > 0.7 ? 1 : t / 0.7; // hold, then fade
      // Pop in with a little overshoot, then settle.
      const grow = 1 + 0.3 * Math.sin(Math.min(1, (1 - t) / 0.22) * Math.PI);
      o.size = size * grow;
      o.fill = packedStr(this.col[i]!, a);
      o.stroke = colorStr(11, 15, 32, a); // C.ink, faded in step with the fill
      o.sw = Math.max(3, size * 0.2);
      g.text(this.txt[i]!, this.x[i]!, this.y[i]!, o);
    }
  }
}

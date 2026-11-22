// The one Canvas2D implementation of the frozen `Renderer` contract.
//
// Everything 58 games can draw goes through here, which makes this the place
// where four product decisions are enforced once instead of 58 times:
//
//   devicePixelRatio    handled ONCE, in `resize()`. Games work purely in
//                       logical CSS px and never see `dpr`.
//   the dark canvas     `clear()` always paints the in-game dark background,
//                       in both themes, tinted by the game's hue. A light
//                       canvas blows out next to a camera preview and kills
//                       every glow and particle.
//   legibility          text has a hard minimum size, a weight floor, Korean
//                       tracking, tabular digits and a stroke-behind-fill
//                       outline. A child reads this from ~2m.
//   a glow budget       `Paint.glow` is a shadow blur, which is the single most
//                       expensive thing in this file. There is a per-frame
//                       budget and extra glows are silently dropped.
//
// NaN discipline: every primitive checks its coordinates and skips the draw
// rather than poisoning the path. A dropped circle is a cosmetic bug; a NaN in
// the current path silently blanks every subsequent draw in the frame.
import { TAU } from '../math';
import { L, MIN_VIS, palm, POSE_EDGES } from '../pose/landmarks';
import type { Paint, PlayerPose, Pt, Renderer, SkeletonOpts, TextOpts } from '../types';
import { C, hue, KEYLINE } from './palette';
import { SKY_DOT_FILL, SKY_DOTS, skyStops } from './sky';
import {
  compiledPath, getSprite, type PaintRole, type SpriteId, type SpriteOpts,
} from './sprite';
// Side-effect import: registers the shared sprite set.
import './sprites';
import {
  DIGITS,
  applyTracking,
  clampTextSize,
  emojiFontString,
  fontString,
  isDigit,
  tabularWidth,
} from './text';

/** Retina is worth it; 3x on a phone is not — it triples fill cost for a
 *  difference nobody standing 2m away can see. */
export const DEFAULT_MAX_DPR = 2;

/**
 * Glow budget, in `Paint.glow` draws per frame.
 *
 * A shadow-blurred fill costs roughly 6-20x a flat fill, and on the Chromebook
 * class of device this project targets, ~20 of them is the whole frame. Games
 * are told "hero objects only"; this is what happens when they don't listen —
 * the first 14 glows of a frame render, the rest draw flat. Silently, because a
 * missing glow is invisible and a dropped frame is not.
 */
export const GLOW_BUDGET = 14;

const DIGIT_COUNT = 10;

/** Joints that get a dot in `skeleton()` — the union of POSE_EDGES endpoints.
 *  Computed once; face points are deliberately absent (drawing 11 dots on a
 *  child's face looks like surveillance). */
/** Wrists, ankles and the head: the parts a player actually steers with. */
const END_JOINTS: readonly number[] = [
  L.LEFT_WRIST, L.RIGHT_WRIST, L.LEFT_ANKLE, L.RIGHT_ANKLE,
];
/** Hands only — the default for games played with the arms. */
const HAND_JOINTS: readonly number[] = [L.LEFT_WRIST, L.RIGHT_WRIST];
const EMPTY_JOINTS: readonly number[] = [];

const SKELETON_JOINTS: readonly number[] = (() => {
  const seen = new Set<number>();
  for (const e of POSE_EDGES) {
    seen.add(e[0]);
    seen.add(e[1]);
  }
  return [...seen];
})();

/** Limbs as flat joint pairs. Feet are part of the leg: a short thick stub
 *  past the ankle reads as a boot. */
export const ARM_EDGES: readonly number[] = [
  L.LEFT_SHOULDER, L.LEFT_ELBOW, L.LEFT_ELBOW, L.LEFT_WRIST,
  L.RIGHT_SHOULDER, L.RIGHT_ELBOW, L.RIGHT_ELBOW, L.RIGHT_WRIST,
];
export const LEG_EDGES: readonly number[] = [
  L.LEFT_HIP, L.LEFT_KNEE, L.LEFT_KNEE, L.LEFT_ANKLE, L.LEFT_ANKLE, L.LEFT_FOOT_INDEX,
  L.RIGHT_HIP, L.RIGHT_KNEE, L.RIGHT_KNEE, L.RIGHT_ANKLE, L.RIGHT_ANKLE, L.RIGHT_FOOT_INDEX,
];
/** Every joint the avatar can draw something on, for its bounding box. */
const BODY_JOINTS: readonly number[] = [L.NOSE, ...SKELETON_JOINTS];

/**
 * The player avatar's proportions, in shoulder widths (`p.scalePx`). Shared
 * with the SVG shot renderer, so a shot shows the body a child actually sees.
 */
export const BODY = {
  /** Limb diameters. Chunky on purpose: a stick figure reads as a debug view. */
  arm: 0.24,
  leg: 0.3,
  /** Stroke width that rounds the torso quad's corners. */
  torso: 0.3,
  neck: 0.3,
  /** Big, like every party-game character: a child's head is ~0.6 shoulder
   *  widths across, this is ~0.9. */
  head: 0.46,
  mitt: 0.21,
  shoe: 0.2,
  /** Plain joint dots, `jointSet: 'all'` only. */
  dot: 0.09,
  /** Emphasis ring radius, as a multiple of that joint's dot radius. */
  ring: 1.6,
  ringW: 0.075,
  /** The belly inside the body layer: white at this alpha, then the body
   *  colour at `bellyTint` — a light tint about half opaque, so objects behind
   *  the child's chest stay visible. The limbs need not be see-through. */
  bellyWhite: 0.35,
  bellyTint: 0.3,
  /** Head = body colour at this alpha over white: a lighter tint of any CSS
   *  colour without parsing it. */
  headTint: 0.55,
  /** How far the ghost silhouette reaches past the body. */
  ghostGrow: 0.14,
  /** Ghost = body colour at this alpha over white. */
  ghostTint: 0.5,
  /** Shine on the head and mitts: a short white arc at the top-left. */
  gloss: 0.7,
  glossW: 0.055,
} as const;

/** The shine arc on a ball of radius r: at GLOSS_K * r, from GLOSS_A0 to
 *  GLOSS_A1 — top-left, a sixth of the way round. Shared with the SVG shot
 *  renderer. */
export const GLOSS_K = 0.66;
export const GLOSS_A0 = Math.PI * 1.1;
export const GLOSS_A1 = Math.PI * 1.4;
/** Add that arc to the current path. */
function glossArc(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const k = r * GLOSS_K;
  c.moveTo(x + Math.cos(GLOSS_A0) * k, y + Math.sin(GLOSS_A0) * k);
  c.arc(x, y, k, GLOSS_A0, GLOSS_A1, false);
}

/** Shoulder-width unit in px, clamped: a child leaning into the lens must not
 *  become a wall, and one far away must not shrink back into a stick figure. */
export function bodyUnit(scalePx: number, s: number): number {
  const u = Number.isFinite(scalePx) && scalePx > 0 ? scalePx : 120 * s;
  return Math.min(Math.max(u, 50 * s), 320 * s);
}

/** Ink keyline outside the body colour, per side: the house sticker edge. */
export const bodyInk = (s: number): number => Math.max(2.5, 5.5 * s);

/** A wrist gets a mitt, an ankle a shoe, anything else a small dot; an
 *  explicit `jointR` (> 0) overrides all three. */
export function dotRadius(j: number, u: number, jr: number): number {
  if (jr > 0) return jr;
  if (j === L.LEFT_WRIST || j === L.RIGHT_WRIST) return u * BODY.mitt;
  if (j === L.LEFT_ANKLE || j === L.RIGHT_ANKLE) return u * BODY.shoe;
  return u * BODY.dot;
}

/**
 * Confidence as a FADE, not a switch: 0 at MIN_VIS, 1 a quarter above it.
 * Hard-gating makes a limb blink between frames; fading keeps the body whole
 * while still refusing to draw a joint the model is guessing at.
 */
export function limbFade(va: number, vb: number): number {
  const v = va < vb ? va : vb;
  if (!(v > MIN_VIS)) return 0;
  const t = (v - MIN_VIS) / 0.25;
  const k = t > 1 ? 1 : t;
  return k * k * (3 - 2 * k); // smoothstep
}

/**
 * Where a hand's mitt goes: the palm, which is where the games hit-test — or
 * the wrist when neither the fingers nor the elbow are trustworthy enough to
 * extrapolate from. False when the wrist itself is not.
 */
export function mittAt(p: PlayerPose, side: 'L' | 'R', out: Pt): boolean {
  const w = side === 'L' ? L.LEFT_WRIST : L.RIGHT_WRIST;
  const v = p.vis;
  if (!(v[w]! >= MIN_VIS)) return false;
  const fingers = side === 'L'
    ? v[L.LEFT_PINKY]! >= MIN_VIS && v[L.LEFT_INDEX]! >= MIN_VIS && v[L.LEFT_THUMB]! >= MIN_VIS
    : v[L.RIGHT_PINKY]! >= MIN_VIS && v[L.RIGHT_INDEX]! >= MIN_VIS && v[L.RIGHT_THUMB]! >= MIN_VIS;
  const elbow = side === 'L' ? L.LEFT_ELBOW : L.RIGHT_ELBOW;
  if (fingers || v[elbow]! >= MIN_VIS) {
    palm(p, side, out);
  } else {
    out.x = p.px[w * 2]!;
    out.y = p.px[w * 2 + 1]!;
  }
  return Number.isFinite(out.x) && Number.isFinite(out.y);
}

/** Where a shoe goes: halfway from ankle to toe, so with the foot stub it
 *  reads as a boot — or on the ankle when the toe is not trustworthy. */
export function shoeAt(p: PlayerPose, side: 'L' | 'R', out: Pt): boolean {
  const a = side === 'L' ? L.LEFT_ANKLE : L.RIGHT_ANKLE;
  const t = side === 'L' ? L.LEFT_FOOT_INDEX : L.RIGHT_FOOT_INDEX;
  if (!(p.vis[a]! >= MIN_VIS)) return false;
  const ax = p.px[a * 2]!;
  const ay = p.px[a * 2 + 1]!;
  const toe = p.vis[t]! >= MIN_VIS;
  out.x = toe ? (ax + p.px[t * 2]!) / 2 : ax;
  out.y = toe ? (ay + p.px[t * 2 + 1]!) / 2 : ay;
  return Number.isFinite(out.x) && Number.isFinite(out.y);
}

const fin = (a: number): boolean => Number.isFinite(a);
const fin2 = (a: number, b: number): boolean => Number.isFinite(a) && Number.isFinite(b);
const fin4 = (a: number, b: number, c: number, d: number): boolean =>
  Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function dprOf(): number {
  const d = (globalThis as { devicePixelRatio?: number }).devicePixelRatio;
  return typeof d === 'number' && d > 0 ? d : 1;
}

export interface Canvas2DOpts {
  /** Force a pixel ratio (tests, screenshots, the quality ladder). */
  dpr?: number;
  /** Default 2. The quality ladder drops this to 1 on a weak GPU. */
  maxDpr?: number;
  /** Opaque canvas by default: the compositor skips a blend per frame. Turned
   *  on automatically when `skyAlpha` < 1. */
  alpha?: boolean;
  /**
   * Opacity of the sky `clear()` paints, 0..1. Default 1: today's opaque
   * sky. Below 1 the canvas gets an alpha channel and whatever is behind it
   * (the camera backdrop, see render/sky.ts BACKDROP_SKY_ALPHA) shows through
   * the sky only; everything drawn after `clear()` is unaffected.
   */
  skyAlpha?: number;
  /**
   * Write `canvas.style.width/height` on every resize. Default FALSE, and that
   * default was paid for: setting an inline style pins the element's layout
   * box, so a canvas sized by CSS (`width:100%`, flex, grid) collapses to
   * whatever it measured on the first frame and then observes its own frozen
   * size forever. Symptom: the game renders correctly into the top-left 300x150
   * of a full-screen canvas.
   *
   * CSS owns the element's layout size; this class owns the backing store. Turn
   * this on only for a canvas with no CSS sizing at all, where it stops the
   * element from laying out at `width * dpr` CSS px.
   */
  manageStyle?: boolean;
}

export class Canvas2DRenderer implements Renderer {
  readonly canvas: HTMLCanvasElement;
  private readonly c: CanvasRenderingContext2D;

  private _w = 1;
  private _h = 1;
  private _s = 1;
  private _dpr = 1;
  /** Last hue passed to clear(), so sprites default to the game's own accent
   *  and a game never has to thread its hue through every draw call. */
  private themeHue = 210;
  private maxDpr: number;
  private dprForced: number | undefined;
  private manageStyle: boolean;
  private readonly skyAlpha: number;

  /** Seconds since the round started. Set by `beginFrame`. */
  t = 0;

  /** Our own alpha stack: `alpha()` multiplies, so we must know the current
   *  value. `ctx.save()` also saves globalAlpha, we just mirror it. */
  private a = 1;
  private readonly aStack: number[] = [];

  private glowLeft = GLOW_BUDGET;
  private glowsDropped = 0;

  // Cached sky gradient and dot layout, rebuilt only when the hue or the size
  // changes. Compared as numbers: a string key would allocate every frame.
  private bgHue = Number.NaN;
  private bgW = 0;
  private bgH = 0;
  private bgGrad: CanvasGradient | null = null;
  private readonly dots = new Float32Array(SKY_DOTS.length);
  private dotN = 0;

  // Text metric caches, keyed by the ctx.font string.
  private readonly digitCache = new Map<string, number>();
  private readonly charCache = new Map<string, number>();
  private readonly emojiOffCache = new Map<string, number>();

  constructor(canvas: HTMLCanvasElement, o?: Canvas2DOpts) {
    this.canvas = canvas;
    const sa = o?.skyAlpha;
    this.skyAlpha = sa !== undefined && fin(sa) ? clamp01(sa) : 1;
    const ctx = canvas.getContext('2d', {
      alpha: o?.alpha ?? this.skyAlpha < 1,
      desynchronized: true,
    }) as CanvasRenderingContext2D | null;
    if (!ctx) throw new Error('[Canvas2DRenderer] 2D context unavailable');
    this.c = ctx;
    this.maxDpr = o?.maxDpr ?? DEFAULT_MAX_DPR;
    this.dprForced = o?.dpr;
    this.manageStyle = o?.manageStyle ?? false;
    // Fall back to a sane viewport, never to `canvas.width` — that is the
    // 300x150 HTML default, and adopting it looks exactly like a layout bug.
    this.resize(canvas.clientWidth || 1280, canvas.clientHeight || 720);
  }

  get w(): number { return this._w; }
  get h(): number { return this._h; }
  get s(): number { return this._s; }
  get dpr(): number { return this._dpr; }
  /** Diagnostics for the debug overlay: how many glows were refused. */
  get glowOverflow(): number { return this.glowsDropped; }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * The ONLY place devicePixelRatio is handled.
   *
   * The backing store is `cssPx * dpr`, the base transform scales by `dpr`, and
   * every public method takes logical CSS px. A game that multiplies by `g.s`
   * looks identical on a 1x projector and a 2x retina panel.
   */
  resize(cssW: number, cssH: number, dpr?: number): void {
    const d = Math.min(Math.max(dpr ?? this.dprForced ?? dprOf(), 1), this.maxDpr);
    this._w = Math.max(1, Math.round(cssW));
    this._h = Math.max(1, Math.round(cssH));
    this._dpr = d;
    this._s = Math.min(this._w, this._h) / 1000;
    const bw = Math.max(1, Math.round(this._w * d));
    const bh = Math.max(1, Math.round(this._h * d));
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    if (this.manageStyle && this.canvas.style) {
      this.canvas.style.width = `${this._w}px`;
      this.canvas.style.height = `${this._h}px`;
    }
    this.bgGrad = null;
    this.digitCache.clear();
    this.charCache.clear();
    this.resetState();
  }

  /** Change the pixel-ratio ceiling (quality ladder) and re-apply it. */
  setMaxDpr(maxDpr: number): void {
    this.maxDpr = Math.max(1, maxDpr);
    this.resize(this._w, this._h);
  }

  private resetState(): void {
    const c = this.c;
    c.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    this.a = 1;
    this.aStack.length = 0;
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.shadowBlur = 0;
    c.shadowColor = 'rgb(0 0 0 / 0)';
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.miterLimit = 2;
  }

  /** Call once per rendered frame, before the game's `render()`.
   *  `tSec` is seconds since the round started (the renderer's `t`). */
  beginFrame(tSec: number): void {
    this.t = fin(tSec) ? tSec : 0;
    this.glowLeft = GLOW_BUDGET;
    this.resetState();
  }

  /** Call after the fx pass. Only resets state; nothing is buffered. */
  endFrame(): void {
    this.resetState();
  }

  // ─── Transform / alpha ─────────────────────────────────────────────────────

  save(): void {
    this.c.save();
    this.aStack.push(this.a);
  }

  restore(): void {
    this.c.restore();
    this.a = this.aStack.pop() ?? 1;
    this.c.globalAlpha = this.a;
  }

  translate(x: number, y: number): void {
    if (!fin2(x, y)) return;
    this.c.translate(x, y);
  }

  rotate(rad: number): void {
    if (!fin(rad)) return;
    this.c.rotate(rad);
  }

  scale(x: number, y: number): void {
    if (!fin2(x, y) || x === 0 || y === 0) return;
    this.c.scale(x, y);
  }

  alpha(a: number): void {
    if (!fin(a)) return;
    this.a = clamp01(this.a * a);
    this.c.globalAlpha = this.a;
  }

  // ─── Background ────────────────────────────────────────────────────────────

  /**
   * Paint the in-game background. Dark in BOTH themes, by design.
   *
   * Ignores the current transform on purpose: camera shake translates the world,
   * and a shaken `clear()` would leave an unpainted seam along two edges every
   * frame the screen shakes.
   */
  clear(hueDeg?: number): void {
    const c = this.c;
    const w = this._w;
    const h = this._h;
    const hd = fin(hueDeg as number) ? Math.round(((hueDeg as number) % 360 + 360) % 360) : -1;
    if (hd >= 0) this.themeHue = hd;
    c.save();
    c.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.shadowBlur = 0;

    if (hd !== this.bgHue || w !== this.bgW || h !== this.bgH || !this.bgGrad) {
      this.bgHue = hd;
      this.bgW = w;
      this.bgH = h;
      const g = c.createLinearGradient(0, 0, 0, h);
      for (const [at, color] of skyStops(hd)) g.addColorStop(at, color);
      this.bgGrad = g;
      // Lay the party-light dots out once per size; a hue-less clear is the
      // plain warm ground and gets none.
      const m = Math.min(w, h);
      this.dotN = hd >= 0 ? SKY_DOTS.length / 3 : 0;
      for (let i = 0; i < this.dotN; i++) {
        this.dots[i * 3] = SKY_DOTS[i * 3]! * w;
        this.dots[i * 3 + 1] = SKY_DOTS[i * 3 + 1]! * h;
        this.dots[i * 3 + 2] = SKY_DOTS[i * 3 + 2]! * m;
      }
    }
    // A translucent sky must not accumulate over last frame's pixels: wipe
    // to transparent first, then paint the sky at its opacity.
    if (this.skyAlpha < 1) {
      c.clearRect(0, 0, w, h);
      c.globalAlpha = this.skyAlpha;
    }
    // Two draws: the gradient, then every dot in one path.
    c.fillStyle = this.bgGrad;
    c.fillRect(0, 0, w, h);
    if (this.dotN > 0) {
      const d = this.dots;
      c.beginPath();
      for (let i = 0; i < this.dotN; i++) {
        const x = d[i * 3]!;
        const y = d[i * 3 + 1]!;
        const r = d[i * 3 + 2]!;
        c.moveTo(x + r, y);
        c.arc(x, y, r, 0, TAU);
      }
      c.fillStyle = SKY_DOT_FILL;
      c.fill();
    }
    c.restore();
  }

  // ─── Paint ─────────────────────────────────────────────────────────────────

  /** The "sticker" outline width everything defaults to. ~2.6px at 1000px. */
  private get ink(): number {
    return Math.max(1.5, 2.6 * this._s);
  }

  /** Fill then stroke the current path. Glow (a shadow blur) is applied to the
   *  FIRST paint only — one blur per draw, never two. */
  private finish(p: Paint, defSw: number): void {
    const c = this.c;
    const hasFill = !!p.fill;
    const hasStroke = !!p.stroke;
    let glowed = false;
    const gr = p.glow;
    if (gr && gr > 0 && this.glowLeft > 0) {
      // shadowBlur is NOT scaled by the CTM, so compensate for dpr or a glow
      // looks half as wide on a retina panel as on a projector.
      c.shadowBlur = gr * this._dpr;
      c.shadowColor = p.glowColor ?? p.stroke ?? p.fill ?? C.white;
      this.glowLeft--;
      glowed = true;
    } else if (gr && gr > 0) {
      this.glowsDropped++;
    }

    if (hasFill) {
      c.fillStyle = p.fill!;
      c.fill();
      if (glowed) {
        c.shadowBlur = 0;
        glowed = false;
      }
    }
    if (hasStroke) {
      c.lineWidth = Math.max(0.5, p.sw ?? defSw);
      c.strokeStyle = p.stroke!;
      c.stroke();
    }
    if (!hasFill && !hasStroke) {
      // A Paint with nothing set is an authoring slip, not a reason to draw
      // nothing and leave the author hunting a blank screen.
      c.fillStyle = C.white;
      c.fill();
    }
    if (glowed) c.shadowBlur = 0;
  }

  // ─── Primitives ────────────────────────────────────────────────────────────

  circle(x: number, y: number, r: number, p: Paint): void {
    if (!fin2(x, y) || !fin(r) || r <= 0) return;
    const c = this.c;
    c.beginPath();
    c.arc(x, y, r, 0, TAU);
    this.finish(p, this.ink);
  }

  /** Ring segment when `stroke` is set; pie wedge when `fill` is set.
   *  Dwell gauges want the ring. */
  arc(x: number, y: number, r: number, a0: number, a1: number, p: Paint): void {
    if (!fin2(x, y) || !fin(r) || r <= 0 || !fin2(a0, a1)) return;
    const c = this.c;
    c.beginPath();
    if (p.fill) {
      c.moveTo(x, y);
      c.arc(x, y, r, a0, a1);
      c.closePath();
    } else {
      c.arc(x, y, r, a0, a1);
    }
    this.finish(p, Math.max(2, 6 * this._s));
  }

  rect(x: number, y: number, w: number, h: number, p: Paint): void {
    if (!fin4(x, y, w, h)) return;
    const c = this.c;
    c.beginPath();
    c.rect(x, y, w, h);
    this.finish(p, this.ink);
  }

  roundRect(x: number, y: number, w: number, h: number, r: number, p: Paint): void {
    if (!fin4(x, y, w, h) || !fin(r)) return;
    const c = this.c;
    c.beginPath();
    this.roundRectPath(x, y, w, h, r);
    this.finish(p, this.ink);
  }

  /** Hand-rolled rather than `ctx.roundRect()`: identical output everywhere,
   *  including Safari < 16.4 and any fake context in the tests. */
  private roundRectPath(x: number, y: number, w: number, h: number, r: number): void {
    const c = this.c;
    const neg = w < 0 || h < 0;
    const x0 = neg ? Math.min(x, x + w) : x;
    const y0 = neg ? Math.min(y, y + h) : y;
    const ww = Math.abs(w);
    const hh = Math.abs(h);
    const rr = Math.max(0, Math.min(r, ww / 2, hh / 2));
    if (rr <= 0.01) {
      c.rect(x0, y0, ww, hh);
      return;
    }
    const x1 = x0 + ww;
    const y1 = y0 + hh;
    c.moveTo(x0 + rr, y0);
    c.lineTo(x1 - rr, y0);
    c.quadraticCurveTo(x1, y0, x1, y0 + rr);
    c.lineTo(x1, y1 - rr);
    c.quadraticCurveTo(x1, y1, x1 - rr, y1);
    c.lineTo(x0 + rr, y1);
    c.quadraticCurveTo(x0, y1, x0, y1 - rr);
    c.lineTo(x0, y0 + rr);
    c.quadraticCurveTo(x0, y0, x0 + rr, y0);
    c.closePath();
  }

  line(x0: number, y0: number, x1: number, y1: number, width: number, p: Paint): void {
    if (!fin4(x0, y0, x1, y1) || !fin(width)) return;
    const c = this.c;
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    // A line has no interior: `fill` means "the colour of the line".
    const col = p.stroke ?? p.fill ?? C.white;
    let glowed = false;
    const gr = p.glow;
    if (gr && gr > 0 && this.glowLeft > 0) {
      c.shadowBlur = gr * this._dpr;
      c.shadowColor = p.glowColor ?? col;
      this.glowLeft--;
      glowed = true;
    } else if (gr && gr > 0) {
      this.glowsDropped++;
    }
    c.lineWidth = Math.max(0.5, width);
    c.strokeStyle = col;
    c.stroke();
    if (glowed) c.shadowBlur = 0;
  }

  poly(pts: Float32Array, n: number, p: Paint, close = true): void {
    if (!pts || n < 2) return;
    const c = this.c;
    const count = Math.min(n, pts.length >> 1);
    // One bad point blanks the whole path; check before opening it.
    for (let i = 0; i < count * 2; i++) if (!fin(pts[i]!)) return;
    c.beginPath();
    c.moveTo(pts[0]!, pts[1]!);
    for (let i = 1; i < count; i++) c.lineTo(pts[i * 2]!, pts[i * 2 + 1]!);
    if (close) c.closePath();
    this.finish(p, this.ink);
  }

  star(x: number, y: number, r: number, spikes: number, p: Paint): void {
    if (!fin2(x, y) || !fin(r) || r <= 0) return;
    const k = Math.max(3, Math.min(16, Math.round(spikes) || 5));
    // 0.46 inner ratio is the classic "reward star"; thinner reads as a splat.
    const ri = r * (k <= 5 ? 0.46 : 0.58);
    const c = this.c;
    c.beginPath();
    const step = Math.PI / k;
    let ang = -Math.PI / 2; // a point straight up
    c.moveTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r);
    for (let i = 0; i < k; i++) {
      ang += step;
      c.lineTo(x + Math.cos(ang) * ri, y + Math.sin(ang) * ri);
      ang += step;
      c.lineTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r);
    }
    c.closePath();
    this.finish(p, this.ink);
  }

  /** Triangle pointing along `dir` (radians, 0 = 3 o'clock, same as `arc`). */
  chevron(x: number, y: number, r: number, dir: number, p: Paint): void {
    if (!fin2(x, y) || !fin(r) || r <= 0 || !fin(dir)) return;
    const c = this.c;
    const back = 2.5; // ~143 degrees: a readable arrowhead, not a needle
    c.beginPath();
    c.moveTo(x + Math.cos(dir) * r, y + Math.sin(dir) * r);
    c.lineTo(x + Math.cos(dir + back) * r, y + Math.sin(dir + back) * r);
    c.lineTo(x + Math.cos(dir - back) * r, y + Math.sin(dir - back) * r);
    c.closePath();
    this.finish(p, this.ink);
  }

  // ─── Text ──────────────────────────────────────────────────────────────────

  /** Widest digit in the current font. Cached per font string. */
  private digitWidth(): number {
    const f = this.c.font;
    let d = this.digitCache.get(f);
    if (d === undefined) {
      d = 0;
      for (let i = 0; i < DIGIT_COUNT; i++) {
        const w = this.c.measureText(DIGITS[i]!).width;
        if (w > d) d = w;
      }
      if (this.digitCache.size > 64) this.digitCache.clear();
      this.digitCache.set(f, d);
    }
    return d;
  }

  /** Advance of a single character in the current font. Cached per font+char so
   *  the tabular draw loop does not re-measure every frame. */
  private charWidth(ch: string): number {
    const key = `${this.c.font} ${ch}`;
    let w = this.charCache.get(key);
    if (w === undefined) {
      w = this.c.measureText(ch).width;
      if (this.charCache.size > 512) this.charCache.clear();
      this.charCache.set(key, w);
    }
    return w;
  }

  private widthOf(s: string, tabular: boolean): number {
    if (!tabular) return this.c.measureText(s).width;
    const dw = this.digitWidth();
    return tabularWidth(s, dw, (ch) => this.charWidth(ch));
  }

  /** Lay a string out on the tabular digit grid, left edge at `x`. */
  private drawTabular(s: string, x: number, y: number, mode: 'fill' | 'stroke'): void {
    const c = this.c;
    const dw = this.digitWidth();
    let cx = x;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (isDigit(ch)) {
        // Centre the glyph inside its cell so "1" is not hard left.
        const gw = this.charWidth(ch);
        const px = cx + (dw - gw) / 2;
        if (mode === 'fill') c.fillText(ch, px, y);
        else c.strokeText(ch, px, y);
        cx += dw;
      } else {
        if (mode === 'fill') c.fillText(ch, cx, y);
        else c.strokeText(ch, cx, y);
        cx += this.charWidth(ch);
      }
    }
  }

  text(s: string, x: number, y: number, o?: TextOpts): void {
    if (s === undefined || s === null) return;
    const str = typeof s === 'string' ? s : String(s);
    if (str === '' || !fin2(x, y)) return;
    const c = this.c;
    const display = o?.display ?? false;
    const tabular = o?.tabular ?? false;
    const weight = o?.weight ?? (display ? 800 : 700);
    let size = clampTextSize(o?.size ?? 28);

    c.font = fontString(size, weight, display);
    applyTracking(c, size);
    let w = this.widthOf(str, tabular);

    const mw = o?.maxWidth;
    if (mw !== undefined && mw > 0 && w > mw) {
      // Shrink to fit rather than using fillText's maxWidth, which condenses
      // the glyphs horizontally and makes Hangul look squashed and cheap.
      const shrink = Math.max(0.6, mw / w);
      size = Math.max(MIN_FIT_PX, size * shrink);
      c.font = fontString(size, weight, display);
      applyTracking(c, size);
      w = this.widthOf(str, tabular);
    }

    const rot = o?.rot ?? 0;
    const turned = rot !== 0 && fin(rot);
    if (turned) {
      c.save();
      c.translate(x, y);
      c.rotate(rot);
    }
    const bx = turned ? 0 : x;
    const by = turned ? 0 : y;
    const align = o?.align ?? 'left';
    c.textBaseline = o?.baseline ?? 'alphabetic';

    let ox = bx;
    if (tabular) {
      // We place glyphs ourselves, so alignment is ours too.
      c.textAlign = 'left';
      ox = align === 'center' ? bx - w / 2 : align === 'right' ? bx - w : bx;
    } else {
      c.textAlign = align;
    }

    // Outline BEHIND the fill, whole string at a time. Over a busy game
    // background this is the difference between readable and invisible.
    const strokeCol = o?.stroke;
    if (strokeCol) {
      c.lineWidth = Math.max(1, o?.sw ?? size * 0.17);
      c.lineJoin = 'round';
      c.miterLimit = 2;
      c.strokeStyle = strokeCol;
      if (tabular) this.drawTabular(str, ox, by, 'stroke');
      else c.strokeText(str, ox, by);
    }
    c.fillStyle = o?.fill ?? C.text;
    if (tabular) this.drawTabular(str, ox, by, 'fill');
    else c.fillText(str, ox, by);

    if (turned) c.restore();
  }

  measure(s: string, o?: TextOpts): number {
    if (!s) return 0;
    const display = o?.display ?? false;
    const size = clampTextSize(o?.size ?? 28);
    this.c.font = fontString(size, o?.weight ?? (display ? 800 : 700), display);
    applyTracking(this.c, size);
    return this.widthOf(s, o?.tabular ?? false);
  }

  /**
   * Draw a vector sprite centred on (x, y).
   *
   * Sprites are authored in a 100x100 box, so the transform here is the whole
   * trick: translate to the centre, rotate, scale by size/100, then shift the
   * author box so its centre lands on the origin. Stroke widths are in author
   * units and therefore scale with the sprite — an outline written as `4`
   * stays 4% of the sprite at every size, which is what keeps 58 games'
   * line weights consistent.
   */
  sprite(id: SpriteId, x: number, y: number, size: number, o?: SpriteOpts): void {
    if (!fin2(x, y) || !fin(size) || size <= 0) return;
    const sp = getSprite(id);
    if (!sp) {
      // Loud in dev, invisible in production: a typo should stop an author
      // immediately, but must never blank a child's screen mid-party.
      if (import.meta.env?.DEV) throw new Error(`[renderer] unknown sprite "${id}"`);
      return;
    }
    const c = this.c;
    c.save();
    if (o?.alpha !== undefined && fin(o.alpha)) c.globalAlpha *= clamp01(o.alpha);
    c.translate(x, y);
    if (o?.rot && fin(o.rot)) c.rotate(o.rot);
    const k = size / 100;
    c.scale(k * (o?.scaleX ?? 1), k * (o?.scaleY ?? 1));
    c.translate(-50, -50);

    let glowed = false;
    if (o?.glow && o.glow > 0 && this.glowLeft > 0) {
      // shadowBlur ignores the CTM, so it must be pre-divided by our scale or
      // a small sprite gets an enormous halo.
      c.shadowBlur = (o.glow * this._dpr) / Math.max(k, 1e-3);
      c.shadowColor = o.tint ?? C.white;
      this.glowLeft--;
      glowed = true;
    } else if (o?.glow && o.glow > 0) {
      this.glowsDropped++;
    }

    for (const layer of sp.layers) {
      const path = compiledPath(layer.d);
      const fill = o?.flatten ?? this.role(layer.fill, o);
      if (fill) {
        c.fillStyle = fill;
        c.fill(path);
        if (glowed) { c.shadowBlur = 0; glowed = false; }
      }
      // A flattened sprite is a silhouette: drawing its outline would put a
      // seam through a solid shape.
      const stroke = o?.flatten ? undefined : this.role(layer.stroke, o);
      if (stroke) {
        c.lineWidth = Math.max(0.4, layer.sw ?? 4);
        c.lineJoin = 'round';
        c.lineCap = 'round';
        c.strokeStyle = stroke;
        c.stroke(path);
      }
    }
    c.restore();
  }

  /** Resolve a sprite layer's palette role to a concrete colour. */
  private role(r: PaintRole | string | undefined, o?: SpriteOpts): string | undefined {
    if (r === undefined) return undefined;
    const h = o?.hue ?? this.themeHue;
    switch (r) {
      case 'theme': return hue(h, 78, 62);
      case 'themeLight': return hue(h, 82, 76);
      case 'themeDark': return hue(h, 70, 40);
      case 'ink': return C.ink;
      case 'keyline': return KEYLINE;
      case 'white': return C.white;
      case 'accent': return C.accent;
      case 'success': return C.success;
      case 'warn': return C.warn;
      case 'danger': return C.danger;
      case 'tint': return o?.tint ?? hue(h, 78, 62);
      default: return r; // already a CSS colour
    }
  }

  // ─── Body ──────────────────────────────────────────────────────────────────

  /**
   * The player avatar: a chunky flat "sticker" of the child's own body.
   *
   * Thick round limbs, a see-through rounded torso, a plain round head (no
   * face — ART.md §5) and big round mitts on the hands, over one ink keyline.
   * Drawn opaque into an offscreen layer, then composited ONCE at the
   * requested alpha. Painted straight onto the canvas at alpha 0.5 instead,
   * the ink under every limb shows through its colour and every overlap
   * darkens, and the body reads as an X-ray rather than a sticker.
   *
   * Cost: ~20 small fills/strokes into the layer (no shadow blur, no
   * allocation) plus one clear and one drawImage of the body's bounding box.
   *
   * Mirroring is already applied in `p.px`. Do not mirror again.
   */
  skeleton(p: PlayerPose, o?: SkeletonOpts): void {
    if (!p || !p.px || !p.vis) return;
    const al = clamp01(o?.alpha ?? 0.92);
    if (al <= 0) return;
    const col = o?.color ?? C.slot[p.slot] ?? C.slot[0];
    const u = bodyUnit(p.scalePx, this._s);
    const ink = o?.outline === false ? 0 : bodyInk(this._s);
    const lw = o?.lineWidth;
    const armW = lw !== undefined && fin(lw) && lw > 0 ? lw : u * BODY.arm;
    const legW = armW * (BODY.leg / BODY.arm);
    // -1 = each joint's own default size; 0 = no dots at all.
    const jr = o?.jointR !== undefined && fin(o.jointR) ? Math.max(0, o.jointR) : -1;
    const set = o?.jointSet;
    const dots = jr === 0 || set === 'none'
      ? EMPTY_JOINTS
      : set === 'all' ? SKELETON_JOINTS : set === 'hands' ? HAND_JOINTS : END_JOINTS;
    // Ankle "dots" are shoes, drawn with the legs so they merge into them.
    const shoes = dots === END_JOINTS || dots === SKELETON_JOINTS;
    const emph = o?.emphasize ?? EMPTY_JOINTS;
    const ringW = u * BODY.ringW;
    const pad = Math.max(
      u * BODY.head, legW, BODY.ring * Math.max(u * BODY.mitt, jr) + ringW,
    ) + 2 * ink + 2;
    if (!this.prepBody(p, pad)) return;

    const c = this.openBody(al);
    const layered = c !== this.c;
    const ba = layered ? 1 : this.a * al;
    const shoeR = jr > 0 ? jr : u * BODY.shoe;

    // Legs and shoes first: the torso covers their tops.
    if (ink > 0) {
      c.strokeStyle = KEYLINE;
      this.strokeLimbs(c, p, LEG_EDGES, legW + 2 * ink, ba);
      if (shoes && this.shoesPath(c, shoeR + ink) > 0) {
        c.fillStyle = KEYLINE;
        c.fill();
      }
    }
    c.strokeStyle = col;
    this.strokeLimbs(c, p, LEG_EDGES, legW, ba);
    if (shoes && this.shoesPath(c, shoeR) > 0) {
      c.fillStyle = col;
      c.fill();
    }

    // Neck and head before the torso, so the neck disappears into the collar.
    // The head is the body colour over white: a lighter tint of any CSS
    // colour a game passes, without parsing it.
    if (this.headOk) {
      const hr = u * BODY.head;
      const nw = u * BODY.neck;
      if (ink > 0) this.headPass(c, KEYLINE, nw + 2 * ink, hr + ink);
      this.headPass(c, C.white, nw, hr);
      c.globalAlpha = ba * BODY.headTint;
      this.headPass(c, col, nw, hr);
      c.globalAlpha = ba;
      c.beginPath();
      glossArc(c, this.hx, this.hy, hr);
      this.strokeGloss(c, u, ba);
    }

    // Torso: an ink rim around a see-through belly, so whatever the game drew
    // behind the child's chest stays visible.
    const tr = (u * BODY.torso) / 2;
    if (ink > 0) this.paintTorso(c, p, tr + ink, KEYLINE);
    if (layered) {
      // Punch the inside out of the layer (ink, neck base, leg tops), then
      // refill it translucent. Only possible on the layer: on the opaque
      // canvas this would cut a black hole.
      c.globalCompositeOperation = 'destination-out';
      this.paintTorso(c, p, tr, KEYLINE);
      c.globalCompositeOperation = 'source-over';
    }
    // A light tint, not a thin wash of the full colour: translucent blue over
    // a peach sky mixes to grey.
    c.globalAlpha = ba * BODY.bellyWhite;
    this.paintTorso(c, p, tr, C.white);
    c.globalAlpha = ba * BODY.bellyTint;
    this.paintTorso(c, p, tr, col);
    c.globalAlpha = ba;

    // Arms over the torso and head: hands raised in front of the face are in
    // front of it.
    if (ink > 0) {
      c.strokeStyle = KEYLINE;
      this.strokeLimbs(c, p, ARM_EDGES, armW + 2 * ink, ba);
    }
    c.strokeStyle = col;
    this.strokeLimbs(c, p, ARM_EDGES, armW, ba);

    // Mitts on the palms (and plain dots for `jointSet: 'all'`): one path per
    // pass. Only the ENDS by default — a dot on every joint reads as a
    // medical scan of a child rather than a character.
    if (dots.length > 0) {
      if (ink > 0 && this.dotsPath(c, p, dots, jr, u, ink) > 0) {
        c.fillStyle = KEYLINE;
        c.fill();
      }
      if (this.dotsPath(c, p, dots, jr, u, 0) > 0) {
        c.fillStyle = col;
        c.fill();
      }
      // A shine on each mitt: a vinyl toy, not a target marker.
      c.beginPath();
      let shine = 0;
      for (let i = 0; i < dots.length; i++) {
        const j = dots[i]!;
        if ((j !== L.LEFT_WRIST && j !== L.RIGHT_WRIST) || !this.dotAt(p, j)) continue;
        glossArc(c, this.tx, this.ty, dotRadius(j, u, jr));
        shine++;
      }
      if (shine > 0) this.strokeGloss(c, u, ba);
    }

    // "This is the hand that matters": a bright ring with a gap, so it reads
    // as a halo around the mitt rather than a bigger mitt.
    if (emph.length > 0 && this.ringsPath(c, p, emph, jr, u) > 0) {
      if (ink > 0) {
        c.strokeStyle = KEYLINE;
        c.lineWidth = ringW + 2 * ink;
        c.stroke();
      }
      c.strokeStyle = C.accent;
      c.lineWidth = ringW;
      c.stroke();
    }

    this.closeBody(c, al);
  }

  /**
   * Soft coloured silhouette: the avatar's own shape, grown, in one flat
   * light tint of the player's colour.
   *
   * Drawn under the skeleton it is a faint aura; on its own it shows a parent
   * exactly what the camera sees — a filled shape with no face, which is the
   * privacy story made visible. Same layer as the skeleton, so overlapping
   * limbs do not darken where they cross.
   */
  ghostBody(p: PlayerPose, alpha: number): void {
    if (!p || !p.px || !p.vis) return;
    const a = clamp01(fin(alpha) ? alpha : 0.5);
    if (a <= 0) return;
    const col = C.slot[p.slot] ?? C.slot[0];
    const u = bodyUnit(p.scalePx, this._s);
    const g = u * BODY.ghostGrow;
    if (!this.prepBody(p, Math.max(u * BODY.head, u * BODY.leg) + g + 2)) return;

    const c = this.openBody(a);
    const layered = c !== this.c;
    const ba = layered ? 1 : this.a * a;
    // On the layer: a white silhouette, then the colour laid over it
    // `source-atop` — one rect, tinting only where the silhouette is.
    const base = layered ? C.white : col;
    c.strokeStyle = base;
    c.fillStyle = base;
    this.strokeLimbs(c, p, LEG_EDGES, u * BODY.leg + 2 * g, ba);
    this.strokeLimbs(c, p, ARM_EDGES, u * BODY.arm + 2 * g, ba);
    if (this.shoesPath(c, u * BODY.shoe + g) > 0) c.fill();
    this.paintTorso(c, p, (u * BODY.torso) / 2 + g, base);
    if (this.headOk) this.headPass(c, base, u * BODY.neck + 2 * g, u * BODY.head + g);
    if (this.dotsPath(c, p, HAND_JOINTS, -1, u, g) > 0) {
      c.fillStyle = base;
      c.fill();
    }
    if (layered) {
      c.globalCompositeOperation = 'source-atop';
      c.globalAlpha = BODY.ghostTint;
      c.fillStyle = col;
      c.fillRect(this.bx0, this.by0, this.bx1 - this.bx0, this.by1 - this.by0);
      c.globalCompositeOperation = 'source-over';
      c.globalAlpha = 1;
    }
    this.closeBody(c, a);
  }

  /** Free the body layer's backing store now rather than at some later GC:
   *  the attract reel builds a renderer for every game it shows. */
  dispose(): void {
    if (this.layerCanvas) {
      this.layerCanvas.width = 0;
      this.layerCanvas.height = 0;
    }
    this.layerCanvas = null;
    this.layerCtx = null;
    this.layerTried = true;
  }

  // Scratch for one body draw. Fields, so a frame allocates nothing.
  private layerCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private layerCtx: CanvasRenderingContext2D | null = null;
  private layerTried = false;
  /** Body bounds, logical px. */
  private bx0 = 0;
  private by0 = 0;
  private bx1 = 0;
  private by1 = 0;
  /** The layer region in use, device px. */
  private lx = 0;
  private ly = 0;
  private lw = 0;
  private lh = 0;
  private readonly palmL: Pt = { x: 0, y: 0 };
  private readonly palmR: Pt = { x: 0, y: 0 };
  private palmOkL = false;
  private palmOkR = false;
  private readonly shoeL: Pt = { x: 0, y: 0 };
  private readonly shoeR: Pt = { x: 0, y: 0 };
  private shoeOkL = false;
  private shoeOkR = false;
  private headOk = false;
  /** Head centre and shoulder centre. */
  private hx = 0;
  private hy = 0;
  private sx = 0;
  private sy = 0;
  /** Out-params of `dotAt`. */
  private tx = 0;
  private ty = 0;
  /** Torso corners: left shoulder, right shoulder, right hip, left hip. */
  private readonly quad = new Float64Array(8);

  /** The offscreen body layer, created on first use and kept at the
   *  canvas's backing size. Null where there is no way to make one (the unit
   *  tests' fake context), in which case the body draws straight onto the
   *  canvas. */
  private bodyLayer(): CanvasRenderingContext2D | null {
    if (!this.layerTried) {
      this.layerTried = true;
      try {
        const doc = (this.canvas as { ownerDocument?: Document | null }).ownerDocument;
        const OC = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
        const cv = doc ? doc.createElement('canvas') : OC ? new OC(1, 1) : null;
        const lc = cv ? ((cv as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D | null) : null;
        if (cv && lc) {
          this.layerCanvas = cv;
          this.layerCtx = lc;
        }
      } catch {
        // No layer: draw straight onto the canvas.
      }
    }
    const cv = this.layerCanvas;
    if (!cv || !this.layerCtx) return null;
    if (cv.width !== this.canvas.width) cv.width = this.canvas.width;
    if (cv.height !== this.canvas.height) cv.height = this.canvas.height;
    return this.layerCtx;
  }

  /**
   * Work out where this body is: its padded bounds, its palms and its head.
   * False when not one joint is trustworthy, so the caller draws nothing.
   */
  private prepBody(p: PlayerPose, pad: number): boolean {
    const px = p.px;
    const vis = p.vis;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < BODY_JOINTS.length; i++) {
      const j = BODY_JOINTS[i]!;
      if (!(vis[j]! >= MIN_VIS)) continue;
      const x = px[j * 2]!;
      const y = px[j * 2 + 1]!;
      if (!fin2(x, y)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    // Mitts sit on the palm, past the wrist, where the games hit-test.
    this.palmOkL = mittAt(p, 'L', this.palmL);
    this.palmOkR = mittAt(p, 'R', this.palmR);
    this.shoeOkL = shoeAt(p, 'L', this.shoeL);
    this.shoeOkR = shoeAt(p, 'R', this.shoeR);
    if (this.palmOkL) {
      const q = this.palmL;
      if (q.x < x0) x0 = q.x;
      if (q.x > x1) x1 = q.x;
      if (q.y < y0) y0 = q.y;
      if (q.y > y1) y1 = q.y;
    }
    if (this.palmOkR) {
      const q = this.palmR;
      if (q.x < x0) x0 = q.x;
      if (q.x > x1) x1 = q.x;
      if (q.y < y0) y0 = q.y;
      if (q.y > y1) y1 = q.y;
    }
    // A head needs a nose and both shoulders: without the shoulders there is
    // nothing to hang it from.
    this.headOk = false;
    if (
      vis[L.NOSE]! >= MIN_VIS && vis[L.LEFT_SHOULDER]! >= MIN_VIS &&
      vis[L.RIGHT_SHOULDER]! >= MIN_VIS
    ) {
      this.hx = px[L.NOSE * 2]!;
      this.hy = px[L.NOSE * 2 + 1]!;
      this.sx = (px[L.LEFT_SHOULDER * 2]! + px[L.RIGHT_SHOULDER * 2]!) / 2;
      this.sy = (px[L.LEFT_SHOULDER * 2 + 1]! + px[L.RIGHT_SHOULDER * 2 + 1]!) / 2;
      this.headOk = fin4(this.hx, this.hy, this.sx, this.sy);
    }
    if (!(x0 <= x1)) return false;
    this.bx0 = x0 - pad;
    this.by0 = y0 - pad;
    this.bx1 = x1 + pad;
    this.by1 = y1 + pad;
    return true;
  }

  /** A cleared, dpr-scaled layer to draw the body into — or, with no layer,
   *  the canvas itself at the body's alpha. */
  private openBody(al: number): CanvasRenderingContext2D {
    const lc = this.bodyLayer();
    if (lc) {
      const d = this._dpr;
      const x0 = Math.max(0, Math.floor(this.bx0 * d));
      const y0 = Math.max(0, Math.floor(this.by0 * d));
      const x1 = Math.min(this.canvas.width, Math.ceil(this.bx1 * d));
      const y1 = Math.min(this.canvas.height, Math.ceil(this.by1 * d));
      this.lx = x0;
      this.ly = y0;
      this.lw = x1 - x0;
      this.lh = y1 - y0;
      lc.setTransform(1, 0, 0, 1, 0, 0);
      lc.globalAlpha = 1;
      lc.globalCompositeOperation = 'source-over';
      // Only this box is cleared and only this box is copied out, so nothing
      // a previous frame left elsewhere in the layer can ever show.
      if (this.lw > 0 && this.lh > 0) lc.clearRect(x0, y0, this.lw, this.lh);
      lc.setTransform(d, 0, 0, d, 0, 0);
      lc.lineCap = 'round';
      lc.lineJoin = 'round';
      return lc;
    }
    const c = this.c;
    c.save();
    c.globalAlpha = this.a * al;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    return c;
  }

  /** Composite the layer onto the canvas once, at the body's alpha, under the
   *  canvas's current transform (so camera shake moves the body too). */
  private closeBody(c: CanvasRenderingContext2D, al: number): void {
    if (c === this.c) {
      c.restore();
      return;
    }
    if (this.lw <= 0 || this.lh <= 0 || !this.layerCanvas) return;
    const m = this.c;
    const d = this._dpr;
    m.save();
    m.globalAlpha = this.a * al;
    m.drawImage(
      this.layerCanvas, this.lx, this.ly, this.lw, this.lh,
      this.lx / d, this.ly / d, this.lw / d, this.lh / d,
    );
    m.restore();
  }

  /**
   * Stroke a set of limbs (flat joint pairs) at one width and style.
   *
   * Fully trusted limbs share ONE path, so their round joins merge into one
   * shape. Limbs in the confidence band fade instead of blinking: a hard
   * MIN_VIS switch makes an arm vanish and reappear between frames, which
   * reads as the camera having lost the player.
   */
  private strokeLimbs(
    c: CanvasRenderingContext2D,
    p: PlayerPose,
    edges: readonly number[],
    width: number,
    ba: number,
  ): void {
    const px = p.px;
    c.lineWidth = width;
    c.beginPath();
    let n = 0;
    for (let i = 0; i < edges.length; i += 2) {
      const a = edges[i]!;
      const b = edges[i + 1]!;
      if (limbFade(p.vis[a]!, p.vis[b]!) < 1) continue;
      const ax = px[a * 2]!;
      const ay = px[a * 2 + 1]!;
      const bx = px[b * 2]!;
      const by = px[b * 2 + 1]!;
      if (!fin4(ax, ay, bx, by)) continue;
      c.moveTo(ax, ay);
      c.lineTo(bx, by);
      n++;
    }
    if (n > 0) c.stroke();
    for (let i = 0; i < edges.length; i += 2) {
      const a = edges[i]!;
      const b = edges[i + 1]!;
      const k = limbFade(p.vis[a]!, p.vis[b]!);
      if (k <= 0 || k >= 1) continue;
      const ax = px[a * 2]!;
      const ay = px[a * 2 + 1]!;
      const bx = px[b * 2]!;
      const by = px[b * 2 + 1]!;
      if (!fin4(ax, ay, bx, by)) continue;
      c.globalAlpha = ba * k;
      c.beginPath();
      c.moveTo(ax, ay);
      c.lineTo(bx, by);
      c.stroke();
    }
    c.globalAlpha = ba;
  }

  /** Stroke the current gloss path: white, top-left, no keyline (ART.md §2.7). */
  private strokeGloss(c: CanvasRenderingContext2D, u: number, ba: number): void {
    c.globalAlpha = ba * BODY.gloss;
    c.strokeStyle = C.white;
    c.lineWidth = u * BODY.glossW;
    c.stroke();
    c.globalAlpha = ba;
  }

  /**
   * Neck plus head disc as ONE fill, so a translucent pass (the head tint)
   * covers the overlap once instead of showing the neck through the head.
   * The neck is a quad wound the same way as the arc, so nonzero fill unions
   * them; its flat bottom end sits inside the torso and is punched away.
   */
  private headPass(c: CanvasRenderingContext2D, style: string, neckW: number, r: number): void {
    const dx = this.hx - this.sx;
    const dy = this.hy - this.sy;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (neckW / 2);
    const ny = (dx / len) * (neckW / 2);
    c.beginPath();
    c.moveTo(this.sx - nx, this.sy - ny);
    c.lineTo(this.hx - nx, this.hy - ny);
    c.lineTo(this.hx + nx, this.hy + ny);
    c.lineTo(this.sx + nx, this.sy + ny);
    c.closePath();
    c.moveTo(this.hx + r, this.hy);
    c.arc(this.hx, this.hy, r, 0, TAU);
    c.fillStyle = style;
    c.fill();
  }

  /**
   * Paint the torso grown by `r`, in one call: the quad (shoulders + hips)
   * with round corners, or just the shoulder bar when the hips are out of
   * frame.
   *
   * The rounded quad is built as ONE closed outline — an arc on each corner
   * joined by the offset edges — and filled once. fill() then a round-joined
   * stroke() would paint the inner half of the stroke twice, and at partial
   * alpha that shows as a lighter rim inside the belly.
   */
  private paintTorso(c: CanvasRenderingContext2D, p: PlayerPose, r: number, style: string): void {
    const v = p.vis;
    const px = p.px;
    if (!(v[L.LEFT_SHOULDER]! >= MIN_VIS && v[L.RIGHT_SHOULDER]! >= MIN_VIS)) return;
    const q = this.quad;
    q[0] = px[L.LEFT_SHOULDER * 2]!;
    q[1] = px[L.LEFT_SHOULDER * 2 + 1]!;
    q[2] = px[L.RIGHT_SHOULDER * 2]!;
    q[3] = px[L.RIGHT_SHOULDER * 2 + 1]!;
    if (!fin4(q[0], q[1], q[2], q[3])) return;
    q[4] = px[L.RIGHT_HIP * 2]!;
    q[5] = px[L.RIGHT_HIP * 2 + 1]!;
    q[6] = px[L.LEFT_HIP * 2]!;
    q[7] = px[L.LEFT_HIP * 2 + 1]!;
    c.beginPath();
    if (!(v[L.LEFT_HIP]! >= MIN_VIS && v[L.RIGHT_HIP]! >= MIN_VIS) || !fin4(q[4], q[5], q[6], q[7])) {
      c.moveTo(q[0], q[1]);
      c.lineTo(q[2], q[3]);
      c.lineWidth = 2 * r;
      c.strokeStyle = style;
      c.stroke();
      return;
    }
    // Walk the corners clockwise on screen (positive shoelace area), so each
    // corner's arc runs from the previous edge's outward normal to the next's.
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const k = ((i + 1) & 3) * 2;
      area += q[i * 2]! * q[k + 1]! - q[k]! * q[i * 2 + 1]!;
    }
    const step = area >= 0 ? 1 : 3;
    let i = 0;
    for (let n = 0; n < 4; n++) {
      const pi = ((i + 4 - step) & 3) * 2;
      const ni = ((i + step) & 3) * 2;
      const x = q[i * 2]!;
      const y = q[i * 2 + 1]!;
      // Outward normal of edge a->b on a clockwise outline is (dy, -dx).
      const a0 = Math.atan2(-(x - q[pi]!), y - q[pi + 1]!);
      const a1 = Math.atan2(-(q[ni]! - x), q[ni + 1]! - y);
      c.arc(x, y, r, a0, a1, false);
      i = (i + step) & 3;
    }
    c.closePath();
    c.fillStyle = style;
    c.fill();
  }

  /** Where joint `j`'s dot goes (wrists: the palm; ankles: the shoe). Writes
   *  `tx`/`ty`. */
  private dotAt(p: PlayerPose, j: number): boolean {
    if (j < 0 || j * 2 + 1 >= p.px.length || !(p.vis[j]! >= MIN_VIS)) return false;
    const q = j === L.LEFT_WRIST ? (this.palmOkL ? this.palmL : null)
      : j === L.RIGHT_WRIST ? (this.palmOkR ? this.palmR : null)
        : j === L.LEFT_ANKLE ? (this.shoeOkL ? this.shoeL : null)
          : j === L.RIGHT_ANKLE ? (this.shoeOkR ? this.shoeR : null)
            : null;
    this.tx = q ? q.x : p.px[j * 2]!;
    this.ty = q ? q.y : p.px[j * 2 + 1]!;
    return fin2(this.tx, this.ty);
  }

  /** Path of both shoes at radius `r`. Returns how many. */
  private shoesPath(c: CanvasRenderingContext2D, r: number): number {
    c.beginPath();
    let n = 0;
    if (this.shoeOkL) {
      c.moveTo(this.shoeL.x + r, this.shoeL.y);
      c.arc(this.shoeL.x, this.shoeL.y, r, 0, TAU);
      n++;
    }
    if (this.shoeOkR) {
      c.moveTo(this.shoeR.x + r, this.shoeR.y);
      c.arc(this.shoeR.x, this.shoeR.y, r, 0, TAU);
      n++;
    }
    return n;
  }

  /** Path of every dot in `set` except the ankles (those are shoes, drawn
   *  with the legs), each grown by `grow`. Returns how many. */
  private dotsPath(
    c: CanvasRenderingContext2D,
    p: PlayerPose,
    set: readonly number[],
    jr: number,
    u: number,
    grow: number,
  ): number {
    c.beginPath();
    let n = 0;
    for (let i = 0; i < set.length; i++) {
      const j = set[i]!;
      if (j === L.LEFT_ANKLE || j === L.RIGHT_ANKLE || !this.dotAt(p, j)) continue;
      const r = dotRadius(j, u, jr) + grow;
      c.moveTo(this.tx + r, this.ty);
      c.arc(this.tx, this.ty, r, 0, TAU);
      n++;
    }
    return n;
  }

  /** Path of an emphasis ring around every joint in `set`. Returns how many. */
  private ringsPath(
    c: CanvasRenderingContext2D,
    p: PlayerPose,
    set: readonly number[],
    jr: number,
    u: number,
  ): number {
    c.beginPath();
    let n = 0;
    for (let i = 0; i < set.length; i++) {
      const j = set[i]!;
      if (!this.dotAt(p, j)) continue;
      const r = BODY.ring * dotRadius(j, u, jr);
      c.moveTo(this.tx + r, this.ty);
      c.arc(this.tx, this.ty, r, 0, TAU);
      n++;
    }
    return n;
  }
}

/** Absolute floor when shrinking to fit `maxWidth`. Below this the label is not
 *  readable at 2m and the layout is wrong, not the text. */
const MIN_FIT_PX = 14;

/**
 * Keep a renderer's backing store matched to the canvas's CSS-measured size.
 *
 * For the shell: give the canvas a CSS size (`width:100%;height:100%;display:
 * block`) and call this once. Returns a teardown function.
 *
 * `host` defaults to the canvas itself. Pass the wrapper element instead when
 * the canvas is absolutely positioned inside it.
 */
export function attachResize(r: Canvas2DRenderer, host?: Element): () => void {
  const el = host ?? r.canvas;
  const apply = (): void => {
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w > 0 && h > 0 && (w !== r.w || h !== r.h)) r.resize(w, h);
  };
  apply();
  const RO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  if (RO) {
    const ro = new RO(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }
  const g = globalThis as {
    addEventListener?: typeof addEventListener;
    removeEventListener?: typeof removeEventListener;
  };
  g.addEventListener?.('resize', apply);
  return () => g.removeEventListener?.('resize', apply);
}

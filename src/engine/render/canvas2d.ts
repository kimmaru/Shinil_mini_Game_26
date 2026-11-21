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
import { L, MIN_VIS, POSE_EDGES } from '../pose/landmarks';
import type { Paint, PlayerPose, Renderer, SkeletonOpts, TextOpts } from '../types';
import { C, fade } from './palette';
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
const SKELETON_JOINTS: readonly number[] = (() => {
  const seen = new Set<number>();
  for (const e of POSE_EDGES) {
    seen.add(e[0]);
    seen.add(e[1]);
  }
  return [...seen];
})();

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
  /** Opaque canvas by default: the compositor skips a blend per frame, and the
   *  in-game canvas is never transparent anyway. */
  alpha?: boolean;
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
  private maxDpr: number;
  private dprForced: number | undefined;
  private manageStyle: boolean;

  /** Seconds since the round started. Set by `beginFrame`. */
  t = 0;

  /** Our own alpha stack: `alpha()` multiplies, so we must know the current
   *  value. `ctx.save()` also saves globalAlpha, we just mirror it. */
  private a = 1;
  private readonly aStack: number[] = [];

  private glowLeft = GLOW_BUDGET;
  private glowsDropped = 0;

  // Cached full-screen gradients, rebuilt only when the hue or the size changes.
  private bgKey = '';
  private bgGrad: CanvasGradient | null = null;
  private vigGrad: CanvasGradient | null = null;

  // Text metric caches, keyed by the ctx.font string.
  private readonly digitCache = new Map<string, number>();
  private readonly charCache = new Map<string, number>();
  private readonly emojiOffCache = new Map<string, number>();

  constructor(canvas: HTMLCanvasElement, o?: Canvas2DOpts) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', {
      alpha: o?.alpha ?? false,
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
    this.bgKey = '';
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
    c.save();
    c.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.shadowBlur = 0;

    const key = `${hd}|${w}|${h}`;
    if (key !== this.bgKey || !this.bgGrad) {
      this.bgKey = key;
      const g = c.createLinearGradient(0, 0, 0, h);
      if (hd < 0) {
        g.addColorStop(0, C.bg);
        g.addColorStop(1, C.bgDeep);
      } else {
        // A tint, not a repaint: the game is recognisably the same product.
        g.addColorStop(0, `hsl(${hd} 44% 18%)`);
        g.addColorStop(0.52, C.bg);
        g.addColorStop(1, C.bgDeep);
      }
      this.bgGrad = g;
      const r = c.createRadialGradient(
        w / 2, h * 0.4, Math.min(w, h) * 0.12,
        w / 2, h * 0.5, Math.max(w, h) * 0.8,
      );
      r.addColorStop(0, 'rgb(255 255 255 / 0.055)');
      r.addColorStop(0.58, 'rgb(0 0 0 / 0)');
      r.addColorStop(1, 'rgb(0 0 0 / 0.4)');
      this.vigGrad = r;
    }
    c.fillStyle = this.bgGrad;
    c.fillRect(0, 0, w, h);
    if (this.vigGrad) {
      c.fillStyle = this.vigGrad;
      c.fillRect(0, 0, w, h);
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
   * The entire art pipeline.
   *
   * Centring matters more than it sounds: `textBaseline = 'middle'` puts the
   * x-height midpoint at `y`, and emoji glyphs fill the em box, so every emoji
   * in the game sits ~8% of its size too low — enough that a hit marker misses
   * the thing it is marking. We measure the glyph's real ink box once and cache
   * the baseline offset as a ratio of the size.
   */
  emoji(s: string, x: number, y: number, size: number, rot?: number): void {
    if (!s || !fin2(x, y) || !fin(size) || size <= 0) return;
    const c = this.c;
    const turned = rot !== undefined && rot !== 0 && fin(rot);
    // Integer px with no rotation keeps the colour bitmap crisp instead of
    // resampled; a rotating emoji is resampled regardless.
    const px = turned ? Math.max(8, size) : Math.max(8, Math.round(size));
    c.font = emojiFontString(px);
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    c.fillStyle = C.text; // only used by a monochrome fallback glyph
    const off = this.emojiOffset(s, px) * px;
    if (turned) {
      c.save();
      c.translate(x, y);
      c.rotate(rot!);
      c.fillText(s, 0, off);
      c.restore();
    } else {
      c.fillText(s, Math.round(x), Math.round(y + off));
    }
  }

  /** Baseline offset, as a fraction of the font size, that centres this glyph's
   *  ink box on `y`. Cached per glyph. ~0.37 for most emoji. */
  private emojiOffset(s: string, px: number): number {
    let r = this.emojiOffCache.get(s);
    if (r === undefined) {
      const m = this.c.measureText(s) as TextMetrics;
      const asc = m.actualBoundingBoxAscent;
      const desc = m.actualBoundingBoxDescent;
      r =
        fin2(asc, desc) && asc + desc > 0 && px > 0
          ? (asc - desc) / 2 / px
          : 0.37;
      if (!fin(r) || Math.abs(r) > 1) r = 0.37;
      if (this.emojiOffCache.size > 256) this.emojiOffCache.clear();
      this.emojiOffCache.set(s, r);
    }
    return r;
  }

  // ─── Body ──────────────────────────────────────────────────────────────────

  /**
   * The skeleton overlay.
   *
   * Two full passes over POSE_EDGES: a dark outline underneath, then the
   * slot-coloured stroke on top. One stroke call each, so it is two paths per
   * body regardless of how many edges are visible. The outline is not decoration
   * — a cyan limb over a cyan shirt is invisible, and the player then believes
   * tracking is broken.
   *
   * Mirroring is already applied in `p.px`. Do not mirror again.
   */
  skeleton(p: PlayerPose, o?: SkeletonOpts): void {
    if (!p || !p.px || !p.vis) return;
    const c = this.c;
    const col = o?.color ?? C.slot[p.slot] ?? C.slot[0];
    const al = clamp01(o?.alpha ?? 0.92);
    if (al <= 0) return;
    const lw = Math.max(3, o?.lineWidth ?? 9 * this._s);
    const outline = o?.outline ?? true;
    const ow = Math.max(2, 3.2 * this._s);
    const jr = o?.jointR ?? lw * 0.72;

    c.save();
    c.globalAlpha = this.a * al;
    c.lineCap = 'round';
    c.lineJoin = 'round';

    if (outline) {
      c.strokeStyle = C.ink;
      c.lineWidth = lw + ow * 2;
      this.strokeEdges(p);
      this.strokeHead(p, jr, lw + ow * 2, true);
    }
    c.strokeStyle = col;
    c.lineWidth = lw;
    this.strokeEdges(p);
    this.strokeHead(p, jr, lw, false, col);

    if (jr > 0) {
      // Joint dots: dark ring under a coloured core, same reason as the limbs.
      for (let i = 0; i < SKELETON_JOINTS.length; i++) {
        const j = SKELETON_JOINTS[i]!;
        if (p.vis[j]! < MIN_VIS) continue;
        const jxp = p.px[j * 2]!;
        const jyp = p.px[j * 2 + 1]!;
        if (!fin2(jxp, jyp)) continue;
        if (outline) {
          c.beginPath();
          c.arc(jxp, jyp, jr + ow, 0, TAU);
          c.fillStyle = C.ink;
          c.fill();
        }
        c.beginPath();
        c.arc(jxp, jyp, jr, 0, TAU);
        c.fillStyle = col;
        c.fill();
      }
    }

    const emph = o?.emphasize;
    if (emph && emph.length > 0) {
      const er = Math.max(jr * 2, 10 * this._s);
      for (let i = 0; i < emph.length; i++) {
        const j = emph[i]!;
        if (j < 0 || j * 2 + 1 >= p.px.length) continue;
        if (p.vis[j]! < MIN_VIS) continue;
        const jxp = p.px[j * 2]!;
        const jyp = p.px[j * 2 + 1]!;
        if (!fin2(jxp, jyp)) continue;
        c.beginPath();
        c.arc(jxp, jyp, er + ow, 0, TAU);
        c.fillStyle = C.ink;
        c.fill();
        c.beginPath();
        c.arc(jxp, jyp, er, 0, TAU);
        c.fillStyle = C.white;
        c.fill();
        c.beginPath();
        c.arc(jxp, jyp, er * 0.62, 0, TAU);
        c.fillStyle = col;
        c.fill();
      }
    }
    c.restore();
  }

  private strokeEdges(p: PlayerPose): void {
    const c = this.c;
    c.beginPath();
    for (let i = 0; i < POSE_EDGES.length; i++) {
      const e = POSE_EDGES[i]!;
      const a = e[0];
      const b = e[1];
      if (p.vis[a]! < MIN_VIS || p.vis[b]! < MIN_VIS) continue;
      const ax = p.px[a * 2]!;
      const ay = p.px[a * 2 + 1]!;
      const bx = p.px[b * 2]!;
      const by = p.px[b * 2 + 1]!;
      if (!fin4(ax, ay, bx, by)) continue;
      c.moveTo(ax, ay);
      c.lineTo(bx, by);
    }
    c.stroke();
  }

  /** A neck line plus a head ring. POSE_EDGES has no head (no face dots, by
   *  design), and a skeleton without one reads as a decapitated puppet. */
  private strokeHead(
    p: PlayerPose,
    jr: number,
    lw: number,
    dark: boolean,
    col?: string,
  ): void {
    const c = this.c;
    if (p.vis[L.NOSE]! < MIN_VIS) return;
    if (p.vis[L.LEFT_SHOULDER]! < MIN_VIS || p.vis[L.RIGHT_SHOULDER]! < MIN_VIS) return;
    const nx = p.px[L.NOSE * 2]!;
    const ny = p.px[L.NOSE * 2 + 1]!;
    const sx = (p.px[L.LEFT_SHOULDER * 2]! + p.px[L.RIGHT_SHOULDER * 2]!) / 2;
    const sy = (p.px[L.LEFT_SHOULDER * 2 + 1]! + p.px[L.RIGHT_SHOULDER * 2 + 1]!) / 2;
    if (!fin4(nx, ny, sx, sy)) return;
    const scale = fin(p.scalePx) && p.scalePx > 0 ? p.scalePx : jr * 8;
    const hr = scale * 0.34;
    // Stop the neck at the head ring so the line does not cross the face.
    const dx = nx - sx;
    const dy = ny - sy;
    const d = Math.hypot(dx, dy) || 1;
    const tx = nx - (dx / d) * hr;
    const ty = ny - (dy / d) * hr;
    c.beginPath();
    c.moveTo(sx, sy);
    c.lineTo(tx, ty);
    c.lineWidth = lw;
    c.strokeStyle = dark ? C.ink : col ?? C.white;
    c.stroke();
    c.beginPath();
    c.arc(nx, ny, hr, 0, TAU);
    c.stroke();
  }

  /**
   * Soft filled silhouette: torso quad + limb capsules + head.
   *
   * Used by the silhouette games and by the attract screen, where its real job
   * is showing a parent exactly what the camera sees — a filled blob with no
   * face, which is the privacy story made visible.
   *
   * Two passes (wide and faint, then narrow and solid) fake a soft edge for the
   * price of two more strokes. `ctx.filter = 'blur()'` would look better and
   * costs an offscreen surface per frame.
   */
  ghostBody(p: PlayerPose, alpha: number): void {
    if (!p || !p.px || !p.vis) return;
    const a = clamp01(fin(alpha) ? alpha : 0.5);
    if (a <= 0) return;
    const col = C.slot[p.slot] ?? C.slot[0];
    const scale = fin(p.scalePx) && p.scalePx > 0 ? p.scalePx : 120;
    const c = this.c;
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    this.ghostPass(p, col, a * 0.3, scale * 0.12, scale);
    this.ghostPass(p, col, a * 0.92, 0, scale);
    c.restore();
  }

  private ghostPass(
    p: PlayerPose,
    col: string,
    a: number,
    grow: number,
    scale: number,
  ): void {
    const c = this.c;
    const paint = fade(col, a);
    c.globalAlpha = this.a;
    c.fillStyle = paint;
    c.strokeStyle = paint;

    // Torso quad — the body's mass.
    if (
      p.vis[L.LEFT_SHOULDER]! >= MIN_VIS && p.vis[L.RIGHT_SHOULDER]! >= MIN_VIS &&
      p.vis[L.LEFT_HIP]! >= MIN_VIS && p.vis[L.RIGHT_HIP]! >= MIN_VIS
    ) {
      const quad = [L.LEFT_SHOULDER, L.RIGHT_SHOULDER, L.RIGHT_HIP, L.LEFT_HIP];
      let ok = true;
      for (const j of quad) if (!fin2(p.px[j * 2]!, p.px[j * 2 + 1]!)) ok = false;
      if (ok) {
        c.beginPath();
        c.moveTo(p.px[quad[0]! * 2]!, p.px[quad[0]! * 2 + 1]!);
        for (let i = 1; i < 4; i++) {
          c.lineTo(p.px[quad[i]! * 2]!, p.px[quad[i]! * 2 + 1]!);
        }
        c.closePath();
        c.fill();
        // Widen the silhouette so the quad edges are not razor straight.
        c.lineWidth = scale * 0.22 + grow;
        c.stroke();
      }
    }

    // Limb capsules.
    c.lineWidth = scale * 0.3 + grow;
    this.ghostLimb(p, L.LEFT_SHOULDER, L.LEFT_ELBOW);
    this.ghostLimb(p, L.LEFT_ELBOW, L.LEFT_WRIST);
    this.ghostLimb(p, L.RIGHT_SHOULDER, L.RIGHT_ELBOW);
    this.ghostLimb(p, L.RIGHT_ELBOW, L.RIGHT_WRIST);
    c.lineWidth = scale * 0.36 + grow;
    this.ghostLimb(p, L.LEFT_HIP, L.LEFT_KNEE);
    this.ghostLimb(p, L.LEFT_KNEE, L.LEFT_ANKLE);
    this.ghostLimb(p, L.RIGHT_HIP, L.RIGHT_KNEE);
    this.ghostLimb(p, L.RIGHT_KNEE, L.RIGHT_ANKLE);

    // Head: a blank oval. No eyes, no mouth — this is a shadow, not a portrait.
    if (p.vis[L.NOSE]! >= MIN_VIS) {
      const nx = p.px[L.NOSE * 2]!;
      const ny = p.px[L.NOSE * 2 + 1]!;
      if (fin2(nx, ny)) {
        c.beginPath();
        c.arc(nx, ny, scale * 0.4 + grow * 0.5, 0, TAU);
        c.fill();
      }
      if (p.vis[L.LEFT_SHOULDER]! >= MIN_VIS && p.vis[L.RIGHT_SHOULDER]! >= MIN_VIS) {
        const sx = (p.px[L.LEFT_SHOULDER * 2]! + p.px[L.RIGHT_SHOULDER * 2]!) / 2;
        const sy = (p.px[L.LEFT_SHOULDER * 2 + 1]! + p.px[L.RIGHT_SHOULDER * 2 + 1]!) / 2;
        if (fin2(sx, sy)) {
          c.lineWidth = scale * 0.34 + grow;
          c.beginPath();
          c.moveTo(sx, sy);
          c.lineTo(nx, ny);
          c.stroke();
        }
      }
    }
  }

  private ghostLimb(p: PlayerPose, a: number, b: number): void {
    if (p.vis[a]! < MIN_VIS || p.vis[b]! < MIN_VIS) return;
    const ax = p.px[a * 2]!;
    const ay = p.px[a * 2 + 1]!;
    const bx = p.px[b * 2]!;
    const by = p.px[b * 2 + 1]!;
    if (!fin4(ax, ay, bx, by)) return;
    const c = this.c;
    c.beginPath();
    c.moveTo(ax, ay);
    c.lineTo(bx, by);
    c.stroke();
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

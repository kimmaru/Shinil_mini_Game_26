// Renderer that records draw calls as SVG instead of painting pixels.
//
// Why this exists: the visual gate has to look at 58 games, and the two
// obvious ways to get a picture are both closed.
//   - A real browser screenshot needs rAF, which the review pane suspends
//     whenever it is hidden, so a t=5s frame never arrives.
//   - canvas.toDataURL / toBlob are banned by scripts/check-privacy.mjs, and
//     that ban is load-bearing: it is what makes "no frame ever leaves this
//     machine" provable rather than promised. Punching a dev-only hole in it
//     would cost more than it buys.
//
// So we re-render the same draw calls into SVG. It needs no browser, no
// canvas, and no new dependency, and the output is TEXT — greppable for
// off-screen geometry and diffable between two runs of the same seed, which a
// PNG is not.
//
// Fidelity is deliberately approximate: glow becomes a soft blur, `measure`
// estimates advance widths. This answers "is the game drawing the right
// things in the right places", not "is the anti-aliasing correct".
import { L, MIN_VIS, POSE_EDGES } from '../pose/landmarks';
import type { RenderAudit } from './nullRenderer';
import {
  ARM_EDGES, BODY, bodyInk, bodyUnit, dotRadius, GLOSS_A0, GLOSS_A1, GLOSS_K, LEG_EDGES,
  limbFade, mittAt, shoeAt,
} from '../render/canvas2d';
import { C, KEYLINE } from '../render/palette';
import { SKY_DOT_FILL, SKY_DOTS, skyStops } from '../render/sky';
import type { Paint, Renderer, SkeletonOpts, TextOpts } from '../render/renderer';
import { getSprite, resolveRole, type SpriteId, type SpriteOpts } from '../render/sprite';
import type { PlayerPose, Pt } from '../types';

const n = (v: number): string =>
  Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '0';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Shared by every shape. Returns the fill/stroke/filter attribute string. */
function paintAttrs(p: Paint, glowIds: Set<number>): string {
  const fill = p.fill ?? 'none';
  let a = ` fill="${fill}"`;
  if (p.stroke) {
    a += ` stroke="${p.stroke}" stroke-width="${n(p.sw ?? 2)}"` +
      ' stroke-linejoin="round" stroke-linecap="round"';
  }
  if (p.glow && p.glow > 0) {
    const r = Math.max(1, Math.round(p.glow / 2));
    glowIds.add(r);
    a += ` filter="url(#glow${r})"`;
  }
  return a;
}

export interface SvgShotOpts {
  /** Drawn behind everything, so a game that never calls clear() still reads
   *  as a frame rather than as transparent nothing. */
  backdrop?: string;
  /** Round times, in seconds, to keep a frame for. One run yields every shot,
   *  so a contact sheet of 21 games costs 21 runs rather than 21 x frames. */
  snapAt?: readonly number[];
  /** Sky opacity, as Canvas2DOpts.skyAlpha. Default 1: shots show the opaque
   *  sky; pass render/sky.ts BACKDROP_SKY_ALPHA to see the backdrop look
   *  (the sky then shows `backdrop` through it). */
  skyAlpha?: number;
}

export class SvgRenderer implements Renderer {
  readonly w: number;
  readonly h: number;
  readonly s: number;
  t = 0;

  /** The same audit the NullRenderer keeps, so this drops into the harness in
   *  its place and the shot tool reports blank frames and off-screen geometry
   *  without a second run. */
  readonly audit: RenderAudit = {
    ops: 0, opsThisFrame: 0, frames: 0, framesWithNoDraw: 0,
    nanOps: 0, offscreenOps: 0, problems: [],
  };

  strict = false;

  /** Captured frames, keyed by the requested snapshot time in seconds. */
  readonly shots = new Map<number, string>();

  private readonly snapAt: number[];
  private snapIdx = 0;
  private out: string[] = [];
  private readonly glowIds = new Set<number>();
  /** Groups opened since each save(), so restore() closes exactly those. */
  private readonly stack: number[] = [];
  private open = 0;
  /** Unique ids for the skeleton's belly masks within one frame's document. */
  private maskN = 0;
  private readonly backdrop: string;
  private readonly skyAlpha: number;

  constructor(w: number, h: number, o: SvgShotOpts = {}) {
    this.w = w;
    this.h = h;
    this.s = Math.min(w, h) / 1000;
    this.backdrop = o.backdrop ?? C.bg;
    this.skyAlpha = o.skyAlpha !== undefined && Number.isFinite(o.skyAlpha)
      ? Math.max(0, Math.min(1, o.skyAlpha))
      : 1;
    this.snapAt = [...(o.snapAt ?? [])].sort((a, b) => a - b);
  }

  // ─── frame control ─────────────────────────────────────────────────────────

  /** Call before each render() so op counts are per-frame. */
  beginFrame(t: number): void {
    this.t = t;
    this.audit.opsThisFrame = 0;
    this.out = [];
    this.glowIds.clear();
    this.stack.length = 0;
    this.open = 0;
    this.maskN = 0;
  }

  /** Call after each render(). Captures a frame once the round passes the next
   *  requested time. */
  endFrame(): void {
    this.audit.frames++;
    if (this.audit.opsThisFrame === 0) this.audit.framesWithNoDraw++;
    while (
      this.snapIdx < this.snapAt.length &&
      this.t >= (this.snapAt[this.snapIdx] as number)
    ) {
      // Close any group the game left open, or the document is malformed.
      const depth = this.open + this.stack.reduce((a, b) => a + b, 0);
      const tail = '</g>'.repeat(depth);
      this.shots.set(this.snapAt[this.snapIdx] as number, this.toSvg(tail));
      this.snapIdx++;
    }
  }

  /** The finished SVG document for the frame most recently drawn. */
  toSvg(tail = ''): string {
    const defs = [...this.glowIds].map((r) =>
      `<filter id="glow${r}" x="-50%" y="-50%" width="200%" height="200%">` +
      `<feGaussianBlur stdDeviation="${r}"/>` +
      '<feComponentTransfer><feFuncA type="linear" slope="1.6"/></feComponentTransfer>' +
      '<feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>',
    ).join('');
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.w} ${this.h}" ` +
      `width="${this.w}" height="${this.h}">` +
      (defs ? `<defs>${defs}</defs>` : '') +
      `<rect width="${this.w}" height="${this.h}" fill="${this.backdrop}"/>` +
      this.out.join('') + tail +
      '</svg>'
    );
  }

  // ─── bookkeeping ───────────────────────────────────────────────────────────

  private op(...xy: number[]): void {
    this.audit.ops++;
    this.audit.opsThisFrame++;
    for (let i = 0; i < xy.length; i += 2) {
      const x = xy[i] as number;
      const y = xy[i + 1] as number;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        this.audit.nanOps++;
        if (this.audit.problems.length < 8) {
          this.audit.problems.push(`non-finite coord at t=${this.t.toFixed(2)}`);
        }
        if (this.strict) throw new Error(`[SvgRenderer] non-finite coord at t=${this.t}`);
        return;
      }
      if (x < -this.w || x > 2 * this.w || y < -this.h || y > 2 * this.h) {
        this.audit.offscreenOps++;
        if (this.audit.problems.length < 8) {
          this.audit.problems.push(`offscreen (${Math.round(x)},${Math.round(y)})`);
        }
        return;
      }
    }
  }

  private push(s: string): void {
    this.out.push(s);
  }

  private g(transform: string): void {
    this.push(`<g ${transform}>`);
    this.open++;
  }

  // ─── transform stack ───────────────────────────────────────────────────────

  save(): void {
    this.stack.push(this.open);
    this.open = 0;
  }

  restore(): void {
    for (let i = 0; i < this.open; i++) this.push('</g>');
    this.open = this.stack.pop() ?? 0;
  }

  translate(x: number, y: number): void {
    this.g(`transform="translate(${n(x)} ${n(y)})"`);
  }

  rotate(rad: number): void {
    this.g(`transform="rotate(${n((rad * 180) / Math.PI)})"`);
  }

  scale(x: number, y: number): void {
    this.g(`transform="scale(${n(x)} ${n(y)})"`);
  }

  alpha(a: number): void {
    // Nested group opacity multiplies in SVG, which is exactly the contract.
    this.g(`opacity="${n(Math.max(0, Math.min(1, a)))}"`);
  }

  // ─── shapes ────────────────────────────────────────────────────────────────

  clear(h?: number): void {
    this.op();
    // Same stops as the canvas renderer (render/sky.ts), so a shot shows what
    // a child sees rather than a more saturated sky nobody plays on.
    const hd = h !== undefined && Number.isFinite(h) ? Math.round(((h % 360) + 360) % 360) : -1;
    const id = `sky${hd < 0 ? 'n' : hd}`;
    const stops = skyStops(hd)
      .map(([at, color]) => `<stop offset="${at}" stop-color="${color}"/>`)
      .join('');
    let dots = '';
    if (hd >= 0) {
      const m = Math.min(this.w, this.h);
      for (let i = 0; i < SKY_DOTS.length; i += 3) {
        dots += `<circle cx="${n((SKY_DOTS[i] as number) * this.w)}" ` +
          `cy="${n((SKY_DOTS[i + 1] as number) * this.h)}" r="${n((SKY_DOTS[i + 2] as number) * m)}"/>`;
      }
      dots = `<g fill="${SKY_DOT_FILL}">${dots}</g>`;
    }
    const sky = `<rect width="${this.w}" height="${this.h}" fill="url(#${id})"/>` + dots;
    this.push(
      `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient></defs>` +
      (this.skyAlpha < 1 ? `<g opacity="${n(this.skyAlpha)}">${sky}</g>` : sky),
    );
  }

  circle(x: number, y: number, r: number, p: Paint): void {
    this.op(x, y);
    this.push(
      `<circle cx="${n(x)}" cy="${n(y)}" r="${n(Math.abs(r))}"` +
      `${paintAttrs(p, this.glowIds)}/>`,
    );
  }

  arc(x: number, y: number, r: number, a0: number, a1: number, p: Paint): void {
    this.op(x, y);
    const rr = Math.abs(r);
    const span = a1 - a0;
    // A full turn cannot be expressed as one arc segment; draw a ring instead.
    if (Math.abs(span) >= Math.PI * 2 - 1e-3) {
      this.push(
        `<circle cx="${n(x)}" cy="${n(y)}" r="${n(rr)}" fill="none"` +
        ` stroke="${p.stroke ?? p.fill ?? KEYLINE}" stroke-width="${n(p.sw ?? 2)}"/>`,
      );
      return;
    }
    const x0 = x + rr * Math.cos(a0);
    const y0 = y + rr * Math.sin(a0);
    const x1 = x + rr * Math.cos(a1);
    const y1 = y + rr * Math.sin(a1);
    const large = Math.abs(span) > Math.PI ? 1 : 0;
    const sweep = span > 0 ? 1 : 0;
    const d = `M ${n(x0)} ${n(y0)} A ${n(rr)} ${n(rr)} 0 ${large} ${sweep} ${n(x1)} ${n(y1)}`;
    const a = p.fill && p.fill !== 'none'
      ? ` fill="${p.fill}"`
      : ` fill="none" stroke="${p.stroke ?? KEYLINE}" stroke-width="${n(p.sw ?? 2)}" stroke-linecap="round"`;
    this.push(`<path d="${d}"${a}/>`);
  }

  rect(x: number, y: number, w: number, h: number, p: Paint): void {
    this.roundRect(x, y, w, h, 0, p);
  }

  roundRect(x: number, y: number, w: number, h: number, r: number, p: Paint): void {
    this.op(x, y, x + w, y + h);
    this.push(
      `<rect x="${n(x)}" y="${n(y)}" width="${n(Math.abs(w))}" height="${n(Math.abs(h))}" ` +
      `rx="${n(Math.abs(r))}"${paintAttrs(p, this.glowIds)}/>`,
    );
  }

  line(x0: number, y0: number, x1: number, y1: number, width: number, p: Paint): void {
    this.op(x0, y0, x1, y1);
    this.push(
      `<line x1="${n(x0)}" y1="${n(y0)}" x2="${n(x1)}" y2="${n(y1)}" ` +
      `stroke="${p.stroke ?? p.fill ?? KEYLINE}" stroke-width="${n(width)}" ` +
      'stroke-linecap="round"/>',
    );
  }

  poly(pts: Float32Array, count: number, p: Paint, close = true): void {
    const k = Math.max(0, Math.min(count, pts.length >> 1));
    if (k < 2) return;
    const xy: number[] = [];
    let d = '';
    for (let i = 0; i < k; i++) {
      const x = pts[i * 2] as number;
      const y = pts[i * 2 + 1] as number;
      xy.push(x, y);
      d += `${i === 0 ? 'M' : 'L'} ${n(x)} ${n(y)} `;
    }
    this.op(...xy);
    if (close) d += 'Z';
    this.push(`<path d="${d.trim()}"${paintAttrs(p, this.glowIds)}/>`);
  }

  star(x: number, y: number, r: number, spikes: number, p: Paint): void {
    this.op(x, y);
    const k = Math.max(3, Math.round(spikes));
    const inner = r * 0.45;
    let d = '';
    for (let i = 0; i < k * 2; i++) {
      const rad = i % 2 === 0 ? r : inner;
      const a = -Math.PI / 2 + (i * Math.PI) / k;
      d += `${i === 0 ? 'M' : 'L'} ${n(x + rad * Math.cos(a))} ${n(y + rad * Math.sin(a))} `;
    }
    this.push(`<path d="${d}Z"${paintAttrs(p, this.glowIds)}/>`);
  }

  chevron(x: number, y: number, r: number, dir: number, p: Paint): void {
    this.op(x, y);
    let d = '';
    for (let i = 0; i < 3; i++) {
      const a = dir + (i * 2 * Math.PI) / 3;
      d += `${i === 0 ? 'M' : 'L'} ${n(x + r * Math.cos(a))} ${n(y + r * Math.sin(a))} `;
    }
    this.push(`<path d="${d}Z"${paintAttrs(p, this.glowIds)}/>`);
  }

  // ─── text ──────────────────────────────────────────────────────────────────

  text(s: string, x: number, y: number, o: TextOpts = {}): void {
    this.op(x, y);
    const size = o.size ?? 24;
    const anchor = o.align === 'right' ? 'end' : o.align === 'left' ? 'start' : 'middle';
    const base = o.baseline === 'top'
      ? 'hanging'
      : o.baseline === 'bottom'
        ? 'text-after-edge'
        : o.baseline === 'alphabetic'
          ? 'alphabetic'
          : 'middle';
    const family = o.display
      ? "'Gmarket Sans','Pretendard Variable',sans-serif"
      : "'Pretendard Variable',sans-serif";
    const rot = o.rot ? ` transform="rotate(${n((o.rot * 180) / Math.PI)} ${n(x)} ${n(y)})"` : '';
    const stroke = o.stroke
      ? ` stroke="${o.stroke}" stroke-width="${n(o.sw ?? 4)}" paint-order="stroke"` +
        ' stroke-linejoin="round"'
      : '';
    this.push(
      `<text x="${n(x)}" y="${n(y)}" font-size="${n(size)}" font-weight="${o.weight ?? 700}" ` +
      `font-family="${family}" text-anchor="${anchor}" dominant-baseline="${base}" ` +
      `fill="${o.fill ?? C.text}"${stroke}${rot}>${esc(s)}</text>`,
    );
  }

  /** Estimated advance width. Hangul and CJK are full-width, latin about half,
   *  which is close enough for "does this label overflow its panel". */
  measure(s: string, o: TextOpts = {}): number {
    const size = o.size ?? 24;
    let em = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0) ?? 0;
      const wide = (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3000 && c <= 0x9fff) ||
        (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xff00 && c <= 0xff60);
      em += wide ? 1 : ch === ' ' ? 0.28 : 0.54;
    }
    return em * size;
  }

  // ─── sprites ───────────────────────────────────────────────────────────────

  sprite(id: SpriteId, x: number, y: number, size: number, o: SpriteOpts = {}): void {
    this.op(x, y);
    const sp = getSprite(id);
    if (!sp) {
      // Mirror the canvas renderer: a missing id must look broken, not absent.
      this.push(
        `<rect x="${n(x - size / 2)}" y="${n(y - size / 2)}" width="${n(size)}" ` +
        `height="${n(size)}" fill="none" stroke="${C.danger}" stroke-width="3" ` +
        'stroke-dasharray="6 4"/>',
      );
      return;
    }
    const k = size / 100;
    const tf = [
      `translate(${n(x)} ${n(y)})`,
      o.rot ? `rotate(${n((o.rot * 180) / Math.PI)})` : '',
      `scale(${n(k * (o.scaleX ?? 1))} ${n(k * (o.scaleY ?? 1))})`,
      'translate(-50 -50)',
    ].filter(Boolean).join(' ');
    const body = sp.layers.map((l) => {
      const fill = o.flatten ?? resolveRole(l.fill, o) ?? 'none';
      const stroke = l.stroke === 'keyline' ? KEYLINE : resolveRole(l.stroke, o);
      const sa = stroke && !o.flatten
        ? ` stroke="${stroke}" stroke-width="${l.sw ?? 4}" stroke-linejoin="round"` +
          ' stroke-linecap="round"'
        : '';
      return `<path d="${l.d}" fill="${fill}"${sa}/>`;
    }).join('');
    const op = o.alpha !== undefined && o.alpha < 1 ? ` opacity="${n(o.alpha)}"` : '';
    this.push(`<g transform="${tf}"${op}>${body}</g>`);
  }

  // ─── pose ──────────────────────────────────────────────────────────────────
  //
  // The same sticker avatar as Canvas2DRenderer.skeleton(), from the same
  // proportions (BODY). There the body is drawn opaque into a layer and
  // composited once; here a group's `opacity` composites it once, which is
  // the same thing. The see-through belly is a mask instead of a punch.

  skeleton(p: PlayerPose, o: SkeletonOpts = {}): void {
    this.op();
    const al = Math.max(0, Math.min(1, o.alpha ?? 0.92));
    if (al <= 0) return;
    const col = o.color ?? C.slot[p.slot] ?? C.slot[0];
    const u = bodyUnit(p.scalePx, this.s);
    const ink = o.outline === false ? 0 : bodyInk(this.s);
    const armW = o.lineWidth !== undefined && o.lineWidth > 0 ? o.lineWidth : u * BODY.arm;
    const legW = armW * (BODY.leg / BODY.arm);
    const jr = o.jointR !== undefined && Number.isFinite(o.jointR) ? Math.max(0, o.jointR) : -1;
    const dots = jr === 0 || o.jointSet === 'none'
      ? []
      : o.jointSet === 'all' ? ALL_DOTS : o.jointSet === 'hands' ? HANDS : ENDS;
    const shoes = dots === ENDS || dots === ALL_DOTS;
    const shoeR = jr > 0 ? jr : u * BODY.shoe;
    const tw = u * BODY.torso;
    const hr = u * BODY.head;
    const nw = u * BODY.neck;
    const head = headAt(p);
    const torso = torsoD(p);

    // Everything the belly punch removes: legs, head and neck, torso rim.
    let under = '';
    if (ink > 0) {
      under += limbsSvg(p, LEG_EDGES, legW + 2 * ink, KEYLINE);
      if (shoes) under += shoesSvg(p, shoeR + ink, KEYLINE);
    }
    under += limbsSvg(p, LEG_EDGES, legW, col);
    if (shoes) under += shoesSvg(p, shoeR, col);
    if (head) {
      if (ink > 0) under += headSvg(head, KEYLINE, nw + 2 * ink, hr + ink);
      under += headSvg(head, C.white, nw, hr);
      under += `<g opacity="${BODY.headTint}">${headSvg(head, col, nw, hr)}</g>`;
      under += glossSvg(glossD(head.hx, head.hy, hr), u);
    }
    let out = '';
    if (torso) {
      if (ink > 0) under += shapeSvg(torso, KEYLINE, tw + 2 * ink);
      const id = `belly${this.maskN++}`;
      const W = this.w;
      const H = this.h;
      // An element's `opacity` composites its fill and stroke together, so
      // here (unlike the canvas) fill + stroke paints the belly exactly once.
      out +=
        `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="${-W}" y="${-H}" ` +
        `width="${3 * W}" height="${3 * H}"><rect x="${-W}" y="${-H}" width="${3 * W}" ` +
        `height="${3 * H}" fill="white"/>${shapeSvg(torso, 'black', tw)}</mask></defs>` +
        `<g mask="url(#${id})">${under}</g>` +
        `<g opacity="${BODY.bellyWhite}">${shapeSvg(torso, C.white, tw)}</g>` +
        `<g opacity="${BODY.bellyTint}">${shapeSvg(torso, col, tw)}</g>`;
    } else {
      out += under;
    }
    if (ink > 0) out += limbsSvg(p, ARM_EDGES, armW + 2 * ink, KEYLINE);
    out += limbsSvg(p, ARM_EDGES, armW, col);
    const hands = dots.filter((j) => j !== L.LEFT_ANKLE && j !== L.RIGHT_ANKLE);
    if (ink > 0) out += dotsSvg(p, hands, jr, u, ink, KEYLINE);
    out += dotsSvg(p, hands, jr, u, 0, col);
    const at = { x: 0, y: 0 };
    let shine = '';
    for (const j of hands) {
      if ((j === L.LEFT_WRIST || j === L.RIGHT_WRIST) && dotXY(p, j, at)) {
        shine += glossD(at.x, at.y, dotRadius(j, u, jr));
      }
    }
    if (shine) out += glossSvg(shine, u);
    const rings = ringsD(p, o.emphasize ?? [], jr, u);
    if (rings) {
      const rw = u * BODY.ringW;
      if (ink > 0) {
        out += `<path d="${rings}" fill="none" stroke="${KEYLINE}" stroke-width="${n(rw + 2 * ink)}"/>`;
      }
      out += `<path d="${rings}" fill="none" stroke="${C.accent}" stroke-width="${n(rw)}"/>`;
    }
    this.push(`<g opacity="${n(al)}">${out}</g>`);
  }

  ghostBody(p: PlayerPose, alpha: number): void {
    this.op();
    const a = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 0.5;
    if (a <= 0) return;
    const col = C.slot[p.slot] ?? C.slot[0];
    const u = bodyUnit(p.scalePx, this.s);
    const g = u * BODY.ghostGrow;
    // One silhouette, painted white and then again in the body colour at
    // ghostTint: the same light tint the canvas gets from `source-atop`.
    const shape = (c: string): string => {
      let s = limbsSvg(p, LEG_EDGES, u * BODY.leg + 2 * g, c);
      s += limbsSvg(p, ARM_EDGES, u * BODY.arm + 2 * g, c);
      s += shoesSvg(p, u * BODY.shoe + g, c);
      const torso = torsoD(p);
      if (torso) s += shapeSvg(torso, c, u * BODY.torso + 2 * g);
      const head = headAt(p);
      if (head) s += headSvg(head, c, u * BODY.neck + 2 * g, u * BODY.head + g);
      return s + dotsSvg(p, HANDS, -1, u, g, c);
    };
    this.push(
      `<g opacity="${n(a)}">${shape(C.white)}` +
      `<g opacity="${BODY.ghostTint}">${shape(col)}</g></g>`,
    );
  }
}

const HANDS = [L.LEFT_WRIST, L.RIGHT_WRIST];
const ENDS = [L.LEFT_WRIST, L.RIGHT_WRIST, L.LEFT_ANKLE, L.RIGHT_ANKLE];
const ALL_DOTS = [...new Set(POSE_EDGES.flat())];

const okXY = (x: number, y: number): boolean => Number.isFinite(x) && Number.isFinite(y);

/** Limbs at one width and colour; fully trusted ones share one path, faded
 *  ones are drawn at their own opacity (same rule as the canvas). */
function limbsSvg(p: PlayerPose, edges: readonly number[], width: number, stroke: string): string {
  let d = '';
  let faded = '';
  const attrs = ` fill="none" stroke="${stroke}" stroke-width="${n(width)}"` +
    ' stroke-linecap="round" stroke-linejoin="round"';
  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i] as number;
    const b = edges[i + 1] as number;
    const k = limbFade(p.vis[a] ?? 0, p.vis[b] ?? 0);
    if (k <= 0) continue;
    const x0 = p.px[a * 2] as number;
    const y0 = p.px[a * 2 + 1] as number;
    const x1 = p.px[b * 2] as number;
    const y1 = p.px[b * 2 + 1] as number;
    if (!okXY(x0, y0) || !okXY(x1, y1)) continue;
    const seg = `M${n(x0)} ${n(y0)}L${n(x1)} ${n(y1)}`;
    if (k >= 1) d += seg;
    else faded += `<path d="${seg}"${attrs} opacity="${n(k)}"/>`;
  }
  return (d ? `<path d="${d}"${attrs}/>` : '') + faded;
}

/** Torso quad, or the shoulder bar when the hips are out of frame. */
function torsoD(p: PlayerPose): string {
  const v = (j: number): boolean => (p.vis[j] ?? 0) >= MIN_VIS;
  const x = (j: number): number => p.px[j * 2] as number;
  const y = (j: number): number => p.px[j * 2 + 1] as number;
  const ls = L.LEFT_SHOULDER;
  const rs = L.RIGHT_SHOULDER;
  const lh = L.LEFT_HIP;
  const rh = L.RIGHT_HIP;
  if (!v(ls) || !v(rs) || !okXY(x(ls), y(ls)) || !okXY(x(rs), y(rs))) return '';
  let d = `M${n(x(ls))} ${n(y(ls))}L${n(x(rs))} ${n(y(rs))}`;
  if (v(lh) && v(rh) && okXY(x(lh), y(lh)) && okXY(x(rh), y(rh))) {
    d += `L${n(x(rh))} ${n(y(rh))}L${n(x(lh))} ${n(y(lh))}Z`;
  }
  return d;
}

/** A path filled and stroked in one colour (round joins round the corners). */
const shapeSvg = (d: string, c: string, sw: number): string =>
  `<path d="${d}" fill="${c}" stroke="${c}" stroke-width="${n(sw)}" stroke-linejoin="round" stroke-linecap="round"/>`;

interface HeadAt { hx: number; hy: number; sx: number; sy: number }

function headAt(p: PlayerPose): HeadAt | null {
  const ok = (j: number): boolean => (p.vis[j] ?? 0) >= MIN_VIS;
  if (!ok(L.NOSE) || !ok(L.LEFT_SHOULDER) || !ok(L.RIGHT_SHOULDER)) return null;
  const h = {
    hx: p.px[L.NOSE * 2] as number,
    hy: p.px[L.NOSE * 2 + 1] as number,
    sx: ((p.px[L.LEFT_SHOULDER * 2] as number) + (p.px[L.RIGHT_SHOULDER * 2] as number)) / 2,
    sy: ((p.px[L.LEFT_SHOULDER * 2 + 1] as number) + (p.px[L.RIGHT_SHOULDER * 2 + 1] as number)) / 2,
  };
  return okXY(h.hx, h.hy) && okXY(h.sx, h.sy) ? h : null;
}

const headSvg = (h: HeadAt, c: string, neckW: number, r: number): string =>
  `<line x1="${n(h.sx)}" y1="${n(h.sy)}" x2="${n(h.hx)}" y2="${n(h.hy)}" stroke="${c}" ` +
  `stroke-width="${n(neckW)}" stroke-linecap="round"/>` +
  `<circle cx="${n(h.hx)}" cy="${n(h.hy)}" r="${n(r)}" fill="${c}"/>`;

/** The canvas's shine arc (GLOSS_*) as path data. */
function glossD(x: number, y: number, r: number): string {
  const k = r * GLOSS_K;
  return `M${n(x + Math.cos(GLOSS_A0) * k)} ${n(y + Math.sin(GLOSS_A0) * k)}` +
    `A${n(k)} ${n(k)} 0 0 1 ${n(x + Math.cos(GLOSS_A1) * k)} ${n(y + Math.sin(GLOSS_A1) * k)}`;
}

const glossSvg = (d: string, u: number): string =>
  `<path d="${d}" fill="none" stroke="${C.white}" stroke-width="${n(u * BODY.glossW)}" ` +
  `stroke-linecap="round" opacity="${BODY.gloss}"/>`;

function shoesSvg(p: PlayerPose, r: number, fill: string): string {
  const at = { x: 0, y: 0 };
  let s = '';
  for (const side of ['L', 'R'] as const) {
    if (shoeAt(p, side, at)) s += `<circle cx="${n(at.x)}" cy="${n(at.y)}" r="${n(r)}"/>`;
  }
  return s ? `<g fill="${fill}">${s}</g>` : '';
}

/** Where joint `j`'s dot goes: wrists get the palm and ankles the shoe, like
 *  the canvas. */
function dotXY(p: PlayerPose, j: number, out: Pt): boolean {
  if (j < 0 || j * 2 + 1 >= p.px.length || (p.vis[j] ?? 0) < MIN_VIS) return false;
  if (j === L.LEFT_WRIST) return mittAt(p, 'L', out);
  if (j === L.RIGHT_WRIST) return mittAt(p, 'R', out);
  if (j === L.LEFT_ANKLE) return shoeAt(p, 'L', out);
  if (j === L.RIGHT_ANKLE) return shoeAt(p, 'R', out);
  out.x = p.px[j * 2] as number;
  out.y = p.px[j * 2 + 1] as number;
  return okXY(out.x, out.y);
}

function dotsSvg(
  p: PlayerPose, set: readonly number[], jr: number, u: number, grow: number, fill: string,
): string {
  const at = { x: 0, y: 0 };
  let s = '';
  for (const j of set) {
    if (!dotXY(p, j, at)) continue;
    s += `<circle cx="${n(at.x)}" cy="${n(at.y)}" r="${n(dotRadius(j, u, jr) + grow)}"/>`;
  }
  return s ? `<g fill="${fill}">${s}</g>` : '';
}

function ringsD(p: PlayerPose, set: readonly number[], jr: number, u: number): string {
  const at = { x: 0, y: 0 };
  let d = '';
  for (const j of set) {
    if (!dotXY(p, j, at)) continue;
    const r = BODY.ring * dotRadius(j, u, jr);
    d += `M${n(at.x + r)} ${n(at.y)}A${n(r)} ${n(r)} 0 1 0 ${n(at.x - r)} ${n(at.y)}` +
      `A${n(r)} ${n(r)} 0 1 0 ${n(at.x + r)} ${n(at.y)}Z`;
  }
  return d;
}

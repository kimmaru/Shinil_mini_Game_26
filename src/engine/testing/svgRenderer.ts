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
import { POSE_EDGES } from '../pose/landmarks';
import type { RenderAudit } from './nullRenderer';
import { C, fade, hueLight, KEYLINE } from '../render/palette';
import type { Paint, Renderer, SkeletonOpts, TextOpts } from '../render/renderer';
import { getSprite, resolveRole, type SpriteId, type SpriteOpts } from '../render/sprite';
import type { PlayerPose } from '../types';

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
  private readonly backdrop: string;

  constructor(w: number, h: number, o: SvgShotOpts = {}) {
    this.w = w;
    this.h = h;
    this.s = Math.min(w, h) / 1000;
    this.backdrop = o.backdrop ?? C.bg;
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
    const sky = h === undefined ? C.bg : hueLight(h);
    this.push(`<rect width="${this.w}" height="${this.h}" fill="${sky}"/>`);
    this.push(
      `<rect y="${n(this.h * 0.82)}" width="${this.w}" height="${n(this.h * 0.18)}" ` +
      `fill="${C.bgDeep}"/>`,
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

  skeleton(p: PlayerPose, o: SkeletonOpts = {}): void {
    this.op();
    const col = o.color ?? C.slot[p.slot] ?? C.slot[0];
    const lw = o.lineWidth ?? Math.max(4, this.s * 14);
    const vis = o.alpha ?? 1;
    const parts: string[] = [];
    for (const [a, b] of POSE_EDGES) {
      if ((p.vis[a] ?? 0) < 0.5 || (p.vis[b] ?? 0) < 0.5) continue;
      const x0 = p.px[a * 2] as number;
      const y0 = p.px[a * 2 + 1] as number;
      const x1 = p.px[b * 2] as number;
      const y1 = p.px[b * 2 + 1] as number;
      if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
      if (o.outline !== false) {
        parts.push(
          `<line x1="${n(x0)}" y1="${n(y0)}" x2="${n(x1)}" y2="${n(y1)}" ` +
          `stroke="${KEYLINE}" stroke-width="${n(lw + 6)}" stroke-linecap="round"/>`,
        );
      }
      parts.push(
        `<line x1="${n(x0)}" y1="${n(y0)}" x2="${n(x1)}" y2="${n(y1)}" ` +
        `stroke="${col}" stroke-width="${n(lw)}" stroke-linecap="round"/>`,
      );
    }
    const jr = o.jointR ?? lw * 0.8;
    if (jr > 0 && o.jointSet !== 'none') {
      const all: number[] = [];
      for (let j = 0; j < 33; j++) all.push(j);
      const set = o.jointSet === 'all'
        ? all
        : o.jointSet === 'hands' ? [15, 16] : [15, 16, 27, 28];
      for (const j of set) {
        if ((p.vis[j] ?? 0) < 0.5) continue;
        const x = p.px[j * 2] as number;
        const y = p.px[j * 2 + 1] as number;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const big = o.emphasize?.includes(j) ? 2 : 1;
        parts.push(
          `<circle cx="${n(x)}" cy="${n(y)}" r="${n(jr * big)}" fill="${col}" ` +
          `stroke="${KEYLINE}" stroke-width="3"/>`,
        );
      }
    }
    this.push(`<g opacity="${n(vis)}">${parts.join('')}</g>`);
  }

  ghostBody(p: PlayerPose, alpha: number): void {
    this.op();
    const b = p.box;
    this.push(
      `<rect x="${n(b.x * this.w)}" y="${n(b.y * this.h)}" width="${n(b.w * this.w)}" ` +
      `height="${n(b.h * this.h)}" rx="${n(Math.min(b.w * this.w, b.h * this.h) * 0.3)}" ` +
      `fill="${fade(C.ink, alpha * 0.55)}"/>`,
    );
  }
}

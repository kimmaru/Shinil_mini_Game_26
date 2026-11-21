// A Renderer that draws nothing and audits everything.
//
// The highest value-per-line file in the test suite. It catches the three bugs
// that look identical from the outside — a blank screen:
//   1. NaN coordinates (a divide-by-zero in a scale calculation)
//   2. everything drawn off-screen (a sign error, or px/normalized confusion)
//   3. nothing drawn at all (a state machine that never leaves its first state)
import type { Paint, PlayerPose, Renderer, SkeletonOpts, TextOpts } from '../types';
import { hasSprite, spriteIds, type SpriteId, type SpriteOpts } from '../render/sprite';
// Registers the shared sprite set. Imported here as well as in the Canvas2D
// renderer so a headless run validates the same ids a browser run draws.
import '../render/sprites';

export interface RenderAudit {
  ops: number;
  opsThisFrame: number;
  frames: number;
  framesWithNoDraw: number;
  nanOps: number;
  offscreenOps: number;
  /** First few problems, with the op name, for a readable failure message. */
  problems: string[];
}

export class NullRenderer implements Renderer {
  readonly w: number;
  readonly h: number;
  readonly s: number;
  t = 0;

  readonly audit: RenderAudit = {
    ops: 0, opsThisFrame: 0, frames: 0, framesWithNoDraw: 0,
    nanOps: 0, offscreenOps: 0, problems: [],
  };

  /** When true, a NaN coordinate throws immediately instead of being counted.
   *  Useful when you want the stack trace. */
  strict = false;

  constructor(w = 1280, h = 720) {
    this.w = w;
    this.h = h;
    this.s = Math.min(w, h) / 1000;
  }

  /** Call once per rendered frame, before the game's render(). */
  beginFrame(t: number): void {
    this.t = t;
    this.audit.opsThisFrame = 0;
  }

  /** Call once after the game's render(). */
  endFrame(): void {
    this.audit.frames++;
    if (this.audit.opsThisFrame === 0) this.audit.framesWithNoDraw++;
  }

  private note(op: string, msg: string, kind: 'nan' | 'off'): void {
    if (kind === 'nan') this.audit.nanOps++;
    else this.audit.offscreenOps++;
    if (this.audit.problems.length < 8) this.audit.problems.push(`${op}: ${msg}`);
    if (this.strict && kind === 'nan') throw new Error(`[NullRenderer] ${op}: ${msg}`);
  }

  /** Validate coordinates and count the op. */
  private op(name: string, ...coords: number[]): void {
    this.audit.ops++;
    this.audit.opsThisFrame++;
    for (const c of coords) {
      if (!Number.isFinite(c)) {
        this.note(name, `non-finite coordinate (${coords.join(', ')})`, 'nan');
        return;
      }
    }
    // A generous box: effects legitimately spill past the edge, but an object
    // two full screens away is a bug, not a flourish.
    for (let i = 0; i + 1 < coords.length; i += 2) {
      const x = coords[i]!;
      const y = coords[i + 1]!;
      if (x < -this.w || x > 2 * this.w || y < -this.h || y > 2 * this.h) {
        this.note(name, `far off-screen (${x.toFixed(0)}, ${y.toFixed(0)})`, 'off');
        return;
      }
    }
  }

  save(): void {}
  restore(): void {}
  translate(x: number, y: number): void { this.op('translate', x, y); }
  rotate(r: number): void { this.op('rotate', r); }
  scale(x: number, y: number): void { this.op('scale', x, y); }
  alpha(a: number): void { this.op('alpha', a); }
  clear(): void { this.audit.ops++; this.audit.opsThisFrame++; }

  circle(x: number, y: number, r: number, _p: Paint): void { this.op('circle', x, y, r, 0); }
  arc(x: number, y: number, r: number, a0: number, a1: number, _p: Paint): void {
    this.op('arc', x, y, r, 0, a0, a1);
  }
  rect(x: number, y: number, w: number, h: number, _p: Paint): void {
    this.op('rect', x, y, w, h);
  }
  roundRect(x: number, y: number, w: number, h: number, r: number, _p: Paint): void {
    this.op('roundRect', x, y, w, h, r, 0);
  }
  line(x0: number, y0: number, x1: number, y1: number, width: number, _p: Paint): void {
    this.op('line', x0, y0, x1, y1, width, 0);
  }
  poly(pts: Float32Array, n: number, _p: Paint): void {
    this.audit.ops++;
    this.audit.opsThisFrame++;
    for (let i = 0; i < n * 2; i++) {
      if (!Number.isFinite(pts[i]!)) { this.note('poly', `non-finite point ${i >> 1}`, 'nan'); return; }
    }
  }
  star(x: number, y: number, r: number, _spikes: number, _p: Paint): void {
    this.op('star', x, y, r, 0);
  }
  chevron(x: number, y: number, r: number, dir: number, _p: Paint): void {
    this.op('chevron', x, y, r, 0, dir, 0);
  }
  text(s: string, x: number, y: number, _o?: TextOpts): void {
    if (typeof s !== 'string') this.note('text', `non-string content: ${typeof s}`, 'nan');
    if (/NaN|undefined|Infinity/.test(s)) {
      // A score that renders as "NaN점" is a real bug the player sees.
      this.note('text', `suspicious content "${s}"`, 'nan');
    }
    this.op('text', x, y);
  }
  measure(s: string, o?: TextOpts): number {
    return s.length * (o?.size ?? 16) * 0.55;
  }
  sprite(id: SpriteId, x: number, y: number, size: number, o?: SpriteOpts): void {
    // An unknown id draws nothing in production, which looks exactly like a
    // game that forgot to spawn anything. Catch it here instead.
    if (!hasSprite(id)) {
      this.note('sprite', `unknown id "${id}" (known: ${spriteIds().slice(0, 6).join(', ')}…)`, 'nan');
    }
    this.op('sprite', x, y, size, 0);
    if (o?.rot !== undefined && !Number.isFinite(o.rot)) {
      this.note('sprite', `non-finite rot for "${id}"`, 'nan');
    }
  }
  skeleton(_p: PlayerPose, _o?: SkeletonOpts): void { this.audit.ops++; this.audit.opsThisFrame++; }
  ghostBody(_p: PlayerPose, _a: number): void { this.audit.ops++; this.audit.opsThisFrame++; }
}

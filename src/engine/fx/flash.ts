// Full-viewport flash, and the WCAG 2.3.1 enforcement that goes with it.
//
// WHY THIS LIVES HERE AND NOT IN 58 GAMES
// Photosensitive epilepsy is triggered by repeated large-area luminance change.
// WCAG 2.3.1 (Three Flashes or Below Threshold) is a Level-A criterion: no more
// than three flashes in any one-second period, and a flash only counts if it is
// both a large relative luminance change AND covers more than ~25% of the
// visual field. Saturated red is called out separately because the red flash
// threshold is stricter than the general one.
//
// 58 authors cannot each get that right, and the failure mode is not a bug
// report — it is a child having a seizure. So the rule is mechanical, it lives
// in one file, and `fx.flash()` has no way to opt out of it.
//
// WHAT THIS IMPLEMENTATION ACTUALLY ENFORCES
//  1. Rate. At most 3 flash onsets in any sliding 1.0s window (1 under reduced
//     motion). Extra calls are silently dropped — a dropped flash is invisible,
//     and an author who gets an exception instead will "fix" it by drawing
//     their own rectangle.
//  2. Area. The bright part is a border band ~6% of the min viewport dimension
//     deep, which is under 25% of the viewport for every aspect ratio we ship.
//     The centre — where the gameplay and the text are — gets a separate
//     full-viewport tint capped at 0.08 alpha, well below a "large luminance
//     change".
//  3. Colour. Saturated red is desaturated toward salmon and then mixed 30%
//     toward white. `fx.flash('#FF0000')` is a legal call that cannot produce a
//     saturated red flash.
//  4. Opt-out. `manifest.a11y.noFlashing` turns the whole thing off via
//     `setEnabled(false)`; the game keeps working because a flash is never the
//     only feedback channel.
//
// The vignette is drawn with nested stroked rounded rects rather than a radial
// gradient, because the frozen Renderer vocabulary has no gradients — and it
// turns out to look better anyway: the centre of the screen stays readable
// during the flash instead of washing out.
import type { Paint, Renderer } from '../types';
import { colorStr, parseColor } from './particles';

export const FLASH_WINDOW_SEC = 1.0;
export const MAX_FLASHES_PER_SEC = 3;
/** Onsets per second allowed when the player asked for reduced motion. */
export const MAX_FLASHES_PER_SEC_REDUCED = 1;
/** Peak alpha of the border band. */
export const MAX_EDGE_ALPHA = 0.46;
/** Peak alpha of the full-viewport component. Deliberately small — this is the
 *  part that covers >25% of the visual field. */
export const MAX_CENTER_ALPHA = 0.08;
/** Border depth as a fraction of min(w, h). 0.06 keeps the bright area under
 *  25% of the viewport even on a square window. */
export const EDGE_DEPTH = 0.06;
export const FADE_SEC = 0.26;
export const FADE_SEC_REDUCED = 0.5;

const BANDS = 7;

export class Flash {
  /** Onset timestamps of the last N accepted flashes, as a ring buffer. */
  private readonly stamps = new Float64Array(MAX_FLASHES_PER_SEC);
  private si = 0;
  private clock = 0;

  private life = 0;
  private max = FADE_SEC;
  private power = 0;
  private r = 255;
  private g = 255;
  private b = 255;

  /** Accepted / refused counts, for the debug overlay and the tests. */
  fired = 0;
  dropped = 0;

  enabled = true;
  reduced = false;

  private readonly paint: Paint = {};

  constructor() {
    this.stamps.fill(-FLASH_WINDOW_SEC * 4);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.life = 0;
  }

  setReduced(on: boolean): void {
    this.reduced = on;
  }

  /** How many onsets are allowed in a one-second window right now. */
  get budget(): number {
    return this.reduced ? MAX_FLASHES_PER_SEC_REDUCED : MAX_FLASHES_PER_SEC;
  }

  /**
   * Request a flash. Returns false when the limiter refused it.
   *
   * The test to read first: ten calls in one frame produce three flashes.
   */
  request(color?: string, power?: number): boolean {
    if (!this.enabled) {
      this.dropped++;
      return false;
    }
    // Count accepted onsets still inside the sliding window. Three slots, so
    // this is three comparisons and obviously correct, which matters more here
    // than being clever.
    let inWindow = 0;
    for (let i = 0; i < this.stamps.length; i++) {
      if (this.clock - this.stamps[i]! < FLASH_WINDOW_SEC) inWindow++;
    }
    if (inWindow >= this.budget) {
      this.dropped++;
      return false;
    }
    this.stamps[this.si] = this.clock;
    this.si = (this.si + 1) % this.stamps.length;
    this.fired++;

    const packed = safeFlashColor(parseColor(color ?? '#FFFFFF'));
    this.r = (packed >> 16) & 255;
    this.g = (packed >> 8) & 255;
    this.b = packed & 255;
    const p = Number.isFinite(power as number) ? Math.min(1, Math.max(0, power as number)) : 0.6;
    // Reduced motion gets half the amplitude over twice the time: a swell, not
    // a strobe.
    this.power = this.reduced ? p * 0.5 : p;
    this.max = this.reduced ? FADE_SEC_REDUCED : FADE_SEC;
    this.life = this.max;
    return true;
  }

  update(dt: number): void {
    if (!(dt > 0)) return;
    this.clock += dt;
    if (this.life > 0) this.life = Math.max(0, this.life - dt);
  }

  reset(): void {
    this.life = 0;
    this.fired = 0;
    this.dropped = 0;
    this.stamps.fill(this.clock - FLASH_WINDOW_SEC * 4);
  }

  get active(): boolean {
    return this.life > 0;
  }

  /** 0..1 envelope of the current flash. */
  get alpha(): number {
    if (this.life <= 0) return 0;
    const t = this.life / this.max;
    // Snap on, ease off — an instant onset is what makes it read as impact.
    return this.power * t * t;
  }

  /** Screen-space. Draw AFTER the world and outside the shake transform: a
   *  flash that moves with the camera reads as a glitch. */
  draw(g: Renderer): void {
    const a = this.alpha;
    if (a <= 0) return;
    const w = g.w;
    const h = g.h;
    const paint = this.paint;

    // Full-viewport component, hard-capped.
    paint.fill = colorStr(this.r, this.g, this.b, a * MAX_CENTER_ALPHA);
    paint.stroke = undefined;
    paint.glow = 0;
    g.rect(0, 0, w, h, paint);

    // Border band: the bright part, under 25% of the viewport by construction.
    const depth = Math.min(w, h) * EDGE_DEPTH;
    const band = depth / BANDS;
    const radius = Math.min(w, h) * 0.06;
    paint.fill = undefined;
    for (let i = 0; i < BANDS; i++) {
      const t = i / (BANDS - 1); // 0 at the edge, 1 at the inner limit
      const inset = band * i + band * 0.5;
      const ba = a * MAX_EDGE_ALPHA * (1 - t) * (1 - t);
      if (ba <= 0.004) continue;
      paint.stroke = colorStr(this.r, this.g, this.b, ba);
      paint.sw = band * 1.35;
      g.roundRect(inset, inset, w - inset * 2, h - inset * 2, radius, paint);
    }
  }
}

/**
 * Make any requested colour safe to flash.
 *
 * Saturated red has its own, stricter WCAG threshold, so red-dominant inputs are
 * pushed toward salmon first; then everything is mixed 30% toward white, which
 * both lowers saturation and makes the flash read as "light" rather than as a
 * colour wash. `flash(C.danger)` therefore still looks like a warning, and
 * still cannot be a saturated red flash.
 */
export function safeFlashColor(packed: number): number {
  let r = (packed >> 16) & 255;
  let g = (packed >> 8) & 255;
  let b = packed & 255;
  if (r > 150 && r - Math.max(g, b) > 60) {
    g = Math.max(g, 128);
    b = Math.max(b, 116);
  }
  const mix = 0.3;
  r = Math.round(r + (255 - r) * mix);
  g = Math.round(g + (255 - g) * mix);
  b = Math.round(b + (255 - b) * mix);
  return (r << 16) | (g << 8) | b;
}

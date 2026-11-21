// Backing-store pixel ratio for the game canvas.
//
// A 2015 Retina MacBook Pro reports devicePixelRatio 2, so a full-screen
// 1440x900 CSS canvas is 2880x1800: 5.2M pixels filled every frame (two
// full-screen gradients before the game draws anything) by an Iris Pro that is
// also running pose inference. From 2m away nobody can tell that from 1.5x
// (2.9M px, 56% of the fill). So start at 1.5 and step down further if the
// render rate says it is still too much. Logical (CSS px) sizes never change;
// only the backing store does.

export const DPR_START = 1.5;
export const DPR_FLOOR = 1;
export const DPR_STEP = 0.25;
/** Smoothed render fps under which a frame counts as slow. */
export const DPR_SLOW_FPS = 50;
/** Consecutive slow frames before stepping down: ~2.5s at 45fps, so a GC
 *  pause or a game's first-frame hitch does not cost resolution for good. */
export const DPR_SLOW_FRAMES = 120;

/**
 * Steps the pixel-ratio ceiling down while frames are slow. Never back up:
 * a resize reallocates the backing store, and oscillating between two levels
 * is a visible stutter every few seconds. One instance lives for the page, so
 * the next round starts where the last one settled.
 */
export class DprGovernor {
  private slow = 0;
  cap: number;

  constructor(cap = DPR_START, private readonly floor = DPR_FLOOR) {
    this.cap = Math.max(floor, cap);
  }

  /** Feed one frame's smoothed fps. True when `cap` just dropped. */
  sample(fps: number): boolean {
    if (this.cap <= this.floor) return false;
    this.slow = fps < DPR_SLOW_FPS ? this.slow + 1 : 0;
    if (this.slow < DPR_SLOW_FRAMES) return false;
    this.slow = 0;
    this.cap = Math.max(this.floor, this.cap - DPR_STEP);
    return true;
  }
}

// ══ FROZEN CONTRACT ══ imported by 58 game modules.
import type { Pt } from './types';

export const TAU = Math.PI * 2;
export const DEG = 180 / Math.PI;

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Inverse lerp, clamped. Maps a value in [a,b] to 0..1. */
export const norm = (v: number, a: number, b: number): number =>
  b === a ? 0 : clamp01((v - a) / (b - a));
export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
export const sign = (v: number): -1 | 0 | 1 => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** Frame-rate independent exponential approach. `rate` is roughly
 *  "fraction closed per second"; 8 is snappy, 2 is lazy. */
export const approach = (cur: number, target: number, rate: number, dt: number): number =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));

// Easing. Match the CSS motion tokens in src/styles/tokens.css.
export const easeOutQuint = (t: number): number => 1 - Math.pow(1 - clamp01(t), 5);
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3);
export const easeInQuad = (t: number): number => clamp01(t) * clamp01(t);
export const easeInOut = (t: number): number => {
  const x = clamp01(t);
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
};
/** Overshoots past 1 then settles. For things that should feel alive —
 *  buttons, stars, badges. Never on panels. */
export const easeOutBack = (t: number, s = 1.70158): number => {
  const x = clamp01(t) - 1;
  return 1 + (s + 1) * x * x * x + s * x * x;
};
export const easeOutElastic = (t: number): number => {
  const x = clamp01(t);
  if (x === 0 || x === 1) return x;
  return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
};
/** 0 -> 1 -> 0. For one-shot pops driven off a 0..1 life value. */
export const pulse = (t: number): number => Math.sin(clamp01(t) * Math.PI);

// ─── Collision ───────────────────────────────────────────────────────────────

export const dist2 = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};
export const dist = (ax: number, ay: number, bx: number, by: number): number =>
  Math.hypot(ax - bx, ay - by);

/** Point-in-circle. */
export const hitCircle = (px: number, py: number, cx: number, cy: number, r: number): boolean =>
  dist2(px, py, cx, cy) <= r * r;

/** Circle-circle. */
export const hitCircles = (
  ax: number, ay: number, ar: number,
  bx: number, by: number, br: number,
): boolean => dist2(ax, ay, bx, by) <= (ar + br) * (ar + br);

/** Point-in-rect (x,y is the top-left corner). */
export const hitRect = (
  px: number, py: number,
  x: number, y: number, w: number, h: number,
): boolean => px >= x && px <= x + w && py >= y && py <= y + h;

/**
 * Swept segment-vs-circle: did a hand moving from (x0,y0) to (x1,y1) this frame
 * pass through a target?
 *
 * A fast swing covers 100+ px between frames, so a naive point test misses it
 * entirely and the game feels broken exactly when the player is trying hardest.
 * Every swat/slice/swing game must use this, not hitCircle.
 */
export function hitSegCircle(
  x0: number, y0: number, x1: number, y1: number,
  cx: number, cy: number, r: number,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return dist2(x0, y0, cx, cy) <= r * r;
  let t = ((cx - x0) * dx + (cy - y0) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return dist2(x0 + dx * t, y0 + dy * t, cx, cy) <= r * r;
}

/** Shortest distance from a point to a segment. For laser/web/rope games. */
export function distSegPoint(
  x0: number, y0: number, x1: number, y1: number,
  px: number, py: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return dist(x0, y0, px, py);
  let t = ((px - x0) * dx + (py - y0) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return dist(x0 + dx * t, y0 + dy * t, px, py);
}

/** Do two segments cross? For "did a limb touch the laser grid". */
export function segsCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
  const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

// ─── Angles ──────────────────────────────────────────────────────────────────

/**
 * Interior angle at B, in degrees, 0..180.
 * Uses atan2(|cross|, dot) rather than acos(dot/|a||b|): the acos form blows up
 * its domain on a fully extended limb, which is exactly when a game asks
 * "is the arm straight?".
 */
export function angleDeg(a: Pt, b: Pt, c: Pt): number {
  const bax = a.x - b.x;
  const bay = a.y - b.y;
  const bcx = c.x - b.x;
  const bcy = c.y - b.y;
  return Math.atan2(Math.abs(bax * bcy - bay * bcx), bax * bcx + bay * bcy) * DEG;
}

/** Same, from raw coordinates — avoids allocating Pts in update(). */
export function angleDeg6(
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
): number {
  const bax = ax - bx;
  const bay = ay - by;
  const bcx = cx - bx;
  const bcy = cy - by;
  return Math.atan2(Math.abs(bax * bcy - bay * bcx), bax * bcx + bay * bcy) * DEG;
}

/** Direction of p->q in screen space: 0 = right, 90 = straight UP.
 *  (y is negated because screen y grows downward.) */
export const limbAngle = (px: number, py: number, qx: number, qy: number): number =>
  Math.atan2(-(qy - py), qx - px) * DEG;

/** Smallest signed difference between two angles in degrees, -180..180. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// ─── Misc ────────────────────────────────────────────────────────────────────

/** Median of a small array. Robust to the one frame where a wrist teleports to
 *  a reflection in a window — a mean would smear that spike across 5 frames. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

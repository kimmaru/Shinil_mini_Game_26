// ══ FROZEN CONTRACT ══ imported by 58 game modules. See docs/GAME_AUTHORING.md.
//
// The 33 BlazePose GHUM landmarks, and the accessors every game uses.
//
// "left"/"right" are THE SUBJECT'S left and right.
//
// The preview is mirrored, which makes it behave like an actual mirror: a child
// raising their left hand sees it on the LEFT of the screen. So screen-left is
// LEFT_WRIST, and a game prompting "왼손을 들어요" should watch LEFT_WRIST.
// (The raw camera image is the opposite — unmirrored, the subject's left hand
// is on the image's right — but no game ever sees raw coordinates: `px` is
// already mirrored by the time it reaches you.)
//
// Decided once, here, and never re-litigated: getting it backwards sends every
// 7-year-old the wrong way, and nothing in the code will complain.
import type { PlayerPose, Pt } from '../types';

export const L = {
  NOSE: 0,
  LEFT_EYE_INNER: 1, LEFT_EYE: 2, LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4, RIGHT_EYE: 5, RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7, RIGHT_EAR: 8,
  MOUTH_LEFT: 9, MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_PINKY: 17, RIGHT_PINKY: 18,
  LEFT_INDEX: 19, RIGHT_INDEX: 20,
  LEFT_THUMB: 21, RIGHT_THUMB: 22,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
  LEFT_HEEL: 29, RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31, RIGHT_FOOT_INDEX: 32,
} as const;

export type Joint = (typeof L)[keyof typeof L];
export const LANDMARK_COUNT = 33;

export const LANDMARK_NAMES: readonly string[] = [
  'nose', 'left_eye_inner', 'left_eye', 'left_eye_outer',
  'right_eye_inner', 'right_eye', 'right_eye_outer',
  'left_ear', 'right_ear', 'mouth_left', 'mouth_right',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_pinky', 'right_pinky',
  'left_index', 'right_index', 'left_thumb', 'right_thumb',
  'left_hip', 'right_hip', 'left_knee', 'right_knee',
  'left_ankle', 'right_ankle', 'left_heel', 'right_heel',
  'left_foot_index', 'right_foot_index',
];

/** Skeleton edges for drawing. Face mesh points are deliberately omitted —
 *  drawing 11 face dots on a child's face looks like surveillance. */
export const POSE_EDGES: readonly (readonly [Joint, Joint])[] = [
  [L.LEFT_SHOULDER, L.RIGHT_SHOULDER],
  [L.LEFT_SHOULDER, L.LEFT_ELBOW], [L.LEFT_ELBOW, L.LEFT_WRIST],
  [L.RIGHT_SHOULDER, L.RIGHT_ELBOW], [L.RIGHT_ELBOW, L.RIGHT_WRIST],
  [L.LEFT_SHOULDER, L.LEFT_HIP], [L.RIGHT_SHOULDER, L.RIGHT_HIP],
  [L.LEFT_HIP, L.RIGHT_HIP],
  [L.LEFT_HIP, L.LEFT_KNEE], [L.LEFT_KNEE, L.LEFT_ANKLE],
  [L.RIGHT_HIP, L.RIGHT_KNEE], [L.RIGHT_KNEE, L.RIGHT_ANKLE],
  [L.LEFT_ANKLE, L.LEFT_FOOT_INDEX], [L.RIGHT_ANKLE, L.RIGHT_FOOT_INDEX],
];

export type Side = 'L' | 'R';

/** Minimum visibility to trust a landmark. Below this, GATE — do not guess.
 *  Feeding a 0.1-visibility ankle into a jump detector breaks the whole round. */
export const MIN_VIS = 0.5;

// ─── Reads. All of these are allocation-free except where a Pt is returned. ──

/** View-pixel x of a joint (already mirrored). */
export const jx = (p: PlayerPose, j: Joint): number => p.px[j * 2]!;
/** View-pixel y of a joint. */
export const jy = (p: PlayerPose, j: Joint): number => p.px[j * 2 + 1]!;
/** Normalized x: hip-centred, shoulder-width units. */
export const nx = (p: PlayerPose, j: Joint): number => p.n[j * 2]!;
/** Normalized y: hip-centred, shoulder-width units, +y DOWN. */
export const ny = (p: PlayerPose, j: Joint): number => p.n[j * 2 + 1]!;
/** Normalized velocity, units/sec. */
export const vx = (p: PlayerPose, j: Joint): number => p.v[j * 2]!;
export const vy = (p: PlayerPose, j: Joint): number => p.v[j * 2 + 1]!;
/** Visibility 0..1. */
export const vis = (p: PlayerPose, j: Joint): number => p.vis[j]!;

/** True only if EVERY listed joint is visible enough to act on. */
export function visible(p: PlayerPose, ...joints: Joint[]): boolean {
  for (const j of joints) if (p.vis[j]! < MIN_VIS) return false;
  return true;
}

/** Writes the view-px position of a joint into `out` and returns it.
 *  Pass a Pt you allocated in init() to keep update() allocation-free. */
export function jointPx(p: PlayerPose, j: Joint, out: Pt): Pt {
  out.x = p.px[j * 2]!;
  out.y = p.px[j * 2 + 1]!;
  return out;
}

/** Midpoint of two joints in view px. */
export function midPx(p: PlayerPose, a: Joint, b: Joint, out: Pt): Pt {
  out.x = (p.px[a * 2]! + p.px[b * 2]!) / 2;
  out.y = (p.px[a * 2 + 1]! + p.px[b * 2 + 1]!) / 2;
  return out;
}

/** Hip centre in view px — the body's anchor. */
export const hipPx = (p: PlayerPose, out: Pt): Pt => midPx(p, L.LEFT_HIP, L.RIGHT_HIP, out);
/** Shoulder centre in view px. */
export const shoulderPx = (p: PlayerPose, out: Pt): Pt =>
  midPx(p, L.LEFT_SHOULDER, L.RIGHT_SHOULDER, out);

/**
 * Palm centre in view px — NOT the wrist.
 *
 * Hit zones belong on the palm: a child reaching for a target aims with their
 * hand, and the wrist trails ~1 hand-length behind it. We extend 1.4x from the
 * wrist toward the finger centroid, falling back to an elbow-to-wrist
 * extension when the fingers are not visible (common in sleeves).
 */
export function palm(p: PlayerPose, side: Side, out: Pt): Pt {
  const w = side === 'L' ? L.LEFT_WRIST : L.RIGHT_WRIST;
  const pinky = side === 'L' ? L.LEFT_PINKY : L.RIGHT_PINKY;
  const index = side === 'L' ? L.LEFT_INDEX : L.RIGHT_INDEX;
  const thumb = side === 'L' ? L.LEFT_THUMB : L.RIGHT_THUMB;
  const elbow = side === 'L' ? L.LEFT_ELBOW : L.RIGHT_ELBOW;

  const wxp = p.px[w * 2]!;
  const wyp = p.px[w * 2 + 1]!;

  if (p.vis[pinky]! >= MIN_VIS && p.vis[index]! >= MIN_VIS && p.vis[thumb]! >= MIN_VIS) {
    const cx = (p.px[pinky * 2]! + p.px[index * 2]! + p.px[thumb * 2]!) / 3;
    const cy = (p.px[pinky * 2 + 1]! + p.px[index * 2 + 1]! + p.px[thumb * 2 + 1]!) / 3;
    out.x = wxp + (cx - wxp) * 1.4;
    out.y = wyp + (cy - wyp) * 1.4;
    return out;
  }
  // Fallback: 18% of the forearm past the wrist, away from the elbow.
  const exp = p.px[elbow * 2]!;
  const eyp = p.px[elbow * 2 + 1]!;
  out.x = wxp + (wxp - exp) * 0.18;
  out.y = wyp + (wyp - eyp) * 0.18;
  return out;
}

/** Palm speed in view px/sec. Use this to speed-gate hits so a resting hand
 *  parked on a target does not farm points. */
export function palmSpeedPx(p: PlayerPose, side: Side): number {
  const w = side === 'L' ? L.LEFT_WRIST : L.RIGHT_WRIST;
  return Math.hypot(p.v[w * 2]!, p.v[w * 2 + 1]!) * p.scalePx;
}

/** Distance between two joints in NORMALIZED units (shoulder widths). */
export function jointDist(p: PlayerPose, a: Joint, b: Joint): number {
  return Math.hypot(p.n[a * 2]! - p.n[b * 2]!, p.n[a * 2 + 1]! - p.n[b * 2 + 1]!);
}

/** Distance between two joints in view px. */
export function jointDistPx(p: PlayerPose, a: Joint, b: Joint): number {
  return Math.hypot(p.px[a * 2]! - p.px[b * 2]!, p.px[a * 2 + 1]! - p.px[b * 2 + 1]!);
}

/** Highest visible point of the head in view px — for limbo bars and ceilings. */
export function headTopPx(p: PlayerPose): number {
  let top = Infinity;
  for (const j of [L.NOSE, L.LEFT_EAR, L.RIGHT_EAR, L.LEFT_EYE, L.RIGHT_EYE] as Joint[]) {
    if (p.vis[j]! >= MIN_VIS) top = Math.min(top, p.px[j * 2 + 1]!);
  }
  return Number.isFinite(top) ? top : p.px[L.NOSE * 2 + 1]!;
}

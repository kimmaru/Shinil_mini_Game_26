// ══ FROZEN CONTRACT ══ used by every game's smoke test.
//
// Synthetic landmark streams. This is how 58 games are verified without 58
// camera sessions, and why no child's body data exists anywhere in this repo.
//
// A clip is built from a parametric standing skeleton posed by declarative
// keyframes, then run through noise injection (jitter, visibility dropout,
// frame drops, variable fps) so a detector that passes here has already met
// the conditions that break naive implementations in a real classroom.
import { L, LANDMARK_COUNT } from '../pose/landmarks';
import { clamp01, lerp } from '../math';

/** One detected person in one frame — exactly the shape the MediaPipe path
 *  produces, so clips exercise real engine code. */
export interface PersonFrame {
  /** 33 * 2, image-normalized 0..1, y DOWN, NOT mirrored. */
  lm: Float32Array;
  vis: Float32Array;
}

export interface ClipFrame {
  /** Seconds. */
  t: number;
  /** Detection order, which is deliberately NOT a stable identity — the model
   *  gives no durable ids and the array order swaps when two people cross.
   *  The engine's own tracker is what must survive that. */
  people: PersonFrame[];
}

export interface PoseClip {
  name: string;
  fps: number;
  frames: ClipFrame[];
}

/**
 * Body pose parameters. Angles are in degrees, measured in screen space where
 * 0 = pointing right and 90 = straight up, matching `limbAngle` in math.ts.
 */
export interface BodyParams {
  /** Hip-centre position in image coords. */
  hipX: number;
  hipY: number;
  /** Shoulder width as a fraction of image width. 0.17 ~= 2m from a laptop. */
  shoulderW: number;
  /** Torso tilt: + leans toward image-right. */
  leanDeg: number;
  /** Upper-arm direction. -90 = hanging down, 0 = straight out right, 90 = up. */
  armL: number;
  armR: number;
  /** Elbow bend, 0 = straight. */
  elbowL: number;
  elbowR: number;
  /** Thigh direction; -90 = straight down. */
  legL: number;
  legR: number;
  /** Knee bend, 0 = straight. */
  kneeL: number;
  kneeR: number;
  /** Lifts one ankle toward the other knee, 0..1. For balance games. */
  footLiftL: number;
  footLiftR: number;
}

export const STAND: BodyParams = {
  hipX: 0.5, hipY: 0.62, shoulderW: 0.17, leanDeg: 0,
  armL: -78, armR: -102, elbowL: 8, elbowR: 8,
  legL: -84, legR: -96, kneeL: 3, kneeR: 3,
  footLiftL: 0, footLiftR: 0,
};

// Proportions in units of shoulder width. Roughly 8-to-11-year-old build.
const P = {
  torso: 1.35, hipW: 0.62, upperArm: 0.85, foreArm: 0.78,
  thigh: 1.12, shin: 1.05, foot: 0.3,
  neck: 0.3, headR: 0.34, earX: 0.2, eyeX: 0.11, mouthX: 0.08,
};

const D2R = Math.PI / 180;

/**
 * Build one frame of landmarks from body parameters.
 *
 * Aspect correction matters: image coords are 0..1 on both axes but the frame
 * is 16:9, so a limb of length `S` spans S horizontally and S*aspect
 * vertically. Skipping this gives a skeleton that is visibly squashed and makes
 * every angle-based detector wrong.
 */
export function body(p: Partial<BodyParams> = {}, aspect = 16 / 9): Float32Array {
  const b = { ...STAND, ...p };
  const S = b.shoulderW;
  const out = new Float32Array(LANDMARK_COUNT * 2);
  const set = (j: number, x: number, y: number): void => {
    out[j * 2] = x;
    out[j * 2 + 1] = y;
  };
  // Walk `len` shoulder-widths in screen direction `deg` from (x,y).
  const step = (x: number, y: number, deg: number, len: number): [number, number] => [
    x + Math.cos(deg * D2R) * len * S,
    y - Math.sin(deg * D2R) * len * S * aspect,
  ];

  const hx = b.hipX;
  const hy = b.hipY;
  const half = P.hipW / 2;
  set(L.LEFT_HIP, hx + half * S, hy);
  set(L.RIGHT_HIP, hx - half * S, hy);

  // Torso: straight up from the hips, rotated by lean.
  const [sx, sy] = step(hx, hy, 90 + b.leanDeg, P.torso);
  const shDeg = b.leanDeg; // shoulder line stays perpendicular to the spine
  const [slx, sly] = step(sx, sy, shDeg, 0.5);
  const [srx, sry] = step(sx, sy, shDeg + 180, 0.5);
  set(L.LEFT_SHOULDER, slx, sly);
  set(L.RIGHT_SHOULDER, srx, sry);

  // Arms. Elbow bend curls the forearm toward the body.
  const arm = (
    side: 'L' | 'R', ox: number, oy: number, upper: number, bend: number,
  ): void => {
    const [ex, ey] = step(ox, oy, upper, P.upperArm);
    const inward = side === 'L' ? -1 : 1;
    const [wx, wy] = step(ex, ey, upper + bend * inward, P.foreArm);
    const E = side === 'L' ? L.LEFT_ELBOW : L.RIGHT_ELBOW;
    const W = side === 'L' ? L.LEFT_WRIST : L.RIGHT_WRIST;
    set(E, ex, ey);
    set(W, wx, wy);
    // Hand points: the finger centroid sits one short step past the wrist.
    const [fx, fy] = step(wx, wy, upper + bend * inward, 0.16);
    const spread = 0.05 * S;
    set(side === 'L' ? L.LEFT_INDEX : L.RIGHT_INDEX, fx + spread, fy);
    set(side === 'L' ? L.LEFT_PINKY : L.RIGHT_PINKY, fx - spread, fy);
    set(side === 'L' ? L.LEFT_THUMB : L.RIGHT_THUMB, fx, fy + spread * aspect);
  };
  arm('L', slx, sly, b.armL, b.elbowL);
  arm('R', srx, sry, b.armR, b.elbowR);

  // Legs.
  const leg = (
    side: 'L' | 'R', ox: number, oy: number, thighDeg: number, bend: number, lift: number,
  ): void => {
    const [kx, ky] = step(ox, oy, thighDeg, P.thigh);
    const [axRaw, ayRaw] = step(kx, ky, thighDeg + bend, P.shin);
    // A lifted foot travels from the floor toward the opposite knee.
    const ax = lerp(axRaw, kx, clamp01(lift));
    const ay = lerp(ayRaw, ky + 0.1 * S * aspect, clamp01(lift));
    const K = side === 'L' ? L.LEFT_KNEE : L.RIGHT_KNEE;
    const A = side === 'L' ? L.LEFT_ANKLE : L.RIGHT_ANKLE;
    set(K, kx, ky);
    set(A, ax, ay);
    set(side === 'L' ? L.LEFT_HEEL : L.RIGHT_HEEL, ax - 0.04 * S, ay + 0.03 * S * aspect);
    set(
      side === 'L' ? L.LEFT_FOOT_INDEX : L.RIGHT_FOOT_INDEX,
      ax + P.foot * S * (side === 'L' ? 1 : -1),
      ay + 0.04 * S * aspect,
    );
  };
  leg('L', hx + half * S, hy, b.legL, -b.kneeL, b.footLiftL);
  leg('R', hx - half * S, hy, b.legR, b.kneeR, b.footLiftR);

  // Head.
  const [nx0, ny0] = step(sx, sy, 90 + b.leanDeg, P.neck + P.headR);
  set(L.NOSE, nx0, ny0);
  const ey = ny0 - 0.06 * S * aspect;
  set(L.LEFT_EYE, nx0 + P.eyeX * S, ey);
  set(L.RIGHT_EYE, nx0 - P.eyeX * S, ey);
  set(L.LEFT_EYE_INNER, nx0 + P.eyeX * 0.6 * S, ey);
  set(L.RIGHT_EYE_INNER, nx0 - P.eyeX * 0.6 * S, ey);
  set(L.LEFT_EYE_OUTER, nx0 + P.eyeX * 1.4 * S, ey);
  set(L.RIGHT_EYE_OUTER, nx0 - P.eyeX * 1.4 * S, ey);
  set(L.LEFT_EAR, nx0 + P.earX * S, ny0 - 0.03 * S * aspect);
  set(L.RIGHT_EAR, nx0 - P.earX * S, ny0 - 0.03 * S * aspect);
  set(L.MOUTH_LEFT, nx0 + P.mouthX * S, ny0 + 0.08 * S * aspect);
  set(L.MOUTH_RIGHT, nx0 - P.mouthX * S, ny0 + 0.08 * S * aspect);
  return out;
}

// ─── Deterministic RNG, so clips are byte-identical across runs ──────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Clip assembly ───────────────────────────────────────────────────────────

/** A keyframe track: given 0..1 progress through the clip, return body params. */
export type PoseFn = (u: number, t: number) => Partial<BodyParams>;

export interface BuildOpts {
  fps?: number;
  seed?: number;
  /** Gaussian landmark jitter, in fractions of image width. MediaPipe's raw
   *  output wobbles 3-4px at 640 wide, i.e. ~0.005. */
  jitter?: number;
  /** Probability per frame that a joint group drops below MIN_VIS. */
  dropout?: number;
  /** Probability per frame that the whole frame is skipped (camera hitch). */
  frameDrop?: number;
  /** Hide the lower body entirely — the "small room / laptop" case. */
  hideLegs?: boolean;
  aspect?: number;
}

export function buildClip(
  name: string, durationSec: number, pose: PoseFn, o: BuildOpts = {},
): PoseClip {
  const fps = o.fps ?? 25;
  const rng = mulberry32(o.seed ?? 1337);
  const jitter = o.jitter ?? 0.0035;
  const dropout = o.dropout ?? 0.02;
  const frameDrop = o.frameDrop ?? 0.01;
  const aspect = o.aspect ?? 16 / 9;
  const frames: ClipFrame[] = [];
  const total = Math.max(1, Math.round(durationSec * fps));

  // Box-Muller, reused so jitter is normally distributed rather than uniform:
  // uniform noise under-represents the occasional large excursion that is
  // exactly what breaks a single-threshold detector.
  const gauss = (): number => {
    const u = Math.max(1e-9, rng());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };

  for (let i = 0; i < total; i++) {
    const t = i / fps;
    if (i > 0 && rng() < frameDrop) continue; // camera hitch
    const u = total <= 1 ? 0 : i / (total - 1);
    const lm = body(pose(u, t), aspect);
    const vis = new Float32Array(LANDMARK_COUNT).fill(0.97);

    for (let j = 0; j < LANDMARK_COUNT; j++) {
      lm[j * 2] = lm[j * 2]! + gauss() * jitter;
      lm[j * 2 + 1] = lm[j * 2 + 1]! + gauss() * jitter * aspect;
      if (rng() < dropout) vis[j] = 0.2;
      // Anything outside the frame genuinely is not visible.
      if (lm[j * 2]! < 0 || lm[j * 2]! > 1 || lm[j * 2 + 1]! < 0 || lm[j * 2 + 1]! > 1) {
        vis[j] = 0.15;
      }
    }
    if (o.hideLegs) {
      for (const j of [
        L.LEFT_KNEE, L.RIGHT_KNEE, L.LEFT_ANKLE, L.RIGHT_ANKLE,
        L.LEFT_HEEL, L.RIGHT_HEEL, L.LEFT_FOOT_INDEX, L.RIGHT_FOOT_INDEX,
      ]) vis[j] = 0.1;
    }
    frames.push({ t, people: [{ lm, vis }] });
  }
  return { name, fps, frames };
}

// ─── Pose helpers, for readable keyframes ────────────────────────────────────

/** Both arms out at `deg` (0 = horizontal, 90 = overhead). */
export const armsAt = (deg: number): Partial<BodyParams> => ({
  armL: deg, armR: 180 - deg, elbowL: 4, elbowR: 4,
});
/** One arm raised, the other hanging. */
export const armAt = (side: 'L' | 'R', deg: number): Partial<BodyParams> =>
  side === 'L'
    ? { armL: deg, elbowL: 4, armR: -102 }
    : { armR: 180 - deg, elbowR: 4, armL: -78 };
/**
 * Hands brought together, with a selectable clap height.
 *
 * `close`: 0 = hands apart, 1 = clapped. `height`: 0 = at the shoulders,
 * 1 = in front of the chest, 2 = down at the waist.
 *
 * The forearm (0.78 shoulder-widths) is longer than the half shoulder-width it
 * must cross, so the hands only meet when the elbows swing out — which is what
 * a real clap looks like. Convergence therefore depends on the SAME upper-arm
 * angle that sets the height, so the two cannot be varied independently: these
 * three presets were found by searching the (upper, bend) space for pairs whose
 * wrists meet (measured gap < 0.15 shoulder-widths) at distinct heights.
 */
export const clapAt = (close: number, height: 0 | 1 | 2 = 1): Partial<BodyParams> => {
  const c = clamp01(close);
  // [upper-arm angle, elbow bend] with the wrists at the midline.
  const CLOSED: readonly [number, number][] = [
    [250, 148], // at the shoulders
    [284, 122], // in front of the chest
    [280, 62],  // down at the waist
  ];
  const [upper, bend] = CLOSED[height]!;
  // Opening is a straightening of the elbows, which swings the wrists apart
  // without touching the angle that controls convergence.
  const b = lerp(bend - 58, bend, c);
  return { armL: upper, armR: 180 - upper, elbowL: b, elbowR: b };
};

export const squatBy = (depth: number): Partial<BodyParams> => ({
  hipY: STAND.hipY + 0.11 * clamp01(depth),
  kneeL: 3 + 62 * clamp01(depth), kneeR: 3 + 62 * clamp01(depth),
});
export const leanBy = (deg: number): Partial<BodyParams> => ({ leanDeg: deg });
export const hipAt = (y: number): Partial<BodyParams> => ({ hipY: y });
/** Lift one knee toward the chest, 0..1. Run-in-place and stair-climb. */
export const kneeUp = (side: 'L' | 'R', amount: number): Partial<BodyParams> => {
  const a = clamp01(amount);
  return side === 'L'
    ? { legL: -84 + 52 * a, kneeL: 3 + 80 * a }
    : { legR: -96 - 52 * a, kneeR: 3 + 80 * a };
};
/** Sinusoidal 0..1 at `hz`. */
export const osc = (t: number, hz: number, phase = 0): number =>
  (Math.sin((t * hz + phase) * Math.PI * 2) + 1) / 2;

/**
 * Zip two single-person clips into one two-person clip.
 *
 * The people array is sorted by body x each frame, which is exactly what a
 * naive consumer would do — so when the two bodies cross, the order flips and
 * any game relying on index-as-identity visibly breaks. That is the point:
 * this clip is the identity-swap regression test.
 */
export function mergeClips(name: string, a: PoseClip, b: PoseClip): PoseClip {
  const n = Math.min(a.frames.length, b.frames.length);
  const frames: ClipFrame[] = [];
  for (let i = 0; i < n; i++) {
    const fa = a.frames[i]!;
    const fb = b.frames[i]!;
    const people = [...fa.people, ...fb.people].sort(
      (p, q) => p.lm[L.LEFT_HIP * 2]! - q.lm[L.LEFT_HIP * 2]!,
    );
    frames.push({ t: fa.t, people });
  }
  return { name, fps: a.fps, frames };
}

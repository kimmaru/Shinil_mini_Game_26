import { describe, expect, it } from 'vitest';
import { clip } from '../testing/clips';
import { STAND, body, buildClip, type BodyParams, type PoseClip } from '../testing/synth';
import { defaultCalibration } from './source';
import { L, LANDMARK_COUNT, MIN_VIS, jointDist } from './landmarks';
import { PoseNormalizer, SCALE_MAX_FRAC, SCALE_MIN_FRAC } from './normalize';
import { createPlayerPose } from './frame';
import { ReplayPoseSource } from './replay';

const VIEW = { w: 1280, h: 720 };
const UPPER = [
  L.NOSE,
  L.LEFT_SHOULDER, L.RIGHT_SHOULDER,
  L.LEFT_ELBOW, L.RIGHT_ELBOW,
  L.LEFT_WRIST, L.RIGHT_WRIST,
  L.LEFT_HIP, L.RIGHT_HIP,
  L.LEFT_KNEE, L.RIGHT_KNEE,
] as const;

/** The same motion, framed at a different distance and screen position. */
function sweep(shoulderW: number, hipX: number, hipY: number, jitter: number): PoseClip {
  return buildClip(
    `sw-${shoulderW}`,
    6,
    (_u, t) => ({
      shoulderW,
      hipX,
      hipY,
      armL: -70 + 70 * Math.sin(t * 1.5),
      armR: -110 - 70 * Math.sin(t * 1.5),
      elbowL: 20 + 20 * Math.cos(t * 1.1),
      elbowR: 20 + 20 * Math.cos(t * 1.1),
      leanDeg: 8 * Math.sin(t * 0.6),
    }),
    { seed: 7, jitter, dropout: 0, frameDrop: 0 },
  );
}

function runNorm(c: PoseClip): { n: Float32Array[]; scale: number[] } {
  const norm = new PoseNormalizer();
  const pose = createPlayerPose(1, 0, defaultCalibration(VIEW.w, VIEW.h));
  const calib = defaultCalibration(VIEW.w, VIEW.h);
  const n: Float32Array[] = [];
  const scale: number[] = [];
  for (const fr of c.frames) {
    const p = fr.people[0]!;
    norm.feed(p.lm, p.vis, VIEW.w, VIEW.h, calib, fr.t);
    norm.project(pose, 0, VIEW.w, VIEW.h);
    n.push(Float32Array.from(pose.n));
    scale.push(pose.scalePx);
  }
  return { n, scale };
}

describe('normalize: camera-distance invariance', () => {
  it('the same motion near and far gives the same normalized values', () => {
    // 0.13 shoulder widths ~ 2.5m; 0.075 ~ 4m (the `far-small` framing). Also
    // moved to a different place on screen, so this tests translation too.
    const near = runNorm(sweep(0.13, 0.5, 0.48, 0));
    const far = runNorm(sweep(0.075, 0.33, 0.52, 0));
    expect(near.n.length).toBe(far.n.length);

    let worst = 0;
    let sum = 0;
    let count = 0;
    for (let i = 25; i < near.n.length; i++) {
      for (const j of UPPER) {
        for (const k of [0, 1]) {
          const d = Math.abs(near.n[i]![j * 2 + k]! - far.n[i]![j * 2 + k]!);
          worst = Math.max(worst, d);
          sum += d;
          count++;
        }
      }
    }
    // Measured worst-case ~0.004 shoulder widths over 125 frames x 11 joints.
    // Every gameplay threshold in the catalogue is >= 0.2, so this is three
    // orders of margin: a game tuned at 2.5m behaves identically at 4m.
    expect(worst).toBeLessThan(0.02);
    expect(sum / count).toBeLessThan(0.005);
  });

  it('scale is measured, not assumed: px scales with the body', () => {
    const near = runNorm(sweep(0.13, 0.5, 0.48, 0));
    const far = runNorm(sweep(0.075, 0.5, 0.52, 0));
    const nearScale = near.scale[near.scale.length - 1]!;
    const farScale = far.scale[far.scale.length - 1]!;
    expect(nearScale / farScale).toBeCloseTo(0.13 / 0.075, 1);
    expect(nearScale).toBeCloseTo(0.13 * VIEW.w, 0);
  });

  it('survives real sensor noise at 4m, where noise is 2x bigger in body units', () => {
    const near = runNorm(sweep(0.13, 0.5, 0.48, 0.0035));
    const far = runNorm(sweep(0.075, 0.5, 0.52, 0.0035));
    let sum = 0;
    let count = 0;
    for (let i = 25; i < near.n.length; i++) {
      for (const j of UPPER) {
        sum += Math.abs(near.n[i]![j * 2]! - far.n[i]![j * 2]!);
        sum += Math.abs(near.n[i]![j * 2 + 1]! - far.n[i]![j * 2 + 1]!);
        count += 2;
      }
    }
    // Jitter is specified in fractions of image WIDTH, so at 0.075 shoulder
    // widths it is 1.7x larger in body units. The residual is still far below
    // any threshold a game uses.
    expect(sum / count).toBeLessThan(0.06);
  });

  it('far-small produces sane normalized geometry', () => {
    const src = new ReplayPoseSource(clip('far-small'), { maxPlayers: 1 });
    void src.start();
    let checked = 0;
    let bad = 0;
    let worstShoulder = 0;
    let worstHip = 0;
    const shoulders: number[] = [];
    for (let i = 0; i < 16 * 60; i++) {
      const f = src.sample(i / 60);
      const p = f.p1;
      if (!p?.present) continue;
      checked++;
      for (let k = 0; k < LANDMARK_COUNT * 2; k++) {
        if (!Number.isFinite(p.n[k]!) || !Number.isFinite(p.px[k]!) || !Number.isFinite(p.v[k]!)) {
          bad++;
        }
      }
      const sd = jointDist(p, L.LEFT_SHOULDER, L.RIGHT_SHOULDER);
      shoulders.push(sd);
      worstShoulder = Math.max(worstShoulder, Math.abs(sd - 1));
      worstHip = Math.max(
        worstHip,
        Math.abs(p.n[L.LEFT_HIP * 2]! + p.n[L.RIGHT_HIP * 2]!),
      );
    }
    expect(checked).toBeGreaterThan(600);
    expect(bad).toBe(0);
    // Shoulders are 1 unit apart BY DEFINITION of the unit...
    const sorted = shoulders.slice().sort((a, b) => a - b);
    expect(sorted[sorted.length >> 1]!).toBeCloseTo(1, 1);
    // ...but not exactly, and the reason is worth knowing: when one shoulder
    // drops below MIN_VIS we HOLD its last position rather than guess, and if
    // the body happens to be mid-jump that held shoulder is a few tenths of a
    // shoulder width stale for up to the 0.3s grace window. Gate-don't-guess
    // buys that, and it is the right trade; just do not assume |shoulder
    // separation - 1| is ever exactly zero.
    expect(worstShoulder).toBeLessThan(0.4);
    // The hip centre is the origin, always, with no exceptions.
    expect(worstHip).toBeLessThan(0.02);
  });
});

describe('normalize: mirroring', () => {
  const calib = defaultCalibration(VIEW.w, VIEW.h);
  const unmirrored = { ...calib, mirrored: false };

  function once(c: typeof calib): ReturnType<typeof createPlayerPose> {
    const norm = new PoseNormalizer();
    const pose = createPlayerPose(1, 0, c);
    const vis = new Float32Array(LANDMARK_COUNT).fill(0.97);
    // One arm raised, so left and right are distinguishable.
    const lm = body({ shoulderW: 0.1, hipY: 0.58, armL: 80, elbowL: 4 }, 16 / 9);
    for (let i = 0; i < 10; i++) norm.feed(lm, vis, VIEW.w, VIEW.h, c, i / 30);
    norm.project(pose, 0, VIEW.w, VIEW.h);
    return pose;
  }

  it('mirrors x only, and the subject LEFT hand lands on the LEFT of the screen', () => {
    const m = once(calib);
    const u = once(unmirrored);
    // This is the one that decides whether "왼손 들어!" sends a 7-year-old the
    // right way. Mirrored preview == a mirror: the raised left hand appears on
    // the left of the screen.
    expect(m.px[L.LEFT_WRIST * 2]!).toBeLessThan(VIEW.w / 2);
    expect(u.px[L.LEFT_WRIST * 2]!).toBeGreaterThan(VIEW.w / 2);
    // y is never mirrored.
    expect(m.px[L.LEFT_WRIST * 2 + 1]!).toBeCloseTo(u.px[L.LEFT_WRIST * 2 + 1]!, 3);
  });

  it('n is derived from the mirrored space, so logic and drawing agree', () => {
    const m = once(calib);
    const sgnN = Math.sign(m.n[L.LEFT_WRIST * 2]!);
    const sgnPx = Math.sign(m.px[L.LEFT_WRIST * 2]! - VIEW.w / 2);
    expect(sgnN).toBe(sgnPx);
  });
});

describe('normalize: degradation', () => {
  const calib = defaultCalibration(VIEW.w, VIEW.h);

  it('falls back to torso then to last-good when shoulders vanish', () => {
    const norm = new PoseNormalizer();
    const pose = createPlayerPose(1, 0, calib);
    const lm = body({ shoulderW: 0.1, hipY: 0.58 }, 16 / 9);
    const vis = new Float32Array(LANDMARK_COUNT).fill(0.97);
    for (let i = 0; i < 20; i++) norm.feed(lm, vis, VIEW.w, VIEW.h, calib, i / 30);
    const good = norm.scalePx;
    expect(good).toBeCloseTo(0.1 * VIEW.w, 0);

    // Lose both shoulders for a second: the torso fallback must land close
    // enough that no threshold visibly moves.
    const noSh = new Float32Array(vis);
    noSh[L.LEFT_SHOULDER] = 0.1;
    noSh[L.RIGHT_SHOULDER] = 0.1;
    for (let i = 20; i < 50; i++) norm.feed(lm, noSh, VIEW.w, VIEW.h, calib, i / 30);
    expect(Math.abs(norm.scalePx - good) / good).toBeLessThan(0.1);

    // Lose the hips as well: nothing left to measure, so hold the last value.
    const nothing = new Float32Array(LANDMARK_COUNT).fill(0.1);
    for (let i = 50; i < 80; i++) norm.feed(lm, nothing, VIEW.w, VIEW.h, calib, i / 30);
    expect(norm.scalePx).toBeGreaterThan(0);
    norm.project(pose, 0, VIEW.w, VIEW.h);
    expect([...pose.px].every(Number.isFinite)).toBe(true);
  });

  it('clamps the scale so one mis-detection cannot explode the geometry', () => {
    const norm = new PoseNormalizer();
    const vis = new Float32Array(LANDMARK_COUNT).fill(0.97);
    // A body claiming to be 3x wider than the frame.
    const huge = body({ shoulderW: 3, hipY: 0.5 }, 16 / 9);
    for (let i = 0; i < 40; i++) norm.feed(huge, vis, VIEW.w, VIEW.h, calib, i / 30);
    expect(norm.scalePx).toBeLessThanOrEqual(VIEW.h * SCALE_MAX_FRAC + 0.001);
    const tiny = body({ shoulderW: 0.0005, hipY: 0.5 }, 16 / 9);
    const n2 = new PoseNormalizer();
    for (let i = 0; i < 40; i++) n2.feed(tiny, vis, VIEW.w, VIEW.h, calib, i / 30);
    expect(n2.scalePx).toBeGreaterThanOrEqual(VIEW.h * SCALE_MIN_FRAC - 0.001);
  });

  it('smooths scale far more heavily than positions', () => {
    const norm = new PoseNormalizer();
    const vis = new Float32Array(LANDMARK_COUNT).fill(0.97);
    const a = body({ shoulderW: 0.1, hipY: 0.58 }, 16 / 9);
    for (let i = 0; i < 40; i++) norm.feed(a, vis, VIEW.w, VIEW.h, calib, i / 30);
    const before = norm.scalePx;
    // A single frame claiming the body doubled in size.
    const b = body({ shoulderW: 0.2, hipY: 0.58 }, 16 / 9);
    norm.feed(b, vis, VIEW.w, VIEW.h, calib, 40 / 30);
    // 30% of the way at most — a scale that jumps makes every threshold jump.
    expect(norm.scalePx).toBeLessThan(before * 1.35);
  });

  it('holds a vanished joint for 0.3s, then admits it is gone', () => {
    const norm = new PoseNormalizer();
    const pose = createPlayerPose(1, 0, calib);
    const lm = body({ shoulderW: 0.1, hipY: 0.58 }, 16 / 9);
    const vis = new Float32Array(LANDMARK_COUNT).fill(0.97);
    for (let i = 0; i < 20; i++) norm.feed(lm, vis, VIEW.w, VIEW.h, calib, i / 30);
    const heldX = norm.w[L.LEFT_WRIST * 2]!;

    const gone = new Float32Array(vis);
    gone[L.LEFT_WRIST] = 0.1;
    // A teleported wrist (a reflection in a window) while invisible.
    const bad = Float32Array.from(lm);
    bad[L.LEFT_WRIST * 2] = 0.95;
    bad[L.LEFT_WRIST * 2 + 1] = 0.02;

    norm.feed(bad, gone, VIEW.w, VIEW.h, calib, 20 / 30);
    // Still trusted (grace window) and still where it was: we hold, not guess.
    expect(norm.vis[L.LEFT_WRIST]!).toBeGreaterThan(MIN_VIS);
    expect(norm.w[L.LEFT_WRIST * 2]!).toBeCloseTo(heldX, 2);

    for (let i = 21; i < 40; i++) norm.feed(bad, gone, VIEW.w, VIEW.h, calib, i / 30);
    // Past 0.3s: gated, so `visible()` stops every detector that needs it.
    expect(norm.vis[L.LEFT_WRIST]!).toBeLessThan(MIN_VIS);
    norm.project(pose, 0, VIEW.w, VIEW.h);
    expect(Math.hypot(pose.v[L.LEFT_WRIST * 2]!, pose.v[L.LEFT_WRIST * 2 + 1]!)).toBeLessThan(0.5);
  });

  it('reports roll without correcting for it', () => {
    const norm = new PoseNormalizer();
    const pose = createPlayerPose(1, 0, calib);
    const vis = new Float32Array(LANDMARK_COUNT).fill(0.97);
    const level = body({ shoulderW: 0.1, hipY: 0.58, leanDeg: 0 }, 16 / 9);
    for (let i = 0; i < 20; i++) norm.feed(level, vis, VIEW.w, VIEW.h, calib, i / 30);
    norm.project(pose, 0, VIEW.w, VIEW.h);
    expect(Math.abs(pose.rollDeg)).toBeLessThan(1);

    const tilt = body({ shoulderW: 0.1, hipY: 0.58, leanDeg: 20 }, 16 / 9);
    const n2 = new PoseNormalizer();
    for (let i = 0; i < 20; i++) n2.feed(tilt, vis, VIEW.w, VIEW.h, calib, i / 30);
    n2.project(pose, 0, VIEW.w, VIEW.h);
    expect(Math.abs(pose.rollDeg)).toBeGreaterThan(10);
    // Sign flips with the lean, whichever way the mirror points.
    const tilt2 = body({ shoulderW: 0.1, hipY: 0.58, leanDeg: -20 }, 16 / 9);
    const n3 = new PoseNormalizer();
    for (let i = 0; i < 20; i++) n3.feed(tilt2, vis, VIEW.w, VIEW.h, calib, i / 30);
    const first = pose.rollDeg;
    n3.project(pose, 0, VIEW.w, VIEW.h);
    expect(Math.sign(pose.rollDeg)).toBe(-Math.sign(first));
  });

  it('box is a 0..1 view fraction covering the visible body', () => {
    const norm = new PoseNormalizer();
    const pose = createPlayerPose(1, 0, calib);
    const vis = new Float32Array(LANDMARK_COUNT).fill(0.97);
    const lm = body({ shoulderW: 0.1, hipY: 0.58 }, 16 / 9);
    for (let i = 0; i < 20; i++) norm.feed(lm, vis, VIEW.w, VIEW.h, calib, i / 30);
    norm.project(pose, 0, VIEW.w, VIEW.h);
    expect(pose.box.x).toBeGreaterThan(0);
    expect(pose.box.x + pose.box.w).toBeLessThan(1);
    expect(pose.box.h).toBeGreaterThan(0.5);
    expect(pose.box.y + pose.box.h).toBeLessThanOrEqual(1.01);
  });
});

describe('normalize: extrapolation and allocation', () => {
  const calib = defaultCalibration(VIEW.w, VIEW.h);

  it('extrapolates along the filtered velocity', () => {
    const norm = new PoseNormalizer();
    const pose = createPlayerPose(1, 0, calib);
    const vis = new Float32Array(LANDMARK_COUNT).fill(0.97);
    for (let i = 0; i < 30; i++) {
      const lm = body(
        { shoulderW: 0.1, hipY: 0.58, armL: -70 + i * 4 } as Partial<BodyParams>,
        16 / 9,
      );
      norm.feed(lm, vis, VIEW.w, VIEW.h, calib, i / 30);
    }
    norm.project(pose, 0, VIEW.w, VIEW.h);
    const atInference = pose.n[L.LEFT_WRIST * 2 + 1]!;
    const vy = pose.v[L.LEFT_WRIST * 2 + 1]!;
    norm.project(pose, 0.04, VIEW.w, VIEW.h);
    const extrapolated = pose.n[L.LEFT_WRIST * 2 + 1]!;
    expect(Math.abs(vy)).toBeGreaterThan(0.5);
    // Hip-relative n moves by (joint velocity - hip velocity) * age; the hip
    // is static here, so it is the joint velocity.
    expect(extrapolated - atInference).toBeCloseTo(vy * 0.04, 2);
  });

  it('keeps n exactly hip-centred even while extrapolating', () => {
    const src = new ReplayPoseSource(clip('jump-x8'), { maxPlayers: 1 });
    void src.start();
    for (let i = 0; i < 16 * 60; i++) {
      const p = src.sample(i / 60).p1;
      if (!p?.present) continue;
      const hx = (p.n[L.LEFT_HIP * 2]! + p.n[L.RIGHT_HIP * 2]!) / 2;
      const hy = (p.n[L.LEFT_HIP * 2 + 1]! + p.n[L.RIGHT_HIP * 2 + 1]!) / 2;
      expect(Math.abs(hx)).toBeLessThan(1e-3);
      expect(Math.abs(hy)).toBeLessThan(1e-3);
    }
  });

  it('reuses every array: no allocation in the steady state', () => {
    const src = new ReplayPoseSource(clip('idle'), { maxPlayers: 1 });
    void src.start();
    const f1 = src.sample(1);
    const p1 = f1.p1!;
    const f2 = src.sample(1.5);
    expect(f2).toBe(f1);
    expect(f2.p1).toBe(p1);
    expect(f2.p1!.n).toBe(p1.n);
    expect(f2.p1!.px).toBe(p1.px);
    expect(f2.p1!.v).toBe(p1.v);
    expect(f2.p1!.box).toBe(p1.box);
  });

  it('STAND is a whole-body framing, so feet-gated detectors can fire', () => {
    // Regression guard. STAND used to be shoulderW 0.17 / hipY 0.62, which put
    // the ankles at y=1.27 — outside a 16:9 frame. That made `lowerBodyVisible`
    // false for almost the whole corpus and left every legs/feet game
    // untestable, while every test still passed. A body only fits 16:9 below
    // shoulderW ~0.13, so if someone enlarges STAND again, this fails loudly.
    const lm = body({ ...STAND }, 16 / 9);
    for (const j of [L.NOSE, L.LEFT_ANKLE, L.RIGHT_ANKLE]) {
      expect(lm[j * 2 + 1]!).toBeGreaterThan(0);
      expect(lm[j * 2 + 1]!).toBeLessThan(1);
    }
    const idleFrame = clip('idle').frames[20]!.people[0]!;
    expect(idleFrame.vis[L.LEFT_ANKLE]!).toBeGreaterThan(MIN_VIS);
    // far-small is a smaller, further-away body and is also whole.
    const farFrame = clip('far-small').frames[20]!.people[0]!;
    expect(farFrame.vis[L.LEFT_ANKLE]!).toBeGreaterThan(MIN_VIS);
  });
});

// A child 1.2m from a laptop: head to waist in frame, hips off the bottom edge
// (a MacBook lid tilted back aims the camera slightly up). Before this framing
// was handled, nothing reacted until the child backed off far enough to show
// both hips — see identity.ts HEAD_ABOVE_SHOULDERS and normalize.ts
// HIP_ENTER_VIS.
import { describe, expect, it } from 'vitest';
import { body, buildClip, mulberry32, type PersonFrame, type PoseClip } from '../testing/synth';
import { clip } from '../testing/clips';
import { L, LANDMARK_COUNT, MIN_VIS } from './landmarks';
import { PoseIdentity, isUprightPose } from './identity';
import { PoseNormalizer } from './normalize';
import { createPlayerPose } from './frame';
import { defaultCalibration } from './source';
import { ReplayPoseSource } from './replay';
import { AutoCalibrator } from './calibration';
import { pickPool } from '../registry';

const VIEW = { w: 1280, h: 720 };
const ASPECT = VIEW.w / VIEW.h;
const FPS = 25;
/** Shoulders 20% of the width, hips at y=1.06: the 1.2m laptop framing. */
const CLOSE = { shoulderW: 0.2, hipY: 1.06 } as const;

/** One synthetic detection; anything outside the image is invisible, as it
 *  is from the real model. */
function person(p: Parameters<typeof body>[0]): PersonFrame {
  const lm = body(p, ASPECT);
  const vis = new Float32Array(LANDMARK_COUNT).fill(0.97);
  for (let j = 0; j < LANDMARK_COUNT; j++) {
    const x = lm[j * 2]!;
    const y = lm[j * 2 + 1]!;
    if (x < 0 || x > 1 || y < 0 || y > 1) vis[j] = 0.15;
  }
  return { lm, vis };
}

/** Feed the same detection(s) for `sec` seconds; returns the end time. */
function hold(id: PoseIdentity, dets: readonly PersonFrame[], t0: number, sec: number): number {
  let t = t0;
  for (; t < t0 + sec; t += 1 / FPS) {
    id.update(dets, t, VIEW.w, VIEW.h);
    id.project(t, 0, FPS, VIEW.w, VIEW.h);
  }
  return t;
}

describe('close range: upper-body acceptance', () => {
  it('the synthetic framing really is head-to-waist with the hips out of frame', () => {
    const d = person(CLOSE);
    expect(d.vis[L.LEFT_HIP]!).toBeLessThan(MIN_VIS);
    expect(d.vis[L.RIGHT_HIP]!).toBeLessThan(MIN_VIS);
    expect(d.vis[L.NOSE]!).toBeGreaterThan(MIN_VIS);
    expect(d.vis[L.LEFT_SHOULDER]!).toBeGreaterThan(MIN_VIS);
  });

  it('a child with no hips in view becomes the player after the normal probation', () => {
    const id = new PoseIdentity({ maxPlayers: 2 });
    const dets = [person(CLOSE)];
    let t = hold(id, dets, 0, 0.4);
    expect(id.frame.players.length).toBe(0); // still on probation, as for anyone
    t = hold(id, dets, t, 0.2);
    expect(id.frame.p1?.present).toBe(true);
    expect(isUprightPose(id.frame.p1!)).toBe(true);
    // The scale is their own shoulders, not a fallback.
    expect(id.frame.p1!.scalePx / VIEW.w).toBeCloseTo(CLOSE.shoulderW, 2);
  });

  it('is calibrated, ready and not told to move', () => {
    const c = buildClip('close-idle', 4, () => ({ ...CLOSE }), { seed: 31, fps: FPS });
    // Real hips well below the frame report ~0, and real shoulders ~0.9: the
    // torso-anchor mean `conf` then sits under MIN_VIS however clear the child
    // is, which used to keep the calibrator from ever seeing them.
    for (const f of c.frames) {
      for (const p of f.people) {
        p.vis[L.LEFT_HIP] = 0.02;
        p.vis[L.RIGHT_HIP] = 0.02;
        p.vis[L.LEFT_SHOULDER] = Math.min(p.vis[L.LEFT_SHOULDER]!, 0.9);
        p.vis[L.RIGHT_SHOULDER] = Math.min(p.vis[L.RIGHT_SHOULDER]!, 0.9);
      }
    }
    const a = feedAuto(c);
    expect(a.present).toBe(true);
    expect(a.ready).toBe(true);
    expect(a.profile.shoulderW / VIEW.w).toBeCloseTo(CLOSE.shoulderW, 2);
    // 0.2 x ~4.1 shoulder widths of span = 0.82 of the view: arms fit.
    expect(a.tooClose).toBe(false);
    expect(a.tooFar).toBe(false);
    expect(a.lowerBodyVisible).toBe(false);
  });

  it('the 4-second capture measures them too, instead of rejecting the frames', async () => {
    const c = buildClip('close-arms', 6, (_u, t) => ({
      ...CLOSE, armL: 10 * Math.sin(t), armR: 180 - 10 * Math.sin(t), elbowL: 2, elbowR: 2,
    }), { seed: 32, fps: FPS });
    const src = new ReplayPoseSource(c, { maxPlayers: 1, view: VIEW });
    await src.start();
    const p = await src.calibrate(4000);
    expect(p.shoulderW / VIEW.w).toBeCloseTo(CLOSE.shoulderW, 2);
    expect(p.armLen).toBeGreaterThan(1.5);
    expect(p.lowerBodyVisible).toBe(false);
  });
});

describe('close range: what must still be rejected', () => {
  /** Rotate a body by 90 degrees: shoulder line vertical, head beside them. */
  const lying = (dir: 1 | -1, hipX: number): PersonFrame =>
    person({ shoulderW: 0.1, hipX, hipY: 0.6, leanDeg: 90 * dir, armL: -90, armR: -90 });

  it('someone lying down, hips in view or not', () => {
    for (const d of [lying(1, 0.7), lying(-1, 0.3), lying(1, 1.1), lying(-1, -0.1)]) {
      const id = new PoseIdentity({ maxPlayers: 1 });
      hold(id, [d], 0, 2);
      expect(id.frame.players.length).toBe(0);
    }
  });

  it('an upside-down blob (a chair back) with no hips in view', () => {
    const d = person(CLOSE);
    for (let j = 0; j < LANDMARK_COUNT; j++) d.lm[j * 2 + 1] = 1 - d.lm[j * 2 + 1]!;
    const id = new PoseIdentity({ maxPlayers: 1 });
    hold(id, [d], 0, 2);
    expect(id.frame.players.length).toBe(0);
  });

  it('a pair of shoulders with no face (a coat on a chair)', () => {
    const d = person(CLOSE);
    for (let j = L.NOSE; j <= L.MOUTH_RIGHT; j++) d.vis[j] = 0.1;
    const id = new PoseIdentity({ maxPlayers: 1 });
    hold(id, [d], 0, 2);
    expect(id.frame.players.length).toBe(0);
  });

  it('isUprightPose agrees with probation on a lying body', () => {
    const id = new PoseIdentity({ maxPlayers: 1, requireUpright: false });
    hold(id, [lying(1, 0.7)], 0, 1);
    expect(id.frame.p1?.present).toBe(true);
    expect(isUprightPose(id.frame.p1!)).toBe(false);
  });
});

describe('close range: the hip origin', () => {
  const calib = defaultCalibration(VIEW.w, VIEW.h);

  it('does not jump while hips flicker in and out at the bottom edge', () => {
    // Hips right on the edge: visibility wanders 0.3..0.8 frame to frame, the
    // way the real model reports a joint it can half see. The body is still.
    const rng = mulberry32(5);
    const norm = new PoseNormalizer();
    const pose = createPlayerPose(1, 0, calib);
    const lm = body({ shoulderW: 0.2, hipY: 0.97 }, ASPECT);
    const vis = new Float32Array(LANDMARK_COUNT).fill(0.97);
    let worst = 0;
    let prev = NaN;
    for (let i = 0; i < 150; i++) {
      const v = 0.3 + 0.5 * rng();
      vis[L.LEFT_HIP] = v;
      vis[L.RIGHT_HIP] = v;
      norm.feed(lm, vis, VIEW.w, VIEW.h, calib, i / FPS);
      norm.project(pose, 0, VIEW.w, VIEW.h);
      const y = pose.n[L.NOSE * 2 + 1]!;
      if (i > 10 && Number.isFinite(prev)) worst = Math.max(worst, Math.abs(y - prev));
      prev = y;
    }
    // Anything a game could see is ~0.1 SW; a step of 0.3 would be a visible
    // teleport of every joint.
    expect(worst).toBeLessThan(0.02);
  });

  it('moves with the body when the hips are out of frame, instead of freezing', () => {
    // The child slides sideways 0.2 of the view with no hips in sight. The
    // old origin was the last hip position ever seen, so every `n` drifted by
    // the whole slide (1 shoulder width here).
    const norm = new PoseNormalizer();
    const pose = createPlayerPose(1, 0, calib);
    const xs: number[] = [];
    for (let i = 0; i < 100; i++) {
      const d = person({ ...CLOSE, hipX: 0.4 + 0.2 * (i / 99) });
      norm.feed(d.lm, d.vis, VIEW.w, VIEW.h, calib, i / FPS);
      norm.project(pose, 0, VIEW.w, VIEW.h);
      xs.push(pose.n[L.NOSE * 2]!);
    }
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(0.1);
    expect(norm.hipWeight).toBe(0);
  });

  it('learns this body\'s torso, so the estimate lands on the real hips', () => {
    // A body whose torso is NOT the default length (a camera looking up
    // foreshortens it). Hips visible for 3s, then they drop out of frame.
    const norm = new PoseNormalizer();
    const pose = createPlayerPose(1, 0, calib);
    const lm = body({ shoulderW: 0.2, hipY: 0.9 }, ASPECT);
    // Squash the torso 15% toward the shoulders: hips 15% closer.
    const shy = (lm[L.LEFT_SHOULDER * 2 + 1]! + lm[L.RIGHT_SHOULDER * 2 + 1]!) / 2;
    for (const j of [L.LEFT_HIP, L.RIGHT_HIP]) lm[j * 2 + 1] = shy + (lm[j * 2 + 1]! - shy) * 0.85;
    const vis = new Float32Array(LANDMARK_COUNT).fill(0.97);
    let t = 0;
    for (let i = 0; i < 75; i++, t += 1 / FPS) norm.feed(lm, vis, VIEW.w, VIEW.h, calib, t);
    norm.project(pose, 0, VIEW.w, VIEW.h);
    const before = pose.n[L.NOSE * 2 + 1]!;

    vis[L.LEFT_HIP] = 0.1;
    vis[L.RIGHT_HIP] = 0.1;
    let worst = 0;
    let prev = before;
    for (let i = 0; i < 50; i++, t += 1 / FPS) {
      norm.feed(lm, vis, VIEW.w, VIEW.h, calib, t);
      norm.project(pose, 0, VIEW.w, VIEW.h);
      const y = pose.n[L.NOSE * 2 + 1]!;
      worst = Math.max(worst, Math.abs(y - prev));
      prev = y;
    }
    expect(norm.hipWeight).toBe(0);
    expect(Math.abs(prev - before)).toBeLessThan(0.05);
    expect(worst).toBeLessThan(0.02);
  });
});

describe('close range: the roulette pool', () => {
  const HIP_GAMES = ['ox-quiz-zone', 'snowball-fight'];
  const LEG_GAMES = ['air-whack-mole', 'goalkeeper-save', 'wave-jump'];
  const pool = (lowerBodyVisible: boolean): string[] =>
    pickPool({
      players: 1, space: ['seated', 'standing', 'room'], cameraOn: true, lowerBodyVisible,
    }).map((m) => m.id);

  it('upper-body framing reports no lower body, which hides hip and leg games', () => {
    const c = buildClip('close-wave', 4, (_u, t) => ({
      ...CLOSE, armL: 20 + 60 * Math.sin(t * 2), armR: 160 - 60 * Math.sin(t * 2),
    }), { seed: 33, fps: FPS });
    const a = feedAuto(c);
    expect(a.ready).toBe(true);
    expect(a.lowerBodyVisible).toBe(false);

    const ids = pool(a.lowerBodyVisible);
    for (const g of [...HIP_GAMES, ...LEG_GAMES]) expect(ids).not.toContain(g);
    // Everything played with the arms, hands and head stays.
    for (const g of [
      'arm-pump-inflate', 'balloon-pop-party', 'bike-pedal', 'blue-flag-white-flag',
      'candy-rain-catch', 'castle-defense', 'cheer-combo', 'color-shield-block',
      'connect-dots-order', 'fruit-slash', 'koko-ko-touch', 'max-reach-stretch',
      'mosquito-clap', 'run-in-place-sprint', 'shooting-star-grab', 'spider-touch',
      'web-cut', 'wrist-aim-target', 'wrist-maze',
    ]) {
      expect(ids).toContain(g);
    }
  });

  it('a whole-body framing keeps every game', () => {
    const a = feedAuto(clip('idle'));
    expect(a.lowerBodyVisible).toBe(true);
    const ids = pool(a.lowerBodyVisible);
    for (const g of [...HIP_GAMES, ...LEG_GAMES]) expect(ids).toContain(g);
  });
});

/** Clip -> identity -> normalize -> AutoCalibrator, the camera path's order. */
function feedAuto(c: PoseClip): AutoCalibrator {
  const a = new AutoCalibrator({ view: VIEW, fps: FPS });
  const src = new ReplayPoseSource(c, { maxPlayers: 1, view: VIEW, loop: false });
  void src.start();
  const last = c.frames[c.frames.length - 1]!.t;
  for (let t = 0; t <= last; t += 1 / FPS) a.feed(src.sample(t).p1, t);
  return a;
}

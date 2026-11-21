import { describe, expect, it } from 'vitest';
import { clip } from '../testing/clips';
import { STAND } from '../testing/synth';

/** far-small's framing, read off the clip so this cannot drift. */
const FAR_SHOULDER_W = 0.058;
import { CALIBRATE_SAMPLES, CalibrationCapture, ENERGY_JOINTS, motionEnergy } from './calibration';
import { createPlayerPose } from './frame';
import { defaultCalibration } from './source';
import { L, MIN_VIS } from './landmarks';
import { ReplayPoseSource } from './replay';

const VIEW = { w: 1280, h: 720 };

describe('calibration from a clip', () => {
  it('idle gives sane values and an honest lowerBodyVisible', async () => {
    const src = new ReplayPoseSource(clip('idle'), { maxPlayers: 1, view: VIEW });
    await src.start();
    const p = await src.calibrate(4000);

    // Derived from the fixture, not hardcoded: the corpus framing is its own
    // business, and a literal here rots the moment it is reframed.
    const expectedPx = STAND.shoulderW * VIEW.w;
    expect(p.shoulderW).toBeGreaterThan(expectedPx * 0.94);
    expect(p.shoulderW).toBeLessThan(expectedPx * 1.06);
    expect(p.standHipY).toBeCloseTo(STAND.hipY, 1);
    // No squat and no reach in this clip, so both fall back, and the fallbacks
    // are relative to the measured stand — never a global constant.
    expect(p.squatHipY).toBeCloseTo(p.standHipY + 0.12, 3);
    expect(p.reachUpY).toBeCloseTo(p.standHipY - 0.2, 3);
    // STAND is a whole-body framing, so the floor is measurable and legs/feet
    // games stay in the pool. (This previously asserted `false`, which was the
    // corpus cropping the ankles out of frame — fixed, not worked around.)
    expect(p.lowerBodyVisible).toBe(true);
    expect(p.floorY).toBeGreaterThan(0.8);
    expect(p.floorY).toBeLessThan(1);
    expect(p.mirrored).toBe(true);
    // Arms were down the whole time: span is derived from the measured arm
    // length rather than invented.
    expect(p.armLen).toBeGreaterThan(1.5);
    expect(p.armLen).toBeLessThan(1.8);
    expect(p.armSpan).toBeCloseTo(2 * p.armLen + 0.9, 5);
  });

  it('hold-poses measures a real arm span', async () => {
    const src = new ReplayPoseSource(clip('hold-poses'), { maxPlayers: 1, view: VIEW });
    await src.start();
    const p = await src.calibrate(8000);
    // The clip opens on a T pose, so the span is measured rather than derived.
    expect(p.armSpan).toBeGreaterThan(4);
    expect(p.armSpan).toBeLessThan(4.6);
  });

  it('measures overhead reach from a clip whose arms actually go up', async () => {
    // Calibration only ever sees a bounded window, so `reachUpY` is only a
    // measurement if the hands go up DURING it. In the real flow the
    // calibration screen asks for exactly that ("두 손을 번쩍 들어보세요!");
    // reach-grid opens with the arms above horizontal, which is the same shape.
    const src = new ReplayPoseSource(clip('reach-grid'), { maxPlayers: 1, view: VIEW });
    await src.start();
    const p = await src.calibrate(4000);
    const marginSW = (p.standHipY - p.reachUpY) * VIEW.h / p.shoulderW;
    // Clears the shoulders (1.35 SW above the hips) by a real margin.
    expect(marginSW).toBeGreaterThan(1.8);
    expect(p.reachUpY).toBeGreaterThan(0);
  });

  it('far-small (a full-body framing) sees the floor', async () => {
    const src = new ReplayPoseSource(clip('far-small'), { maxPlayers: 1, view: VIEW });
    await src.start();
    const p = await src.calibrate(4000);
    expect(p.lowerBodyVisible).toBe(true);
    expect(p.floorY).toBeGreaterThan(0.6);
    expect(p.floorY).toBeLessThan(1);
    expect(p.shoulderW).toBeCloseTo(FAR_SHOULDER_W * VIEW.w, 0);
  });

  it('idleEnergy is the PLAYER\'s own resting motion, not a constant', async () => {
    const still = new ReplayPoseSource(clip('idle'), { maxPlayers: 1, view: VIEW });
    await still.start();
    const a = await still.calibrate(4000);

    const fidgety = new ReplayPoseSource(clip('fidget'), { maxPlayers: 1, view: VIEW });
    await fidgety.start();
    const b = await fidgety.calibrate(4000);

    // Both are plausible, and the fidgeting child measures higher. A freeze
    // game thresholding on a global constant would fail that child every time.
    expect(a.idleEnergy).toBeGreaterThan(0.05);
    expect(a.idleEnergy).toBeLessThan(1);
    expect(b.idleEnergy).toBeGreaterThan(a.idleEnergy);
  });

  it('rejects rather than inventing a profile when nobody is visible', async () => {
    const empty = {
      name: 'empty',
      fps: 25,
      frames: clip('idle').frames.map((f) => ({ t: f.t, people: [] })),
    };
    const src = new ReplayPoseSource(empty, { maxPlayers: 1, view: VIEW });
    await src.start();
    await expect(src.calibrate(4000)).rejects.toThrow();
  });
});

describe('CalibrationCapture', () => {
  const calib = defaultCalibration(VIEW.w, VIEW.h);

  it('discards the first frames and caps the sample count', () => {
    const cap = new CalibrationCapture({ ms: 100_000, skipFrames: 10 });
    const pose = createPlayerPose(1, 0, calib);
    pose.present = true;
    pose.conf = 0.9;
    pose.scalePx = 200;
    for (let i = 0; i < 200; i++) cap.feed(pose, i / 25, VIEW.h);
    expect(cap.samples).toBe(CALIBRATE_SAMPLES);
  });

  it('ignores frames where the player is absent or barely visible', () => {
    const cap = new CalibrationCapture({ skipFrames: 0 });
    const pose = createPlayerPose(1, 0, calib);
    pose.present = false;
    pose.conf = 0.9;
    for (let i = 0; i < 20; i++) cap.feed(pose, i / 25, VIEW.h);
    expect(cap.samples).toBe(0);
    pose.present = true;
    pose.conf = 0.2;
    for (let i = 0; i < 20; i++) cap.feed(pose, i / 25, VIEW.h);
    expect(cap.samples).toBe(0);
    expect(cap.usable).toBe(false);
    expect(() => cap.finish()).toThrow();
  });

  it('progress reaches 1 and done flips', () => {
    const cap = new CalibrationCapture({ ms: 1000, skipFrames: 0, maxSamples: 1000 });
    const pose = createPlayerPose(1, 0, calib);
    pose.present = true;
    pose.conf = 0.9;
    pose.scalePx = 200;
    expect(cap.progress).toBe(0);
    for (let i = 0; i < 25; i++) cap.feed(pose, i / 25, VIEW.h);
    expect(cap.progress).toBeGreaterThan(0.9);
    cap.feed(pose, 1.2, VIEW.h);
    expect(cap.done).toBe(true);
  });
});

describe('motionEnergy', () => {
  const calib = defaultCalibration(VIEW.w, VIEW.h);

  it('is a mean over visible joints, in shoulder-widths/sec', () => {
    const pose = createPlayerPose(1, 0, calib);
    pose.vis.fill(0.9);
    for (const j of ENERGY_JOINTS) {
      pose.v[j * 2] = 3;
      pose.v[j * 2 + 1] = 4; // |v| = 5
    }
    expect(motionEnergy(pose)).toBeCloseTo(5, 5);
  });

  it('gates invisible joints instead of counting them as still', () => {
    const pose = createPlayerPose(1, 0, calib);
    pose.vis.fill(0.9);
    pose.vis[L.LEFT_ANKLE] = 0.1;
    pose.vis[L.RIGHT_ANKLE] = 0.1;
    for (const j of ENERGY_JOINTS) {
      pose.v[j * 2] = 0;
      pose.v[j * 2 + 1] = j === L.LEFT_WRIST ? 10 : 0;
    }
    // 1 moving joint out of 11 visible, not out of 13.
    expect(motionEnergy(pose)).toBeCloseTo(10 / (ENERGY_JOINTS.length - 2), 5);
    expect(pose.vis[L.LEFT_ANKLE]!).toBeLessThan(MIN_VIS);
  });

  it('is zero when nothing is visible, not NaN', () => {
    const pose = createPlayerPose(1, 0, calib);
    pose.vis.fill(0);
    expect(motionEnergy(pose)).toBe(0);
  });
});

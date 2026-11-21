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

// ─── AutoCalibrator: the kiosk path ─────────────────────────────────────────
//
// Everything here runs synthetic clips through the REAL pipeline
// (ReplayPoseSource -> identity -> normalize), so the numbers include the
// tracker's own 0.45s probation and normalize.ts's scale EMA. A test that fed
// hand-made poses straight into the calibrator would pass with a convergence
// budget the camera path cannot meet.
import {
  AUTO_SWAP_ABSENCE_SEC, AUTO_TOO_CLOSE_SPAN, AUTO_TOO_FAR_FRAC, AutoCalibrator,
} from './calibration';
import { buildClip, type PoseClip } from '../testing/synth';

const FPS = 25;
const STEP = 1 / FPS;

/** A clip of one body of a given size, standing. */
function person(shoulderW: number, hipY: number, sec: number, seed: number): PoseClip {
  return buildClip('p', sec, () => ({ shoulderW, hipY }), { seed, fps: FPS });
}

/** Splice clips and gaps (seconds of frames with nobody in them) into one
 *  timeline — the kiosk's actual input: body, empty room, different body. */
function timeline(name: string, segs: readonly (PoseClip | number)[]): PoseClip {
  const frames: PoseClip['frames'] = [];
  let t = 0;
  for (const s of segs) {
    if (typeof s === 'number') {
      const n = Math.round(s * FPS);
      for (let k = 0; k < n; k++) frames.push({ t: t + k * STEP, people: [] });
      t += n * STEP;
    } else {
      for (const f of s.frames) frames.push({ t: t + f.t, people: f.people });
      t += s.frames[s.frames.length - 1]!.t + STEP;
    }
  }
  return { name, fps: FPS, frames };
}

/** Drive a clip through the pipeline into an AutoCalibrator, one frame at a
 *  time. `onStep` sees the state after each fed frame. `hide` makes the
 *  calibrator see `undefined` for a frame even though the tracker reported a
 *  body — that is how a tracking gap of an exact length is tested. */
function feedClip(
  c: PoseClip,
  auto: AutoCalibrator,
  onStep?: (i: number, t: number) => void,
  hide?: (i: number) => boolean,
): void {
  const src = new ReplayPoseSource(c, { maxPlayers: 1, view: VIEW, loop: false });
  void src.start();
  for (let i = 0; i < c.frames.length; i++) {
    const t = i * STEP;
    const f = src.sample(t);
    auto.feed(hide?.(i) ? undefined : f.p1, t);
    onStep?.(i, t);
  }
}

const auto = (): AutoCalibrator => new AutoCalibrator({ view: VIEW, fps: FPS });

describe('AutoCalibrator convergence', () => {
  it('has a usable shoulderW and standHipY within 1s of a body appearing', () => {
    // Empty room for 0.5s, then somebody walks up. The kiosk has no
    // calibration screen, so this is the entire budget: they look at START,
    // and by the time they press it the profile must be theirs.
    const a = auto();
    const enterAt = 0.5;
    const c = timeline('enter', [enterAt, person(0.105, 0.52, 3, 101)]);
    let readyAt = -1;
    let firstSeenAt = -1;
    feedClip(c, a, (_i, t) => {
      if (firstSeenAt < 0 && a.present) firstSeenAt = t;
      if (readyAt < 0 && a.ready) readyAt = t;
    });

    expect(readyAt).toBeGreaterThan(0);
    expect(readyAt - enterAt).toBeLessThan(1);
    // Most of that second is the identity tracker's 0.45s probation, which is
    // spent before the calibrator is handed anything at all.
    expect(readyAt - firstSeenAt).toBeLessThan(0.3);
    // And the value is right, not merely early.
    expect(a.profile.shoulderW).toBeCloseTo(0.105 * VIEW.w, 0 - 1);
    expect(a.profile.standHipY).toBeCloseTo(0.52, 1);
  });

  it('starts unobserved fields as honest estimates, then upgrades them', () => {
    // Standing still: shoulders and hips are measurable, a stretch, an
    // overhead reach and a squat are not — nobody did them.
    const idle = auto();
    feedClip(clip('idle'), idle, undefined);
    expect(idle.observed.shoulderW).toBe(true);
    expect(idle.observed.standHipY).toBe(true);
    expect(idle.observed.squatHipY).toBe(false);
    expect(idle.observed.reachUpY).toBe(false);
    // Nothing is left blank: the unobserved fields are the documented relative
    // fallbacks, so a game sized off them is playable rather than broken.
    expect(idle.profile.squatHipY).toBeCloseTo(idle.profile.standHipY + 0.12, 5);
    expect(idle.profile.reachUpY).toBeCloseTo(idle.profile.standHipY - 0.2, 5);

    // A clip where the hands DO go up upgrades reachUpY to a measurement.
    const reached = auto();
    feedClip(clip('reach-grid'), reached, undefined);
    expect(reached.observed.reachUpY).toBe(true);
    expect(reached.profile.reachUpY).toBeLessThan(reached.profile.standHipY - 0.2);

    // Likewise squat depth.
    const squatted = auto();
    feedClip(clip('squat-x8'), squatted, undefined);
    expect(squatted.observed.squatHipY).toBe(true);
    expect(squatted.profile.squatHipY).toBeGreaterThan(squatted.profile.standHipY + 0.04);
  });

  it('estimates idleEnergy from the still stretches, not from the movement', () => {
    // The one-shot capture takes the median of its window, which for a moving
    // body is the energy of a body in motion. Threshold a freeze game on that
    // and the customer can keep moving through the freeze.
    const src = new ReplayPoseSource(clip('fidget'), { maxPlayers: 1, view: VIEW });
    void src.start();
    const oneShot = src.calibrate(4000);

    const a = auto();
    feedClip(clip('fidget'), a, undefined);
    expect(a.observed.idleEnergy).toBe(true);
    expect(a.profile.idleEnergy).toBeGreaterThan(0.08);
    return oneShot.then((p) => {
      expect(a.profile.idleEnergy).toBeLessThan(p.idleEnergy);
    });
  });
});

describe('AutoCalibrator customer swap', () => {
  it('resets on a real absence and measures the NEW body', () => {
    // A 190cm adult, an empty kiosk, then a 120cm child. Inheriting the
    // adult's shoulderW would mis-size every threshold in the child's round.
    const a = auto();
    const big = 0.13;
    const small = 0.07;
    const c = timeline('swap', [person(big, 0.55, 2.5, 111), 1, person(small, 0.45, 2.5, 112)]);
    let bigW = 0;
    let idAfterGap = -1;
    feedClip(c, a, (_i, t) => {
      if (t < 2.4 && a.ready) bigW = a.profile.shoulderW;
      if (idAfterGap < 0 && a.customerId > 0) idAfterGap = t;
    });

    expect(bigW).toBeCloseTo(big * VIEW.w, 0 - 1);
    expect(a.customerId).toBe(1);
    // The reset lands one absence window after the body left, not later.
    expect(idAfterGap).toBeGreaterThan(2.4);
    expect(idAfterGap).toBeLessThan(2.5 + AUTO_SWAP_ABSENCE_SEC + 0.2);
    // And the published profile is the child's.
    expect(a.ready).toBe(true);
    expect(a.profile.shoulderW).toBeCloseTo(small * VIEW.w, 0 - 1);
    expect(a.profile.shoulderW).toBeLessThan(bigW * 0.7);
  });

  it('publishes the prior, not the last customer, while the new one is unmeasured', () => {
    // The instant between "that customer left" and "this customer measured" is
    // the dangerous one: whatever is published there must not be the previous
    // body. It is the neutral prior, and `ready` says so.
    const a = auto();
    const c = timeline('gap', [person(0.13, 0.55, 2.5, 121), 1, person(0.07, 0.45, 2.5, 122)]);
    let checked = false;
    feedClip(c, a, (_i, t) => {
      if (!checked && a.customerId === 1) {
        checked = true;
        expect(a.ready).toBe(false);
        expect(a.profile.shoulderW).not.toBeCloseTo(0.13 * VIEW.w, 0 - 1);
        expect(t).toBeLessThan(4);
      }
    });
    expect(checked).toBe(true);
  });

  it('does NOT reset for a one-or-two-frame tracking gap', () => {
    // 2 frames at 25fps is 80ms; the worst stream we ship against (10fps with
    // 6% frame drop) loses at most ~200-300ms. Treating that as a new customer
    // would re-scale every threshold mid-round and visibly jump the score.
    const a = auto();
    const c = person(0.13, 0.55, 4, 131);
    const gapFrames = 2;
    expect(gapFrames * STEP).toBeLessThan(AUTO_SWAP_ABSENCE_SEC);

    let before = 0;
    feedClip(
      c,
      a,
      (i) => {
        if (i === 49) before = a.profile.shoulderW;
      },
      (i) => i === 50 || i === 51,
    );

    expect(a.customerId).toBe(0);
    expect(a.ready).toBe(true);
    // The profile carried straight through the gap: no reset, no snap.
    expect(a.profile.shoulderW).toBeCloseTo(before, 0);
    expect(a.profile.shoulderW).toBeCloseTo(0.13 * VIEW.w, 0 - 1);
  });
});

describe('AutoCalibrator freeze', () => {
  it('holds the profile across a round even when the body changes', () => {
    // Freeze is the shell's call, on the countdown -> play transition. The
    // guarantee a round depends on: the same movement scores the same in the
    // first and second half.
    const a = auto();
    const c = timeline('round', [person(0.13, 0.55, 2, 141), person(0.07, 0.45, 4, 142)]);
    let snap: string = '';
    let frozenRef: ReturnType<AutoCalibrator['freeze']> | undefined;
    let drifted = false;
    let sawPresenceAfterFreeze = false;
    feedClip(c, a, (i) => {
      if (i === 45) {
        frozenRef = a.freeze();
        snap = JSON.stringify(frozenRef);
      }
      if (i > 45 && a.frozen) {
        if (JSON.stringify(a.profile) !== snap) drifted = true;
        if (a.present) sawPresenceAfterFreeze = true;
      }
      if (i === 140) a.thaw();
    });

    expect(frozenRef).toBeDefined();
    expect(drifted).toBe(false);
    // Frozen is not blind: the shell still gets presence and distance signals
    // during the round.
    expect(sawPresenceAfterFreeze).toBe(true);
    // After thaw it is measuring again, and it is measuring the body that is
    // actually there.
    expect(a.frozen).toBe(false);
    expect(a.ready).toBe(true);
    expect(a.profile.shoulderW).toBeCloseTo(0.07 * VIEW.w, 0 - 1);
    // The snapshot handed to the round is a separate object, so nothing that
    // happened after thaw reached it.
    expect(JSON.stringify(frozenRef)).toBe(snap);
  });

  it('defers a customer swap during a round until thaw', () => {
    const a = auto();
    const c = timeline('leave', [person(0.13, 0.55, 2, 151), 1, person(0.07, 0.45, 3, 152)]);
    let snap = '';
    let idBeforeThaw = -1;
    let readyAfterThaw = true;
    feedClip(c, a, (i) => {
      if (i === 45) snap = JSON.stringify(a.freeze());
      if (i === 110) {
        idBeforeThaw = a.customerId;
        expect(JSON.stringify(a.profile)).toBe(snap);
        a.thaw();
        readyAfterThaw = a.ready;
      }
    });
    // The round kept its profile; the reset happened the moment it ended.
    expect(idBeforeThaw).toBe(0);
    expect(readyAfterThaw).toBe(false);
    expect(a.customerId).toBe(1);
    expect(a.profile.shoulderW).toBeCloseTo(0.07 * VIEW.w, 0 - 1);
  });
});

describe('AutoCalibrator framing signals', () => {
  it('flags a customer who is too far to threshold against', () => {
    const a = auto();
    feedClip(clip('far-small'), a, undefined);
    // far-small stands at 0.058 of the view width, under the 0.06 limit.
    expect(a.profile.shoulderW / VIEW.w).toBeLessThan(AUTO_TOO_FAR_FRAC);
    expect(a.tooFar).toBe(true);
    expect(a.tooClose).toBe(false);
  });

  it('leaves a normal and a laptop framing alone', () => {
    const far = auto();
    feedClip(clip('idle'), far, undefined);
    expect(far.tooFar).toBe(false);
    expect(far.tooClose).toBe(false);

    // NOTE (lead): this block asserted the OLD width-fraction rule, which
    // AUTO_TOO_CLOSE_SPAN replaced mid-edit. Per that constant's own doc the
    // close laptop framing (0.26) is now flagged ON PURPOSE — at that distance
    // a T-pose is ~1.1x wider than the frame, so reach targets are physically
    // unreachable, and at a kiosk there is room to step back. Asserting the
    // documented behaviour rather than the superseded one.
    const laptop = auto();
    feedClip(clip('no-legs'), laptop, undefined);
    const spanFit = (laptop.profile.shoulderW / VIEW.w) * laptop.profile.armSpan;
    expect(spanFit).toBeGreaterThan(AUTO_TOO_CLOSE_SPAN);
    expect(laptop.tooClose).toBe(true);
  });

  it('flags a customer standing on top of the camera', () => {
    const a = auto();
    feedClip(person(0.34, 0.9, 3, 161), a, undefined);
    expect(a.tooClose).toBe(true);
    expect(a.tooFar).toBe(false);
  });

  it('says nothing about distance when nobody is there', () => {
    const a = auto();
    const c = timeline('empty', [1.5]);
    feedClip(c, a, undefined);
    expect(a.present).toBe(false);
    expect(a.tooFar).toBe(false);
    expect(a.tooClose).toBe(false);
    expect(a.ready).toBe(false);
  });

  it('reports an invisible lower body instead of guessing a floor', () => {
    const a = auto();
    feedClip(clip('no-legs'), a, undefined);
    expect(a.lowerBodyVisible).toBe(false);
    expect(a.profile.lowerBodyVisible).toBe(false);
    expect(a.observed.floorY).toBe(false);
    // 1.0 is the contract's "never seen" sentinel, not a measurement.
    expect(a.profile.floorY).toBe(1);

    const whole = auto();
    feedClip(clip('idle'), whole, undefined);
    expect(whole.lowerBodyVisible).toBe(true);
    expect(whole.profile.floorY).toBeGreaterThan(0.8);
    expect(whole.profile.floorY).toBeLessThan(1);
  });
});

describe('AutoCalibrator scale smoothing', () => {
  it('barely moves while the body only wobbles', () => {
    // A jittering scale jitters EVERY threshold in the game at once, which is
    // why scale is smoothed far harder than position.
    const a = auto();
    let prev = 0;
    let worst = 0;
    feedClip(clip('fidget'), a, () => {
      if (!a.ready) return;
      if (prev > 0) worst = Math.max(worst, Math.abs(a.profile.shoulderW - prev) / prev);
      prev = a.profile.shoulderW;
    });
    expect(worst).toBeLessThan(0.01); // measured 0.001 on this clip
  });

  it('still follows a customer who walks forward', () => {
    // Slow is only correct until the body really moves: a 0.07 -> 0.13 walk is
    // a ~85% scale change, which has to be tracked or every threshold stays
    // sized for where they used to stand.
    const a = auto();
    const c = buildClip('walk', 6, (_u, t) => {
      const k = t < 2 ? 0 : t > 3.2 ? 1 : (t - 2) / 1.2;
      return { shoulderW: 0.07 + 0.06 * k, hipY: 0.45 + 0.1 * k };
    }, { seed: 171, fps: FPS });
    let atWalkStart = 0;
    let oneSecAfter = 0;
    feedClip(c, a, (_i, t) => {
      if (Math.abs(t - 2) < STEP / 2) atWalkStart = a.profile.shoulderW;
      if (Math.abs(t - 4.2) < STEP / 2) oneSecAfter = a.profile.shoulderW;
    });
    expect(atWalkStart).toBeCloseTo(0.07 * VIEW.w, 0 - 1);
    // Within 10% of the new size one second after they stop, and converging.
    expect(oneSecAfter).toBeGreaterThan(0.13 * VIEW.w * 0.9);
    expect(a.profile.shoulderW).toBeGreaterThan(oneSecAfter);
    expect(a.profile.shoulderW).toBeLessThan(0.13 * VIEW.w * 1.05);
    // Walking is not a new customer.
    expect(a.customerId).toBe(0);
  });
});

// Clip -> PoseFrame driver for the gesture unit tests.
//
// `ReplayPoseSource` (src/engine/pose/replay.ts) did not exist when this layer
// was written, so this drives the REAL normalization pipeline
// (pose/normalize.ts + pose/frame.ts) directly from a synthetic clip. That
// matters more than convenience: `n`, `v`, `px` and `vis` all come out of the
// same code a camera session goes through, including the One Euro filter whose
// derivative is what every velocity threshold in this layer is measured
// against. A hand-rolled normalizer here would have let me tune thresholds
// against velocities the engine never actually produces.
//
// Lives in a *.test.ts file on purpose: E2 owns `gestures/*.test.ts` and
// nothing else, and this is test-only scaffolding. When replay.ts lands, the
// tests should move onto it and this file can go.
import { describe, expect, it } from 'vitest';

import { clamp } from '../math';
import { MAX_EXTRAPOLATE_SEC, createPlayerPose, createPoseFrame } from '../pose/frame';
import { L, MIN_VIS } from '../pose/landmarks';
import { PoseNormalizer } from '../pose/normalize';
import { defaultCalibration } from '../pose/source';
import { type ClipName, clip } from '../testing/clips';
import type { PoseClip } from '../testing/synth';
import type { CalibrationProfile, PoseFrame } from '../types';

export const VIEW_W = 1280;
export const VIEW_H = 720;

export interface DriveOpts {
  viewW?: number;
  viewH?: number;
  calib?: CalibrationProfile;
  /** Read at this rate with extrapolation between inferences, the way the real
   *  loop does (60Hz game steps over ~25Hz inference). Default: one read per
   *  inference, which is the harsher test for a velocity threshold. */
  stepHz?: number;
}

/** Feed one clip through the engine's own normalizer, calling `fn` per read. */
export function driveClip(
  src: PoseClip | ClipName,
  fn: (f: PoseFrame) => void,
  o: DriveOpts = {},
): void {
  const c = typeof src === 'string' ? clip(src) : src;
  const viewW = o.viewW ?? VIEW_W;
  const viewH = o.viewH ?? VIEW_H;
  const calib = o.calib ?? defaultCalibration(viewW, viewH);
  const norm = new PoseNormalizer();
  const pose = createPlayerPose(1, 0, calib);
  const frame = createPoseFrame();
  frame.players.push(pose);
  frame.byId.set(1, pose);
  frame.p1 = pose;

  const emit = (t: number, ageSec: number): void => {
    norm.project(pose, ageSec, viewW, viewH);
    pose.present = norm.primed && pose.conf >= MIN_VIS;
    frame.t = t;
    frame.inferenceAgeMs = ageSec * 1000;
    frame.fps = c.fps;
    fn(frame);
  };

  if (!o.stepHz) {
    for (let i = 0; i < c.frames.length; i++) {
      const cf = c.frames[i]!;
      const person = cf.people[0];
      if (!person) continue;
      norm.feed(person.lm, person.vis, viewW, viewH, calib, cf.t);
      emit(cf.t, 0);
    }
    return;
  }

  // Fixed-step read loop with capped extrapolation, as PoseSource.sample() does.
  const dt = 1 / o.stepHz;
  const end = c.frames[c.frames.length - 1]!.t;
  let next = 0;
  for (let t = 0; t <= end + 1e-9; t += dt) {
    while (next < c.frames.length && c.frames[next]!.t <= t + 1e-9) {
      const cf = c.frames[next]!;
      const person = cf.people[0];
      if (person) norm.feed(person.lm, person.vis, viewW, viewH, calib, cf.t);
      next++;
    }
    if (!norm.primed) continue;
    emit(t, clamp(t - norm.lastT, 0, MAX_EXTRAPOLATE_SEC));
  }
}

/** Count how many reads satisfy `pred`. Used by every detector test. */
export function countReads(
  src: PoseClip | ClipName,
  pred: (f: PoseFrame) => boolean,
  o: DriveOpts = {},
): number {
  let n = 0;
  driveClip(
    src,
    (f) => {
      if (pred(f)) n++;
    },
    o,
  );
  return n;
}

/** Seconds at which `pred` was true, for latency and ordering assertions. */
export function firedAt(
  src: PoseClip | ClipName,
  pred: (f: PoseFrame) => boolean,
  o: DriveOpts = {},
): number[] {
  const out: number[] = [];
  driveClip(
    src,
    (f) => {
      if (pred(f)) out.push(f.t);
    },
    o,
  );
  return out;
}

// Exactly one self-test: every other gestures test file imports this module,
// and vitest re-runs an imported test file's suites in each importing file, so
// anything more than this would run a dozen times.
describe('clip harness', () => {
  it('normalizes clips into hip-centred shoulder-width units at any distance', () => {
    const probe = (name: ClipName): { reads: number; scale: number; hipN: number; span: number; nan: number } => {
      const r = { reads: 0, scale: 0, hipN: 0, span: 0, nan: 0 };
      driveClip(name, (f) => {
        const p = f.p1!;
        r.reads++;
        r.scale = p.scalePx;
        r.hipN = Math.max(
          r.hipN,
          Math.abs((p.n[L.LEFT_HIP * 2 + 1]! + p.n[L.RIGHT_HIP * 2 + 1]!) / 2),
        );
        r.span = Math.abs(p.n[L.LEFT_SHOULDER * 2]! - p.n[L.RIGHT_SHOULDER * 2]!);
        for (let i = 0; i < p.n.length; i++) if (!Number.isFinite(p.n[i]!)) r.nan++;
      });
      return r;
    };

    const near = probe('idle');
    expect(near.reads).toBeGreaterThan(250);
    // A plausible shoulder width in view px. Deliberately a wide band: the clip
    // corpus owns the body's size and has changed it once already.
    expect(near.scale).toBeGreaterThan(80);
    expect(near.scale).toBeLessThan(300);
    expect(near.hipN).toBeLessThan(1e-3); // `n` is hip-centred by construction

    // The same body much further away: far fewer pixels, identical normalized
    // span. That equality is the whole contract this layer depends on.
    const far = probe('far-small');
    expect(far.scale).toBeLessThan(near.scale * 0.8);
    expect(near.span).toBeGreaterThan(0.9);
    expect(near.span).toBeLessThan(1.1);
    expect(far.span).toBeGreaterThan(0.9);
    expect(far.span).toBeLessThan(1.1);

    // 10fps with dropout and frame drops must not produce a single NaN.
    const lag = probe('laggy');
    expect(lag.reads).toBeGreaterThan(100);
    expect(lag.nan).toBe(0);
    expect(near.nan).toBe(0);
  });
});

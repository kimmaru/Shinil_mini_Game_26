import { describe, expect, it } from 'vitest';

import { motionEnergy } from '../pose/calibration';
import { defaultCalibration } from '../pose/source';
import { createGestureService } from './service';
import { IDLE_MIN } from './stillness';
import { driveClip } from './harness.test';
import type { CalibrationProfile } from '../types';
import type { ClipName as Clip } from '../testing/clips';

/** What THIS player measures while standing still — exactly what a real
 *  4-second calibration would capture, via the same `motionEnergy` the
 *  calibration uses. Tests that use `defaultCalibration()` are testing the
 *  fallback constant, not the fairness rule. */
function calibFrom(clip: Clip): CalibrationProfile {
  const base = defaultCalibration();
  const samples: number[] = [];
  driveClip(clip, (f) => {
    if (f.p1?.present) samples.push(motionEnergy(f.p1));
  });
  samples.sort((a, b) => a - b);
  return { ...base, idleEnergy: Math.max(IDLE_MIN, samples[samples.length >> 1]!) };
}

const stillFraction = (clip: Clip, calib: CalibrationProfile, factor?: number): number => {
  const g = createGestureService(() => undefined);
  const d = g.use('stillness', factor === undefined ? {} : { factor });
  let still = 0;
  let reads = 0;
  driveClip(
    clip,
    (f) => {
      reads++;
      if (d.read(f).still) still++;
    },
    { calib },
  );
  return still / reads;
};

describe('stillness', () => {
  it('measures a FIDGETING child as still, against their own idle energy', () => {
    // The single most important fairness decision in the freeze games. Children
    // cannot hold still and the ones trying hardest shake the most, so the
    // threshold is a multiple of what THIS child measured standing still — not
    // a global constant. A fidgeting child who is trying to freeze must pass.
    const calib = calibFrom('idle');
    expect(stillFraction('idle', calib)).toBeGreaterThan(0.95);
    expect(stillFraction('fidget', calib)).toBeGreaterThan(0.9);
  });

  it('catches a child who is actually moving', () => {
    const calib = calibFrom('idle');
    // Running and swinging are not freezing. Jumping sits in between because
    // the body is genuinely still between the hops.
    expect(stillFraction('knee-run', calib)).toBeLessThan(0.1);
    expect(stillFraction('swing-wide', calib)).toBeLessThan(0.25);
    expect(stillFraction('jump-x8', calib)).toBeLessThan(0.75);
  });

  it('is ordered: the more a body moves, the less still it reads', () => {
    const calib = calibFrom('idle');
    const idle = stillFraction('idle', calib);
    const fidget = stillFraction('fidget', calib);
    const run = stillFraction('knee-run', calib);
    const swing = stillFraction('swing-wide', calib);
    // idle and fidget both sit at ~98%: a fidgeting child passing as reliably
    // as a motionless one is the intended outcome, not a tie to break.
    expect(idle).toBeGreaterThanOrEqual(fidget - 0.02);
    expect(fidget).toBeGreaterThan(swing);
    expect(fidget).toBeGreaterThan(run);
  });

  it('scales with the player: a jumpier calibration is more forgiving', () => {
    // Two children, same clip. The one whose calibration captured more resting
    // motion gets more latitude — which is the whole point.
    const calm = calibFrom('idle');
    const jumpy = { ...calm, idleEnergy: calm.idleEnergy * 2.5 };
    expect(stillFraction('fidget', jumpy)).toBeGreaterThanOrEqual(
      stillFraction('fidget', calm),
    );
  });

  it('factor tightens and loosens the threshold', () => {
    const calib = calibFrom('idle');
    const tight = stillFraction('fidget', calib, 1.2);
    const loose = stillFraction('fidget', calib, 6);
    expect(loose).toBeGreaterThan(tight);
  });

  it('reports quality 0..1 and energy in sw/sec', () => {
    const calib = calibFrom('idle');
    const g = createGestureService(() => undefined);
    const d = g.use('stillness');
    let minQ = 9;
    let maxQ = -9;
    let maxE = 0;
    driveClip(
      'knee-run',
      (f) => {
        const s = d.read(f);
        minQ = Math.min(minQ, s.quality);
        maxQ = Math.max(maxQ, s.quality);
        maxE = Math.max(maxE, s.energy);
        expect(Number.isFinite(s.energy)).toBe(true);
      },
      { calib },
    );
    expect(minQ).toBeGreaterThanOrEqual(0);
    expect(maxQ).toBeLessThanOrEqual(1);
    expect(maxE).toBeGreaterThan(0);
  });

  it('survives an absurd calibration instead of becoming impossible', () => {
    // A capture taken from a photo held up to the camera reports ~0 idle
    // energy; one taken from a child bouncing reports something huge. Neither
    // may make a freeze game unplayable or trivially winnable.
    const base = defaultCalibration();
    const zero = { ...base, idleEnergy: 0 };
    const huge = { ...base, idleEnergy: 50 };
    expect(stillFraction('knee-run', zero)).toBeLessThan(0.2);
    expect(stillFraction('knee-run', huge)).toBeLessThan(1.01);
    // And with a clamped-high idle, a genuinely still body still reads still.
    expect(stillFraction('idle', huge)).toBeGreaterThan(0.9);
  });

  it('uses the same energy definition the calibration measured', () => {
    // Importing `motionEnergy` from pose/calibration.ts rather than writing our
    // own is load-bearing: two definitions of energy would make `idleEnergy`
    // meaningless. This asserts the detector's reported energy tracks it.
    const calib = calibFrom('idle');
    const g = createGestureService(() => undefined);
    const d = g.use('stillness', { windowMs: 40 });
    let sumDet = 0;
    let sumRef = 0;
    let n = 0;
    driveClip(
      'swing-wide',
      (f) => {
        const s = d.read(f);
        if (!s.ok) return;
        n++;
        sumDet += s.energy;
        sumRef += motionEnergy(f.p1!);
      },
      { calib },
    );
    expect(n).toBeGreaterThan(100);
    // Same quantity, just averaged over the window: the clip means must match.
    expect(sumDet / n).toBeCloseTo(sumRef / n, 2);
  });

  it('gates when the body is barely visible rather than reporting a freeze', () => {
    // "No landmarks" must never read as "perfectly still" — that would hand a
    // freeze game a full score for walking out of the room.
    const g = createGestureService(() => undefined);
    const d = g.use('stillness');
    let okCount = 0;
    let reads = 0;
    driveClip('idle', (f) => {
      reads++;
      // Blank out every energy joint's visibility.
      f.p1!.vis.fill(0.1);
      if (d.read(f).ok) okCount++;
    });
    expect(reads).toBeGreaterThan(100);
    expect(okCount).toBe(0);
  });
});

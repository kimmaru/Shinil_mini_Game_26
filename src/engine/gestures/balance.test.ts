import { describe, expect, it } from 'vitest';

import { armsAt, buildClip, osc } from '../testing/synth';
import { createGestureService } from './service';
import { driveClip } from './harness.test';
import type { ClipName } from '../testing/clips';

const onFootFraction = (clip: ClipName | ReturnType<typeof buildClip>, opts?: object): number => {
  const g = createGestureService(() => undefined);
  const d = g.use('balance', opts as never);
  let on = 0;
  let reads = 0;
  driveClip(clip, (f) => {
    reads++;
    if (d.read(f).onOneFoot) on++;
  });
  return on / reads;
};

describe('balance', () => {
  it('detects the one-leg pose in hold-poses and nothing else in it', () => {
    // `hold-poses` is 6 poses of 4s each; the 4th (t 12-16) lifts one foot, and
    // the following segment spends its first second lerping that foot back down
    // — during which the foot genuinely IS still off the floor, so the window
    // runs to 17.
    const g = createGestureService(() => undefined);
    const d = g.use('balance');
    let inPose = 0;
    let outside = 0;
    driveClip('hold-poses', (f) => {
      if (!d.read(f).onOneFoot) return;
      if (f.t >= 12 && f.t < 17) inPose++;
      else outside++;
    });
    expect(inPose).toBeGreaterThan(40); // most of a 3s hold at 25fps
    expect(outside).toBeLessThan(10);
  });

  it('a SQUAT is not a one-leg stand', () => {
    // The bug this test exists for: with the knees cropped at the bottom of a
    // deep squat, normalize.ts holds their last position for 0.3s while the hip
    // keeps descending, so a hip-to-knee distance collapses by a third of a
    // shoulder width and reads as a lifted knee. Comparing the two knees to
    // EACH OTHER cancels whole-body motion exactly.
    expect(onFootFraction('squat-x8')).toBeLessThan(0.05);
  });

  it('standing, fidgeting and walking are not one-leg stands', () => {
    expect(onFootFraction('idle')).toBe(0);
    expect(onFootFraction('fidget')).toBe(0);
    expect(onFootFraction('step-lr')).toBeLessThan(0.05);
    expect(onFootFraction('reach-grid')).toBeLessThan(0.05);
  });

  it('honours a requested foot', () => {
    // The one-leg pose in `hold-poses` lifts the subject's LEFT foot.
    expect(onFootFraction('hold-poses', { foot: 'L' })).toBeGreaterThan(0.1);
    expect(onFootFraction('hold-poses', { foot: 'R' })).toBeLessThan(0.02);
  });

  it('liftAt tunes how high the foot must come', () => {
    const easy = onFootFraction('hold-poses', { liftAt: 0.2 });
    const hard = onFootFraction('hold-poses', { liftAt: 1.4 });
    expect(easy).toBeGreaterThan(hard);
    expect(hard).toBe(0);
  });

  it('works with the feet cropped out of frame, via the knees', () => {
    // The laptop user: no ankles at all. A knee lift must still register, or
    // three balance games are unplayable for anyone close to their screen.
    // Framed so the ankles fall below the bottom of the image while the knees
    // stay in it — the actual laptop framing, not a synthetic flag.
    const kneeStand = buildClip(
      'knee-stand',
      8,
      (_u, t) => ({
        shoulderW: 0.16,
        hipY: 0.6,
        ...(t > 2 ? { legL: -34, kneeL: 70 } : {}),
      }),
      { seed: 81 },
    );
    const g = createGestureService(() => undefined);
    const d = g.use('balance');
    let before = 0;
    let after = 0;
    let okAfter = false;
    driveClip(kneeStand, (f) => {
      const s = d.read(f);
      if (f.t < 1.8) {
        if (s.onOneFoot) before++;
      } else if (f.t > 2.5) {
        if (s.onOneFoot) after++;
        okAfter = okAfter || s.ok;
      }
    });
    expect(before).toBe(0);
    expect(okAfter).toBe(true);
    expect(after).toBeGreaterThan(20);
  });

  it('reports sway and a quality that falls as the body wobbles', () => {
    const steady = buildClip('steady', 8, () => ({ ...armsAt(0), footLiftL: 1, legR: -90 }), {
      seed: 82,
    });
    const wobbly = buildClip(
      'wobbly',
      8,
      (_u, t) => ({
        ...armsAt(0),
        footLiftL: 1,
        legR: -90,
        hipX: 0.5 + 0.045 * Math.sin(t * 7),
        leanDeg: 9 * Math.sin(t * 6),
      }),
      { seed: 83 },
    );
    const quality = (c: ReturnType<typeof buildClip>): { q: number; sway: number } => {
      const g = createGestureService(() => undefined);
      const d = g.use('balance');
      let qs = 0;
      let sw = 0;
      let n = 0;
      driveClip(c, (f) => {
        const s = d.read(f);
        if (!s.onOneFoot || f.t < 2) return;
        qs += s.quality;
        sw += s.sway;
        n++;
      });
      return { q: n ? qs / n : 0, sway: n ? sw / n : 0 };
    };
    const a = quality(steady);
    const b = quality(wobbly);
    expect(a.q).toBeGreaterThan(b.q);
    expect(b.sway).toBeGreaterThan(a.sway);
    expect(a.q).toBeLessThanOrEqual(1);
    expect(b.q).toBeGreaterThanOrEqual(0);
  });

  it('accumulates heldMs while the stand lasts and resets when it breaks', () => {
    const onOff = buildClip(
      'on-off',
      12,
      (_u, t) =>
        osc(t, 1 / 6) > 0.5
          ? { ...armsAt(0), footLiftL: 1, legR: -90 }
          : { ...armsAt(0) },
      { seed: 84 },
    );
    const g = createGestureService(() => undefined);
    const d = g.use('balance');
    let maxHeld = 0;
    let sawReset = false;
    let prev = 0;
    driveClip(onOff, (f) => {
      const s = d.read(f);
      maxHeld = Math.max(maxHeld, s.heldMs);
      if (prev > 500 && s.heldMs === 0) sawReset = true;
      prev = s.heldMs;
    });
    expect(maxHeld).toBeGreaterThan(1000);
    expect(sawReset).toBe(true);
  });

  it('gates rather than guessing when no legs are visible at all', () => {
    const g = createGestureService(() => undefined);
    const d = g.use('balance');
    let anyOk = false;
    let anyOn = false;
    driveClip('no-legs', (f) => {
      const s = d.read(f);
      anyOk = anyOk || s.ok;
      anyOn = anyOn || s.onOneFoot;
    });
    expect(anyOk).toBe(false);
    expect(anyOn).toBe(false);
  });
});

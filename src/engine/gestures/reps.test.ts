import { describe, expect, it } from 'vitest';

import { L } from '../pose/landmarks';
import { buildClip, kneeUp, osc } from '../testing/synth';
import { createGestureService } from './service';
import { kneeLift } from './reps';
import { driveClip } from './harness.test';
import type { PlayerPose } from '../types';

const REP = { signal: (p: PlayerPose) => kneeLift(p, 'L'), enter: 0.22, exit: 0.1 } as const;

/** A run-in-place at an exact cadence, so the expected count is arithmetic. */
const runClip = (hz: number, sec: number): ReturnType<typeof buildClip> =>
  buildClip(`run-${hz}`, sec, (_u, t) => kneeUp('L', osc(t, hz)), { seed: 61, dropout: 0 });

describe('rep counter', () => {
  it('counts one rep per cycle at a known cadence', () => {
    // 1.2Hz for 10s = 12 cycles. The first cycle starts mid-rise (osc begins at
    // 0.5 and falling), so 11 or 12 is correct; nothing else is.
    const g = createGestureService(() => undefined);
    const d = g.use('rep', REP);
    let reps = 0;
    driveClip(runClip(1.2, 10), (f) => {
      reps = d.read(f).reps;
    });
    expect(reps).toBeGreaterThanOrEqual(11);
    expect(reps).toBeLessThanOrEqual(12);
  });

  it('counts on ONE edge — never two per cycle', () => {
    for (const hz of [0.8, 1.2, 1.8]) {
      const g = createGestureService(() => undefined);
      const d = g.use('rep', REP);
      let reps = 0;
      driveClip(runClip(hz, 10), (f) => {
        reps = d.read(f).reps;
      });
      const cycles = hz * 10;
      // Doubling would show up as 2x here; this is the whole point of the test.
      expect(reps, `${hz}Hz`).toBeLessThanOrEqual(Math.ceil(cycles) + 1);
      expect(reps, `${hz}Hz`).toBeGreaterThanOrEqual(Math.floor(cycles) - 1);
    }
  });

  it('loses nothing the signal itself does not lose', () => {
    // `knee-run` is a 2.2Hz sprint — 39.6 true cycles in 18s. The pose
    // pipeline's One Euro attenuates a limb moving that fast to ~63% of its
    // amplitude, so the scalar the game hands us crosses the thresholds fewer
    // times than the player's legs actually moved, before this detector sees
    // anything. What IS this detector's job is to lose nothing further, so the
    // assertion is the equality, not the absolute number.
    const g = createGestureService(() => undefined);
    const d = g.use('rep', { ...REP, needs: [L.LEFT_KNEE] });
    let reps = 0;
    let crossings = 0;
    let up = false;
    driveClip('knee-run', (f) => {
      const v = kneeLift(f.p1!, 'L');
      if (!up && v >= 0.22) {
        up = true;
        crossings++;
      } else if (up && v <= 0.1) up = false;
      reps = d.read(f).reps;
    });
    expect(crossings).toBeGreaterThan(20);
    // Never MORE than the signal crossed: that direction is double-counting,
    // and it is the bug that would silently double every score in a running
    // game. The reference counter here has no confirm frames and no refractory
    // period, so it also counts the occasional noise doublet that the detector
    // is right to reject — hence a small allowance downward, and none upward.
    expect(reps).toBeLessThanOrEqual(crossings);
    expect(reps).toBeGreaterThanOrEqual(crossings - 3);
  });

  it('counts nothing on idle or fidget', () => {
    for (const clip of ['idle', 'fidget'] as const) {
      const g = createGestureService(() => undefined);
      const d = g.use('rep', { ...REP, needs: [L.LEFT_KNEE] });
      let reps = 0;
      driveClip(clip, (f) => {
        reps = d.read(f).reps;
      });
      expect(reps, clip).toBe(0);
    }
  });

  it('is frame-rate independent', () => {
    // Same motion at 10fps and 30fps must count the same cycles.
    const counts = [10, 30].map((fps) => {
      const c = buildClip('r', 10, (_u, t) => kneeUp('L', osc(t, 1.2)), {
        seed: 61,
        fps,
        dropout: 0,
      });
      const g = createGestureService(() => undefined);
      const d = g.use('rep', REP);
      let reps = 0;
      driveClip(c, (f) => {
        reps = d.read(f).reps;
      });
      return reps;
    });
    expect(Math.abs(counts[0]! - counts[1]!)).toBeLessThanOrEqual(1);
  });

  it('justCounted is true for exactly one read', () => {
    const g = createGestureService(() => undefined);
    const d = g.use('rep', REP);
    let run = 0;
    let worst = 0;
    driveClip(runClip(1.2, 10), (f) => {
      if (d.read(f).justCounted) run++;
      else run = 0;
      worst = Math.max(worst, run);
    });
    expect(worst).toBe(1);
  });

  it('reports cadence in cycles/sec and decays when the player stops', () => {
    const stopHalfway = buildClip(
      'stop',
      16,
      (_u, t) => (t < 8 ? kneeUp('L', osc(t, 1.5)) : {}),
      { seed: 62, dropout: 0 },
    );
    const g = createGestureService(() => undefined);
    const d = g.use('rep', REP);
    let whileRunning = 0;
    let atEnd = 0;
    driveClip(stopHalfway, (f) => {
      const s = d.read(f);
      if (f.t > 6 && f.t < 7.5) whileRunning = s.rate;
      atEnd = s.rate;
    });
    expect(whileRunning).toBeGreaterThan(1.1);
    expect(whileRunning).toBeLessThan(1.9);
    expect(atEnd).toBeLessThan(0.1); // stale cadence must not persist
  });

  it('holds the count when a required joint is not visible', () => {
    // `no-legs`: knees below MIN_VIS for the whole clip. The counter must hold,
    // not count garbage.
    const g = createGestureService(() => undefined);
    const d = g.use('rep', { ...REP, needs: [L.LEFT_KNEE] });
    let reps = 0;
    let anyOk = false;
    driveClip('no-legs', (f) => {
      const s = d.read(f);
      reps = s.reps;
      anyOk = anyOk || s.ok;
    });
    expect(anyOk).toBe(false);
    expect(reps).toBe(0);
  });

  it('phase advances 0..1 inside a cycle', () => {
    const g = createGestureService(() => undefined);
    const d = g.use('rep', REP);
    let min = 9;
    let max = -9;
    driveClip(runClip(1.2, 10), (f) => {
      const s = d.read(f);
      if (s.reps > 2) {
        min = Math.min(min, s.phase);
        max = Math.max(max, s.phase);
      }
    });
    expect(min).toBeLessThan(0.2);
    expect(max).toBeGreaterThan(0.8);
    expect(max).toBeLessThanOrEqual(1);
  });

  it('reset() zeroes the count so a second round starts clean', () => {
    const g = createGestureService(() => undefined);
    const d = g.use('rep', REP);
    driveClip(runClip(1.2, 10), (f) => void d.read(f));
    expect(d.read({ t: 999, inferenceAgeMs: 0, fps: 25, players: [], byId: new Map(), p1: undefined }).reps).toBeGreaterThan(5);
    g.resetAll();
    let reps = 1;
    driveClip(runClip(1.2, 2), (f) => {
      reps = d.read(f).reps;
    });
    expect(reps).toBeLessThanOrEqual(3);
  });
});

describe('kneeLift fallback ladder', () => {
  it('uses the knees when visible', () => {
    const g = createGestureService(() => undefined);
    const d = g.use('rep', { ...REP, needs: [L.LEFT_KNEE] });
    let reps = 0;
    driveClip('knee-run', (f) => {
      reps = d.read(f).reps;
    });
    expect(reps).toBeGreaterThan(20);
  });

  it('falls back to arm pumping when the knees are cropped', () => {
    // The laptop case: knees and ankles invisible, arms pumping. Degrading the
    // RULE rather than the data is what RESEARCH-POSE §5.4 recommends.
    const armRun = buildClip(
      'arm-run',
      10,
      (_u, t) => ({
        shoulderW: 0.26,
        hipY: 0.95,
        armL: -78 + 55 * osc(t, 1.2),
        armR: -102 - 55 * osc(t, 1.2, 0.5),
      }),
      { seed: 63, hideLegs: true, dropout: 0 },
    );
    const g = createGestureService(() => undefined);
    // No `needs`: the ladder is inside kneeLift, so the game does not branch.
    const d = g.use('rep', REP);
    let reps = 0;
    driveClip(armRun, (f) => {
      reps = d.read(f).reps;
    });
    expect(reps).toBeGreaterThanOrEqual(10);
    expect(reps).toBeLessThanOrEqual(13);
  });
});

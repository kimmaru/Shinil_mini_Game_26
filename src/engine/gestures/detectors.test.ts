// The assertions this project most needs to hold: exact counts, a zero
// false-positive floor, scale invariance and frame-rate invariance.
//
// Every expected number here was measured, not guessed, and the measurement is
// quoted next to it. If one of these moves, a threshold moved with it and
// dozens of games changed behaviour at once.
import { describe, expect, it } from 'vitest';

import { L } from '../pose/landmarks';
import { STAND, buildClip, clapAt, type PoseClip } from '../testing/synth';
import { defaultCalibration } from '../pose/source';
import { createGestureService } from './service';
import { driveClip } from './harness.test';
import type { GestureKind, PoseFrame } from '../types';

/** Count the one-frame events a detector produces over a whole clip. */
function count(
  clip: Parameters<typeof driveClip>[0],
  kind: GestureKind,
  pick: (s: never) => boolean,
  opts?: object,
  drive?: Parameters<typeof driveClip>[2],
): number {
  const g = createGestureService(() => undefined);
  const d = g.use(kind, opts as never);
  let n = 0;
  driveClip(
    clip,
    (f) => {
      if (pick(d.read(f) as never)) n++;
    },
    drive,
  );
  return n;
}

const jumps = (c: Parameters<typeof driveClip>[0], o?: object, dr?: Parameters<typeof driveClip>[2]): number =>
  count(c, 'jump', (s: { fired: boolean }) => s.fired, o, dr);
const squats = (c: Parameters<typeof driveClip>[0], o?: object, dr?: Parameters<typeof driveClip>[2]): number =>
  count(c, 'squat', (s: { released: boolean }) => s.released, o, dr);
const claps = (c: Parameters<typeof driveClip>[0], o?: object, dr?: Parameters<typeof driveClip>[2]): number =>
  count(c, 'clap', (s: { fired: boolean }) => s.fired, o, dr);

/**
 * The same body-relative motion at a chosen camera distance.
 *
 * Vertical displacement is given in SHOULDER WIDTHS (hence the `* S * aspect`,
 * because synth's vertical unit is S*aspect), so the gesture is IDENTICAL in
 * normalized units at every scale. That is what scale invariance means — the
 * `far-small` clip is not an "equivalent near clip", it is a clip whose
 * image-space motion is the same and whose body-relative motion is therefore
 * 2.3x bigger.
 */
function scaleClip(S: number): PoseClip {
  const aspect = 16 / 9;
  return buildClip(
    `scale-${S}`,
    14,
    (_u, t) => {
      const cyc = t % 3.5;
      if (cyc < 0.6) {
        const up = Math.sin((cyc / 0.6) * Math.PI);
        return { shoulderW: S, hipY: STAND.hipY - 0.55 * up * S * aspect };
      }
      if (cyc >= 1.2 && cyc < 2.2) {
        const d = Math.sin(((cyc - 1.2) / 1) * Math.PI);
        return {
          shoulderW: S,
          hipY: STAND.hipY + 0.55 * d * S * aspect,
          kneeL: 3 + 60 * d,
          kneeR: 3 + 60 * d,
        };
      }
      if (cyc >= 2.6 && cyc < 3.1) {
        return { shoulderW: S, ...clapAt(Math.sin(((cyc - 2.6) / 0.5) * Math.PI)) };
      }
      return { shoulderW: S };
    },
    { seed: 99, jitter: 0.0035 * (S / 0.17) },
  );
}

describe('exact counts', () => {
  it('jump-x8 detects exactly 8 jumps', () => {
    expect(jumps('jump-x8')).toBe(8);
  });

  it('squat-x8 detects exactly 8 squats — counted on the RELEASE edge', () => {
    expect(squats('squat-x8')).toBe(8);
    // `released` is the counting edge the contract names, and entries and
    // releases must pair exactly 1:1 — 8 and 8, never 8 and 9. A game that
    // counted BOTH edges would score 16 here, which is the doubling this suite
    // exists to catch.
    const g = createGestureService(() => undefined);
    const d = g.use('squat');
    let entered = 0;
    let released = 0;
    let bothEdges = 0;
    driveClip('squat-x8', (f) => {
      const s = d.read(f);
      if (s.entered) entered++;
      if (s.released) released++;
      if (s.entered || s.released) bothEdges++;
    });
    expect(entered).toBe(8);
    expect(released).toBe(8);
    expect(bothEdges).toBe(16);
  });

  it('clap-x12 detects exactly 12 claps', () => {
    expect(claps('clap-x12')).toBe(12);
  });

  it('counts are not doubled by counting both edges', () => {
    // A squat that is entered and released must produce ONE of each, never a
    // released without an entered.
    const g = createGestureService(() => undefined);
    const d = g.use('squat');
    let open = 0;
    let worst = 0;
    driveClip('squat-x8', (f) => {
      const s = d.read(f);
      if (s.entered) open++;
      if (s.released) open--;
      worst = Math.max(worst, Math.abs(open));
    });
    expect(worst).toBeLessThanOrEqual(1);
  });
});

describe('false-positive floor', () => {
  // The most important test in the file: a game must not award points for
  // standing still or scratching an ear.
  for (const clip of ['idle', 'fidget'] as const) {
    it(`${clip} fires nothing for any discrete detector`, () => {
      expect(jumps(clip)).toBe(0);
      expect(squats(clip)).toBe(0);
      expect(claps(clip)).toBe(0);
      expect(count(clip, 'raise', (s: { entered: boolean }) => s.entered, { side: 'either' })).toBe(0);
      expect(count(clip, 'lean', (s: { changed: boolean; dir: number }) => s.changed && s.dir !== 0)).toBe(0);
      expect(count(clip, 'step', (s: { changed: boolean }) => s.changed)).toBe(0);
      // `swing` has no fire edge; its activation is the scoring event.
      expect(count(clip, 'swing', (s: { active: boolean }) => s.active)).toBe(0);
      expect(
        count(clip, 'zone', (s: { entered: boolean }) => s.entered, {
          x: 0.0,
          y: 0.0,
          w: 0.2,
          h: 0.2,
        }),
      ).toBe(0);
    });
  }

  it('a squat recovery is not a jump', () => {
    // `squat-x8` stands back up at up to 0.94 sw/s of hip velocity, which is
    // above any usable velocity threshold. Only the displacement gate keeps
    // this at zero — the two games that use both detectors depend on it.
    expect(jumps('squat-x8')).toBe(0);
  });

  it('a jump is not a squat, and running is neither', () => {
    expect(squats('jump-x8')).toBe(0);
    expect(jumps('knee-run')).toBe(0);
    expect(squats('knee-run')).toBe(0);
  });

  it('clapping is not raising, and swinging is not clapping', () => {
    // The overhead variant of `clap-x12` still only brings the wrists to 0.105
    // sw BELOW the shoulder, so a clap never reads as a raise.
    expect(count('clap-x12', 'raise', (s: { entered: boolean }) => s.entered, { side: 'either' })).toBe(0);
    expect(claps('reach-grid')).toBe(0);
    expect(claps('knee-run')).toBe(0);
    expect(claps('jump-x8')).toBe(0);
    expect(claps('step-lr')).toBe(0);
    // NOT swing-wide: its +-110 degree sweeps genuinely bring the two wrists
    // within 0.039 sw of each other, fast. A detector that ignored that would
    // be ignoring a real hand clap.
  });
});

describe('invariance', () => {
  it('is scale invariant: identical motion at 0.6x, 1x and 2.3x distance', () => {
    const counts = [0.075, 0.17, 0.3].map((S) => {
      const c = scaleClip(S);
      return { S, j: jumps(c), s: squats(c), c: claps(c) };
    });
    // 14s / 3.5s per cycle = 4 of each.
    for (const r of counts) {
      expect(r.j, `jumps at shoulderW ${r.S}`).toBe(4);
      expect(r.s, `squats at shoulderW ${r.S}`).toBe(4);
      expect(r.c, `claps at shoulderW ${r.S}`).toBe(4);
    }
  });

  it('far-small (4m away) detects its 6 real jumps', () => {
    // The clip's own jumps are 2.3x larger in body-relative units than
    // `jump-x8`'s, because its image-space motion is unchanged while its body
    // is 2.3x smaller. All 6 are found.
    //
    // It also reports up to 2 EXTRA jumps, and they are not a threshold
    // problem: at 96px shoulder width the scale estimate in normalize.ts
    // wobbles up to 7.2% frame to frame, and because `px = w * scalePx` that
    // moves the whole body by up to 0.28 sw about the view origin — a hop,
    // as far as any detector can tell. Documented rather than tuned away: a
    // threshold that rejected 0.28 sw would also reject every real hop in
    // `jump-x8` (0.21-0.38 sw).
    const n = jumps('far-small');
    expect(n).toBeGreaterThanOrEqual(6);
    expect(n).toBeLessThanOrEqual(8);
  });

  it('is read-rate invariant: 60Hz and 120Hz reads over 25Hz inference', () => {
    // Games step at a fixed 1/60 while inference arrives at ~25Hz. Reading a
    // detector more often must not count a gesture more often.
    for (const stepHz of [60, 120]) {
      expect(jumps('jump-x8', undefined, { stepHz }), `jumps at ${stepHz}Hz`).toBe(8);
      expect(claps('clap-x12', undefined, { stepHz }), `claps at ${stepHz}Hz`).toBe(12);
      expect(squats('squat-x8', undefined, { stepHz }), `squats at ${stepHz}Hz`).toBe(8);
    }
  });

  it('laggy (10fps, dropout, frame drops) finds every jump and no extras', () => {
    // The clip contains 6 true jumps (every 2.5s over 14s) — not 8 — so "within
    // +-1 of the clean clip" means finding its own 6.
    expect(jumps('laggy')).toBe(6);
  });

  it('produces no NaN anywhere, on any clip', () => {
    for (const clip of ['idle', 'jump-x8', 'far-small', 'laggy', 'no-legs'] as const) {
      const g = createGestureService(() => undefined);
      const j = g.use('jump');
      const sq = g.use('squat');
      const cl = g.use('clap');
      const sw = g.use('swing');
      const re = g.use('reach');
      const st = g.use('step');
      const ln = g.use('lean');
      driveClip(clip, (f) => {
        const a = j.read(f);
        expect(Number.isFinite(a.height) && Number.isFinite(a.power)).toBe(true);
        expect(Number.isFinite(sq.read(f).depth)).toBe(true);
        const c = cl.read(f);
        expect(Number.isFinite(c.at.x) && Number.isFinite(c.power)).toBe(true);
        const s = sw.read(f);
        expect(Number.isFinite(s.speed) && Number.isFinite(s.dirDeg)).toBe(true);
        expect(Number.isFinite(s.from.x) && Number.isFinite(s.to.x)).toBe(true);
        const r = re.read(f);
        expect(Number.isFinite(r.leftExtend) && Number.isFinite(r.rightSpeed)).toBe(true);
        expect(Number.isFinite(st.read(f).value)).toBe(true);
        expect(Number.isFinite(ln.read(f).value)).toBe(true);
      });
    }
  });
});

describe('one-frame flags never latch', () => {
  it('fired/entered/released are true for exactly one read', () => {
    const g = createGestureService(() => undefined);
    const j = g.use('jump');
    const sq = g.use('squat');
    let worst = 0;
    let run = 0;
    driveClip('jump-x8', (f) => {
      if (j.read(f).fired) run++;
      else run = 0;
      worst = Math.max(worst, run);
    });
    expect(worst).toBe(1);

    worst = 0;
    run = 0;
    driveClip('squat-x8', (f) => {
      if (sq.read(f).released) run++;
      else run = 0;
      worst = Math.max(worst, run);
    });
    expect(worst).toBe(1);
  });

  it('re-reading the same frame returns the same signal without re-stepping', () => {
    // The debug overlay reads detectors the game is also reading. Doing so must
    // not consume the game's event, in either order.
    const g = createGestureService(() => undefined);
    const j = g.use('jump');
    let fires = 0;
    let doubleReadFires = 0;
    driveClip('jump-x8', (f) => {
      const a = j.read(f);
      const b = j.read(f);
      const c = j.read(f);
      if (a.fired) fires++;
      if (b.fired && c.fired && a.fired) doubleReadFires++;
    });
    expect(fires).toBe(8);
    expect(doubleReadFires).toBe(8);
  });
});

describe('semantics', () => {
  it('jump fires near takeoff on a real jump, not at the apex', () => {
    // A real child's jump: hips up ~0.9 shoulder widths over a 0.25s rise.
    // This is the case that matters, and the velocity path catches it within
    // ~2 frames of leaving the floor.
    const real = buildClip(
      'real-jump',
      12,
      (_u, t) => {
        const cyc = t % 3;
        if (cyc >= 0.5) return {};
        const up = Math.sin((cyc / 0.5) * Math.PI);
        return {
          hipY: STAND.hipY - 0.9 * up * 0.17 * (16 / 9),
          kneeL: 3 + 30 * up,
          kneeR: 3 + 30 * up,
        };
      },
      { seed: 42 },
    );
    const g = createGestureService(() => undefined);
    const d = g.use('jump');
    const lags: number[] = [];
    driveClip(real, (f) => {
      if (d.read(f).fired) lags.push(f.t % 3);
    });
    expect(lags.length).toBe(4);
    for (const lag of lags) {
      expect(lag).toBeGreaterThan(0);
      // Measured 0.08-0.20s into a 0.25s rise, i.e. before the apex. The floor
      // is not a threshold choice, it is the pipeline's filter budget: ~90ms of
      // One Euro position lag in normalize.ts, ~40ms of median-of-3, and the
      // 0.08 sw height gate that keeps a run-in-place (0.074 sw) from firing a
      // jump. `JumpDetector.HEIGHT_MIN` is the single knob if a game wants this
      // snappier at the cost of that protection.
      expect(lag).toBeLessThanOrEqual(0.24);
    }
  });

  it('a gentle hop is detected, at a measured cost in latency', () => {
    // `jump-x8`'s hops only displace 0.21-0.38 sw — a 7-12cm hop — so the
    // displacement path cannot clear the noise floor until close to the apex.
    // Measured: 0.32-0.52s into a 0.45s rise. This is the honest floor of what
    // is detectable at this amplitude, not a tuning choice: the One Euro
    // position filter alone costs ~90ms of it, median-of-3 another ~40ms each
    // in normalize.ts and here, and confirmFrames 2 another 80ms.
    const g = createGestureService(() => undefined);
    const d = g.use('jump');
    const lags: number[] = [];
    driveClip('jump-x8', (f) => {
      if (d.read(f).fired) lags.push(f.t % 2);
    });
    expect(lags.length).toBe(8);
    for (const lag of lags) {
      expect(lag).toBeGreaterThan(0);
      expect(lag).toBeLessThan(0.6);
    }
  });

  it('jump power is 0..1 and bigger jumps score higher', () => {
    const g = createGestureService(() => undefined);
    const d = g.use('jump');
    const powers: number[] = [];
    driveClip('jump-x8', (f) => {
      const s = d.read(f);
      if (s.fired) powers.push(s.power);
    });
    for (const p of powers) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
    // The clip cycles small/medium/large; the set must not be constant.
    expect(Math.max(...powers) - Math.min(...powers)).toBeGreaterThan(0.15);
  });

  it('clap reports the palm midpoint in view px', () => {
    const g = createGestureService(() => undefined);
    const d = g.use('clap');
    let seen = 0;
    driveClip('clap-x12', (f) => {
      const s = d.read(f);
      if (!s.fired) return;
      seen++;
      expect(s.at.x).toBeGreaterThan(0);
      expect(s.at.x).toBeLessThan(1280);
      expect(s.at.y).toBeGreaterThan(0);
      expect(s.at.y).toBeLessThan(720);
      expect(s.power).toBeGreaterThan(1.2); // at least minSpeed
    });
    expect(seen).toBe(12);
  });

  it('swing exposes a swept segment, not a point', () => {
    const g = createGestureService(() => undefined);
    const d = g.use('swing');
    let maxSweep = 0;
    driveClip('swing-wide', (f) => {
      const s = d.read(f);
      if (!s.active) return;
      maxSweep = Math.max(maxSweep, Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y));
    });
    // A fast swing covers far more than a palm radius between frames; this is
    // the whole reason `from`/`to` exist for hitSegCircle.
    expect(maxSweep).toBeGreaterThan(40);
  });

  it('swing ignores a scratch: speed alone is not enough', () => {
    // A 6Hz back-and-forth wiggle of the forearm. Its instantaneous speed is
    // high but it goes nowhere, so the net-travel gate rejects it.
    const scratch = buildClip(
      'scratch',
      8,
      (_u, t) => ({ armL: 40 + 10 * Math.sin(t * 38), elbowL: 95 + 12 * Math.sin(t * 38) }),
      { seed: 77 },
    );
    const g = createGestureService(() => undefined);
    const d = g.use('swing', { side: 'L' });
    let active = 0;
    driveClip(scratch, (f) => {
      if (d.read(f).active) active++;
    });
    expect(active).toBe(0);
  });

  it('raise is shoulder-relative, so arm length cannot change the answer', () => {
    // Same gesture, three body scales: a raise must be a raise either way.
    // hipY is low and the arm angle modest so the wrist stays inside the frame
    // at every scale — a wrist that leaves the frame is correctly GATED, which
    // would make this a test of the clip rather than of the detector.
    const raiseClip = (S: number): PoseClip =>
      buildClip(
        `raise-${S}`,
        8,
        (_u, t) => ({
          shoulderW: S,
          hipY: 0.85,
          ...(t % 2 < 1 ? { armL: 45, elbowL: 4 } : { armL: -78 }),
        }),
        { seed: 55 },
      );
    for (const S of [0.08, 0.12, 0.16]) {
      expect(
        count(raiseClip(S), 'raise', (s: { entered: boolean }) => s.entered, { side: 'L' }),
        `shoulderW ${S}`,
      ).toBe(4);
    }
  });

  it('lean is continuous and signed for steering', () => {
    const g = createGestureService(() => undefined);
    const d = g.use('lean');
    let min = 9;
    let max = -9;
    let dirs = 0;
    driveClip('step-lr', (f) => {
      const s = d.read(f);
      min = Math.min(min, s.value);
      max = Math.max(max, s.value);
      if (s.changed && s.dir !== 0) dirs++;
    });
    expect(min).toBeLessThan(-0.9);
    expect(max).toBeGreaterThan(0.9);
    expect(dirs).toBe(5); // 20s of a 7.85s oscillation = 5 half-cycles
  });

  it('step quantizes into lanes and returns to centre', () => {
    const g = createGestureService(() => undefined);
    const d = g.use('step', { lanes: 3 });
    const lanes = new Set<number>();
    let changes = 0;
    driveClip('step-lr', (f) => {
      const s = d.read(f);
      lanes.add(s.lane);
      if (s.changed) changes++;
    });
    expect([...lanes].sort()).toEqual([0, 1, 2]);
    expect(changes).toBe(10); // 5 excursions out and back
  });

  it('step ignores a slow sideways body sweep (the baseline absorbs it)', () => {
    // `reach-grid` translates the hips +-0.47 sw while sweeping. A frozen
    // baseline would read that as stepping; a slowly adapting one must not.
    expect(count('reach-grid', 'step', (s: { changed: boolean }) => s.changed)).toBe(0);
  });

  it('reach reports extension relative to the player own arm length', () => {
    const g = createGestureService(() => undefined);
    const d = g.use('reach');
    let maxExt = 0;
    driveClip('reach-grid', (f) => {
      const s = d.read(f);
      maxExt = Math.max(maxExt, s.leftExtend, s.rightExtend);
      expect(s.leftExtend).toBeGreaterThanOrEqual(0);
    });
    // A straight arm is ~1.0 of calib.armLen; the grid sweep straightens it.
    expect(maxExt).toBeGreaterThan(0.85);
    expect(maxExt).toBeLessThan(1.5);
  });

  it('limbAngle measures a straight arm as straight', () => {
    const tpose = buildClip('t', 4, () => ({ armL: 0, elbowL: 0, armR: 180, elbowR: 0 }), {
      seed: 31,
    });
    const g = createGestureService(() => undefined);
    const d = g.use('limbAngle', {
      a: L.LEFT_SHOULDER,
      b: L.LEFT_ELBOW,
      c: L.LEFT_WRIST,
      target: 180,
      tolDeg: 15,
    });
    let last = 0;
    let matched = 0;
    driveClip(tpose, (f) => {
      const s = d.read(f);
      last = s.deg;
      if (s.matched) matched++;
    });
    expect(last).toBeGreaterThan(165);
    expect(matched).toBeGreaterThan(50);
  });

  it('zone dwells and reports progress for the selection ring', () => {
    const g = createGestureService(() => undefined, { w: 1280, h: 720 });
    const d = g.use('zone', { x: 0, y: 0, w: 1, h: 1, holdMs: 500 });
    let entered = 0;
    let held = 0;
    let maxProgress = 0;
    driveClip('reach-grid', (f) => {
      const s = d.read(f);
      if (s.entered) entered++;
      if (s.held) held++;
      maxProgress = Math.max(maxProgress, s.progress);
    });
    expect(entered).toBeGreaterThan(0);
    expect(maxProgress).toBe(1); // the ring fills
    expect(held).toBeGreaterThan(0);
  });

  it('zone does not strobe on its boundary', () => {
    // The left half of the screen, crossed repeatedly by both sweeping hands.
    // Without the dead-zone margin a palm tracking along the edge would toggle
    // entered/exited every few frames and burn a selection; with it, crossings
    // stay in the tens over ~1000 frames.
    const g = createGestureService(() => undefined, { w: 1280, h: 720 });
    const d = g.use('zone', { x: 0, y: 0, w: 0.5, h: 1 });
    let entered = 0;
    let exited = 0;
    let reads = 0;
    driveClip('reach-grid', (f) => {
      reads++;
      const s = d.read(f);
      if (s.entered) entered++;
      if (s.exited) exited++;
    });
    expect(reads).toBeGreaterThan(900);
    expect(entered).toBeGreaterThan(0);
    expect(entered).toBeLessThan(40);
    expect(Math.abs(entered - exited)).toBeLessThanOrEqual(1);
  });

  it('gates instead of guessing when the body is gone', () => {
    // An empty frame: no player in the slot at all.
    const g = createGestureService(() => undefined);
    const j = g.use('jump');
    const empty: PoseFrame = {
      t: 0,
      inferenceAgeMs: 0,
      fps: 0,
      players: [],
      byId: new Map(),
      p1: undefined,
    };
    for (let i = 0; i < 10; i++) {
      const s = j.read({ ...empty, t: i / 25 });
      expect(s.ok).toBe(false);
      expect(s.fired).toBe(false);
    }
  });

  it('no-legs degrades instead of crashing or firing', () => {
    // Knees, ankles, heels and toes all below MIN_VIS — the laptop user, who
    // also is not jumping in this clip.
    expect(jumps('no-legs')).toBe(0);
    expect(squats('no-legs')).toBe(0);
    // requireFeetVisible GATES on a cropped body rather than guessing...
    const g = createGestureService(() => undefined);
    const d = g.use('jump', { requireFeetVisible: true });
    let anyOk = false;
    driveClip('no-legs', (f) => {
      anyOk = anyOk || d.read(f).ok;
    });
    expect(anyOk).toBe(false);
    // ...and still works when the feet ARE in frame.
    expect(jumps('jump-x8', { requireFeetVisible: true })).toBe(8);
    expect(jumps('jump-x8', { requireFeetVisible: false })).toBe(8);
  });

  it('a stricter `enter` is uniformly stricter (the attract-screen preset)', () => {
    // index.ts: "The attract screen uses 1.9 — a false start is more annoying
    // than a missed one."
    const normal = jumps('jump-x8');
    const strict = jumps('jump-x8', { enter: 2.6 });
    expect(strict).toBeLessThan(normal);
    expect(jumps('idle', { enter: 2.6 })).toBe(0);
  });

  it('respects the engine 250ms refractory floor on scoring gestures', () => {
    // A game asking for 10ms cannot get it.
    const g = createGestureService(() => undefined);
    const d = g.use('clap', { cooldownMs: 10 });
    const times: number[] = [];
    driveClip('clap-x12', (f) => {
      if (d.read(f).fired) times.push(f.t);
    });
    for (let i = 1; i < times.length; i++) {
      expect((times[i]! - times[i - 1]!) * 1000).toBeGreaterThanOrEqual(250);
    }
  });

  it('configure() retunes without re-renting, and reset() re-arms', () => {
    const g = createGestureService(() => undefined);
    const d = g.use('squat');
    let n = 0;
    driveClip('squat-x8', (f) => {
      if (d.read(f).released) n++;
    });
    expect(n).toBe(8);
    // An unreachably deep squat: same detector, no new rental.
    d.configure({ enter: 1.2, exit: 0.6 });
    d.reset();
    let m = 0;
    driveClip('squat-x8', (f) => {
      if (d.read(f).released) m++;
    });
    expect(m).toBe(0);
  });

  it('uses the calibration it is handed, not a global constant', () => {
    // A detector must read calib off the PlayerPose. Here: a profile whose arm
    // length is wrong by 2x must change `reach`'s extension, proving the value
    // is not hard-coded.
    const calib = defaultCalibration();
    const halfArm = { ...calib, armLen: calib.armLen / 2 };
    const maxExt = (c: typeof calib): number => {
      const g = createGestureService(() => undefined);
      const d = g.use('reach');
      let m = 0;
      driveClip('reach-grid', (f) => {
        const s = d.read(f);
        m = Math.max(m, s.leftExtend);
      }, { calib: c });
      return m;
    };
    expect(maxExt(halfArm) / maxExt(calib)).toBeCloseTo(2, 1);
  });
});

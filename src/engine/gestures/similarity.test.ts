import { describe, expect, it } from 'vitest';

import { L } from '../pose/landmarks';
import { armsAt, buildClip } from '../testing/synth';
import { createGestureService } from './service';
import { driveClip } from './harness.test';
import type { Joint } from '../pose/landmarks';

const ARMS: readonly Joint[] = [
  L.LEFT_SHOULDER,
  L.RIGHT_SHOULDER,
  L.LEFT_ELBOW,
  L.RIGHT_ELBOW,
  L.LEFT_WRIST,
  L.RIGHT_WRIST,
];

/** Capture a target vector straight out of a posed clip, which is how a game
 *  would author one: strike the pose, record `n` for the joints you care about. */
function captureTarget(pose: Parameters<typeof armsAt>[0]): Float32Array {
  const c = buildClip('capture', 2, () => armsAt(pose), { seed: 101, jitter: 0, dropout: 0 });
  const out = new Float32Array(ARMS.length * 2);
  driveClip(c, (f) => {
    const p = f.p1!;
    for (let i = 0; i < ARMS.length; i++) {
      out[i * 2] = p.n[ARMS[i]! * 2]!;
      out[i * 2 + 1] = p.n[ARMS[i]! * 2 + 1]!;
    }
  });
  return out;
}

const bestScore = (
  clip: Parameters<typeof driveClip>[0],
  target: Float32Array,
  opts: object = {},
): number => {
  const g = createGestureService(() => undefined);
  const d = g.use('poseMatch', { joints: ARMS, target, ...opts } as never);
  let best = 0;
  driveClip(clip, (f) => {
    best = Math.max(best, d.read(f).best);
  });
  return best;
};

describe('poseMatch', () => {
  it('scores 1 for the pose it was trained on', () => {
    const t = captureTarget(0); // a T
    const held = buildClip('t-hold', 4, () => armsAt(0), { seed: 102 });
    expect(bestScore(held, t)).toBeGreaterThan(0.98);
  });

  it('scores a different pose lower than the right one', () => {
    const tT = captureTarget(0);
    const tY = captureTarget(60);
    const holdT = buildClip('hold-t', 4, () => armsAt(0), { seed: 103 });
    expect(bestScore(holdT, tT)).toBeGreaterThan(bestScore(holdT, tY));
  });

  it('is independent of body scale — the point of the normalization', () => {
    // The same shape, three camera distances, one target vector captured at a
    // fourth. Nothing about the comparison may reward being closer or taller.
    const t = captureTarget(0);
    const scores = [0.08, 0.12, 0.16].map((S) => {
      const c = buildClip(`t-${S}`, 3, () => ({ ...armsAt(0), shoulderW: S, hipY: 0.8 }), {
        seed: 104,
      });
      return bestScore(c, t);
    });
    for (const s of scores) expect(s).toBeGreaterThan(0.95);
    expect(Math.max(...scores) - Math.min(...scores)).toBeLessThan(0.05);
  });

  it('best is a rolling window maximum — a good moment expires', () => {
    // Hit the pose for 0.7s in the middle of 6 seconds of the wrong one. `best`
    // must peak there and then decay, so a round scored on `best` measures how
    // the player is doing NOW rather than the luckiest instant of the round.
    //
    // (A single-FRAME flash is not even testable here, and that is itself
    // reassuring: the One Euro filter in normalize.ts smooths a 40ms pose
    // change away before this detector ever sees it, so the lucky-frame win the
    // contract warns about cannot reach us.)
    const t = captureTarget(0);
    const flash = buildClip(
      'flash',
      6,
      (_u, time) => (time > 2.5 && time < 3.2 ? armsAt(0) : armsAt(-70)),
      { seed: 105, jitter: 0, dropout: 0 },
    );
    const g = createGestureService(() => undefined);
    const d = g.use('poseMatch', { joints: ARMS, target: t, rollingMs: 1000 });
    let peak = 0;
    let atEnd = 0;
    driveClip(flash, (f) => {
      const s = d.read(f);
      peak = Math.max(peak, s.best);
      atEnd = s.best;
    });
    expect(peak).toBeGreaterThan(0.9); // the moment was seen
    expect(atEnd).toBeLessThan(0.9); // and then it expired
  });

  it('perJoint localizes the error for partial-success feedback', () => {
    const t = captureTarget(0);
    // Right arm in the T, left arm hanging.
    const half = buildClip('half', 3, () => ({ armR: 180, elbowR: 4, armL: -78 }), { seed: 106 });
    const g = createGestureService(() => undefined);
    const d = g.use('poseMatch', { joints: ARMS, target: t });
    let pj: Float32Array | null = null;
    driveClip(half, (f) => {
      pj = d.read(f).perJoint;
    });
    const v = pj as unknown as Float32Array;
    expect(v.length).toBe(ARMS.length);
    // The left wrist is the joint in the wrong place; the right one is not.
    const li = ARMS.indexOf(L.LEFT_WRIST);
    const ri = ARMS.indexOf(L.RIGHT_WRIST);
    expect(v[li]!).toBeLessThan(v[ri]!);
    for (const x of v) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
  });

  it('holds its score when most of the template is not visible', () => {
    const t = captureTarget(0);
    const g = createGestureService(() => undefined);
    const d = g.use('poseMatch', { joints: ARMS, target: t });
    let okAfter = false;
    let reads = 0;
    driveClip('idle', (f) => {
      reads++;
      if (reads > 50) f.p1!.vis.fill(0.1);
      const s = d.read(f);
      if (reads > 60) okAfter = okAfter || s.ok;
      expect(Number.isFinite(s.score)).toBe(true);
    });
    expect(okAfter).toBe(false);
  });

  it('weights de-emphasize the joints a game does not care about', () => {
    const t = captureTarget(0);
    const half = buildClip('half', 3, () => ({ armR: 180, elbowR: 4, armL: -78 }), { seed: 107 });
    // Zero weight on every left-arm joint: now only the right arm is judged,
    // and the right arm IS in the pose.
    const w = new Float32Array([1, 1, 0, 1, 0, 1]);
    const wL = new Float32Array([1, 1, 1, 1, 1, 1]);
    expect(bestScore(half, t, { weights: w })).toBeGreaterThan(
      bestScore(half, t, { weights: wL }),
    );
  });
});

describe('jointTargets', () => {
  it('covers targets placed where a hand actually goes, and reports progress', () => {
    // Place the target ON the palm's own path, discovered from the clip, so
    // this tests coverage rather than the author's guess about reachability.
    let px = 0;
    let py = 0;
    let n = 0;
    driveClip('idle', (f) => {
      if (n++ > 10) return;
      px = f.p1!.px[L.RIGHT_WRIST * 2]!;
      py = f.p1!.px[L.RIGHT_WRIST * 2 + 1]!;
    });
    const g = createGestureService(() => undefined, { w: 1280, h: 720 });
    const d = g.use('jointTargets', {
      targets: [{ x: px / 1280, y: py / 720, r: 0.08, joint: L.RIGHT_WRIST }],
      holdMs: 400,
    });
    let done = 0;
    let maxProgress = 0;
    let covered = 0;
    driveClip('idle', (f) => {
      const s = d.read(f);
      if (s.done) done++;
      maxProgress = Math.max(maxProgress, s.progress);
      covered = Math.max(covered, s.coveredCount);
    });
    expect(covered).toBe(1);
    expect(maxProgress).toBe(1);
    expect(done).toBe(1); // exactly one completion, latched afterwards
  });

  it('reports nothing covered for unreachable targets', () => {
    const g = createGestureService(() => undefined, { w: 1280, h: 720 });
    const d = g.use('jointTargets', {
      targets: [
        { x: 0.01, y: 0.99, r: 0.01, joint: L.LEFT_WRIST },
        { x: 0.99, y: 0.01, r: 0.01, joint: L.RIGHT_WRIST },
      ],
      holdMs: 200,
    });
    let done = 0;
    let anyCovered = 0;
    driveClip('idle', (f) => {
      const s = d.read(f);
      if (s.done) done++;
      anyCovered = Math.max(anyCovered, s.coveredCount);
    });
    expect(done).toBe(0);
    expect(anyCovered).toBe(0);
  });

  it('requires ALL targets at once, and `all` is not a partial', () => {
    const g = createGestureService(() => undefined, { w: 1280, h: 720 });
    const d = g.use('jointTargets', {
      targets: [
        // One reachable (anywhere a sweeping hand goes), one not.
        { x: 0.5, y: 0.5, r: 0.45, joint: L.LEFT_WRIST },
        { x: 0.99, y: 0.01, r: 0.005, joint: L.RIGHT_WRIST },
      ],
      holdMs: 100,
    });
    let sawPartial = false;
    let sawAll = false;
    driveClip('reach-grid', (f) => {
      const s = d.read(f);
      if (s.coveredCount === 1) sawPartial = true;
      if (s.all) sawAll = true;
    });
    expect(sawPartial).toBe(true);
    expect(sawAll).toBe(false);
  });

  it('gates when the target joints are invisible', () => {
    const g = createGestureService(() => undefined, { w: 1280, h: 720 });
    const d = g.use('jointTargets', {
      targets: [{ x: 0.5, y: 0.5, r: 0.2, joint: L.LEFT_ANKLE }],
    });
    let anyOk = false;
    driveClip('no-legs', (f) => {
      anyOk = anyOk || d.read(f).ok;
    });
    expect(anyOk).toBe(false);
  });
});

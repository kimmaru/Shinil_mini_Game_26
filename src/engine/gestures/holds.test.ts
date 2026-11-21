import { describe, expect, it } from 'vitest';

import { L } from '../pose/landmarks';
import { armsAt, buildClip } from '../testing/synth';
import { createGestureService } from './service';
import { ANGLE_TRIPLETS, POSE_TEMPLATES } from './holds';
import { driveClip } from './harness.test';

describe('holdPose', () => {
  it('completes the T pose on hold-poses, and never during a transition', () => {
    // `hold-poses` is 24s of 6 poses, 4s each, the first 25% of each segment
    // being a lerped transition: segments start at 0/4/8/12/16/20 and the
    // transition windows are 4-5, 8-9, 12-13, 16-17, 20-21.
    const g = createGestureService(() => undefined);
    const d = g.use('holdPose', { angles: POSE_TEMPLATES.T, holdMs: 800 });
    const done: number[] = [];
    driveClip('hold-poses', (f) => {
      if (d.read(f).done) done.push(f.t);
    });

    // The T is segment 0 and must complete there, shortly after 800ms.
    expect(done.some((t) => t >= 0.8 && t < 4)).toBe(true);

    // Nothing completes mid-transition. A pose detector that did would score a
    // player for sweeping their arms through the target on the way somewhere
    // else, which is the "arbitrary" feeling pose games are accused of.
    for (const t of done) {
      const seg = Math.floor(t / 4);
      const within = t - seg * 4;
      if (seg > 0) expect(within, `completed ${t.toFixed(2)}s mid-transition`).toBeGreaterThan(1);
    }

    // Segments 3 (one-leg, arms still at T) and 5 (arms at 10 degrees with an
    // 18 degree lean) are genuinely T-shaped within 22 degrees of tolerance, so
    // three completions is correct, not a bug.
    expect(done.length).toBe(3);
  });

  it('does not complete a pose the player is not in', () => {
    const g = createGestureService(() => undefined);
    // Arms straight overhead, which `hold-poses` only passes through.
    const d = g.use('holdPose', { angles: POSE_TEMPLATES.FLEX, holdMs: 1500, tolDeg: 12 });
    let done = 0;
    driveClip('idle', (f) => {
      if (d.read(f).done) done++;
    });
    expect(done).toBe(0);
  });

  it('requires the pose to be HELD, not swung through', () => {
    // `swing-wide` sweeps the arms +-110 degrees at ~0.5Hz, passing through the
    // T every half cycle without ever settling in it.
    const g = createGestureService(() => undefined);
    const d = g.use('holdPose', { angles: POSE_TEMPLATES.T, holdMs: 1200 });
    let done = 0;
    driveClip('swing-wide', (f) => {
      if (d.read(f).done) done++;
    });
    expect(done).toBe(0);
  });

  it('a slow sweep that genuinely dwells in the pose does complete', () => {
    // The honest other side of the previous test: arms oscillating only +-60
    // degrees at 0.48Hz are within tolerance of a T for 1.24s at a stretch, and
    // a player whose arms are that close for that long IS holding a T. A
    // detector that refused this would be the arbitrary one.
    const slow = buildClip('slow', 10, (_u, t) => armsAt(Math.sin(t * 3) * 60), { seed: 71 });
    const g = createGestureService(() => undefined);
    expect(
      (() => {
        const d = g.use('holdPose', { angles: POSE_TEMPLATES.T, holdMs: 1200 });
        let n = 0;
        driveClip(slow, (f) => {
          if (d.read(f).done) n++;
        });
        return n;
      })(),
    ).toBeGreaterThan(0);
  });

  it('progress rises to 1 and done fires exactly once per entry', () => {
    const tHold = buildClip('t', 6, () => armsAt(0), { seed: 72 });
    const g = createGestureService(() => undefined);
    const d = g.use('holdPose', { angles: POSE_TEMPLATES.T, holdMs: 800 });
    let done = 0;
    let maxP = 0;
    let sawPartial = false;
    driveClip(tHold, (f) => {
      const s = d.read(f);
      if (s.done) done++;
      maxP = Math.max(maxP, s.progress);
      if (s.progress > 0.1 && s.progress < 0.9) sawPartial = true;
    });
    expect(done).toBe(1); // latched, not re-firing every frame
    expect(maxP).toBe(1);
    expect(sawPartial).toBe(true); // there is a ring to draw
  });

  it('perJoint is parallel to the template keys and reports partial success', () => {
    // One arm in the T, the other hanging: half the template is right, and a
    // game must be able to say so.
    const halfT = buildClip('half', 6, () => ({ armL: 0, elbowL: 4, armR: -102, elbowR: 8 }), {
      seed: 73,
    });
    const g = createGestureService(() => undefined);
    const d = g.use('holdPose', { angles: POSE_TEMPLATES.T, holdMs: 500 });
    let last: Float32Array | null = null;
    let done = 0;
    driveClip(halfT, (f) => {
      const s = d.read(f);
      last = s.perJoint;
      if (s.done) done++;
    });
    const pj = last as unknown as Float32Array;
    expect(pj.length).toBe(Object.keys(POSE_TEMPLATES.T).length);
    // The left elbow/shoulder are correct, the right shoulder is not.
    const keys = Object.keys(POSE_TEMPLATES.T).map(Number);
    const li = keys.indexOf(L.LEFT_SHOULDER);
    const ri = keys.indexOf(L.RIGHT_SHOULDER);
    expect(pj[li]!).toBeGreaterThan(0.7);
    expect(pj[ri]!).toBeLessThan(0.3);
    // And the pose does NOT count, even though its MEAN error is 20.8 degrees
    // — inside the documented 22 degree tolerance. One joint 78 degrees out
    // vetoes it (HoldPoseDetector.JOINT_CAP). Without that veto, five pose
    // games would tell a child with one arm hanging down that they nailed a
    // T pose.
    expect(done).toBe(0);
  });

  it('is independent of body scale — the point of using angles', () => {
    for (const S of [0.08, 0.17, 0.26]) {
      const c = buildClip(`t-${S}`, 4, () => ({ ...armsAt(0), shoulderW: S, hipY: 0.8 }), {
        seed: 74,
      });
      const g = createGestureService(() => undefined);
      const d = g.use('holdPose', { angles: POSE_TEMPLATES.T, holdMs: 800 });
      let done = 0;
      driveClip(c, (f) => {
        if (d.read(f).done) done++;
      });
      expect(done, `shoulderW ${S}`).toBe(1);
    }
  });

  it('drops invisible joints from the mean instead of failing the pose', () => {
    // A knee angle in the template plus a laptop user with no legs: the arms
    // still decide the pose. Scoring a cropped joint as "wrong" would make the
    // pose unreachable for anyone sitting close to their screen.
    const g = createGestureService(() => undefined);
    const d = g.use('holdPose', {
      angles: { ...POSE_TEMPLATES.T, [L.LEFT_KNEE]: 180 },
      holdMs: 600,
    });
    const noLegsT = buildClip('t-nolegs', 5, () => ({ ...armsAt(0), shoulderW: 0.26, hipY: 0.95 }), {
      seed: 75,
      hideLegs: true,
    });
    let done = 0;
    driveClip(noLegsT, (f) => {
      if (d.read(f).done) done++;
    });
    expect(done).toBe(1);
  });

  it('ignores a joint it has no triplet for rather than guessing', () => {
    const g = createGestureService(() => undefined);
    const d = g.use('holdPose', { angles: { [L.NOSE]: 90 }, holdMs: 300 });
    let ok = false;
    driveClip('idle', (f) => {
      ok = ok || d.read(f).ok;
    });
    // No measurable joints at all -> gated, never a free completion.
    expect(ok).toBe(false);
    expect(ANGLE_TRIPLETS[L.NOSE]).toBeUndefined();
  });

  it('every template joint has a triplet', () => {
    for (const tpl of Object.values(POSE_TEMPLATES)) {
      for (const k of Object.keys(tpl)) {
        expect(ANGLE_TRIPLETS[Number(k) as keyof typeof ANGLE_TRIPLETS]).toBeDefined();
      }
    }
  });
});

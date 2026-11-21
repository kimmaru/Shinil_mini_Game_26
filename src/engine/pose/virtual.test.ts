import { describe, expect, it } from 'vitest';
import { body } from '../testing/synth';
import { L, LANDMARK_COUNT, jointDist, palm } from './landmarks';
import { VIRTUAL_BODY, VIRTUAL_HZ, VirtualPoseSource, scriptedPose, solveArm } from './virtual';

const VIEW = { w: 1280, h: 720 };
const ASPECT = VIEW.w / VIEW.h;

function src(): VirtualPoseSource {
  // attach:false keeps this Node-safe; tests drive press()/setPointer()
  // directly, which is also how the dev harness drives it.
  const v = new VirtualPoseSource({ attach: false, gamepad: false, view: VIEW });
  void v.start();
  return v;
}

/** Run the source forward to `to` seconds at 60Hz and return the last frame. */
function run(v: VirtualPoseSource, from: number, to: number) {
  let last = v.sample(from);
  for (let t = from; t <= to; t += 1 / 60) last = v.sample(t);
  return last;
}

describe('solveArm (two-link IK)', () => {
  it('puts the wrist exactly on the target, both sides, all quadrants', () => {
    const sol = { upper: 0, elbow: 0 };
    let worst = 0;
    for (const side of ['L', 'R'] as const) {
      for (let a = 0; a < 360; a += 15) {
        for (const r of [0.3, 0.8, 1.2, 1.6]) {
          const ux = Math.cos((a * Math.PI) / 180) * r;
          const uy = Math.sin((a * Math.PI) / 180) * r;
          solveArm(side, ux, uy, sol);
          // Check through the REAL skeleton builder, not a copy of its maths.
          const lm = body(
            {
              shoulderW: 1,
              hipX: 0,
              hipY: 0,
              [side === 'L' ? 'armL' : 'armR']: sol.upper,
              [side === 'L' ? 'elbowL' : 'elbowR']: sol.elbow,
            },
            1,
          );
          const sj = side === 'L' ? L.LEFT_SHOULDER : L.RIGHT_SHOULDER;
          const wj = side === 'L' ? L.LEFT_WRIST : L.RIGHT_WRIST;
          const gotX = lm[wj * 2]! - lm[sj * 2]!;
          const gotY = -(lm[wj * 2 + 1]! - lm[sj * 2 + 1]!);
          worst = Math.max(worst, Math.hypot(gotX - ux, gotY - uy));
        }
      }
    }
    // Measured worst error 4e-7 shoulder widths across 192 targets.
    expect(worst).toBeLessThan(1e-4);
  });

  it('clamps an unreachable target instead of producing NaN', () => {
    const sol = { upper: 0, elbow: 0 };
    solveArm('L', 9, 9, sol);
    expect(Number.isFinite(sol.upper)).toBe(true);
    expect(Number.isFinite(sol.elbow)).toBe(true);
    solveArm('R', 0, 0, sol);
    expect(Number.isFinite(sol.upper)).toBe(true);
  });
});

describe('VirtualPoseSource: it is a whole body', () => {
  it('is a full-body framing, so legs and feet games are playable', () => {
    const v = src();
    const p = run(v, 0, 1).p1!;
    // STAND would have cropped the ankles; VIRTUAL_BODY does not.
    expect(VIRTUAL_BODY.shoulderW).toBeLessThan(0.17);
    expect(p.vis[L.LEFT_ANKLE]!).toBeGreaterThan(0.5);
    expect(p.vis[L.RIGHT_ANKLE]!).toBeGreaterThan(0.5);
    expect(p.vis[L.NOSE]!).toBeGreaterThan(0.5);
    expect(p.present).toBe(true);
    expect(p.conf).toBeGreaterThan(0.9);
  });

  it('marks a joint outside the frame as not visible', () => {
    const v = new VirtualPoseSource({ attach: false, gamepad: false, view: VIEW });
    void v.start();
    // Hands overhead WHILE jumping does leave the frame, exactly as it would
    // with a real camera. (A cursor off the top edge does not: the arm is only
    // 1.63 shoulder widths long, so the hand stops at full stretch, in frame.)
    v.press('KeyZ');
    v.press('KeyX');
    run(v, 0, 0.8);
    v.press('Space');
    let minVis = 1;
    for (let t = 0.8; t < 1.3; t += 1 / 60) {
      minVis = Math.min(minVis, v.sample(t).p1!.vis[L.LEFT_WRIST]!);
    }
    expect(minVis).toBeLessThan(0.5);
  });

  it('every landmark is finite and the body is where it should be', () => {
    const v = src();
    const p = run(v, 0, 1).p1!;
    for (let k = 0; k < LANDMARK_COUNT * 2; k++) {
      expect(Number.isFinite(p.n[k]!)).toBe(true);
      expect(Number.isFinite(p.px[k]!)).toBe(true);
    }
    expect(jointDist(p, L.LEFT_SHOULDER, L.RIGHT_SHOULDER)).toBeCloseTo(1, 1);
    expect(p.scalePx).toBeCloseTo(VIRTUAL_BODY.shoulderW * VIEW.w, 0);
  });
});

describe('VirtualPoseSource: the bindings a 9-year-old will press', () => {
  it('Space produces a real jump: upward hip velocity past the detector gate', () => {
    const v = src();
    run(v, 0, 0.6);
    v.press('Space');
    let peakUp = 0;
    let topHip = Infinity;
    for (let t = 0.6; t < 1.2; t += 1 / 60) {
      const p = v.sample(t).p1!;
      peakUp = Math.min(peakUp, p.v[L.LEFT_HIP * 2 + 1]!);
      topHip = Math.min(topHip, p.px[L.LEFT_HIP * 2 + 1]!);
    }
    v.release('Space');
    // JumpOpts.enter defaults to 1.5 shoulder-widths/sec upward. Measured
    // -2.32, so the default detector fires with margin, and the attract
    // screen's stricter 1.9 does too.
    expect(peakUp).toBeLessThan(-1.9);
    // And the hips really do rise ~0.6 shoulder widths.
    const standing = v.sample(2).p1!.px[L.LEFT_HIP * 2 + 1]!;
    expect((standing - topHip) / v.sample(2).p1!.scalePx).toBeGreaterThan(0.4);
  });

  it('ArrowDown squats past SquatOpts.enter (0.45 shoulder widths)', () => {
    const v = src();
    const standing = run(v, 0, 0.6).p1!;
    const hip0 = (standing.px[L.LEFT_HIP * 2 + 1]! + standing.px[L.RIGHT_HIP * 2 + 1]!) / 2;
    v.press('ArrowDown');
    const down = run(v, 0.6, 1.6).p1!;
    const hip1 = (down.px[L.LEFT_HIP * 2 + 1]! + down.px[L.RIGHT_HIP * 2 + 1]!) / 2;
    expect((hip1 - hip0) / down.scalePx).toBeGreaterThan(0.5);
    v.release('ArrowDown');
    const up = run(v, 1.6, 2.6).p1!;
    const hip2 = (up.px[L.LEFT_HIP * 2 + 1]! + up.px[L.RIGHT_HIP * 2 + 1]!) / 2;
    expect(Math.abs(hip2 - hip0)).toBeLessThan(6);
  });

  it('ArrowLeft/Right give BOTH a lean and a step, past both gates', () => {
    const v = src();
    const mid = run(v, 0, 0.6).p1!;
    const hipX0 = (mid.px[L.LEFT_HIP * 2]! + mid.px[L.RIGHT_HIP * 2]!) / 2;
    v.press('ArrowRight');
    const leaned = run(v, 0.6, 1.8).p1!;
    const hipX1 = (leaned.px[L.LEFT_HIP * 2]! + leaned.px[L.RIGHT_HIP * 2]!) / 2;
    const shX = (leaned.px[L.LEFT_SHOULDER * 2]! + leaned.px[L.RIGHT_SHOULDER * 2]!) / 2;
    // StepOpts.enter 0.55 shoulder widths of body translation...
    expect(Math.abs(hipX1 - hipX0) / leaned.scalePx).toBeGreaterThan(0.6);
    // ...and LeanOpts.enter 0.30 of shoulder-centre offset from hip-centre.
    expect(Math.abs(shX - hipX1) / leaned.scalePx).toBeGreaterThan(0.3);
    v.release('ArrowRight');
  });

  it('Z and X raise the hand on the matching side of the SCREEN', () => {
    const v = src();
    run(v, 0, 0.6);
    v.press('KeyZ');
    const p = run(v, 0.6, 1.6).p1!;
    // RaiseOpts.above defaults to 0.25 shoulder widths over the shoulder.
    const lift = p.n[L.LEFT_SHOULDER * 2 + 1]! - p.n[L.LEFT_WRIST * 2 + 1]!;
    expect(lift).toBeGreaterThan(0.25);
    // Z is the left-hand key and it raises the hand on the left of the screen.
    expect(p.px[L.LEFT_WRIST * 2]!).toBeLessThan(VIEW.w / 2);
    // The other hand stays down.
    expect(p.n[L.RIGHT_SHOULDER * 2 + 1]! - p.n[L.RIGHT_WRIST * 2 + 1]!).toBeLessThan(0);
    v.release('KeyZ');

    v.press('KeyX');
    const q = run(v, 1.6, 2.6).p1!;
    expect(q.n[L.RIGHT_SHOULDER * 2 + 1]! - q.n[L.RIGHT_WRIST * 2 + 1]!).toBeGreaterThan(0.25);
    expect(q.px[L.RIGHT_WRIST * 2]!).toBeGreaterThan(VIEW.w / 2);
  });

  it('the pointer puts the palm on the cursor', () => {
    const v = src();
    const pt = { x: 0, y: 0 };
    let t = 0;
    for (const [x, y] of [
      [900, 220],
      [400, 300],
      [640, 180],
    ] as const) {
      v.setPointer(x, y);
      const p = run(v, t, t + 1.5).p1!;
      t += 1.5;
      // The wrist is driven by IK; the palm is what a game hit-tests, and it
      // sits 1.4x past the wrist, so check both are in the right place.
      expect(Math.abs(p.px[L.RIGHT_WRIST * 2]! - x)).toBeLessThan(20);
      expect(Math.abs(p.px[L.RIGHT_WRIST * 2 + 1]! - y)).toBeLessThan(20);
      palm(p, 'R', pt);
      expect(Math.hypot(pt.x - x, pt.y - y)).toBeLessThan(p.scalePx * 0.5);
    }
  });

  it('C claps: the wrists converge past ClapOpts.closeAt and re-open past openAt', () => {
    const v = src();
    v.setPointer(820, 260);
    const open = run(v, 0, 1.5).p1!;
    const openSep = jointDist(open, L.LEFT_WRIST, L.RIGHT_WRIST);
    // ClapOpts.openAt defaults to 0.75: the hands must be this far apart for
    // the detector to re-arm between claps.
    expect(openSep).toBeGreaterThan(0.75);

    v.press('KeyC');
    let minSep = 99;
    let atClap = { x: 0, y: 0 };
    for (let t = 1.5; t < 2.1; t += 1 / 60) {
      const p = v.sample(t).p1!;
      const sep = jointDist(p, L.LEFT_WRIST, L.RIGHT_WRIST);
      if (sep < minSep) {
        minSep = sep;
        atClap = {
          x: (p.px[L.LEFT_WRIST * 2]! + p.px[L.RIGHT_WRIST * 2]!) / 2,
          y: (p.px[L.LEFT_WRIST * 2 + 1]! + p.px[L.RIGHT_WRIST * 2 + 1]!) / 2,
        };
      }
    }
    v.release('KeyC');
    // ClapOpts.closeAt defaults to 0.42. Measured 0.257.
    expect(minSep).toBeLessThan(0.42);
    // And the clap happens AT THE CURSOR, which is what makes a swat game
    // playable with a mouse. Within one shoulder width of it, anyway: the arm
    // is 1.63 shoulder widths long and the body only steps so far.
    expect(Math.hypot(atClap.x - 820, atClap.y - 260)).toBeLessThan(
      v.sample(2.2).p1!.scalePx * 1.0,
    );
    // Re-opens for the next clap.
    const after = run(v, 2.1, 2.8).p1!;
    expect(jointDist(after, L.LEFT_WRIST, L.RIGHT_WRIST)).toBeGreaterThan(0.75);
  });

  it('velocities are consistent with positions, never teleports', () => {
    const v = src();
    v.setPointer(300, 500);
    run(v, 0, 1);
    // Yank the cursor right across the screen: the arm must travel, not jump.
    v.setPointer(1000, 200);
    let worstV = 0;
    let worstStep = 0;
    let prevX = v.sample(1).p1!.px[L.RIGHT_WRIST * 2]!;
    for (let t = 1; t < 2.5; t += 1 / 60) {
      const p = v.sample(t).p1!;
      for (let k = 0; k < LANDMARK_COUNT * 2; k++) worstV = Math.max(worstV, Math.abs(p.v[k]!));
      const x = p.px[L.RIGHT_WRIST * 2]!;
      worstStep = Math.max(worstStep, Math.abs(x - prevX));
      prevX = x;
    }
    // A human hand peaks around 6-8 shoulder-widths/sec. This is a snap to a
    // new cursor position, so it is fast — but it is not a teleport, and it is
    // inside the range a real swing produces.
    expect(worstV).toBeLessThan(25);
    expect(worstStep).toBeLessThan(VIEW.w * 0.2);
  });

  it('repeated keydown does not stack jumps', () => {
    const v = src();
    run(v, 0, 0.5);
    v.press('Space');
    v.press('Space');
    v.press('Space');
    let peak = 0;
    for (let t = 0.5; t < 1.4; t += 1 / 60) {
      peak = Math.min(peak, v.sample(t).p1!.v[L.LEFT_HIP * 2 + 1]!);
    }
    expect(peak).toBeGreaterThan(-6); // one jump's worth, not three
  });
});

describe('VirtualPoseSource: plumbing', () => {
  it('feeds at the inference rate and extrapolates in between', () => {
    const v = src();
    v.setPointer(900, 300);
    let maxAge = 0;
    for (let t = 0; t < 2; t += 1 / 60) maxAge = Math.max(maxAge, v.sample(t).inferenceAgeMs);
    expect(v.info.fps).toBe(VIRTUAL_HZ);
    expect(maxAge).toBeGreaterThan(5);
    expect(maxAge).toBeLessThanOrEqual(61);
  });

  it('scripted calibration measures the virtual body instead of guessing', async () => {
    const v = src();
    const p = await v.calibrate(4000);
    // All four of these are real measurements of the body games will see.
    expect(p.shoulderW).toBeCloseTo(VIRTUAL_BODY.shoulderW * VIEW.w, 0);
    expect(p.standHipY).toBeCloseTo(VIRTUAL_BODY.hipY, 2);
    expect(p.squatHipY).toBeGreaterThan(p.standHipY + 0.1);
    expect(p.armSpan).toBeGreaterThan(4);
    expect(p.armLen).toBeGreaterThan(1.5);
    expect(p.reachUpY).toBeLessThan(p.standHipY - 0.4);
    expect(p.lowerBodyVisible).toBe(true);
    expect(p.idleEnergy).toBeGreaterThan(0);
  });

  it('the calibration script actually poses the body', () => {
    expect(scriptedPose(0)).toEqual({});
    expect(scriptedPose(0.4).armL).toBeGreaterThan(-20); // arms out
    expect(scriptedPose(0.65).armL).toBeGreaterThan(60); // overhead
    expect(scriptedPose(0.95).kneeL).toBeGreaterThan(50); // squat
  });

  it('survives a backgrounded tab without simulating the dead time', () => {
    const v = src();
    run(v, 0, 1);
    const p = v.sample(400); // 400 seconds later
    expect(p.p1!.present).toBe(true);
    expect([...p.p1!.px].every(Number.isFinite)).toBe(true);
  });

  it('pause() freezes the body; resume() clears stuck keys', () => {
    const v = src();
    v.press('ArrowRight');
    const moved = run(v, 0, 1).p1!;
    const x = moved.px[L.LEFT_HIP * 2]!;
    v.pause();
    // Frozen: no feeds, and no extrapolation from a clock that keeps running.
    const paused = run(v, 1, 2).p1!.px[L.LEFT_HIP * 2]!;
    expect(paused).toBeCloseTo(x, 0);
    expect(run(v, 2, 2.5).p1!.px[L.LEFT_HIP * 2]!).toBeCloseTo(paused, 5);
    v.resume();
    // A key held when the round paused must not still be held on resume.
    const back = run(v, 2.5, 4).p1!;
    expect(Math.abs(back.px[L.LEFT_HIP * 2]! - x)).toBeGreaterThan(10);
  });

  it('aspect-corrects the body to the view it is given', () => {
    const wide = new VirtualPoseSource({ attach: false, gamepad: false, view: { w: 1600, h: 600 } });
    void wide.start();
    const p = run(wide, 0, 1).p1!;
    // Shoulders are still exactly 1 unit apart, whatever the window shape.
    expect(jointDist(p, L.LEFT_SHOULDER, L.RIGHT_SHOULDER)).toBeCloseTo(1, 1);
    // And the torso is still ~1.36 units, i.e. not squashed.
    const torso = Math.hypot(
      (p.n[L.LEFT_SHOULDER * 2]! + p.n[L.RIGHT_SHOULDER * 2]!) / 2,
      (p.n[L.LEFT_SHOULDER * 2 + 1]! + p.n[L.RIGHT_SHOULDER * 2 + 1]!) / 2,
    );
    expect(torso).toBeGreaterThan(1.2);
    expect(torso).toBeLessThan(1.5);
    expect(ASPECT).toBeGreaterThan(1);
  });
});

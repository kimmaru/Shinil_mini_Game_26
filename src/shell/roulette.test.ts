// The one test in the shell that is not optional.
//
// A wheel that lands on a different game than the one that was chosen destroys
// trust in a single spin, and it is exactly the kind of bug that survives
// manual testing (you have to notice the mismatch while a wheel is spinning).
// So: assert the inverse over a hundred random triples, every run.
import { describe, expect, it } from 'vitest';
import {
  SETTLE_FRACTION,
  TAU,
  cubicBezier,
  sliceUnderPointer,
  targetRotation,
} from './components/Wheel';
import { mulberry32 } from '@/engine/rng';

const rnd = mulberry32(20261121);

describe('targetRotation / sliceUnderPointer', () => {
  it('lands the pointer on the chosen slice, for 200 random triples', () => {
    for (let k = 0; k < 200; k++) {
      const n = 2 + Math.floor(rnd() * 15); // 2..16 slices
      const i = Math.floor(rnd() * n);
      const current = rnd() * 400 - 50; // including negative start rotations
      const spins = 1 + Math.floor(rnd() * 9);
      const rot = targetRotation(i, n, current, spins, rnd);
      expect(sliceUnderPointer(rot, n)).toBe(i);
    }
  });

  it('also lands correctly on a near-miss', () => {
    for (let k = 0; k < 100; k++) {
      const n = 2 + Math.floor(rnd() * 15);
      const i = Math.floor(rnd() * n);
      const current = rnd() * 200;
      const rot = targetRotation(i, n, current, 6, rnd, true);
      expect(sliceUnderPointer(rot, n)).toBe(i);
    }
  });

  it('always rotates forward, never backward', () => {
    for (let k = 0; k < 200; k++) {
      const n = 2 + Math.floor(rnd() * 15);
      const i = Math.floor(rnd() * n);
      const current = rnd() * 500 - 100;
      const rot = targetRotation(i, n, current, 1, rnd);
      expect(rot).toBeGreaterThan(current);
    }
  });

  it('stays monotonic across a chain of 60 spins', () => {
    let cur = 0;
    const n = 8;
    for (let k = 0; k < 60; k++) {
      const i = Math.floor(rnd() * n);
      const next = targetRotation(i, n, cur, 6, rnd, rnd() < 0.25);
      expect(next).toBeGreaterThan(cur);
      expect(sliceUnderPointer(next, n)).toBe(i);
      cur = next;
    }
    // Six turns a spin, sixty spins: the value grows without ever resetting,
    // which is what keeps the CSS transition going one way.
    expect(cur).toBeGreaterThan(60 * 6 * TAU);
  });

  it('keeps the settle overshoot inside the winning slice', () => {
    // The pawn bounce animates PAST the target and settles back. If the
    // overshoot crossed a boundary the wheel would visibly show the wrong game
    // for 170ms before snapping back.
    for (let k = 0; k < 200; k++) {
      const n = 2 + Math.floor(rnd() * 15);
      const i = Math.floor(rnd() * n);
      const nearMiss = rnd() < 0.5;
      const rot = targetRotation(i, n, rnd() * 100, 6, rnd, nearMiss);
      const overshoot = rot + (TAU / n) * SETTLE_FRACTION;
      expect(sliceUnderPointer(overshoot, n)).toBe(i);
    }
  });

  it('handles a single-slice wheel without dividing by zero', () => {
    const rot = targetRotation(0, 1, 0, 6, () => 0.5);
    expect(Number.isFinite(rot)).toBe(true);
    expect(sliceUnderPointer(rot, 1)).toBe(0);
  });
});

describe('cubicBezier', () => {
  const ease = cubicBezier(0.12, 0.76, 0.06, 1);

  it('pins the endpoints', () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(-1)).toBe(0);
    expect(ease(2)).toBe(1);
  });

  it('is monotonically increasing, so the tick count never runs backwards', () => {
    let prev = -1;
    for (let x = 0; x <= 1.0001; x += 0.01) {
      const y = ease(x);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = y;
    }
  });

  it('front-loads the motion, as --ease-wheel does', () => {
    // Half the time spent, well past half the rotation: that is what makes the
    // last second read as suspense rather than as a slow spin.
    expect(ease(0.5)).toBeGreaterThan(0.6);
  });
});

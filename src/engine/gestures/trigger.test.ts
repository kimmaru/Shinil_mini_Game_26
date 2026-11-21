// The primitives. If these are wrong, every detector is wrong in the same way.
import { describe, expect, it } from 'vitest';

import { Baseline, HoldTimer, Stats, Trigger, Vel } from './trigger';

describe('Trigger', () => {
  const run = (tr: Trigger, vals: number[], hz = 25): number[] => {
    const fires: number[] = [];
    for (let i = 0; i < vals.length; i++) {
      if (tr.update(vals[i]!, (i / hz) * 1000)) fires.push(i);
    }
    return fires;
  };

  it('fires once per rising edge and needs `exit` to re-arm', () => {
    const tr = new Trigger(1, 0.5, 0, 1);
    // Up, held, down, up again: two events, not four.
    expect(run(tr, [0, 2, 2, 2, 2, 0, 0, 2, 2])).toEqual([1, 7]);
  });

  it('cannot be built with a single threshold', () => {
    const tr = new Trigger(1, 1);
    expect(tr.exit).toBeLessThan(tr.enter);
    const tr2 = new Trigger(1, 5); // exit above enter is nonsense
    expect(tr2.exit).toBeLessThan(tr2.enter);
  });

  it('a value between enter and exit holds the latch — no flicker', () => {
    const tr = new Trigger(1, 0.5, 0, 1);
    // Dipping to 0.7 (below enter, above exit) must NOT re-arm.
    expect(run(tr, [0, 2, 0.7, 2, 0.7, 2])).toEqual([1]);
  });

  it('confirmFrames suppresses a single-frame spike', () => {
    const tr = new Trigger(1, 0.5, 0, 2);
    expect(run(tr, [0, 5, 0, 0, 5, 0])).toEqual([]); // two isolated spikes
    const tr2 = new Trigger(1, 0.5, 0, 2);
    expect(run(tr2, [0, 2, 2, 0])).toEqual([2]); // held two frames -> fires late
  });

  it('express fires a big value on the first frame', () => {
    const tr = new Trigger(1, 0.5, 0, 2);
    tr.express = 1.6;
    expect(run(tr, [0, 1.7, 1.7])).toEqual([1]);
  });

  it('cooldown suppresses the edge rather than deferring it', () => {
    const tr = new Trigger(1, 0.5, 250, 1);
    // Edges at i=1 (40ms) and i=3 (120ms): the second is inside the cooldown
    // and must be dropped, NOT replayed when the cooldown expires.
    const fires = run(tr, [0, 2, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(fires).toEqual([1]);
    // ... and a later edge past the refractory period fires normally.
    expect(tr.update(2, 1000)).toBe(true);
  });

  it('gates without disturbing the latch, and fires nothing', () => {
    const tr = new Trigger(1, 0.5, 0, 2);
    expect(tr.update(5, 0, false)).toBe(false);
    expect(tr.update(5, 40, false)).toBe(false);
    expect(tr.active).toBe(false);
    // The confirm counter was reset by the gate, so it still takes two frames.
    expect(tr.update(5, 80, true)).toBe(false);
    expect(tr.update(5, 120, true)).toBe(true);
  });

  it('ignores NaN rather than latching on it', () => {
    const tr = new Trigger(1, 0.5, 0, 1);
    expect(tr.update(NaN, 0)).toBe(false);
    expect(tr.active).toBe(false);
  });

  it('entered/exited are one frame each', () => {
    const tr = new Trigger(1, 0.5, 0, 1);
    tr.update(2, 0);
    expect(tr.entered).toBe(true);
    tr.update(2, 40);
    expect(tr.entered).toBe(false);
    expect(tr.exited).toBe(false);
    tr.update(0, 80);
    expect(tr.exited).toBe(true);
    tr.update(0, 120);
    expect(tr.exited).toBe(false);
  });
});

describe('Vel', () => {
  it('reports the same units/sec at any frame rate', () => {
    // A ramp of 3 units/sec sampled at 10, 25 and 60Hz.
    const at = (hz: number): number => {
      const v = new Vel(0.12, 32);
      let out = 0;
      for (let i = 0; i <= hz; i++) out = v.push((i / hz) * 3, i / hz);
      return out;
    };
    for (const hz of [10, 25, 60]) {
      expect(at(hz)).toBeGreaterThan(2.9);
      expect(at(hz)).toBeLessThan(3.1);
    }
  });

  it('spans a dropped frame instead of dividing by a wrong dt', () => {
    const v = new Vel(0.12, 32);
    v.push(0, 0);
    v.push(0.3, 0.1);
    // A 400ms gap with no samples, then motion resumes.
    const out = v.push(0.9, 0.5);
    expect(Number.isFinite(out)).toBe(true);
    expect(out).toBeGreaterThan(0);
  });

  it('is zero on the first sample, never NaN or Infinity', () => {
    const v = new Vel();
    expect(v.push(5, 0)).toBe(0);
    expect(v.push(5, 0)).toBe(0); // duplicate timestamp
  });
});

describe('Baseline', () => {
  it('seeds on the first sample and then adapts', () => {
    const b = new Baseline(1, 0.1, 10);
    expect(b.update(100, 0, false)).toBe(100);
    for (let i = 0; i < 100; i++) b.update(105, 0.04, false);
    expect(b.value).toBeGreaterThan(104);
  });

  it('freezes completely while told to', () => {
    const b = new Baseline(8, 1, 1e9);
    b.update(0, 0, false);
    for (let i = 0; i < 100; i++) b.update(50, 0.04, true);
    expect(b.value).toBe(0);
  });

  it('adapts 10x slower outside the band, so a held pose barely moves it', () => {
    const near = new Baseline(0.8, 0.08, 10);
    const far = new Baseline(0.8, 0.08, 10);
    near.update(0, 0, false);
    far.update(0, 0, false);
    for (let i = 0; i < 25; i++) {
      near.update(5, 0.04, false); // inside the band
      far.update(500, 0.04, false); // outside it
    }
    expect(near.value / 5).toBeGreaterThan(far.value / 500);
  });
});

describe('HoldTimer', () => {
  it('completes once and stays complete until the condition breaks', () => {
    const h = new HoldTimer();
    let dones = 0;
    for (let i = 0; i < 50; i++) {
      h.update(true, 40, 800);
      if (h.done) dones++;
    }
    expect(dones).toBe(1);
    expect(h.progress(800)).toBe(1);
    h.update(false, 40, 800);
    expect(h.progress(800)).toBe(0);
    for (let i = 0; i < 50; i++) {
      h.update(true, 40, 800);
      if (h.done) dones++;
    }
    expect(dones).toBe(2);
  });

  it('resets its progress the moment the condition lapses', () => {
    const h = new HoldTimer();
    h.update(true, 400, 800);
    expect(h.progress(800)).toBeCloseTo(0.5);
    h.update(false, 40, 800);
    h.update(true, 40, 800);
    expect(h.progress(800)).toBeCloseTo(0.05);
  });
});

describe('Stats', () => {
  it('drops samples outside the window', () => {
    const s = new Stats(1, 64);
    for (let i = 0; i < 50; i++) s.push(10, i * 0.04); // 0..1.96s
    expect(s.count).toBeLessThan(30);
    expect(s.mean).toBeCloseTo(10);
    expect(s.std).toBeCloseTo(0);
    expect(s.max).toBeCloseTo(10);
  });

  it('measures spread, for balance sway', () => {
    const s = new Stats(1, 64);
    for (let i = 0; i < 20; i++) s.push(i % 2 === 0 ? 1 : -1, i * 0.04);
    expect(s.std).toBeGreaterThan(0.9);
  });
});

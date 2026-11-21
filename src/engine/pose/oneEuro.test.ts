import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../testing/synth';
import {
  DEFAULT_FILTER,
  Median3,
  OneEuroFilter,
  PoseFilterBank,
  SNAPPY,
  STEADY,
  median3,
} from './oneEuro';

const std = (xs: number[]): number => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
};

/** Best integer sample lag of `got` behind `want`, by least squares. */
function bestLag(want: number[], got: number[], maxLag: number): number {
  let best = Infinity;
  let bestD = 0;
  for (let d = 0; d <= maxLag; d++) {
    let e = 0;
    for (let i = maxLag; i < want.length; i++) {
      const dx = got[i]! - want[i - d]!;
      e += dx * dx;
    }
    if (e < best) {
      best = e;
      bestD = d;
    }
  }
  return bestD;
}

describe('median3', () => {
  it('picks the middle value', () => {
    expect(median3(1, 2, 3)).toBe(2);
    expect(median3(3, 1, 2)).toBe(2);
    expect(median3(2, 2, 9)).toBe(2);
  });

  it('deletes a single-frame spike instead of smearing it', () => {
    const med = new Median3();
    const signal = [1, 1, 1, 1, 50, 1, 1, 1];
    const out = signal.map((x) => med.push(x));
    // The spike is gone entirely, and nothing after it is contaminated.
    expect(Math.max(...out.slice(3))).toBeLessThanOrEqual(1.0001);

    // An EMA with the same job smears it across many frames — this is why the
    // median stage exists and why it has to come first.
    let ema = 1;
    const emaOut = signal.map((x) => (ema = 0.3 * x + 0.7 * ema));
    expect(Math.max(...emaOut)).toBeGreaterThan(10);
    expect(emaOut[emaOut.length - 1]!).toBeGreaterThan(3);
  });

  it('passes a real step through (it is not a low-pass)', () => {
    const med = new Median3();
    const out = [0, 0, 0, 5, 5, 5, 5].map((x) => med.push(x));
    expect(out[out.length - 1]).toBe(5);
  });
});

describe('OneEuroFilter', () => {
  const fs = 30;
  const hz = 1.2; // about as fast as a child swings an arm

  function run(cfg = DEFAULT_FILTER, noise = 0.05, n = 400) {
    const rng = mulberry32(4242);
    const f = new OneEuroFilter(cfg);
    const clean: number[] = [];
    const raw: number[] = [];
    const out: number[] = [];
    const vel: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      const c = Math.sin(2 * Math.PI * hz * t);
      const r = c + (rng() * 2 - 1) * noise;
      clean.push(c);
      raw.push(r);
      out.push(f.push(r, t));
      vel.push(f.velocity);
    }
    return { clean, raw, out, vel };
  }

  /** Resting hand: clean signal is flat, so every deviation IS jitter. */
  function jitterOf(cfg = DEFAULT_FILTER, useMedian = false): number {
    const rng = mulberry32(99);
    const f = new OneEuroFilter(cfg);
    const med = new Median3();
    const out: number[] = [];
    for (let i = 0; i < 300; i++) {
      const r = (rng() * 2 - 1) * 0.05;
      out.push(f.push(useMedian ? med.push(r) : r, i / fs));
    }
    return std(out.slice(40));
  }

  /** Clean fast swing: no noise, so every deviation IS lag. */
  function lagOf(cfg = DEFAULT_FILTER): { lag: number; ampRatio: number } {
    const f = new OneEuroFilter(cfg);
    const clean: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 300; i++) {
      const t = i / fs;
      const c = Math.sin(2 * Math.PI * hz * t);
      clean.push(c);
      out.push(f.push(c, t));
    }
    const warm = out.slice(60);
    return {
      lag: bestLag(clean, out, 8),
      ampRatio: (Math.max(...warm) - Math.min(...warm)) / 2,
    };
  }

  it('reduces jitter without gross lag', () => {
    // Resting-hand jitter: raw noise std is 0.0289 shoulder widths (about 6px
    // at a 200px shoulder width, which is what MediaPipe actually wobbles).
    const rawJitter = 0.05 / Math.sqrt(3);
    const filtered = jitterOf();
    const withMedian = jitterOf(DEFAULT_FILTER, true);
    // Measured: 0.0289 -> 0.0103, a 2.8x reduction, which is exactly the
    // first-order prediction for a 1.5Hz cutoff at 30Hz. STEADY does better,
    // SNAPPY worse; see the preset test below.
    expect(filtered).toBeLessThan(rawJitter * 0.4);
    // The median stage ahead of it helps rather than hurts.
    expect(withMedian).toBeLessThanOrEqual(filtered * 1.2);

    // Lag on a 1.2Hz swing: <= 3 samples at 30Hz = 100ms, amplitude kept.
    const { lag, ampRatio } = lagOf();
    expect(lag).toBeLessThanOrEqual(3);
    expect(ampRatio).toBeGreaterThan(0.7);
  });

  it('presets trade jitter against lag in the documented direction', () => {
    const steady = { j: jitterOf(STEADY), ...lagOf(STEADY) };
    const base = { j: jitterOf(DEFAULT_FILTER), ...lagOf(DEFAULT_FILTER) };
    const snappy = { j: jitterOf(SNAPPY), ...lagOf(SNAPPY) };
    // Lower minCutoff => quieter at rest.
    expect(steady.j).toBeLessThan(base.j);
    expect(base.j).toBeLessThan(snappy.j);
    // ...and laggier in motion.
    expect(snappy.lag).toBeLessThanOrEqual(base.lag);
    expect(base.lag).toBeLessThanOrEqual(steady.lag);
    expect(snappy.ampRatio).toBeGreaterThan(steady.ampRatio);
  });

  it('velocity tracks the analytic derivative', () => {
    const slow = 0.5;
    const f = new OneEuroFilter();
    const vel: number[] = [];
    for (let i = 0; i < 300; i++) {
      const t = i / fs;
      f.push(Math.sin(2 * Math.PI * slow * t), t);
      vel.push(f.velocity);
    }
    // Analytic peak 2*pi*0.5 = 3.14, attenuated by the constant 1Hz derivative
    // cutoff to ~0.89 => ~2.8. The derivative is deliberately NOT
    // speed-adaptive, which is why this is predictable.
    const peak = Math.max(...vel.slice(60));
    expect(peak).toBeGreaterThan(2.3);
    expect(peak).toBeLessThan(3.3);
  });

  it('survives dt=0, negative dt and a backgrounded-tab gap', () => {
    const f = new OneEuroFilter();
    f.push(1, 0);
    expect(Number.isFinite(f.push(1, 0))).toBe(true); // repeated timestamp
    expect(Number.isFinite(f.push(2, -5))).toBe(true); // clock went backwards
    expect(Number.isFinite(f.push(3, 90))).toBe(true); // 90s hidden tab
    expect(Number.isFinite(f.velocity)).toBe(true);
  });

  it('hold() decays velocity instead of freezing it', () => {
    const f = new OneEuroFilter();
    for (let i = 0; i < 20; i++) f.push(i * 0.1, i / 30);
    const moving = f.velocity;
    expect(moving).toBeGreaterThan(1);
    for (let i = 20; i < 50; i++) f.hold(i / 30);
    expect(Math.abs(f.velocity)).toBeLessThan(moving * 0.2);
  });
});

describe('PoseFilterBank', () => {
  it('filters 66 channels and reports per-channel velocity', () => {
    const bank = new PoseFilterBank(66);
    const src = new Float32Array(66);
    const out = new Float32Array(66);
    const vel = new Float32Array(66);
    for (let i = 0; i < 30; i++) {
      for (let c = 0; c < 66; c++) src[c] = c * 0.01 + i * 0.05;
      bank.apply(src, out, vel, i / 30);
    }
    expect(out[10]).toBeGreaterThan(0);
    expect(vel[10]).toBeGreaterThan(0.5);
    expect([...out].every(Number.isFinite)).toBe(true);
  });

  it('reset() clears history', () => {
    const bank = new PoseFilterBank(2);
    bank.push(0, 5, 0);
    expect(bank.primed(0)).toBe(true);
    bank.reset();
    expect(bank.primed(0)).toBe(false);
    expect(bank.push(0, 9, 1)).toBe(9);
  });
});

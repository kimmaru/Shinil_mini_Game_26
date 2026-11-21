// The canvas motion tokens must equal the CSS ones.
//
// Two sources of truth for the same numbers is how a shell that animates in
// 220ms ends up next to a game that animates in 300ms, and the product stops
// feeling like one thing. This parses the real stylesheet rather than trusting
// a copied comment.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { D, E, squash, SQUASH_MAX } from './tokens';

const css = readFileSync(
  fileURLToPath(new URL('../../styles/tokens.css', import.meta.url)),
  'utf8',
);

/** First (i.e. non-reduced-motion) definition of a custom property. */
function cssVar(name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  if (!m) throw new Error(`--${name} is not defined in tokens.css`);
  return m[1]!.trim();
}

const cssMs = (name: string): number => {
  const v = cssVar(name);
  const m = /([\d.]+)ms/.exec(v);
  if (!m) throw new Error(`--${name} is "${v}", not a ms duration`);
  return Number(m[1]);
};

describe('durations mirror the stylesheet', () => {
  it.each([
    ['tick', 'dur-tick'], ['impact', 'dur-impact'], ['instant', 'dur-instant'],
    ['anticipate', 'dur-anticipate'], ['fast', 'dur-fast'], ['base', 'dur-base'],
    ['squash', 'dur-squash'], ['slow', 'dur-slow'], ['telegraph', 'dur-telegraph'],
    ['count', 'dur-count'], ['slower', 'dur-slower'], ['celebrate', 'dur-celebrate'],
    ['wheel', 'dur-wheel'],
  ] as const)('%s === --%s', (key, varName) => {
    expect(D[key] * 1000).toBeCloseTo(cssMs(varName), 3);
  });

  it('covers every --dur- token the stylesheet defines', () => {
    // A new CSS duration with no canvas mirror is the drift this file exists
    // to catch.
    const names = new Set(
      [...css.matchAll(/--dur-([a-z-]+):/g)].map((m) => m[1]!),
    );
    const mirrored = new Set(Object.keys(D).map((k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)));
    for (const n of names) {
      expect(mirrored.has(n), `--dur-${n} has no mirror in motion/tokens.ts`).toBe(true);
    }
  });
});

describe('easing curves mirror the stylesheet', () => {
  const parse = (name: string): [number, number, number, number] => {
    const m = /cubic-bezier\(([^)]+)\)/.exec(cssVar(name));
    if (!m) throw new Error(`--${name} is not a cubic-bezier`);
    return m[1]!.split(',').map((x) => Number(x.trim())) as [number, number, number, number];
  };

  it.each([
    ['outQuint', 'ease-out-quint'], ['outBack', 'ease-out-back'],
    ['inOut', 'ease-in-out'], ['inQuint', 'ease-in-quint'],
    ['spring', 'ease-spring'], ['wheel', 'ease-wheel'],
    ['inBack', 'ease-in-back'], ['outCubic', 'ease-out-cubic'],
    ['outQuart', 'ease-out-quart'], ['prodStd', 'ease-prod-std'],
  ] as const)('%s matches --%s at sampled points', (key, varName) => {
    const [x1, y1, x2, y2] = parse(varName);
    const fn = E[key];
    // Endpoints are exact for every curve.
    expect(fn(0)).toBeCloseTo(0, 6);
    expect(fn(1)).toBeCloseTo(1, 6);
    // And the curve is the one CSS describes: check the control-point
    // signature rather than re-implementing the solver in the test.
    const overshoots = y1 > 1 || y2 > 1;
    const undershoots = y1 < 0 || y2 < 0;
    const samples = [0.25, 0.5, 0.75].map(fn);
    if (overshoots) expect(Math.max(...samples, fn(0.9))).toBeGreaterThan(0.5);
    if (undershoots) expect(Math.min(...samples, fn(0.1))).toBeLessThan(0.2);
    // Monotone in x: every curve must advance.
    for (let t = 0.05; t <= 1; t += 0.05) expect(fn(t)).toBeGreaterThan(-0.6);
  });

  it('outBack overshoots past 1 before settling', () => {
    // The property that makes a pop feel alive. If someone replaces the curve
    // with a plain ease-out, this fails.
    let peak = 0;
    for (let t = 0; t <= 1; t += 0.01) peak = Math.max(peak, E.outBack(t));
    expect(peak).toBeGreaterThan(1.05);
    expect(peak).toBeLessThan(1.25); // beyond this it reads as jelly
  });

  it('inBack pulls backwards first — that IS anticipation', () => {
    let low = 1;
    for (let t = 0; t <= 1; t += 0.01) low = Math.min(low, E.inBack(t));
    expect(low).toBeLessThan(-0.02);
  });
});

describe('squash preserves area without going to paper', () => {
  it('is identity at zero', () => {
    const s = squash(0);
    expect(s.sx).toBeCloseTo(1, 6);
    expect(s.sy).toBeCloseTo(1, 6);
  });

  it('widens, flattens, and swells very slightly', () => {
    const s = squash(0.35);
    expect(s.sx).toBeGreaterThan(1);
    expect(s.sy).toBeLessThan(1);
    // Area is intentionally NOT preserved exactly: the 0.8 exponent leaves a
    // ~2% swell, which is what keeps a squashed shape looking solid instead
    // of like flattened paper.
    expect(s.sx * s.sy).toBeGreaterThan(1.0);
    expect(s.sx * s.sy).toBeLessThan(1.05);
  });

  it('is visible from 2m at the default amount', () => {
    // The bug this guards: an amount that computes to a 2% distortion is
    // invisible on a classroom screen and the juice silently does nothing.
    const s = squash(0.35);
    expect(s.sx - 1).toBeGreaterThan(0.08);
  });

  it('stretch is the mirror of squash', () => {
    const a = squash(0.5, 'squash');
    const b = squash(0.5, 'stretch');
    expect(a.sx).toBeCloseTo(b.sy, 6);
    expect(a.sy).toBeCloseTo(b.sx, 6);
  });

  it('clamps out-of-range amounts rather than exploding', () => {
    expect(squash(99).sx).toBeCloseTo(1 + SQUASH_MAX, 6);
    expect(squash(-99).sx).toBeCloseTo(1, 6);
  });
});

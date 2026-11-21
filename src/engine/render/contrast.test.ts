// Every colour a child must react to has to be legible on the game canvas.
//
// This exists because two real bugs shipped before it did: the sprite outline
// was near-black on a near-black canvas (1.08:1 — invisible), and the default
// theme lightness put blue-violet hues at 3.18:1, below WCAG AA. Neither was
// visible in code review; both are obvious to a measurement.
import { describe, expect, it } from 'vitest';
import { baseL, C, hue, hueDark, hueLight, KEYLINE_ON_DARK, snapHue, THEME_HUES } from './palette';

/** WCAG relative luminance. */
function luminance(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function parse(col: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(col.trim());
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const hsl = /hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/.exec(col);
  if (hsl) return hslToRgb(+hsl[1]!, +hsl[2]! / 100, +hsl[3]! / 100);
  const rgba = /rgb\(\s*(\d+)\s+(\d+)\s+(\d+)/.exec(col);
  if (rgba) return [+rgba[1]!, +rgba[2]!, +rgba[3]!];
  throw new Error(`cannot parse colour "${col}"`);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const ratio = (a: string, b: string): number => {
  const la = luminance(parse(a));
  const lb = luminance(parse(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** The in-game canvas, dark in both themes. */
const CANVAS = C.bg;

describe('sprite keyline', () => {
  it('is visible on the game canvas', () => {
    // The bug this replaces: near-black ink on a near-black canvas.
    expect(ratio(CANVAS, KEYLINE_ON_DARK)).toBeGreaterThan(10);
  });

  it('documents that near-black ink would NOT be visible there', () => {
    // Kept as an assertion so nobody "simplifies" the keyline back to ink.
    expect(ratio(CANVAS, C.ink)).toBeLessThan(1.5);
  });
});

describe('theme hues', () => {
  it.each(THEME_HUES)('hue %i clears WCAG AA against the canvas', (h) => {
    expect(ratio(CANVAS, hue(h))).toBeGreaterThanOrEqual(4.5);
  });

  it('clears AA across the WHOLE wheel, not just the anchors', () => {
    // A game could pass any hue; the lightness correction has to hold for all
    // of them, not only the twelve we picked.
    for (let h = 0; h < 360; h += 5) {
      expect(ratio(CANVAS, hue(h)), `hue ${h}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('lifts only the blue-violet band, and leaves the rest alone', () => {
    expect(baseL(240)).toBeGreaterThan(baseL(60));
    expect(baseL(60)).toBe(baseL(140));
  });

  it('keeps shade and light distinguishable from the base', () => {
    // 1.12 rather than a larger figure because yellow (hue 58) is already near
    // the top of the lightness range: there is barely any headroom above it,
    // and pushing further would wash it out. Shade and light carry no
    // information (ART.md) — they only need to read as the same object lit
    // from the top-left, so a small separation is the correct target.
    for (const h of THEME_HUES) {
      const base = hue(h);
      expect(ratio(base, hueDark(h)), `hue ${h} shade`).toBeGreaterThan(1.15);
      expect(ratio(base, hueLight(h)), `hue ${h} light`).toBeGreaterThan(1.12);
    }
  });

  it('keeps shade readable enough not to vanish into the canvas', () => {
    // Shade carries no information (ART.md), but an object's shaded side still
    // has to read as part of the object rather than a hole in it.
    for (const h of THEME_HUES) {
      expect(ratio(CANVAS, hueDark(h)), `hue ${h}`).toBeGreaterThan(2.2);
    }
  });
});

describe('snapHue', () => {
  it('maps any angle onto one of the twelve anchors', () => {
    for (let h = -720; h <= 720; h += 7) {
      expect(THEME_HUES).toContain(snapHue(h));
    }
  });

  it('leaves an anchor untouched', () => {
    for (const h of THEME_HUES) expect(snapHue(h)).toBe(h);
  });

  it('wraps across 0 rather than snapping the long way round', () => {
    expect(snapHue(355)).toBe(8);
  });
});

describe('semantic colours on the canvas', () => {
  it.each([
    ['accent', C.accent], ['success', C.success], ['danger', C.danger],
    ['warn', C.warn], ['hot', C.hot], ['white', C.white], ['text', C.text],
  ])('%s is legible', (_name, col) => {
    expect(ratio(CANVAS, col)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(C.slot.map((c, i) => [i, c] as const))(
    'player slot %i is legible', (_i, col) => {
      expect(ratio(CANVAS, col)).toBeGreaterThanOrEqual(4.5);
    });
});

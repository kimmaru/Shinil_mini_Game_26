// Every colour a child must react to has to be legible on the game canvas.
//
// This exists because two real bugs shipped before it did: the sprite outline
// was near-black on a near-black canvas (1.08:1 — invisible), and the default
// theme lightness put blue-violet hues at 3.18:1, below WCAG AA. Neither was
// visible in code review; both are obvious to a measurement.
import { describe, expect, it } from 'vitest';
import { baseL, C, hue, hueDark, hueLight, KEYLINE, snapHue, THEME_HUES } from './palette';

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
  it('is what makes a shape legible on the light canvas', () => {
    // The keyline, not the fill, carries legibility here: a yellow fill is
    // only ~2:1 against cream no matter how its lightness is tuned, while the
    // ink outline around it is 18:1. That is how flat-cartoon art works on a
    // light ground, and why the fill is free to be a colour rather than a
    // contrast obligation.
    expect(ratio(CANVAS, KEYLINE)).toBeGreaterThan(12);
  });

  it('is not pure black', () => {
    // Black is heavy, and this audience is seven.
    expect(KEYLINE.toLowerCase()).not.toBe('#000000');
  });
});

describe('theme hues', () => {
  it.each(THEME_HUES)('hue %i is distinguishable from the canvas', (h) => {
    // 2:1 rather than 4.5:1 — the fill is colour, the keyline is contrast
    // (see above). What matters is that a filled shape never blends INTO the
    // cream ground and vanishes.
    expect(ratio(CANVAS, hue(h))).toBeGreaterThanOrEqual(2);
  });

  it('holds across the WHOLE wheel, not just the anchors', () => {
    for (let h = 0; h < 360; h += 5) {
      expect(ratio(CANVAS, hue(h)), `hue ${h}`).toBeGreaterThanOrEqual(1.8);
    }
  });

  it('darkens the yellow-green band, which HSL lightness alone does not', () => {
    // HSL L is not perceptual: at the same L, yellow is far brighter than
    // blue. Without this correction a yellow object is 1.2:1 on cream.
    expect(baseL(60)).toBeLessThan(baseL(240));
    expect(baseL(60)).toBeLessThan(baseL(320));
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

  it('keeps shade distinct from the canvas', () => {
    // Shade carries no information (ART.md), but an object's shaded side still
    // has to read as part of the object rather than a hole in it.
    for (const h of THEME_HUES) {
      expect(ratio(CANVAS, hueDark(h)), `hue ${h}`).toBeGreaterThan(2.5);
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

describe('text and semantic colours on the canvas', () => {
  it('text clears the 7:1 bar a child reads at 2m', () => {
    expect(ratio(CANVAS, C.text)).toBeGreaterThanOrEqual(7);
  });

  it('dim text is still readable', () => {
    expect(ratio(CANVAS, C.textDim)).toBeGreaterThanOrEqual(4.5);
  });

  it('white alone would be invisible — so it must never carry meaning', () => {
    // Documented as an assertion so nobody fills a shape with plain white and
    // wonders where it went.
    expect(ratio(CANVAS, C.white)).toBeLessThan(1.3);
  });

  it.each([
    ['success', C.success], ['danger', C.danger], ['warn', C.warn], ['hot', C.hot],
  ])('%s is distinguishable', (_name, col) => {
    expect(ratio(CANVAS, col)).toBeGreaterThanOrEqual(1.8);
  });

  it.each(C.slot.map((c, i) => [i, c] as const))(
    'player slot %i stands out from the canvas', (_i, col) => {
      // Higher bar than the decorative colours: a player's skeleton is the
      // thing they are steering, and it must not wash out.
      expect(ratio(CANVAS, col)).toBeGreaterThanOrEqual(3);
    });

  it('tells players apart by hue, never by luminance alone', () => {
    // Documented deliberately: the slot colours are close in luminance, which
    // is exactly why every player-coloured element also carries a shape badge
    // and a number.
    expect(C.slotShape.length).toBe(C.slot.length);
  });
});

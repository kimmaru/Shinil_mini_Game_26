// Colors available to games. Mirrors src/styles/tokens.css so the canvas and
// the DOM shell cannot drift apart.
//
// The in-game canvas is dark in BOTH themes: particles, glows and the skeleton
// overlay have to read consistently, and a light canvas blows out next to a
// camera preview.
export const C = {
  bg: '#101733',
  bgDeep: '#080C1A',
  ink: '#0B0F20',

  primary: '#4C6FFF',
  primaryLo: '#93AAFF',
  primaryHi: '#2F4FE0',
  secondary: '#A259FF',
  accent: '#FFB300',
  accentHi: '#FFC53D',
  hot: '#FF4D8D',
  success: '#16C47F',
  warn: '#FF9F1C',
  danger: '#FF4D4D',
  info: '#19B5FE',

  white: '#FFFFFF',
  text: '#F2F5FF',
  textDim: '#B7C0DC',
  textFaint: '#8390B2',

  /** Player slots. NEVER the only cue — pair with the shape badges below. */
  slot: ['#2FA8FF', '#FF7A45', '#39D98A', '#C77DFF'] as const,
  /** Kahoot's rule: color + shape + number, so color-blind players and a
   *  shouted "빨간 세모!" both work. */
  slotShape: ['▲', '◆', '●', '■'] as const,
} as const;

/**
 * Base lightness for a hue, on the dark game canvas.
 *
 * Blue-violet sits in the same region of the spectrum as the canvas itself
 * (#101733), so a flat lightness fails there and nowhere else. Measured at
 * L=62: hue 240 lands at 3.18:1 against the canvas — below WCAG AA — while
 * hue 60 reaches 13.4:1. Lifting only 205-295 brings the whole wheel above
 * 4.5:1 with one line instead of 58 hand-tuned colours.
 */
export const baseL = (h: number): number => {
  const n = ((h % 360) + 360) % 360;
  return n >= 205 && n <= 295 ? 72 : 62;
};

/** A game's own accent, from `manifest.theme.hue`. Lightness defaults to the
 *  contrast-corrected value; pass `l` only when you have measured it. */
export const hue = (h: number, s = 78, l = baseL(h), a = 1): string =>
  a >= 1 ? `hsl(${h} ${s}% ${l}%)` : `hsl(${h} ${s}% ${l}% / ${a})`;

/**
 * The twelve theme hues a game may choose from.
 *
 * NOT 58 hues: 360/58 is 6 degrees apart, which no one can tell apart, so
 * splitting the wheel that finely loses both unity and distinctness. Twelve
 * anchors are individually recognisable, and a game's real identity comes from
 * its objects and layout rather than its colour.
 */
export const THEME_HUES = [8, 26, 42, 58, 92, 140, 168, 192, 212, 238, 266, 322] as const;

/** Snap an arbitrary hue to the nearest anchor, so a stray value cannot
 *  introduce a 13th colour. */
export function snapHue(h: number): number {
  const n = ((h % 360) + 360) % 360;
  let best = THEME_HUES[0] as number;
  let bestD = 360;
  for (const t of THEME_HUES) {
    const d = Math.min(Math.abs(n - t), 360 - Math.abs(n - t));
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

/** One step darker: the shade side of an object. Light is fixed top-left
 *  across the whole catalogue, so shade is always bottom-right. */
export const hueDark = (h: number): string => `hsl(${h} 72% ${baseL(h) - 14}%)`;
/** One step lighter: highlights. */
export const hueLight = (h: number): string =>
  `hsl(${h} 85% ${Math.min(92, baseL(h) + 14)}%)`;

/**
 * The outline colour for sprites.
 *
 * Measured on the game canvas: near-black ink is 1.08:1 — invisible. White at
 * 0.92 alpha is 17.6:1. So the house keyline inverts on dark, which is the one
 * place this project departs from the flat-cartoon references it borrows from
 * (they all assume a light background).
 */
export const KEYLINE_ON_DARK = 'rgb(255 255 255 / 0.92)';
/** On a light panel, a same-hue dark rather than pure black: black is heavy
 *  and this audience is seven. */
export const keylineOnLight = (h: number): string => `hsl(${h} 55% 20%)`;

/** Translucent white, for soft overlays and trails. */
export const fade = (c: string, a: number): string => {
  if (c.startsWith('#') && c.length === 7) {
    const n = Number.parseInt(c.slice(1), 16);
    return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${a})`;
  }
  return c;
};

// Colors available to games. Mirrors src/styles/tokens.css so the canvas and
// the DOM shell cannot drift apart.
//
// The in-game canvas is dark in BOTH themes: particles, glows and the skeleton
// overlay have to read consistently, and a light canvas blows out next to a
// camera preview.
export const C = {
  /**
   * The in-game canvas. Warm cream, not white: pure white reads cold and
   * clinical, and this is a game for seven-year-olds.
   *
   * This is a LIGHT canvas. On a dark one the sprite keyline had to invert to
   * white; here near-black ink is 18:1 and does the job properly, which is
   * what every flat-cartoon reference assumes in the first place.
   */
  bg: '#FFF8EC',
  /** A slightly deeper ground, for floors and insets. */
  bgDeep: '#F4E7D2',
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
  /** Text on the light canvas. */
  text: '#1A1D2E',
  textDim: '#4A5068',
  textFaint: '#7C8398',

  /**
   * Player slots, tuned for the light canvas: 3.5-5.2:1 against cream, where
   * the old bright set fell to 1.7:1 and a green player's skeleton washed out.
   *
   * Their luminances are deliberately close to each other — they are told
   * apart by HUE, and never by colour alone: every player-coloured element
   * also carries a shape badge and a slot number.
   */
  slot: ['#1B7FD4', '#E05A1E', '#128F5A', '#8B3FD9'] as const,
  /** Color + shape + number, so a colour-blind player and a shouted
   *  "빨간 세모!" both work. */
  slotShape: ['▲', '◆', '●', '■'] as const,
} as const;

/**
 * Base lightness for a hue, on the light game canvas.
 *
 * HSL lightness is not perceptual: at a given L, yellow is far brighter to the
 * eye than blue. Measured against the cream canvas, hue 60 at L=50 is 1.2:1
 * while hue 240 at the same L is 8:1 — so the yellow-green band has to come
 * down hard or it disappears.
 *
 * Fill contrast is not the whole story here, though: every sprite carries a
 * near-black keyline at 18:1, and that is what defines the shape. The fill is
 * colour, not legibility, which is exactly the arrangement flat-cartoon art
 * assumes on a light ground.
 */
export const baseL = (h: number): number => {
  const n = ((h % 360) + 360) % 360;
  // Yellow through yellow-green: the band that needs the most correction.
  if (n >= 40 && n <= 95) return 38;
  // Cyan and warm greens sit high too.
  if (n > 95 && n <= 190) return 42;
  return 50;
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
 * The outline colour for sprites, on the light canvas.
 *
 * Measured at 18:1 against the cream ground. Not pure black — black is heavy
 * and this audience is seven — but dark enough that it, rather than the fill,
 * is what makes a shape legible at 2m.
 */
export const KEYLINE = '#171A2B';
/** Kept for surfaces that are still dark (the debug overlay, a photo frame). */
export const KEYLINE_ON_DARK = 'rgb(255 255 255 / 0.92)';
/** A same-hue dark, for an object that wants its outline to belong to it. */
export const keylineOnLight = (h: number): string => `hsl(${h} 55% 24%)`;

/** Translucent white, for soft overlays and trails. */
export const fade = (c: string, a: number): string => {
  if (c.startsWith('#') && c.length === 7) {
    const n = Number.parseInt(c.slice(1), 16);
    return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${a})`;
  }
  return c;
};

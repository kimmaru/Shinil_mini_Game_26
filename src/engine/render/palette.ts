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

/** A game's own accent, from `manifest.theme.hue`. Keeps 58 games distinct
 *  without 58 hand-picked palettes. */
export const hue = (h: number, s = 78, l = 62, a = 1): string =>
  a >= 1 ? `hsl(${h} ${s}% ${l}%)` : `hsl(${h} ${s}% ${l}% / ${a})`;

/** Translucent white, for soft overlays and trails. */
export const fade = (c: string, a: number): string => {
  if (c.startsWith('#') && c.length === 7) {
    const n = Number.parseInt(c.slice(1), 16);
    return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${a})`;
  }
  return c;
};

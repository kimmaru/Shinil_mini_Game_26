// The in-game sky behind every game: gradient stops (0 = top, 1 = bottom) and
// one static decoration layer.
//
// Shared by the canvas renderer and the SVG shot renderer so `npm run shot`
// shows the colours a child actually sees. The two drifted once — shots were
// painted a saturated sky while the real canvas was pastel — and every game
// was then contrast-tuned against a background nobody would ever see.
import { C } from './palette';

export type SkyStop = readonly [offset: number, color: string];

/**
 * Top-of-sky saturation and lightness per hue band.
 *
 * HSL lightness is not perceptual (see `baseL` in palette.ts): at one S/L the
 * yellow-olive band turns to mud and blue goes grey-white. So each band gets
 * its own pair, all landing at roughly the same perceived brightness — bright
 * enough to read as a party, light enough that ink-outlined objects keep
 * their contrast.
 */
function topSL(h: number): readonly [s: number, l: number] {
  if (h >= 36 && h < 70) return [92, 78]; // yellow: stay bright or it goes olive
  if (h >= 70 && h < 100) return [70, 80]; // lime: less saturation or it turns acid
  if (h >= 100 && h < 190) return [64, 76]; // green, teal
  if (h >= 190 && h < 225) return [86, 77]; // sky blue
  if (h >= 225 && h < 250) return [80, 82]; // indigo: dark for its L, so lighter
  if (h >= 250 && h < 330) return [78, 83]; // violet, magenta
  return [92, 82]; // red, coral, orange
}

/** `hue < 0` = no game hue: the plain warm ground. */
export function skyStops(hue: number): readonly SkyStop[] {
  if (hue < 0) return [[0, C.bg], [1, C.bgDeep]];
  // The game's own colour, saturated at the top, settling into a light middle
  // and a warm floor. Every game is recognisably the same product, and the
  // sky still says "this one is the green game".
  const [s, l] = topSL(hue);
  return [
    [0, `hsl(${hue} ${s}% ${l}%)`],
    [0.55, `hsl(${hue} ${Math.round(s * 0.8)}% 92%)`],
    [0.8, 'hsl(40 85% 93%)'],
    [1, 'hsl(33 78% 84%)'],
  ];
}

/**
 * Decoration: big soft "party light" dots in the upper sky, as
 * [x / w, y / h, r / min(w, h)] triples. Static, so each renderer lays them out
 * once per size and draws them as ONE fill.
 *
 * White at low alpha: 1.1–1.3:1 against the sky, inside the 1.2–2.0 band
 * ART.md allows for background decoration, so nothing a child must react to
 * can ever be confused with one.
 */
export const SKY_DOTS: readonly number[] = [
  0.05, 0.1, 0.1,
  0.2, 0.36, 0.05,
  0.3, 0.08, 0.065,
  0.41, 0.3, 0.035,
  0.53, 0.07, 0.085,
  0.64, 0.34, 0.045,
  0.75, 0.12, 0.06,
  0.87, 0.38, 0.075,
  0.97, 0.09, 0.07,
  0.11, 0.58, 0.04,
  0.92, 0.62, 0.045,
];
export const SKY_DOT_FILL = 'rgb(255 255 255 / 0.3)';

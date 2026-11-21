// The shared sprite set: shapes that recur across the catalogue, authored once.
//
// Every sprite lives in a 100x100 box with its visual centre near (50, 50).
// Colours are palette ROLES, not literals, so one definition serves 58 games:
// `star` is gold as a reward and the game's own hue as a collectible, and
// neither game redefined it.
//
// House style (see ART.md):
//   - a dark outline on every silhouette, 5 author units thick
//   - generous corner radii; nothing sharp except deliberate spikes
//   - at most ~4 layers per sprite, so it still reads at 40px from 2m away
//   - flat fills only: no gradients, no inner shading
import {
  circlePath, defineSprites, linePath, polyPath, roundRectPath, starPath,
  type Sprite,
} from './sprite';

/**
 * House outline weight, in author units (= % of the sprite).
 *
 * 4% rather than the 8% an icon set like Lucide uses: those are read at 24px,
 * these are 40-200px game objects, and 8% there turns the outline into the
 * drawing.
 */
const SW = 4;
/** Hero objects — the thing the player is actually chasing. */
const SW_HERO = 5;

/**
 * The outline is WHITE, not black.
 *
 * Measured on the game canvas (#101733): near-black ink is 1.08:1, i.e.
 * invisible, while white at 0.92 alpha is 17.6:1. Every flat-cartoon
 * reference this style borrows from assumes a light background; on a dark one
 * the keyline has to invert. This is the single most important rule here.
 */
const KEY = 'keyline';

/** A filled shape with the house outline. */
const solid = (d: string, fill: Sprite['layers'][0]['fill'], sw = SW): Sprite['layers'][0] =>
  ({ d, fill, stroke: KEY, sw });

/** An unfilled detail line, drawn in the shade of its own object rather than
 *  in the keyline colour, so detail never competes with silhouette. */
const detail = (d: string, sw = 3): Sprite['layers'][0] =>
  ({ d, stroke: 'ink', sw });

defineSprites({
  // ─── Universal ─────────────────────────────────────────────────────────────
  star: { layers: [solid(starPath(50, 50, 46, 5, 0.46), 'accent', SW_HERO)] },
  starOutline: { layers: [{ d: starPath(50, 50, 46, 5, 0.46), stroke: 'tint', sw: 7 }] },
  sparkle: {
    layers: [solid(starPath(50, 50, 44, 4, 0.26), 'white')],
  },
  heart: {
    layers: [solid(
      'M50 86C24 68 10 54 10 38a22 22 0 0 1 40-13A22 22 0 0 1 90 38c0 16-14 30-40 48Z',
      'danger',
    )],
  },
  circle: { layers: [solid(circlePath(50, 50, 44), 'theme')] },
  ring: { layers: [{ d: circlePath(50, 50, 40), stroke: 'tint', sw: 10 }] },
  square: { layers: [solid(roundRectPath(8, 8, 84, 84, 16), 'theme')] },
  triangle: { layers: [solid(polyPath(50, 54, 46, 3), 'theme')] },

  /** Chevron/arrow, pointing right at rot 0. */
  arrow: {
    layers: [solid('M28 16 72 50 28 84 40 50Z', 'theme')],
  },

  // ─── Targets and collectibles ──────────────────────────────────────────────
  target: {
    layers: [
      solid(circlePath(50, 50, 44), 'white', SW_HERO),
      { d: circlePath(50, 50, 30), fill: 'danger' },
      { d: circlePath(50, 50, 16), fill: 'white' },
      { d: circlePath(50, 50, 6), fill: 'danger' },
      { d: circlePath(50, 50, 44), stroke: KEY, sw: SW_HERO },
    ],
  },

  balloon: {
    layers: [
      solid('M50 8c20 0 32 16 32 33 0 19-20 33-32 45C38 74 18 60 18 41 18 24 30 8 50 8Z', 'theme'),
      detail('M50 86q6 6 0 10'),
      { d: circlePath(38, 30, 7), fill: 'white' },
    ],
  },

  candy: {
    layers: [
      solid('M8 30 30 50 8 70Z', 'themeLight'),
      solid('M92 30 70 50 92 70Z', 'themeLight'),
      solid(circlePath(50, 50, 24), 'theme'),
      { d: 'M40 40q10 10 0 20', stroke: 'white', sw: 5 },
    ],
  },

  honey: {
    layers: [
      solid(polyPath(50, 50, 40, 6, 0), 'accent'),
      { d: polyPath(50, 50, 24, 6, 0), stroke: 'white', sw: 5 },
    ],
  },

  rock: {
    layers: [
      solid('M18 72 10 44 32 20 66 16 90 40 84 74 52 88Z', '#6B7390'),
      detail('M34 40 52 34 60 52', 3),
    ],
  },

  basket: {
    layers: [
      solid('M12 34h76l-9 50a8 8 0 0 1-8 7H29a8 8 0 0 1-8-7Z', '#C98B4B'),
      detail('M32 42 38 84M50 42v42M68 42 62 84', 3),
      { d: 'M12 34h76', stroke: KEY, sw: 6 },
    ],
  },

  // ─── Creatures ─────────────────────────────────────────────────────────────
  mosquito: {
    layers: [
      // Wings behind the body, so the outline reads as one silhouette.
      solid('M34 32q-24-16-28 4 18 12 28 2Z', 'white'),
      solid('M66 32q24-16 28 4-18 12-28 2Z', 'white'),
      solid('M50 26q14 0 14 18t-14 34q-14-16-14-34t14-18Z', '#4A5570'),
      { d: circlePath(50, 24, 11), fill: '#4A5570', stroke: KEY, sw: SW },
      detail('M44 14 38 4M56 14 62 4', 3),
    ],
  },

  bee: {
    layers: [
      solid('M34 30q-22-14-26 4 16 12 26 2Z', 'white'),
      solid('M66 30q22-14 26 4-16 12-26 2Z', 'white'),
      solid('M50 24q20 0 20 24t-20 32q-20-14-20-32t20-24Z', 'accent'),
      { d: 'M32 44h36M34 60h32', stroke: 'ink', sw: 6 },
    ],
  },

  // ─── Water ─────────────────────────────────────────────────────────────────
  wave: {
    layers: [
      solid('M4 56q14-22 30 0t30 0 32 0v34H4Z', 'theme'),
      { d: 'M4 56q14-22 30 0t30 0 32 0', stroke: 'white', sw: 6 },
    ],
  },

  bubble: {
    layers: [
      { d: circlePath(50, 50, 38), stroke: 'white', sw: 7 },
      { d: circlePath(36, 36, 9), fill: 'white' },
    ],
  },

  droplet: {
    layers: [solid('M50 8q30 36 30 52a30 30 0 0 1-60 0c0-16 30-52 30-52Z', 'theme')],
  },

  // ─── Feedback ──────────────────────────────────────────────────────────────
  check: {
    layers: [{ d: linePath([20, 52, 42, 74, 82, 26]), stroke: 'success', sw: 13 }],
  },
  cross: {
    layers: [{ d: 'M26 26 74 74M74 26 26 74', stroke: 'danger', sw: 13 }],
  },
  burst: {
    layers: [solid(starPath(50, 50, 46, 8, 0.52), 'accent')],
  },
});

export {};

// Motion tokens for the canvas layer — the mirror of `src/styles/tokens.css`.
//
// The DOM shell animates with CSS tokens; games animate with numbers in a
// fixed-step loop. Without a mirror, 58 authors invent 58 sets of
// milliseconds and the catalogue stops reading as one product — exactly the
// failure the colour palette mirror already prevents.
//
// Units are SECONDS, because that is what the engine's `dt` is.
// `tokens.test.ts` parses the CSS and fails if these drift apart.

/** Durations, in seconds. Pick a situation, never a number. */
export const D = {
  /** One counter step, one beat pulse. The floor below which a change reads
   *  as a glitch rather than a step. */
  tick: 0.05,
  /** Hitstop, and the attack frame of a hit squash. */
  impact: 0.06,
  /** Hover, focus ring, chip colour. */
  instant: 0.08,
  /** The wind-up before a move. NEVER on something the player must react to:
   *  delaying a signal by 110ms is fatal in a whole-body game. */
  anticipate: 0.11,
  /** Press release, check mark, small state change. Feedback lives here. */
  fast: 0.14,
  /** Panels, cards, toasts. */
  base: 0.22,
  /** Squash decay. */
  squash: 0.26,
  /** Screen transitions, modals. */
  slow: 0.36,
  /** "Get ready" warning. 1.7x the adult figure: a whole-body reaction needs
   *  a weight shift before it can start. */
  telegraph: 0.42,
  /** Score count-up. */
  count: 0.45,
  /** Results assembling. A child reads a non-interactive wait longer than
   *  this as "broken" and starts moving, which pollutes the pose input. */
  slower: 0.56,
  /** The full three-star celebration. Here the animation IS the reward, so
   *  adult "keep it short" guidance is inverted. */
  celebrate: 0.9,
  /** The roulette. The one place a long wait is a show rather than a delay. */
  wheel: 3.4,
} as const;

export type DurationName = keyof typeof D;

// ─── Easing ──────────────────────────────────────────────────────────────────
// Cubic-bezier evaluation, matching the CSS curves exactly so a thing that
// moves in the DOM and the same thing on canvas share a feel.

const bezier = (x1: number, y1: number, x2: number, y2: number) => {
  // Newton-Raphson on x, then evaluate y. Converges in 4 iterations for the
  // curves we ship; cheap enough to call per frame.
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number): number => ((ax * t + bx) * t + cx) * t;
  const slopeX = (t: number): number => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 5; i++) {
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      const e = sampleX(t) - x;
      if (Math.abs(e) < 1e-6) break;
      t -= e / d;
    }
    return ((ay * t + by) * t + cy) * t;
  };
};

export const E = {
  /** Default exit and settle. Covers 80% of the distance in the first 20% of
   *  the time, which is what makes something feel like it arrived. */
  outQuint: bezier(0.22, 1, 0.36, 1),
  /** Pop-in: buttons, stars, badges, collected items. Never on panels. */
  outBack: bezier(0.34, 1.56, 0.64, 1),
  inOut: bezier(0.4, 0, 0.2, 1),
  /** Leaving the screen. */
  inQuint: bezier(0.64, 0, 0.78, 0),
  spring: bezier(0.16, 1.1, 0.3, 1),
  wheel: bezier(0.12, 0.76, 0.06, 1),
  /** Anticipation: pulls backwards before going forwards. */
  inBack: bezier(0.36, 0, 0.66, -0.56),
  /** Squash decay. */
  outCubic: bezier(0.33, 1, 0.68, 1),
  /** Counter values. */
  outQuart: bezier(0.25, 1, 0.5, 1),
  /** Settings and lobby UI: efficient, out of the way. */
  prodStd: bezier(0.2, 0, 0.38, 0.9),
  linear: (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t),
} as const;

export type EaseName = keyof typeof E;

// ─── Squash and stretch ──────────────────────────────────────────────────────

/** Maximum distortion at amount = 1. Below ~0.25 the effect is invisible from
 *  2m; above ~0.35 a character reads as a damaged object rather than a
 *  squashed one. */
export const SQUASH_MAX = 0.3;

/**
 * Squash and stretch, with DELIBERATELY imperfect area preservation.
 *
 * True preservation (sy = 1/sx) flattens too far and reads as paper, so the
 * exponent is 0.8: the shape gains about `grow^0.2` of area — roughly 2% at
 * the default amount. That slight swell is what animators actually draw, and
 * it is why a squashed object still looks solid.
 *
 * `amount` 0.35 (the engine default) gives 1.105 / 0.917 — the classic
 * cartoon 1.2 / 0.83 toned down for a 2m viewing distance.
 */
export function squash(amount: number, axis: 'squash' | 'stretch' = 'squash'): {
  sx: number;
  sy: number;
} {
  const a = amount < 0 ? 0 : amount > 1 ? 1 : amount;
  const grow = 1 + a * SQUASH_MAX;
  const shrink = 1 / Math.pow(grow, 0.8);
  return axis === 'squash' ? { sx: grow, sy: shrink } : { sx: shrink, sy: grow };
}

/** Text and faces distort far less: past ~12% a word stops being readable at
 *  2m, which defeats the point of showing it. */
export const SQUASH_MAX_TEXT = 0.12;

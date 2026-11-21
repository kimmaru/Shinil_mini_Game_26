// ══ FROZEN CONTRACT ══ imported by 58 game modules.
//
// Shapes, text and emoji. That is the whole drawing vocabulary.
//
// There is deliberately NO `ctx` getter. Two things follow from that, and both
// are the point:
//   1. 58 games drawn from one vocabulary look like one product instead of 58
//      jam entries.
//   2. There are no image/audio/font files in src/games/**, so the merge
//      surface between parallel authors is literally zero.
// If you think you need raw canvas access, you need an engine feature. Write a
// NEEDS.md instead of reaching through.
import type { PlayerPose } from '../types';

export interface Paint {
  /** CSS color. Prefer the palette helpers in `./palette`. */
  fill?: string;
  stroke?: string;
  /** Stroke width in logical px. */
  sw?: number;
  /** Outer glow radius in px. Costs a shadow blur — use on hero objects only. */
  glow?: number;
  /** Glow color; defaults to `stroke ?? fill`. */
  glowColor?: string;
}

export interface TextOpts {
  size?: number;
  /** 400..900. Never below 500 for anything a child reads at 2m. */
  weight?: number;
  align?: 'left' | 'center' | 'right';
  baseline?: 'top' | 'middle' | 'bottom' | 'alphabetic';
  fill?: string;
  /** Outline drawn behind the fill. Essential over a busy game background. */
  stroke?: string;
  sw?: number;
  /** Use the chunky display face (game titles, big numbers). */
  display?: boolean;
  /** Tabular figures so a counter does not jitter as digits change. */
  tabular?: boolean;
  maxWidth?: number;
  /** Rotation in radians about (x, y). */
  rot?: number;
}

export interface SkeletonOpts {
  alpha?: number;
  /** Defaults to the player's slot color. */
  color?: string;
  /** Joint dot radius in px. 0 hides the dots. */
  jointR?: number;
  lineWidth?: number;
  /** Draw a dark outline under the limbs so they read on any background. */
  outline?: boolean;
  /** Highlight these joints at 2x radius — "this is the hand that matters". */
  emphasize?: readonly number[];
}

export interface Renderer {
  /** Logical (CSS) px. Always use these, never window dimensions. */
  readonly w: number;
  readonly h: number;
  /** Seconds since the round started. For ambient animation that must not
   *  depend on the fixed-step clock. */
  readonly t: number;
  /** min(w, h) / 1000 — multiply sizes by this to scale across a 13" laptop
   *  and a living-room TV. Hard-coded pixel sizes break on one or the other. */
  readonly s: number;

  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(rad: number): void;
  scale(x: number, y: number): void;
  /** Multiplies into the current alpha; does not replace it. */
  alpha(a: number): void;

  /** Fill the frame with the in-game background, tinted by the manifest hue.
   *  Call this first in render() — the engine does not clear for you. */
  clear(hue?: number): void;

  circle(x: number, y: number, r: number, p: Paint): void;
  /** Arc/ring segment. a0/a1 in radians, 0 = 3 o'clock. For dwell gauges. */
  arc(x: number, y: number, r: number, a0: number, a1: number, p: Paint): void;
  rect(x: number, y: number, w: number, h: number, p: Paint): void;
  roundRect(x: number, y: number, w: number, h: number, r: number, p: Paint): void;
  line(x0: number, y0: number, x1: number, y1: number, width: number, p: Paint): void;
  /** `pts` is [x0,y0,x1,y1,...]; only the first `n` POINTS are read. */
  poly(pts: Float32Array, n: number, p: Paint, close?: boolean): void;
  star(x: number, y: number, r: number, spikes: number, p: Paint): void;
  /** Triangle pointing in `dir` radians. Arrows, chevrons, pointers. */
  chevron(x: number, y: number, r: number, dir: number, p: Paint): void;

  text(s: string, x: number, y: number, o?: TextOpts): void;
  /** Measured width in px, for layout. */
  measure(s: string, o?: TextOpts): number;
  /** All "art" is emoji + shapes. No sprite sheets, no image files. */
  emoji(s: string, x: number, y: number, size: number, rot?: number): void;

  /** The engine owns mirroring, slot color and the dark outline. */
  skeleton(p: PlayerPose, o?: SkeletonOpts): void;
  /** Soft filled body blob — the "shadow" look used by silhouette games. */
  ghostBody(p: PlayerPose, alpha: number): void;
}

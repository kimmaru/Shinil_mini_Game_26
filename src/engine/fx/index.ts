// ══ FROZEN CONTRACT ══ imported by 58 game modules.
//
// Juice. All of it is procedural — there are no particle textures, no sprite
// sheets, no shaders. A game calls these; the engine draws them ON TOP of the
// game's own render pass, so you never manage a particle list yourself.
import type { Slot } from '../types';

export interface BurstOpts {
  /** Particle count. Clamped to a budget; asking for 5000 gets you ~300. */
  count?: number;
  color?: string;
  /** Second color; particles interpolate between the two. */
  color2?: string;
  /** px/sec. Default scales with the view. */
  speed?: number;
  /** Cone direction in radians; omit for a full circle. */
  dir?: number;
  /** Cone width in radians. Default TAU. */
  spread?: number;
  /** Seconds. Default 0.6. */
  life?: number;
  /** Particle radius in px. Default 4 * view scale. */
  size?: number;
  /** Downward acceleration, px/sec^2. 0 for sparks, high for debris. */
  gravity?: number;
  /** A sprite instead of plain dots — the cheapest way to make a hit feel
   *  specific to what was hit. */
  sprite?: string;
}

export interface TrailOpts {
  color?: string;
  width?: number;
  /** Seconds the trail persists. Default 0.25. */
  life?: number;
}

/**
 * Impact grades.
 *
 * This is the single most important API in the effects layer. Without it an
 * author picks six numbers per hit — burst count, shake power, hitstop length,
 * flash, squash, text — and 58 authors picking six numbers each is precisely
 * how a catalogue stops feeling like one product.
 *
 *   'tap'   collecting, touching        no shake to speak of, no hitstop
 *   'hit'   the normal hit              the default; what most games want
 *   'big'   a break, a 10-combo         noticeable, still frequent
 *   'huge'  a boss, a milestone         once or twice a round, never more
 */
export type ImpactLevel = 'tap' | 'hit' | 'big' | 'huge';

export interface ImpactOpts {
  color?: string;
  /** A sprite for the particles, which is the cheapest way to make a hit feel
   *  specific to the thing that was hit. */
  sprite?: string;
  /** Floating text, e.g. "+10". */
  label?: string;
  /** Key to squash, if the struck object draws itself through `squashAt`. */
  squashKey?: string;
  /** Cone direction in radians; omit for all directions. */
  dir?: number;
}

export interface FxService {
  /** Particle burst at a point. The default hit effect. */
  burst(x: number, y: number, o?: BurstOpts): void;
  /** Full-screen celebration. Reserve for round-level wins, not every hit. */
  confetti(o?: BurstOpts): void;
  /** Camera shake. `power` 0..1; 0.12 is a solid hit, 0.5 is a disaster.
   *  Suppressed entirely under reduced-motion. */
  shake(power: number, durationSec?: number): void;
  /**
   * Full-viewport flash. `power` 0..1.
   *
   * The engine enforces WCAG 2.3.1 — at most 3 flashes/sec, never a saturated
   * red, and the flashing region capped. 58 authors cannot each get this right,
   * so the rule lives here and extra calls are silently dropped.
   */
  flash(color?: string, power?: number): void;
  /** Expanding ring at a point. Reads as "this registered". */
  pop(x: number, y: number, r: number, color?: string): void;
  /** Fading line segment, for swings and slices. */
  trail(x0: number, y0: number, x1: number, y1: number, o?: TrailOpts): void;
  /**
   * Freeze the fixed-step clock briefly so a hit lands with weight.
   * 0.04-0.08s is right; anything longer reads as a stutter. Rhythm games must
   * never use this — it desynchronizes the audio clock.
   */
  hitstop(seconds: number): void;
  /** Squash-and-stretch a drawn object. Returns a 0..1 decaying amount to
   *  multiply your own scale by; the engine only keeps the timer. */
  squash(key: string, amount?: number): void;
  /** Read back the current squash amount for `key`, 0 when idle. */
  squashAt(key: string): number;
  /** Floating score text that drifts up and fades. */
  popText(x: number, y: number, text: string, color?: string): void;
  /**
   * One call for a hit: particles, shake, hitstop, squash and floating text,
   * at a consistent grade. Prefer this over assembling the five by hand.
   *
   * The engine applies two guards an author cannot be expected to remember:
   * hitstop is forced to zero in rhythm games (the audio clock keeps running,
   * so freezing the game clock desynchronises it permanently), and shake is
   * capped harder in `space: 'room'` games, where the player is already
   * physically moving and screen shake is far more nauseating.
   */
  impact(x: number, y: number, level: ImpactLevel, o?: ImpactOpts): void;

  /**
   * A miss. Deliberately quiet: no shake, no flash, no red.
   *
   * Repeated failure indicators make this age group quit within a minute, so
   * the engine refuses to make a miss loud even if a game asks. The combo
   * break and the absence of a reward are the feedback.
   */
  miss(x?: number, y?: number): void;

  /**
   * A "get ready" warning, drawn `secs` before the thing happens.
   *
   * Not the same as anticipation: anticipation is style and is suppressed
   * under reduced motion, a telegraph is INFORMATION and never is — removing
   * it would make the game unfair rather than merely plainer.
   */
  telegraph(x: number, y: number, r: number, o?: { color?: string; secs?: number }): void;

  /** The canonical color for a player slot (= palette C.slot[slot]). */
  slotColor(slot: Slot): string;
  /** True when the player asked for reduced motion. Games may use this to
   *  swap a spin for a crossfade; shake/flash are already suppressed. */
  readonly reducedMotion: boolean;
}

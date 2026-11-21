// ══ FROZEN CONTRACT ══ imported by 58 game modules.
//
// Seeded spawn timing with a difficulty ramp.
//
// Two rules this exists to enforce:
//  - Spawn timing comes from ctx.rng(), never Math.random(), so a seeded replay
//    reproduces a round exactly. That is what makes 58 games testable.
//  - Difficulty ramps on a curve the engine owns, so every game gets the same
//    "starts gentle, ends frantic" shape instead of 58 hand-rolled ramps.
import { clamp01, lerp } from './math';

export interface SpawnerOpts {
  /** Seconds between spawns at the start of the round. */
  startInterval: number;
  /** Seconds between spawns at the end. Must be <= startInterval. */
  endInterval: number;
  /** Random jitter as a fraction of the interval, 0..1. Default 0.3.
   *  A perfectly regular beat makes a game feel like a metronome. */
  jitter?: number;
  /** Fraction of the round, 0..1, at which the ramp reaches endInterval.
   *  Default 0.75 — the last quarter plays at full tilt. */
  rampUntil?: number;
  /** Spawn this many at once once difficulty passes 0.5 / 0.85. Default 1/1. */
  burstMid?: number;
  burstLate?: number;
  /** Seconds before the first spawn. Default = startInterval * 0.5, so the
   *  player gets a beat to read the screen. */
  leadIn?: number;
}

export class Spawner {
  private t = 0;
  private next: number;
  private readonly o: Required<SpawnerOpts>;

  constructor(
    opts: SpawnerOpts,
    private readonly rng: () => number,
    /** Round length in seconds; drives the ramp. */
    private readonly durationSec: number,
  ) {
    this.o = {
      jitter: 0.3,
      rampUntil: 0.75,
      burstMid: 1,
      burstLate: 1,
      leadIn: opts.startInterval * 0.5,
      ...opts,
    };
    this.next = this.o.leadIn;
  }

  /** 0..1 difficulty for this moment in the round. Use it to scale speed,
   *  size and point values so the whole game ramps together. */
  get difficulty(): number {
    const p = this.durationSec <= 0 ? 1 : this.t / this.durationSec;
    return clamp01(p / Math.max(this.o.rampUntil, 1e-3));
  }

  get elapsed(): number {
    return this.t;
  }

  /**
   * Advance and return how many to spawn this frame (usually 0).
   *
   *   const k = this.spawner.tick(dt);
   *   for (let i = 0; i < k; i++) this.spawnOne();
   */
  tick(dt: number): number {
    this.t += dt;
    if (this.t < this.next) return 0;
    const d = this.difficulty;
    const base = lerp(this.o.startInterval, this.o.endInterval, d);
    const j = 1 + (this.rng() * 2 - 1) * this.o.jitter;
    this.next = this.t + Math.max(0.05, base * j);
    return d > 0.85 ? this.o.burstLate : d > 0.5 ? this.o.burstMid : 1;
  }

  /** Force the next spawn to be `sec` from now. For post-wave pauses. */
  delay(sec: number): void {
    this.next = this.t + sec;
  }

  reset(): void {
    this.t = 0;
    this.next = this.o.leadIn;
  }
}

/** Uniform float in [lo, hi). */
export const randRange = (rng: () => number, lo: number, hi: number): number =>
  lo + rng() * (hi - lo);

/** Uniform integer in [lo, hi]. */
export const randInt = (rng: () => number, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));

/** Pick one element. Returns undefined only for an empty array. */
export const pick = <T,>(rng: () => number, xs: readonly T[]): T | undefined =>
  xs.length === 0 ? undefined : xs[Math.floor(rng() * xs.length)];

/** True with probability p. */
export const chance = (rng: () => number, p: number): boolean => rng() < p;

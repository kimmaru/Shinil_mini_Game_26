// One Euro filter (Casiez, Roussel & Vogel, CHI 2012) + a median-of-3 prefilter.
//
// Pipeline, and the order is load-bearing:
//
//     median-of-3  ->  One Euro  ->  (the caller's hysteresis)
//
// The median stage deletes the single-frame spike where a wrist teleports to a
// reflection in a window; an EMA or a low-pass would smear that spike across
// five frames instead. One Euro then kills resting jitter without adding
// perceptible lag, because its cutoff rises with speed: slow hand -> low
// cutoff -> jitter gone; fast hand -> high cutoff -> motion passes through.
//
// Never smooth a boolean. Smooth the continuous signal and put the hysteresis
// on the threshold (see gestures/index.ts HysteresisOpts).
//
// Units: callers feed NORMALIZED values (shoulder widths) and real timestamps
// in seconds, so `velocity` comes out in shoulder-widths/sec — which is exactly
// what every gesture detector wants, and it is free.

export interface OneEuroConfig {
  /** Nominal input rate in Hz. Used only for the very first dt. */
  freq: number;
  /** Hz. LOWER = less jitter, more lag. */
  minCutoff: number;
  /** Speed coefficient. HIGHER = less lag, more jitter. */
  beta: number;
  /** Hz. Cutoff for the derivative estimate — deliberately constant. */
  dCutoff: number;
}

/** Most games. Tuned for ~25-30Hz input in shoulder-width units.
 *
 *  beta 0.2, was 0.08. Resting jitter is set by minCutoff alone (a still
 *  joint's filtered speed is ~0.3-0.7 SW/s of noise, worth +0.1Hz of
 *  cutoff), so beta is the cheap lever on lag. Measured at 25Hz through the
 *  median+One Euro bank: lag on a 1 SW 1Hz hand move 117 -> 107ms with
 *  amplitude 0.82 -> 0.86; on a 2 SW 1.5Hz swing 100 -> 88ms, 0.75 -> 0.83;
 *  still-joint jitter at 1.2m / 2m / 4m framings 0.0066 / 0.0126 / 0.0229 ->
 *  0.0066 / 0.0126 / 0.0230 SW. Velocities do not depend on beta.
 *  Not higher: at 0.25+ the dwell-to-aim games (connect-dots-order,
 *  wrist-aim-target, web-cut), which have no steady preset to ask for, drop
 *  below their own star cuts on their dev clips. */
export const DEFAULT_FILTER: OneEuroConfig = {
  freq: 30, minCutoff: 1.5, beta: 0.2, dCutoff: 1.0,
};
/** Aim / trace / hold-pose games: a hand parked on a target must not wobble.
 *  Lower beta means it lags a fast swing, which those games do not care about. */
export const STEADY: OneEuroConfig = {
  freq: 30, minCutoff: 0.8, beta: 0.02, dCutoff: 1.0,
};
/** Punch / swing / clap / rhythm: lag is the enemy, a little jitter is fine. */
export const SNAPPY: OneEuroConfig = {
  freq: 30, minCutoff: 2.5, beta: 0.3, dCutoff: 1.0,
};

export type FilterPresetName = 'default' | 'steady' | 'snappy';

export const FILTER_PRESETS: Record<FilterPresetName, OneEuroConfig> = {
  default: DEFAULT_FILTER,
  steady: STEADY,
  snappy: SNAPPY,
};

/** alpha for a first-order low-pass at `cutoff` Hz with sample interval `dt`. */
export function smoothingAlpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/** median of exactly three, branch-only, no sort, no allocation. */
export function median3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/** Sliding median-of-3 over one scalar channel.
 *
 *  Costs one frame of lag on a monotonic ramp (~40ms at 25Hz), which the
 *  extrapolation in PoseSource.sample() hands back. Worth it: a single bad
 *  frame is otherwise visible as a thrown-away point in every swing game. */
export class Median3 {
  private a = 0;
  private b = 0;
  private c = 0;
  private n = 0;

  push(x: number): number {
    this.a = this.b;
    this.b = this.c;
    this.c = x;
    if (this.n < 2) {
      this.n++;
      return x;
    }
    return median3(this.a, this.b, this.c);
  }

  reset(): void {
    this.a = 0;
    this.b = 0;
    this.c = 0;
    this.n = 0;
  }
}

/** Speed-adaptive low-pass over one scalar channel. */
export class OneEuroFilter {
  private cfg: OneEuroConfig;
  private xHat = 0;
  private dxHat = 0;
  private lastX = 0;
  private lastT = -1;
  private hasValue = false;

  constructor(cfg: OneEuroConfig = DEFAULT_FILTER) {
    this.cfg = cfg;
  }

  get primed(): boolean {
    return this.hasValue;
  }

  /** Filtered value as of the last push/hold. */
  get value(): number {
    return this.xHat;
  }

  /** Filtered derivative, units/sec. Free, and what detectors actually want. */
  get velocity(): number {
    return this.dxHat;
  }

  configure(cfg: OneEuroConfig): void {
    this.cfg = cfg;
  }

  /** Feed a sample observed at `t` seconds. */
  push(x: number, t: number): number {
    const c = this.cfg;
    if (!this.hasValue) {
      this.hasValue = true;
      this.xHat = x;
      this.lastX = x;
      this.lastT = t;
      this.dxHat = 0;
      return x;
    }
    // Clamp dt: a backgrounded tab resumes with a huge gap, and a double-posted
    // frame arrives with dt 0. Either one produces nonsense alpha.
    let dt = t - this.lastT;
    if (!(dt > 1e-4)) dt = 1 / c.freq;
    else if (dt > 0.25) dt = 0.25;
    this.lastT = t;

    const dx = (x - this.lastX) / dt;
    this.lastX = x;
    this.dxHat += smoothingAlpha(c.dCutoff, dt) * (dx - this.dxHat);

    const cutoff = c.minCutoff + c.beta * Math.abs(this.dxHat);
    this.xHat += smoothingAlpha(cutoff, dt) * (x - this.xHat);
    return this.xHat;
  }

  /** No trustworthy sample this frame: re-feed the last filtered value so the
   *  time base stays honest and the velocity decays to zero instead of
   *  freezing at whatever it was when the joint vanished. */
  hold(t: number): number {
    if (!this.hasValue) return this.xHat;
    return this.push(this.xHat, t);
  }

  reset(): void {
    this.xHat = 0;
    this.dxHat = 0;
    this.lastX = 0;
    this.lastT = -1;
    this.hasValue = false;
  }
}

/**
 * 33 landmarks x 2 axes = 66 median+OneEuro channels for one player.
 *
 * Allocated once per player slot and reused for the whole session: ~3us/frame,
 * zero allocation in steady state.
 */
export class PoseFilterBank {
  readonly count: number;
  private med: Median3[];
  private euro: OneEuroFilter[];

  constructor(count = 66, cfg: OneEuroConfig = DEFAULT_FILTER) {
    this.count = count;
    this.med = new Array(count);
    this.euro = new Array(count);
    for (let i = 0; i < count; i++) {
      this.med[i] = new Median3();
      this.euro[i] = new OneEuroFilter(cfg);
    }
  }

  primed(i: number): boolean {
    return this.euro[i]!.primed;
  }

  /** median-of-3 then One Euro, for channel `i`. */
  push(i: number, x: number, t: number): number {
    return this.euro[i]!.push(this.med[i]!.push(x), t);
  }

  /** Hold channel `i` — the landmark was not visible enough to trust. */
  hold(i: number, t: number): number {
    const e = this.euro[i]!;
    this.med[i]!.push(e.value);
    return e.hold(t);
  }

  value(i: number): number {
    return this.euro[i]!.value;
  }

  velocity(i: number): number {
    return this.euro[i]!.velocity;
  }

  /** Convenience for tests and for callers with nothing to gate on. */
  apply(src: Float32Array, out: Float32Array, vel: Float32Array, t: number): void {
    for (let i = 0; i < this.count; i++) {
      out[i] = this.push(i, src[i]!, t);
      vel[i] = this.velocity(i);
    }
  }

  configure(cfg: OneEuroConfig): void {
    for (let i = 0; i < this.count; i++) this.euro[i]!.configure(cfg);
  }

  reset(): void {
    for (let i = 0; i < this.count; i++) {
      this.med[i]!.reset();
      this.euro[i]!.reset();
    }
  }
}

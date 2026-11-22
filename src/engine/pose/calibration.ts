// CalibrationProfile capture. Two paths, one set of primitives:
//
//   CalibrationCapture  one 4-second screen, once per player. The operator /
//                       classroom path, where somebody is willing to stand
//                       still and follow an instruction.
//   AutoCalibrator      continuous, screenless, for the exhibition kiosk,
//                       where a stranger walks up, plays once and leaves.
//                       See the long comment above its definition.
//
// Both measure the same quantities with the same robust statistics
// (`quantileInto`, `median`, `motionEnergy`); only the window and the trigger
// differ. Do not fork the measurements — two definitions of "shoulder width"
// or of "energy" make every threshold in the catalogue arguable.
//
// ── CalibrationCapture ──
//
// Everything in the catalogue is measured against THIS, not against a constant,
// because a 120cm seven-year-old 1.2m from a laptop and a 170cm adult 3m back
// are the same game only if the numbers come from the player's own body.
//
// Median, not mean, over ~60 frames: a child WILL wobble, sneeze, or wave at
// their friend halfway through the capture, and one mean is enough to poison
// every threshold for the rest of the session. The first ~10 frames are thrown
// away outright — that is the auto-exposure ramp and the model's own tracking
// warmup, and the landmarks there are visibly worse.
//
// The one value that cannot be a median is `idleEnergy`: it is the player's own
// resting motion energy, and freeze games must threshold against that. A global
// "hold still" constant fails this age group completely — children cannot hold
// still, and the ones who try hardest shake the most.
import type { CalibrationProfile, PlayerPose } from '../types';
import { approach, clamp, median } from '../math';
import { L, MIN_VIS } from './landmarks';
import { defaultCalibration } from './source';
import { DEFAULT_IDENTITY } from './identity';

/**
 * Joints whose speed counts as "motion energy".
 *
 * Face points are excluded (they are noisy and a child's head turn is not
 * fidgeting), as are the finger points (they are the noisiest landmarks in the
 * set). Exported so the stillness detector measures the same thing calibration
 * measured — two definitions of energy would make `idleEnergy` meaningless.
 */
export const ENERGY_JOINTS = [
  L.NOSE,
  L.LEFT_SHOULDER, L.RIGHT_SHOULDER,
  L.LEFT_ELBOW, L.RIGHT_ELBOW,
  L.LEFT_WRIST, L.RIGHT_WRIST,
  L.LEFT_HIP, L.RIGHT_HIP,
  L.LEFT_KNEE, L.RIGHT_KNEE,
  L.LEFT_ANKLE, L.RIGHT_ANKLE,
] as const;

/**
 * Motion energy: MEAN speed over the visible energy joints, in
 * shoulder-widths/sec.
 *
 * NOTE a mean, not the sum the StillnessSignal doc implies — a sum over 13
 * joints is 13x larger and would make `defaultCalibration().idleEnergy` of
 * 0.35 nonsense. A resting child measures ~0.1-0.4 by this definition, which
 * is exactly where that default sits.
 */
export function motionEnergy(p: PlayerPose): number {
  let sum = 0;
  let n = 0;
  for (const j of ENERGY_JOINTS) {
    if (p.vis[j]! < MIN_VIS) continue;
    sum += Math.hypot(p.v[j * 2]!, p.v[j * 2 + 1]!);
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * Good enough to measure: confident torso anchors, OR both shoulders.
 *
 * `conf` averages shoulders AND hips, so a child close to a laptop — hips off
 * the bottom of the frame — reads ~0.5 however clearly they are seen, and was
 * thrown away frame after frame. The shoulders are what the scale is measured
 * from in the first place.
 */
function measurable(p: PlayerPose): boolean {
  return (
    p.present &&
    (p.conf >= MIN_VIS ||
      (p.vis[L.LEFT_SHOULDER]! >= MIN_VIS && p.vis[L.RIGHT_SHOULDER]! >= MIN_VIS))
  );
}

/** Both hips visible: `lowerBodyVisible` needs them as well as the ankles,
 *  because hip-driven games (zones, dodges, jumps) read the hips, and an
 *  origin estimated from the shoulders cannot move like real hips do. */
const hipsVisible = (p: PlayerPose): boolean =>
  p.vis[L.LEFT_HIP]! >= MIN_VIS && p.vis[L.RIGHT_HIP]! >= MIN_VIS;

export interface CalibrateOpts {
  /** Capture window. 4s is long enough for a median and short enough that a
   *  7-year-old does not wander off. */
  ms?: number;
  /** Frames discarded at the start: exposure ramp + model warmup. */
  skipFrames?: number;
  /** Frames kept. More is not better; this is already robust. */
  maxSamples?: number;
  /** Minimum usable samples, else calibration is a failure and must be retried
   *  rather than silently producing a profile from three frames. */
  minSamples?: number;
  mirrored?: boolean;
}

export const CALIBRATE_MS = 4000;
/** Longest believable arm, shoulder widths (a child's is ~1.6). Turning the
 *  torso narrows the shoulder line while an arm is out, which reads as a 2.3
 *  "arm" — and every reach target and extension test then asks for more arm
 *  than the child has. */
export const ARM_LEN_MAX = 1.9;
export const CALIBRATE_SKIP = 10;
export const CALIBRATE_SAMPLES = 60;

/**
 * Nearest-rank quantile of the first `n` values of `src`, sorted into `dst`.
 * `q` 0..1. Returns 0 for an empty input, like `median()`.
 *
 * The caller owns both buffers, so this is allocation-free and can run in a
 * per-frame path (AutoCalibrator's rings). Insertion sort because `n` here is
 * 8..60: at that size it beats a comparator-driven `Array.sort` and, unlike
 * `sort`, it needs no closure and no copy.
 */
function quantileInto(src: ArrayLike<number>, n: number, dst: Float64Array, q: number): number {
  if (n <= 0) return 0;
  for (let k = 0; k < n; k++) {
    const v = src[k]!;
    let j = k - 1;
    while (j >= 0 && dst[j]! > v) {
      dst[j + 1] = dst[j]!;
      j--;
    }
    dst[j + 1] = v;
  }
  return dst[clamp(Math.round((n - 1) * q), 0, n - 1)]!;
}

// Sort scratch, grown on demand and shared: every quantile is consumed before
// the next one is taken (single-threaded, no reentrancy), so one buffer is
// enough and no quantile read allocates after the first.
let sortScratch = new Float64Array(64);
function scratchFor(n: number): Float64Array {
  if (sortScratch.length < n) sortScratch = new Float64Array(n);
  return sortScratch;
}

/** Robust percentile of an unsorted array. `q` 0..1. */
function percentile(xs: readonly number[], q: number): number {
  return quantileInto(xs, xs.length, scratchFor(xs.length), q);
}

/**
 * Accumulates samples from a live frame stream and produces a profile.
 *
 * Reach values (armSpan, armLen, reachUpY, squatHipY) are taken as robust
 * EXTREMES rather than medians: the capture screen asks the player to stretch
 * out, raise up and squat down once, and the median of a 4-second window that
 * includes standing still would wash all of that away. The 90th/10th
 * percentile is the compromise — it needs the pose held for ~0.4s, so a single
 * mis-detected frame cannot define "maximum reach".
 */
export class CalibrationCapture {
  private o: Required<CalibrateOpts>;
  private skipped = 0;
  private shoulderW: number[] = [];
  private span: number[] = [];
  private armLen: number[] = [];
  private hipY: number[] = [];
  private wristY: number[] = [];
  private ankleY: number[] = [];
  private ankleVis: number[] = [];
  private hipsSeen = 0;
  private energy: number[] = [];
  private t0 = -1;
  private tLast = 0;

  constructor(opts: CalibrateOpts = {}) {
    this.o = {
      ms: opts.ms ?? CALIBRATE_MS,
      skipFrames: opts.skipFrames ?? CALIBRATE_SKIP,
      maxSamples: opts.maxSamples ?? CALIBRATE_SAMPLES,
      minSamples: opts.minSamples ?? 8,
      mirrored: opts.mirrored ?? true,
    };
  }

  get samples(): number {
    return this.shoulderW.length;
  }

  get elapsedMs(): number {
    return this.t0 < 0 ? 0 : (this.tLast - this.t0) * 1000;
  }

  /** 0..1 for the progress ring on the calibration screen. */
  get progress(): number {
    const byTime = this.o.ms > 0 ? this.elapsedMs / this.o.ms : 1;
    const byCount = this.o.maxSamples > 0 ? this.samples / this.o.maxSamples : 1;
    return clamp(Math.max(byTime, byCount), 0, 1);
  }

  get done(): boolean {
    return this.samples >= this.o.maxSamples || this.elapsedMs >= this.o.ms;
  }

  /** Feed one projected frame for the player being calibrated. */
  feed(p: PlayerPose, tSec: number, viewH: number): void {
    if (this.t0 < 0) this.t0 = tSec;
    this.tLast = tSec;
    if (!measurable(p)) return;
    if (this.skipped < this.o.skipFrames) {
      this.skipped++;
      return;
    }
    if (this.samples >= this.o.maxSamples) return;

    this.shoulderW.push(p.scalePx);

    // Hip centre as a 0..1 fraction of view height.
    const hipPy = (p.px[L.LEFT_HIP * 2 + 1]! + p.px[L.RIGHT_HIP * 2 + 1]!) / 2;
    this.hipY.push(hipPy / viewH);

    // Normalized units: these are already camera-distance independent.
    const wl = L.LEFT_WRIST * 2;
    const wr = L.RIGHT_WRIST * 2;
    if (p.vis[L.LEFT_WRIST]! >= MIN_VIS && p.vis[L.RIGHT_WRIST]! >= MIN_VIS) {
      this.span.push(Math.hypot(p.n[wl]! - p.n[wr]!, p.n[wl + 1]! - p.n[wr + 1]!));
    }
    const lenL =
      p.vis[L.LEFT_WRIST]! >= MIN_VIS && p.vis[L.LEFT_SHOULDER]! >= MIN_VIS
        ? Math.hypot(
            p.n[wl]! - p.n[L.LEFT_SHOULDER * 2]!,
            p.n[wl + 1]! - p.n[L.LEFT_SHOULDER * 2 + 1]!,
          )
        : 0;
    const lenR =
      p.vis[L.RIGHT_WRIST]! >= MIN_VIS && p.vis[L.RIGHT_SHOULDER]! >= MIN_VIS
        ? Math.hypot(
            p.n[wr]! - p.n[L.RIGHT_SHOULDER * 2]!,
            p.n[wr + 1]! - p.n[L.RIGHT_SHOULDER * 2 + 1]!,
          )
        : 0;
    if (lenL > 0 || lenR > 0) this.armLen.push(Math.max(lenL, lenR));

    // Highest wrist, view fraction. y grows DOWN, so "highest" is the minimum.
    let top = Infinity;
    if (p.vis[L.LEFT_WRIST]! >= MIN_VIS) top = Math.min(top, p.px[wl + 1]!);
    if (p.vis[L.RIGHT_WRIST]! >= MIN_VIS) top = Math.min(top, p.px[wr + 1]!);
    if (Number.isFinite(top)) this.wristY.push(top / viewH);

    const avl = p.vis[L.LEFT_ANKLE]!;
    const avr = p.vis[L.RIGHT_ANKLE]!;
    this.ankleVis.push(Math.max(avl, avr));
    if (avl >= MIN_VIS || avr >= MIN_VIS) {
      const ay =
        avl >= MIN_VIS && avr >= MIN_VIS
          ? (p.px[L.LEFT_ANKLE * 2 + 1]! + p.px[L.RIGHT_ANKLE * 2 + 1]!) / 2
          : avl >= MIN_VIS
            ? p.px[L.LEFT_ANKLE * 2 + 1]!
            : p.px[L.RIGHT_ANKLE * 2 + 1]!;
      this.ankleY.push(ay / viewH);
    }
    if (hipsVisible(p)) this.hipsSeen++;

    this.energy.push(motionEnergy(p));
  }

  /** True once there is enough data to produce an honest profile. */
  get usable(): boolean {
    return this.samples >= this.o.minSamples;
  }

  /**
   * Build the profile. Always returns something usable — a profile with
   * `lowerBodyVisible: false` is a legitimate laptop-user profile, not a
   * failure. Throws only when the torso was never adequately visible, because
   * then there is nothing to measure.
   */
  finish(nowMs = 0): CalibrationProfile {
    if (!this.usable) {
      throw new Error(
        `[calibration] only ${this.samples} usable frames — the body was never adequately visible`,
      );
    }
    const shoulderW = median(this.shoulderW);
    const standHipY = median(this.hipY);
    // Deepest hip position seen. Treated as a squat only if it is a real drop.
    const lowHipY = percentile(this.hipY, 0.95);
    const squatHipY = lowHipY > standHipY + 0.04 ? lowHipY : standHipY + 0.12;

    const armSpanRaw = this.span.length ? percentile(this.span, 0.9) : 0;
    const armLenRaw = this.armLen.length ? percentile(this.armLen, 0.9) : 0;
    const armLen = armLenRaw > 0.9 ? Math.min(ARM_LEN_MAX, armLenRaw) : 1.6;
    // A player who kept their hands down for the whole capture still has an
    // arm span, and it is geometrically determined: two arms plus the width
    // between the shoulders (which is 1 by definition of the unit). Taking the
    // max means a real stretch wins when there was one, and the derived value
    // covers the child who did not understand the instruction.
    //
    // NOTE this comes out ~4.2, not the 2.1 in defaultCalibration() — see the
    // hand-back. Measured on this project's own skeleton and on real
    // anthropometry (span ~= stature, biacromial ~= 0.23 stature), ~4.3 is
    // right and 2.1 is half the real value.
    const armSpan = Math.max(armSpanRaw, 2 * armLen + 0.9);

    const reachRaw = this.wristY.length ? percentile(this.wristY, 0.05) : 1;
    const reachUpY = Math.min(reachRaw, standHipY - 0.2);

    const ankleOk = this.ankleVis.length > 0 && median(this.ankleVis) > MIN_VIS;
    const floorY = ankleOk && this.ankleY.length ? median(this.ankleY) : 1.0;
    // Hips in at least half the frames, like the ankle median.
    const hipsOk = this.hipsSeen * 2 > this.shoulderW.length;

    // Resting energy: the MEDIAN of the per-frame energies, with a floor so a
    // suspiciously still capture (a photo held up to the camera, or a player
    // who genuinely froze for 4s) cannot make every freeze game impossible.
    const idleEnergy = Math.max(0.08, median(this.energy));

    return {
      shoulderW,
      armSpan,
      armLen,
      standHipY: clamp(standHipY, 0.1, 0.99),
      squatHipY: clamp(squatHipY, 0.1, 1.2),
      reachUpY: clamp(reachUpY, -0.5, 0.9),
      floorY: clamp(floorY, 0.2, 1.0),
      idleEnergy,
      lowerBodyVisible: ankleOk && hipsOk,
      mirrored: this.o.mirrored,
      capturedAt: nowMs,
    };
  }

  reset(): void {
    this.skipped = 0;
    this.shoulderW.length = 0;
    this.span.length = 0;
    this.armLen.length = 0;
    this.hipY.length = 0;
    this.wristY.length = 0;
    this.ankleY.length = 0;
    this.ankleVis.length = 0;
    this.hipsSeen = 0;
    this.energy.length = 0;
    this.t0 = -1;
    this.tLast = 0;
  }
}

// ─── AutoCalibrator: the exhibition-kiosk path ──────────────────────────────
//
// The kiosk has one START button and no calibration screen. A stranger walks
// up, plays one round and leaves; the next person is a different height. So the
// profile has to converge in the background while they are still reading the
// button, and it has to be THEIRS and not the previous customer's.
//
// Four decisions carry this file, and the numbers in them are the whole design:
//
//  1. PROGRESSIVE, not all-or-nothing. Shoulder width and standing hip height
//     are visible in the very first frame a body is tracked — one frame is a
//     measurement, a 0.5s median only removes the wobble. Arm span, overhead
//     reach and squat depth are NOT visible until the customer happens to do
//     them, which at a kiosk may be never. Those start as the prior from
//     defaultCalibration() and are upgraded the moment they are actually seen.
//     `observed` says which is which, so nothing downstream has to guess
//     whether a number was measured or assumed.
//
//  2. ABSENCE, not identity, marks a new customer. 0.6s — see
//     AUTO_SWAP_ABSENCE_SEC. Below that, a gap is the tracker hiccuping.
//
//  3. SCALE MOVES SLOWLY, except when it is really moving. One slow lane and
//     one fast lane with a 12% deadband between them — see AUTO_SCALE_*.
//
//  4. FREEZE IS THE CALLER'S CALL. A profile that changes mid-round scores the
//     same movement differently in the first and second half of the round, so
//     the shell freezes it when the round starts and thaws it when the round
//     is over. This class cannot do that for itself: it has no idea what a
//     round is. Shell contract: `freeze()` on the countdown->play transition,
//     `thaw()` on the results screen. Forgetting to thaw means the next
//     customer plays on this customer's body.

/** Which profile fields are real measurements of THIS customer. Everything
 *  else is the prior from `defaultCalibration()` — usable, but do not report
 *  it as if it had been measured. */
export interface ObservedFields {
  shoulderW: boolean;
  standHipY: boolean;
  squatHipY: boolean;
  armSpan: boolean;
  armLen: boolean;
  reachUpY: boolean;
  floorY: boolean;
  idleEnergy: boolean;
}

/**
 * Absence that counts as "a different person next time".
 *
 * Tied to `DEFAULT_IDENTITY.dropSec` (identity.ts), which is also 0.6s: the
 * tracker already calls 0.6s of no match "this player left the room", and a
 * calibrator that disagreed with the tracker about who is in front of the
 * camera would be a second, contradictory source of truth.
 *
 * It also has margin on both sides, which is why it is safe:
 *   - too short? The worst stream we ship against (`laggy`: 10fps, 6% frame
 *     drop, 12% joint dropout) loses 1-2 consecutive frames, i.e. 100-200ms,
 *     and 3 in a row is 300ms. 0.6s is 2x the worst realistic hiccup, so a
 *     hiccup cannot be mistaken for a departure — resetting mid-round would
 *     re-scale every threshold and visibly jump the score.
 *   - too long? A body cannot leave the frame and a different body arrive in
 *     under about a second, so no real swap is missed.
 */
export const AUTO_SWAP_ABSENCE_SEC = 0.6;

/** Median window for scale and hip height. 0.5s kills landmark wobble while
 *  still being a third of the 1.5s a customer spends walking up. */
export const AUTO_WINDOW_SEC = 0.5;

/** An extreme (span, reach, squat depth) must survive this long to count. One
 *  mis-detected frame must never define "maximum reach" for the whole round;
 *  0.3s is ~8 frames, far more than any single-frame glitch. */
export const AUTO_HOLD_SEC = 0.3;

/** Window the resting-energy estimate selects its quiet stretches from. */
export const AUTO_IDLE_WINDOW_SEC = 2;

/** Frames dropped when a body first appears: exposure ramp plus the model's
 *  own tracking warmup. The 4-second screen throws away 10 (0.4s), which would
 *  be 40% of the kiosk's entire 1s budget — and it does not need to, because
 *  the identity tracker's 0.45s probation has already absorbed the warmup by
 *  the time a pose is `present`. */
export const AUTO_SKIP_FRAMES = 1;

/** Samples before shoulderW / standHipY are reported as measured. 3 frames is
 *  0.12s at 25fps: enough for a median to reject one outlier, cheap enough to
 *  stay inside the 1s convergence budget. */
export const AUTO_MIN_SAMPLES = 3;

/**
 * Relative scale change that separates "the customer walked forward" from
 * "landmarks wobble".
 *
 * Measured error either side of 12% is what makes it a safe split: normalize.ts
 * already EMAs shoulder width at SCALE_SMOOTH=0.3 per inference, leaving a few
 * percent of residual jitter, while stepping from 3m to 2m changes shoulder
 * width by ~50%. 12% is 4x the jitter and a quarter of the step.
 */
export const AUTO_SCALE_DEADBAND = 0.12;

/** Slow lane, fraction closed per second. 0.5 is a ~2s time constant: the
 *  residual jitter that gets through the deadband leaks into the published
 *  scale at well under 1% per frame, so thresholds do not breathe. Scale is
 *  deliberately far slower than position (One Euro, ~1Hz cutoff) — a wobbling
 *  scale wobbles EVERY threshold in the game at once. */
export const AUTO_SCALE_RATE_SLOW = 0.5;

/** Fast lane, for a real approach. 4/s closes 98% of a step in 1s, so a
 *  customer who walks up while reading the button is calibrated by the time
 *  they press it. */
export const AUTO_SCALE_RATE_FAST = 4;

/**
 * Too far: shoulder width below 6% of the VIEW WIDTH.
 *
 * Below that a 0.2-shoulder-width gameplay threshold is ~15px against 3-4px of
 * landmark jitter — a 25% error on every distance in the game, which is no
 * longer a game. The corpus pins both ends: `far-small` (0.058) must trip it,
 * a normal standing framing (`idle`, 0.105) must not. Hysteresis on the exit so
 * the shell's hint cannot strobe at the boundary.
 */
export const AUTO_TOO_FAR_FRAC = 0.06;
export const AUTO_TOO_FAR_EXIT = 0.075;

/**
 * Too close: the customer's OWN arm span no longer fits across the view.
 *
 * Expressed as a span fit rather than a width fraction for two reasons. It is
 * the thing the player actually experiences — a game that places targets at
 * arm's reach cannot, because their hands are off-screen. And a width
 * threshold would be unreachable: normalize.ts clamps scale at
 * SCALE_MAX_FRAC * viewH, which on 16:9 is only 0.28 of the WIDTH, so anything
 * stricter than that could never fire no matter how close somebody stood.
 *
 * With armSpan ~4.3 this trips around 23% of the view width, i.e. roughly
 * arm's length from the camera. `no-legs` (0.26, the close laptop framing) is
 * past it and is flagged — correctly: at that framing a T-pose is 1.1x wider
 * than the frame. At a kiosk there is room to step back, which is exactly why
 * the shell is given the signal.
 */
export const AUTO_TOO_CLOSE_SPAN = 1;
export const AUTO_TOO_CLOSE_EXIT = 0.9;

export interface AutoCalibrateOpts {
  /** View the pose px space is mapped into. Also `setView()`. */
  view?: { w: number; h: number };
  /** Feed rate, used ONLY to size the ring buffers so the windows above are
   *  the documented number of seconds. Pass the inference rate (25-30 on the
   *  camera path), not the render rate. */
  fps?: number;
  mirrored?: boolean;
  /** Prior for fields nobody has observed yet. Defaults to the measured
   *  defaults in `defaultCalibration()`. */
  base?: CalibrationProfile;
  swapAbsenceSec?: number;
  minSamples?: number;
  skipFrames?: number;
}

/**
 * Fixed-capacity ring of recent samples, with allocation-free statistics.
 *
 * Allocated once in the constructor. `feed()` runs at inference rate and the
 * engine's rule is that nothing on a per-frame path allocates.
 */
class Ring {
  readonly cap: number;
  private buf: Float64Array;
  private i = 0;
  private n = 0;

  constructor(cap: number) {
    this.cap = Math.max(1, Math.floor(cap));
    this.buf = new Float64Array(this.cap);
  }

  get count(): number {
    return this.n;
  }

  get full(): boolean {
    return this.n >= this.cap;
  }

  push(v: number): void {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.cap;
    if (this.n < this.cap) this.n++;
  }

  clear(): void {
    this.i = 0;
    this.n = 0;
  }

  /** Nearest-rank quantile over the live entries. 0.5 is the median. */
  quantile(q: number): number {
    return quantileInto(this.buf, this.n, scratchFor(this.n), q);
  }

  mean(): number {
    if (this.n === 0) return 0;
    let s = 0;
    for (let k = 0; k < this.n; k++) s += this.buf[k]!;
    return s / this.n;
  }
}

export class AutoCalibrator {
  private o: Required<Omit<AutoCalibrateOpts, 'base' | 'view'>>;
  private base: CalibrationProfile;
  /** Published while thawed. Mutated in place, never reallocated. */
  private live: CalibrationProfile;
  /** Published while frozen. A separate object so that nothing which happens
   *  after `freeze()` can reach a profile a round is already scoring against. */
  private snap: CalibrationProfile;
  private flags: ObservedFields = {
    shoulderW: false, standHipY: false, squatHipY: false, armSpan: false,
    armLen: false, reachUpY: false, floorY: false, idleEnergy: false,
  };

  private viewW: number;
  private viewH: number;

  // Windows. Sized once, from `fps`.
  private rScale: Ring;
  private rHip: Ring;
  private rAnkleVis: Ring;
  private rAnkleY: Ring;
  private rHipVis: Ring;
  private hipsOk = false;
  private rSpan: Ring;
  private rArmLen: Ring;
  private rWrist: Ring;
  private rEnergyShort: Ring;
  private rIdle: Ring;

  // Running extremes for this customer. `-1` / `Infinity` mean "never seen".
  private spanBest = -1;
  private armLenBest = -1;
  private wristTopBest = Infinity;
  private hipStandBest = Infinity;
  private hipLowBest = -1;

  private scalePx = 0;
  private scaleLocked = false;
  private skipped = 0;
  private lastT = -1;
  private lastSeenT = -1;
  private presentNow = false;
  private far = false;
  private close = false;
  private isFrozen = false;
  private pendingReset = false;
  private customer = 0;

  constructor(opts: AutoCalibrateOpts = {}) {
    this.viewW = opts.view?.w ?? 1280;
    this.viewH = opts.view?.h ?? 720;
    this.o = {
      fps: opts.fps ?? 30,
      mirrored: opts.mirrored ?? true,
      swapAbsenceSec: opts.swapAbsenceSec ?? AUTO_SWAP_ABSENCE_SEC,
      minSamples: opts.minSamples ?? AUTO_MIN_SAMPLES,
      skipFrames: opts.skipFrames ?? AUTO_SKIP_FRAMES,
    };
    const fps = Math.max(5, this.o.fps);
    const win = Math.ceil(AUTO_WINDOW_SEC * fps);
    const hold = Math.ceil(AUTO_HOLD_SEC * fps);
    this.rScale = new Ring(win);
    this.rHip = new Ring(win);
    this.rAnkleVis = new Ring(win);
    this.rAnkleY = new Ring(win);
    this.rHipVis = new Ring(win);
    this.rSpan = new Ring(hold);
    this.rArmLen = new Ring(hold);
    this.rWrist = new Ring(hold);
    this.rEnergyShort = new Ring(hold);
    this.rIdle = new Ring(Math.ceil(AUTO_IDLE_WINDOW_SEC * fps));

    this.base = opts.base ?? defaultCalibration(this.viewW, this.viewH);
    this.live = { ...this.base, mirrored: this.o.mirrored, capturedAt: 0 };
    this.snap = { ...this.live };
  }

  /**
   * The current profile. The SAME object every call — do not retain it across
   * a `freeze()`/`thaw()` boundary and do not mutate it. While frozen this is
   * the snapshot and is guaranteed not to change.
   */
  get profile(): CalibrationProfile {
    return this.isFrozen ? this.snap : this.live;
  }

  /** True once shoulderW and standHipY are this customer's own measurements.
   *  Until then `profile` is the prior and games would be sized for a
   *  stranger — gate the START button's "ready" state on this. */
  get ready(): boolean {
    return this.flags.shoulderW && this.flags.standHipY;
  }

  /** Reused object, mutated in place. Read it, do not keep it. */
  get observed(): ObservedFields {
    return this.flags;
  }

  /** A usable body was in the last fed frame. */
  get present(): boolean {
    return this.presentNow;
  }

  /** Shell draws "come a bit closer" / "step back" off these. Graphics and
   *  wording are the shell's business; this is only the signal. Both are false
   *  when nobody is there — there is nobody to ask. */
  get tooFar(): boolean {
    return this.presentNow && this.far;
  }

  get tooClose(): boolean {
    return this.presentNow && this.close;
  }

  /** Honest: at a kiosk or on a laptop the ankles are usually out of frame.
   *  `floorY` stays at the 1.0 sentinel in that case — it is never guessed.
   *  Also false while the hips are out of frame (the close laptop framing),
   *  so hip-driven games leave the pool along with the leg games. */
  get lowerBodyVisible(): boolean {
    return this.flags.floorY && this.hipsOk;
  }

  get frozen(): boolean {
    return this.isFrozen;
  }

  /** Increments on every customer swap and every manual `reset()`. A shell
   *  that caches anything derived from the profile should drop it when this
   *  number changes. */
  get customerId(): number {
    return this.customer;
  }

  /** Measured shoulder width in view px even before `ready` — for the debug
   *  overlay and the distance hint. */
  get scaleNowPx(): number {
    return this.scalePx;
  }

  setView(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
  }

  /**
   * Feed one projected pose, or `undefined`/an absent pose when nobody is
   * tracked. Must be called on absent frames too: absence is the only signal
   * that the customer changed.
   *
   * `tSec` is the caller's clock (seconds, monotonic). Nothing in here reads a
   * wall clock, so a replayed stream calibrates identically every time.
   */
  feed(p: PlayerPose | undefined, tSec: number): void {
    if (this.lastT >= 0 && tSec <= this.lastT) return; // no new information
    const dt = this.lastT < 0 ? 0 : tSec - this.lastT;
    this.lastT = tSec;

    const usable = p !== undefined && measurable(p);

    // ── customer swap, before anything is measured ──────────────────────────
    // `present` already lags the departure: the tracker holds an unmatched
    // body present on its last positions for `hideSec` before letting go. The
    // absence is counted from when the body was last really SEEN, so the reset
    // lands with the tracker's own drop (0.6s), not hideSec after it.
    const absence = tSec - this.lastSeenT + DEFAULT_IDENTITY.hideSec;
    if (this.lastSeenT >= 0 && absence > this.o.swapAbsenceSec) {
      if (this.isFrozen) {
        // Mid-round departure. The round is still being scored against the
        // snapshot, so the reset waits for `thaw()`.
        this.pendingReset = true;
      } else {
        this.reset();
      }
      this.lastSeenT = -1;
    }

    if (!usable) {
      this.presentNow = false;
      return;
    }
    const pose = p;
    this.presentNow = true;
    this.lastSeenT = tSec;

    // Distance signals run even while frozen and even during the skip window:
    // "step forward" is useful before a profile exists and during a round.
    this.updateDistance(pose.scalePx);

    if (this.isFrozen) return; // requirement: the profile cannot move mid-round
    if (this.skipped < this.o.skipFrames) {
      this.skipped++;
      return;
    }

    this.ingest(pose, dt);
  }

  /**
   * Snapshot the profile for the round that is starting, and stop updating.
   *
   * Returns the snapshot, which is safe to hand to `GameContext.profiles`: it
   * is a different object from the live one and nothing mutates it.
   */
  freeze(): CalibrationProfile {
    copyProfile(this.live, this.snap);
    this.isFrozen = true;
    return this.snap;
  }

  /**
   * Resume tracking after a round.
   *
   * The windows are cleared either way: they hold whatever the body was doing
   * when the round started, which is up to a minute stale. If the customer
   * left during the round, the deferred swap reset happens here instead.
   */
  thaw(): void {
    this.isFrozen = false;
    if (this.pendingReset) {
      this.reset();
      return;
    }
    this.clearWindows();
    // Keep the published numbers (same body, same round) but re-lock the scale
    // to wherever they are standing now.
    this.scaleLocked = false;
  }

  /** Forget this customer completely. The published profile falls back to the
   *  prior and `ready` goes false — a caller that ignores `ready` would
   *  otherwise size a 120cm child's game with a 190cm adult's shoulders. */
  reset(): void {
    this.clearWindows();
    copyProfile(this.base, this.live);
    this.live.mirrored = this.o.mirrored;
    this.live.capturedAt = 0;
    this.flags.shoulderW = false;
    this.flags.standHipY = false;
    this.flags.squatHipY = false;
    this.flags.armSpan = false;
    this.flags.armLen = false;
    this.flags.reachUpY = false;
    this.flags.floorY = false;
    this.flags.idleEnergy = false;
    this.scalePx = 0;
    this.scaleLocked = false;
    this.presentNow = false;
    this.far = false;
    this.close = false;
    this.pendingReset = false;
    this.lastSeenT = -1;
    this.customer++;
  }

  private clearWindows(): void {
    this.rScale.clear();
    this.rHip.clear();
    this.rAnkleVis.clear();
    this.rAnkleY.clear();
    this.rHipVis.clear();
    this.hipsOk = false;
    this.rSpan.clear();
    this.rArmLen.clear();
    this.rWrist.clear();
    this.rEnergyShort.clear();
    this.rIdle.clear();
    this.spanBest = -1;
    this.armLenBest = -1;
    this.wristTopBest = Infinity;
    this.hipStandBest = Infinity;
    this.hipLowBest = -1;
    this.skipped = 0;
  }

  private updateDistance(scalePx: number): void {
    const frac = this.viewW > 0 ? scalePx / this.viewW : 0;
    // Hysteresis: enter on the limit, leave only past the exit band.
    this.far = this.far ? frac < AUTO_TOO_FAR_EXIT : frac < AUTO_TOO_FAR_FRAC;
    // Too close is a SPAN fit rather than a width fraction — see
    // AUTO_TOO_CLOSE_SPAN for why a width threshold can never fire. armSpan
    // is in shoulder-width units, so this is the customer's reach measured in
    // view widths: 1.0 means their T-pose exactly fills the frame.
    const spanFit = frac * this.live.armSpan;
    this.close = this.close ? spanFit > AUTO_TOO_CLOSE_EXIT : spanFit > AUTO_TOO_CLOSE_SPAN;
  }

  /** One measured frame. Everything here is in-place. */
  private ingest(p: PlayerPose, dt: number): void {
    const viewH = this.viewH;

    // ── 1. Scale ───────────────────────────────────────────────────────────
    this.rScale.push(p.scalePx);
    if (this.rScale.count >= this.o.minSamples) {
      const target = this.rScale.quantile(0.5);
      if (!this.scaleLocked) {
        // First usable median: snap. Approaching the first measurement
        // gradually would mean the first second of every customer is spent
        // sliding away from a stranger's shoulders.
        this.scalePx = target;
        this.scaleLocked = true;
      } else {
        const moved = Math.abs(target - this.scalePx) > AUTO_SCALE_DEADBAND * this.scalePx;
        this.scalePx = approach(
          this.scalePx,
          target,
          moved ? AUTO_SCALE_RATE_FAST : AUTO_SCALE_RATE_SLOW,
          dt,
        );
        if (moved) {
          // The customer is walking. Every extreme measured in VIEW fractions
          // was measured at the old distance and is now wrong; the ones in
          // shoulder-width units (span, arm length) are properties of the body
          // and survive.
          this.wristTopBest = Infinity;
          this.hipStandBest = Infinity;
          this.hipLowBest = -1;
          this.rHip.clear();
          this.rWrist.clear();
        }
      }
      this.live.shoulderW = this.scalePx;
      this.flags.shoulderW = true;
    } else {
      this.scalePx = p.scalePx; // so the distance hint has something real
    }

    // ── 2. Hip height: standing is the HIGHEST sustained hip, squat the lowest ─
    const hipY = (p.px[L.LEFT_HIP * 2 + 1]! + p.px[L.RIGHT_HIP * 2 + 1]!) / 2 / viewH;
    this.rHip.push(hipY);
    if (this.rHip.count >= this.o.minSamples) {
      const sustained = this.rHip.quantile(0.5);
      // y grows DOWN: standing is the minimum. Taking the window median rather
      // than the current frame means a customer who squats while waiting
      // cannot drag `standHipY` down with them.
      if (sustained < this.hipStandBest) this.hipStandBest = sustained;
      if (this.rHip.full && sustained > this.hipLowBest) this.hipLowBest = sustained;
      this.live.standHipY = clamp(this.hipStandBest, 0.1, 0.99);
      this.flags.standHipY = true;
    }
    const stand = this.live.standHipY;
    const squatObserved = this.hipLowBest > stand + 0.04;
    this.live.squatHipY = clamp(squatObserved ? this.hipLowBest : stand + 0.12, 0.1, 1.2);
    this.flags.squatHipY = squatObserved;

    // ── 3. Reach, in normalized units (already distance-independent) ────────
    const wl = L.LEFT_WRIST * 2;
    const wr = L.RIGHT_WRIST * 2;
    const okL = p.vis[L.LEFT_WRIST]! >= MIN_VIS;
    const okR = p.vis[L.RIGHT_WRIST]! >= MIN_VIS;
    if (okL && okR) {
      this.rSpan.push(Math.hypot(p.n[wl]! - p.n[wr]!, p.n[wl + 1]! - p.n[wr + 1]!));
      if (this.rSpan.full) {
        const held = this.rSpan.quantile(0.5);
        if (held > this.spanBest) this.spanBest = held;
      }
    }
    const lenL = okL && p.vis[L.LEFT_SHOULDER]! >= MIN_VIS
      ? Math.hypot(p.n[wl]! - p.n[L.LEFT_SHOULDER * 2]!, p.n[wl + 1]! - p.n[L.LEFT_SHOULDER * 2 + 1]!)
      : 0;
    const lenR = okR && p.vis[L.RIGHT_SHOULDER]! >= MIN_VIS
      ? Math.hypot(p.n[wr]! - p.n[L.RIGHT_SHOULDER * 2]!, p.n[wr + 1]! - p.n[L.RIGHT_SHOULDER * 2 + 1]!)
      : 0;
    if (lenL > 0 || lenR > 0) {
      this.rArmLen.push(Math.max(lenL, lenR));
      if (this.rArmLen.full) {
        const held = this.rArmLen.quantile(0.5);
        if (held > this.armLenBest) this.armLenBest = held;
      }
    }
    // Same rule as the 4-second capture: an arm length under 0.9 shoulder
    // widths is an occlusion, not an arm.
    const armLenObserved = this.armLenBest > 0.9;
    const armLen = armLenObserved ? Math.min(ARM_LEN_MAX, this.armLenBest) : this.base.armLen;
    const derivedSpan = 2 * armLen + 0.9; // two arms plus the shoulder line
    this.live.armLen = armLen;
    this.flags.armLen = armLenObserved;
    this.live.armSpan = Math.max(this.spanBest, derivedSpan);
    // Grounded in this customer either way: a held stretch beat the derived
    // floor, or the floor itself was derived from their own measured arm
    // length. Only a body that never showed a straight arm leaves this false.
    // (On this project's own skeleton the derived floor comes out marginally
    // ABOVE a real T-pose span — 4.36 vs 4.26 — so "did a stretch win?" alone
    // would report a measured span as an estimate.)
    this.flags.armSpan = armLenObserved || this.spanBest > derivedSpan;

    // Highest wrist as a view fraction. Only a measurement if the hands
    // actually went up during the window; otherwise the same relative fallback
    // the 4-second capture uses, so a game sees the same shape of number from
    // either calibrator.
    let top = Infinity;
    if (okL) top = Math.min(top, p.px[wl + 1]!);
    if (okR) top = Math.min(top, p.px[wr + 1]!);
    if (Number.isFinite(top)) {
      this.rWrist.push(top / viewH);
      if (this.rWrist.full) {
        const held = this.rWrist.quantile(0.5);
        if (held < this.wristTopBest) this.wristTopBest = held;
      }
    }
    const reachFallback = stand - 0.2;
    const reachObserved = this.wristTopBest < reachFallback;
    this.live.reachUpY = clamp(reachObserved ? this.wristTopBest : reachFallback, -0.5, 0.9);
    this.flags.reachUpY = reachObserved;

    // ── 4. Lower body. Reported, never guessed ─────────────────────────────
    const avl = p.vis[L.LEFT_ANKLE]!;
    const avr = p.vis[L.RIGHT_ANKLE]!;
    this.rAnkleVis.push(Math.max(avl, avr));
    if (avl >= MIN_VIS || avr >= MIN_VIS) {
      const ay = avl >= MIN_VIS && avr >= MIN_VIS
        ? (p.px[L.LEFT_ANKLE * 2 + 1]! + p.px[L.RIGHT_ANKLE * 2 + 1]!) / 2
        : avl >= MIN_VIS
          ? p.px[L.LEFT_ANKLE * 2 + 1]!
          : p.px[L.RIGHT_ANKLE * 2 + 1]!;
      this.rAnkleY.push(ay / viewH);
    }
    const ankleOk = this.rAnkleVis.count > 0 && this.rAnkleVis.quantile(0.5) > MIN_VIS;
    this.rHipVis.push(Math.min(p.vis[L.LEFT_HIP]!, p.vis[L.RIGHT_HIP]!));
    this.hipsOk = this.rHipVis.quantile(0.5) >= MIN_VIS;
    this.live.lowerBodyVisible = ankleOk && this.hipsOk;
    this.flags.floorY = ankleOk && this.rAnkleY.count > 0;
    // 1.0 is the contract's "feet were never visible" sentinel.
    this.live.floorY = this.flags.floorY ? clamp(this.rAnkleY.quantile(0.5), 0.2, 1) : 1;

    // ── 5. Resting energy, from the STILL stretches only ───────────────────
    //
    // The 4-second capture takes the median of a window the player was told to
    // stand still in. A kiosk customer is reading a button, shifting weight and
    // waving at a friend, so the median of THEIR window is the energy of a
    // person in motion — threshold a freeze game on that and they can keep
    // moving through the freeze.
    //
    // So: average energy over 0.3s (an instantaneous zero is just the
    // turnaround of a wave — a 0.3s mean is not), then take the lower quartile
    // of 2 seconds of those. That is "the quietest fifth of the recent past",
    // which is as close to a still stretch as a kiosk ever gets.
    this.rEnergyShort.push(motionEnergy(p));
    if (this.rEnergyShort.full) this.rIdle.push(this.rEnergyShort.mean());
    if (this.rIdle.count >= this.o.minSamples) {
      // Same 0.08 floor as the 4-second path: a customer who genuinely froze
      // (or a photo held up to the camera) must not make freeze games
      // impossible for the next person who moves at all.
      this.live.idleEnergy = Math.max(0.08, this.rIdle.quantile(0.25));
      this.flags.idleEnergy = true;
    }

    this.live.mirrored = this.o.mirrored;
    this.live.capturedAt = this.lastT * 1000;
  }
}

/** Field-by-field copy into an existing object: the profile objects are
 *  allocated once and this runs at round boundaries, not per frame. */
function copyProfile(from: CalibrationProfile, to: CalibrationProfile): void {
  to.shoulderW = from.shoulderW;
  to.armSpan = from.armSpan;
  to.armLen = from.armLen;
  to.standHipY = from.standHipY;
  to.squatHipY = from.squatHipY;
  to.reachUpY = from.reachUpY;
  to.floorY = from.floorY;
  to.idleEnergy = from.idleEnergy;
  to.lowerBodyVisible = from.lowerBodyVisible;
  to.mirrored = from.mirrored;
  to.capturedAt = from.capturedAt;
}

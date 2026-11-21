// CalibrationProfile capture: one 4-second screen, once per session per player.
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
import { clamp, median } from '../math';
import { L, MIN_VIS } from './landmarks';

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
export const CALIBRATE_SKIP = 10;
export const CALIBRATE_SAMPLES = 60;

/** Robust percentile of an unsorted array. `q` 0..1. */
function percentile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const a = xs.slice().sort((p, r) => p - r);
  const i = clamp(Math.round((a.length - 1) * q), 0, a.length - 1);
  return a[i]!;
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
    if (!p.present || p.conf < MIN_VIS) return;
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
    const armLen = armLenRaw > 0.9 ? armLenRaw : 1.6;
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
      lowerBodyVisible: ankleOk,
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
    this.energy.length = 0;
    this.t0 = -1;
    this.tLast = 0;
  }
}

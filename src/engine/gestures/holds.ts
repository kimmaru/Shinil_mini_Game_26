// holdPose — angle-template matching plus a hold timer.
//
// Angles, not positions. An angle template is independent of height, build,
// limb length and distance from the camera, which makes "copy this pose" fair
// for a 120cm seven-year-old and a 170cm adult standing at different depths in
// the same room. A position template is not: it quietly rewards whoever happens
// to be built like whoever recorded it.
import { angleDeg6, clamp01 } from '../math';
import { L, MIN_VIS, type Joint } from '../pose/landmarks';
import type { GestureOpts, PlayerPose } from '../types';
import type { HoldPoseOpts, HoldSignal } from './index';
import { DetectorBase, HoldTimer, Trigger, opt } from './trigger';

/**
 * The three landmarks whose interior angle is measured AT each joint.
 *
 * One table, so five pose games cannot disagree about what "the shoulder angle"
 * means. A key with no entry here is ignored rather than guessed at — silently
 * measuring the wrong angle would be worse than measuring none.
 */
export const ANGLE_TRIPLETS: Partial<Record<Joint, readonly [Joint, Joint, Joint]>> = {
  [L.LEFT_ELBOW]: [L.LEFT_SHOULDER, L.LEFT_ELBOW, L.LEFT_WRIST],
  [L.RIGHT_ELBOW]: [L.RIGHT_SHOULDER, L.RIGHT_ELBOW, L.RIGHT_WRIST],
  [L.LEFT_SHOULDER]: [L.LEFT_ELBOW, L.LEFT_SHOULDER, L.LEFT_HIP],
  [L.RIGHT_SHOULDER]: [L.RIGHT_ELBOW, L.RIGHT_SHOULDER, L.RIGHT_HIP],
  [L.LEFT_HIP]: [L.LEFT_SHOULDER, L.LEFT_HIP, L.LEFT_KNEE],
  [L.RIGHT_HIP]: [L.RIGHT_SHOULDER, L.RIGHT_HIP, L.RIGHT_KNEE],
  [L.LEFT_KNEE]: [L.LEFT_HIP, L.LEFT_KNEE, L.LEFT_ANKLE],
  [L.RIGHT_KNEE]: [L.RIGHT_HIP, L.RIGHT_KNEE, L.RIGHT_ANKLE],
  [L.LEFT_WRIST]: [L.LEFT_ELBOW, L.LEFT_WRIST, L.LEFT_INDEX],
  [L.RIGHT_WRIST]: [L.RIGHT_ELBOW, L.RIGHT_WRIST, L.RIGHT_INDEX],
  [L.LEFT_ANKLE]: [L.LEFT_KNEE, L.LEFT_ANKLE, L.LEFT_FOOT_INDEX],
  [L.RIGHT_ANKLE]: [L.RIGHT_KNEE, L.RIGHT_ANKLE, L.RIGHT_FOOT_INDEX],
};

/**
 * Shared pose templates, measured against this repo's own skeleton
 * (testing/synth.ts `armsAt`), so a game using one is guaranteed to be
 * reachable by the clip corpus.
 *
 * Arms-only on purpose: legs and feet are cropped out of frame for a laptop
 * user, and a template that includes a knee angle silently becomes
 * unsatisfiable for them.
 */
export const POSE_TEMPLATES = {
  /** Arms straight out sideways. */
  T: {
    [L.LEFT_ELBOW]: 176,
    [L.RIGHT_ELBOW]: 176,
    [L.LEFT_SHOULDER]: 90,
    [L.RIGHT_SHOULDER]: 90,
  } as Partial<Record<Joint, number>>,
  /** Arms up at 45 degrees. */
  Y: {
    [L.LEFT_ELBOW]: 176,
    [L.RIGHT_ELBOW]: 176,
    [L.LEFT_SHOULDER]: 135,
    [L.RIGHT_SHOULDER]: 135,
  } as Partial<Record<Joint, number>>,
  /** Both arms straight overhead. */
  I: {
    [L.LEFT_ELBOW]: 176,
    [L.RIGHT_ELBOW]: 176,
    [L.LEFT_SHOULDER]: 176,
    [L.RIGHT_SHOULDER]: 176,
  } as Partial<Record<Joint, number>>,
  /** Elbows bent, fists up — "strong arms". */
  FLEX: {
    [L.LEFT_ELBOW]: 60,
    [L.RIGHT_ELBOW]: 60,
    [L.LEFT_SHOULDER]: 90,
    [L.RIGHT_SHOULDER]: 90,
  } as Partial<Record<Joint, number>>,
} as const;

/**
 * HOLD POSE — mean absolute angle error under tolerance, held for `holdMs`.
 *
 * `perJoint` is the reason this is worth more than a boolean: partial-success
 * feedback ("this elbow is right, that one isn't") is what makes a pose game
 * feel fair instead of arbitrary to a 9-year-old. Render it.
 *
 * Joints whose landmarks are not visible are DROPPED from the mean rather than
 * scored as wrong — otherwise a laptop user whose knees are cropped can never
 * complete any pose. If every joint drops out, `ok` goes false and the timer
 * holds where it was.
 */
export class HoldPoseDetector extends DetectorBase<'holdPose'> {
  readonly kind = 'holdPose' as const;
  protected readonly s: HoldSignal;

  /**
   * No single joint may be more than this multiple of `tolDeg` out, however
   * good the mean is.
   *
   * `tolDeg` is documented as a MEAN absolute error, and a mean over four
   * joints hides one badly wrong limb behind three correct ones. Measured: a
   * player holding ONE arm out in a T and the other hanging straight down
   * scores a mean error of 20.8 degrees against the T template and completed
   * the pose — a 78 degree error on one shoulder, diluted by three near-zero
   * ones. Five pose games would have shipped telling children that was a T.
   * A joint this far out is exactly the one whose `perJoint` reads 0.
   */
  static readonly JOINT_CAP = 2.5;

  private keys: Joint[] = [];
  private targets: Float64Array = new Float64Array(0);
  private tol = 22;
  private holdMs = 800;
  private readonly tr: Trigger;
  private readonly timer = new HoldTimer();
  private readonly sm: Float64Array;

  constructor(o: HoldPoseOpts) {
    super(o, 0);
    this.readTemplate(o.angles ?? {});
    this.sm = new Float64Array(16).fill(NaN);
    this.s = {
      inPose: false,
      progress: 0,
      done: false,
      error: 0,
      // Parallel to the keys of `angles`, allocated once.
      perJoint: new Float32Array(this.keys.length),
      ok: false,
    };
    this.tr = new Trigger(0, -1, 0, this.confirmFrames);
    this.apply(o);
  }

  private readTemplate(angles: Partial<Record<Joint, number>>): void {
    this.keys.length = 0;
    const ks = Object.keys(angles);
    const t: number[] = [];
    for (let i = 0; i < ks.length; i++) {
      const j = Number(ks[i]) as Joint;
      const v = angles[j];
      if (v === undefined || !Number.isFinite(v)) continue;
      if (ANGLE_TRIPLETS[j] === undefined) continue; // unknown joint: ignored, not guessed
      this.keys.push(j);
      t.push(v);
    }
    this.targets = new Float64Array(t);
  }

  private apply(o: Partial<HoldPoseOpts>): void {
    this.tol = opt(o.tolDeg, 22, 2, 90);
    this.holdMs = Math.max(0, opt(o.holdMs, 800, 0, 60_000));
    // Thresholds the negated error so "in pose" is a rising edge with
    // hysteresis: a pose held right at the tolerance must not strobe `done`.
    this.tr.set(-this.tol, -this.tol * 1.3);
    this.tr.confirmFrames = this.confirmFrames;
  }

  protected override onConfigure(o: Partial<GestureOpts['holdPose']>): void {
    const h = o as Partial<HoldPoseOpts>;
    if (h.angles !== undefined) {
      this.readTemplate(h.angles);
      if (this.s.perJoint.length !== this.keys.length) {
        // Only on an explicit retune between rounds, never in read().
        (this.s as { perJoint: Float32Array }).perJoint = new Float32Array(this.keys.length);
      }
      this.sm.fill(NaN);
    }
    this.apply(h);
  }

  protected clearEdges(): void {
    this.s.done = false;
  }

  protected step(p: PlayerPose): void {
    let sum = 0;
    let n = 0;
    let worst = 0;
    const alpha = this.dt > 0 ? 1 - Math.exp(-14 * this.dt) : 1;
    for (let i = 0; i < this.keys.length; i++) {
      const j = this.keys[i]!;
      const tri = ANGLE_TRIPLETS[j]!;
      const a = tri[0];
      const b = tri[1];
      const c = tri[2];
      if (p.vis[a]! < MIN_VIS || p.vis[b]! < MIN_VIS || p.vis[c]! < MIN_VIS) {
        this.s.perJoint[i] = 0;
        continue;
      }
      const deg = angleDeg6(
        p.n[a * 2]!,
        p.n[a * 2 + 1]!,
        p.n[b * 2]!,
        p.n[b * 2 + 1]!,
        p.n[c * 2]!,
        p.n[c * 2 + 1]!,
      );
      const prev = i < this.sm.length ? this.sm[i]! : NaN;
      const v = Number.isFinite(prev) ? prev + (deg - prev) * alpha : deg;
      if (i < this.sm.length) this.sm[i] = v;
      const err = Math.abs(v - this.targets[i]!);
      sum += err;
      n++;
      if (err > worst) worst = err;
      // 1 at a perfect angle, 0 at twice the tolerance out. This is the number
      // a game should colour a limb with.
      this.s.perJoint[i] = 1 - clamp01(err / (this.tol * 2));
    }

    const ok = n > 0;
    this.setOk(ok);
    if (ok) this.s.error = sum / n;
    // The trigger sees whichever is worse: the mean, or a single joint scaled
    // back into mean units by the cap. One limb in completely the wrong place
    // vetoes the pose no matter how good the average is.
    const capped = worst / HoldPoseDetector.JOINT_CAP;
    const judged = capped > this.s.error ? capped : this.s.error;
    this.tr.update(-judged, this.tMs, ok);
    this.s.inPose = this.tr.active;
    this.timer.update(this.s.inPose, ok ? this.dtMs : 0, this.holdMs);
    this.s.progress = this.timer.progress(this.holdMs);
    this.s.done = this.timer.done;
  }

  protected onReset(): void {
    this.tr.reset();
    this.timer.reset();
    this.sm.fill(NaN);
    this.s.inPose = false;
    this.s.progress = 0;
    this.s.done = false;
    this.s.error = 0;
    this.s.perJoint.fill(0);
  }

  protected override get dbgUnit(): string {
    return 'deg mean error';
  }
  protected override get dbgValue(): number {
    return this.s.error;
  }
  protected override get dbgEnter(): number {
    return this.tol;
  }
  protected override get dbgExit(): number {
    return this.tol * 1.3;
  }
  protected override get dbgActive(): boolean {
    return this.s.inPose;
  }
}

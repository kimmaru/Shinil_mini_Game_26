// poseMatch (cosine similarity) and jointTargets (coverage).
//
// poseMatch is the Move Mirror method from RESEARCH-POSE §5.5: take the
// keypoints you care about, translate and scale them into a common frame,
// L2-normalize the flat vector, then take a cosine. It is the right answer for
// a party site because it needs no training data and no pose library — a game
// ships one target vector and gets a fair 0..1 score out.
//
// Why it is FAIR: after the centroid subtraction and the RMS-radius division,
// two bodies of different height, build and camera distance that are in the
// same shape produce the same vector. Nothing about the comparison can reward
// being tall.
import { clamp01 } from '../math';
import { L, MIN_VIS, type Joint, palm } from '../pose/landmarks';
import type { GestureOpts, PlayerPose, Pt } from '../types';
import type {
  JointTargetsOpts,
  JointTargetsSignal,
  PoseMatchOpts,
  PoseMatchSignal,
} from './index';
import type { ViewRef } from './detectors';
import { DetectorBase, HoldTimer, Stats, opt } from './trigger';

/** Per-joint error, in shoulder widths of the normalized frame, that scores
 *  `perJoint` 0. Half a shoulder width out is unambiguously the wrong shape. */
export const JOINT_ERR_FULL = 0.5;

// ─── poseMatch ──────────────────────────────────────────────────────────────

export class PoseMatchDetector extends DetectorBase<'poseMatch'> {
  readonly kind = 'poseMatch' as const;
  protected readonly s: PoseMatchSignal;

  private joints: readonly Joint[] = [];
  private weights: Float32Array | null = null;
  /** Target, normalized once at construction — never per frame. */
  private tgt: Float64Array;
  private readonly cur: Float64Array;
  private readonly roll: Stats;

  constructor(o: PoseMatchOpts) {
    super(o, 0);
    this.joints = o.joints ?? [];
    const n = this.joints.length;
    this.cur = new Float64Array(n * 2);
    this.tgt = new Float64Array(n * 2);
    this.s = {
      score: 0,
      best: 0,
      perJoint: new Float32Array(n),
      ok: false,
    };
    this.roll = new Stats(1, 128);
    this.apply(o);
  }

  private apply(o: Partial<PoseMatchOpts>): void {
    if (o.target !== undefined) {
      const n = this.joints.length;
      this.tgt = new Float64Array(n * 2);
      for (let i = 0; i < n * 2 && i < o.target.length; i++) this.tgt[i] = o.target[i]!;
      normalizeShape(this.tgt, n, null);
    }
    if (o.weights !== undefined) this.weights = o.weights;
    this.roll.windowSec = Math.max(0.1, opt(o.rollingMs, 1000, 100, 10_000)) / 1000;
  }

  protected override onConfigure(o: Partial<GestureOpts['poseMatch']>): void {
    this.apply(o as Partial<PoseMatchOpts>);
  }

  protected clearEdges(): void {
    // Continuous score.
  }

  protected step(p: PlayerPose): void {
    const js = this.joints;
    const n = js.length;
    if (n === 0) {
      this.setOk(false);
      return;
    }
    let seen = 0;
    for (let i = 0; i < n; i++) {
      const j = js[i]!;
      this.cur[i * 2] = p.n[j * 2]!;
      this.cur[i * 2 + 1] = p.n[j * 2 + 1]!;
      if (p.vis[j]! >= MIN_VIS) seen++;
    }
    // Half the template missing is not a pose, it is a person walking out of
    // frame. Hold the last score rather than reporting a lucky partial match.
    const ok = seen * 2 >= n;
    this.setOk(ok);
    if (!ok) return;

    const w = this.weights;
    normalizeShape(this.cur, n, null);

    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < n; i++) {
      const j = js[i]!;
      // Default weight is visibility (the weighted Move Mirror variant), so a
      // half-seen wrist cannot drag a good match down.
      const wi = w !== null && i < w.length ? w[i]! : p.vis[j]!;
      const ax = this.cur[i * 2]!;
      const ay = this.cur[i * 2 + 1]!;
      const bx = this.tgt[i * 2]!;
      const by = this.tgt[i * 2 + 1]!;
      dot += wi * (ax * bx + ay * by);
      na += wi * (ax * ax + ay * ay);
      nb += wi * (bx * bx + by * by);
      const ex = ax - bx;
      const ey = ay - by;
      this.s.perJoint[i] = 1 - clamp01(Math.sqrt(ex * ex + ey * ey) / JOINT_ERR_FULL);
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    // clamp01, not (cos+1)/2: a shape unrelated to the target has a cosine near
    // zero and must score near zero. Mapping it to 0.5 would hand every game a
    // free half-score for standing still, and the star curves assume it does
    // not.
    const cos = denom > 1e-9 ? dot / denom : 0;
    this.s.score = clamp01(cos);
    this.roll.push(this.s.score, this.t);
    this.s.best = this.roll.max;
  }

  protected onReset(): void {
    this.roll.reset();
    this.s.score = 0;
    this.s.best = 0;
    this.s.perJoint.fill(0);
  }

  protected override get dbgUnit(): string {
    return 'cosine 0..1';
  }
  protected override get dbgValue(): number {
    return this.s.score;
  }
  protected override get dbgEnter(): number {
    return this.s.best;
  }
}

/**
 * Centre on the joint-set centroid, then divide by the RMS radius.
 *
 * `n` is already hip-centred and shoulder-scaled, but a template of (say) four
 * upper-body joints should still match a player leaning or standing slightly
 * differently, so the comparison is made in the joint set's OWN frame. This is
 * `posenet-similarity`'s normalization with an RMS radius instead of a max,
 * which is less sensitive to one bad landmark.
 */
function normalizeShape(v: Float64Array, n: number, _unused: null): void {
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += v[i * 2]!;
    cy += v[i * 2 + 1]!;
  }
  cx /= n;
  cy /= n;
  let r = 0;
  for (let i = 0; i < n; i++) {
    const dx = v[i * 2]! - cx;
    const dy = v[i * 2 + 1]! - cy;
    v[i * 2] = dx;
    v[i * 2 + 1] = dy;
    r += dx * dx + dy * dy;
  }
  r = Math.sqrt(r / n);
  if (r < 1e-6) return;
  for (let i = 0; i < n * 2; i++) v[i] = v[i]! / r;
}

// ─── jointTargets ───────────────────────────────────────────────────────────

/**
 * JOINT TARGETS — "put this hand here and that knee there", all at once.
 *
 * Targets are in 0..1 view fractions, so this needs the view rect the same way
 * `zone` does (see service.ts). Wrist targets are tested against the PALM, not
 * the wrist: landmarks.ts is emphatic that hit zones belong on the palm, which
 * trails the hand by a whole hand-length, and a child aims with their hand.
 */
export class JointTargetsDetector extends DetectorBase<'jointTargets'> {
  readonly kind = 'jointTargets' as const;
  protected readonly s: JointTargetsSignal;

  private targets: readonly { x: number; y: number; r: number; joint: Joint }[] = [];
  private holdMs = 1200;
  private readonly timer = new HoldTimer();
  private readonly pt: Pt = { x: 0, y: 0 };

  constructor(
    o: JointTargetsOpts,
    private readonly view: ViewRef,
  ) {
    super(o, 0);
    this.targets = o.targets ?? [];
    this.s = {
      covered: new Uint8Array(this.targets.length),
      coveredCount: 0,
      all: false,
      progress: 0,
      done: false,
      ok: false,
    };
    this.holdMs = Math.max(0, opt(o.holdMs, 1200, 0, 60_000));
  }

  protected override onConfigure(o: Partial<GestureOpts['jointTargets']>): void {
    const j = o as Partial<JointTargetsOpts>;
    if (j.targets !== undefined) {
      this.targets = j.targets;
      if (this.s.covered.length !== this.targets.length) {
        (this.s as { covered: Uint8Array }).covered = new Uint8Array(this.targets.length);
      }
    }
    if (j.holdMs !== undefined) this.holdMs = Math.max(0, j.holdMs);
  }

  protected clearEdges(): void {
    this.s.done = false;
  }

  protected step(p: PlayerPose): void {
    const vw = this.view.w > 0 ? this.view.w : 1280;
    const vh = this.view.h > 0 ? this.view.h : 720;
    const ts = this.targets;
    let count = 0;
    let seen = 0;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i]!;
      if (p.vis[t.joint]! < MIN_VIS) {
        this.s.covered[i] = 0;
        continue;
      }
      seen++;
      if (t.joint === L.LEFT_WRIST) palm(p, 'L', this.pt);
      else if (t.joint === L.RIGHT_WRIST) palm(p, 'R', this.pt);
      else {
        this.pt.x = p.px[t.joint * 2]!;
        this.pt.y = p.px[t.joint * 2 + 1]!;
      }
      const dx = this.pt.x - t.x * vw;
      const dy = this.pt.y - t.y * vh;
      // Radius is a fraction of the SHORTER side, so a target is the same
      // physical size on a 4:3 projector and a 16:9 laptop.
      const r = t.r * Math.min(vw, vh);
      const hit = dx * dx + dy * dy <= r * r;
      this.s.covered[i] = hit ? 1 : 0;
      if (hit) count++;
    }
    this.s.coveredCount = count;
    this.s.all = ts.length > 0 && count === ts.length;
    this.setOk(seen > 0);
    this.timer.update(this.s.all, this.dtMs, this.holdMs);
    this.s.done = this.timer.done;
    this.s.progress =
      this.holdMs <= 0
        ? ts.length === 0
          ? 0
          : count / ts.length
        : this.timer.progress(this.holdMs);
  }

  protected onReset(): void {
    this.timer.reset();
    this.s.covered.fill(0);
    this.s.coveredCount = 0;
    this.s.all = false;
    this.s.progress = 0;
    this.s.done = false;
  }

  protected override get dbgUnit(): string {
    return 'targets covered';
  }
  protected override get dbgValue(): number {
    return this.s.coveredCount;
  }
  protected override get dbgEnter(): number {
    return this.targets.length;
  }
  protected override get dbgActive(): boolean {
    return this.s.all;
  }
}

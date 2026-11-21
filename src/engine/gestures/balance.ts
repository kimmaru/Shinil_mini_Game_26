// balance — single-leg detection plus a sway quality metric.
//
// Three games depend on this (flamingo-balance, tightrope-walk, tree-pose-yoga)
// and all three are played in front of a laptop, where the feet are the FIRST
// thing cropped out of frame. Measured on this corpus: the ankles are below
// MIN_VIS in every clip except `hold-poses` (where only the LIFTED ankle rises
// into view) and `far-small`. So a detector that simply requires two visible
// ankles would never fire for a real player in a real classroom.
//
// Hence a fallback ladder, in order of trustworthiness:
//   1. both ankles visible  -> height difference between them. Needs no
//      baseline and no anatomy, so it is the only rung with no assumptions.
//   2. exactly one ankle    -> its hip-to-ankle distance against a standing
//      reference. A lifted foot nearly halves that distance, which is a big,
//      obvious signal; the reference is seeded from anatomy and then tracks the
//      player's own leg. This rung must come BEFORE the knees, because the one
//      ankle a laptop camera sees is usually the LIFTED one.
//   3. both knees, no ankles -> height difference between the knees. A knee
//      lift is a cruder balance cue, but it lets a cropped-feet player play.
//      Never one knee against a hip-distance reference: see rung 3 below for
//      the squat that detector reads as a permanent one-leg stand.
import { clamp, clamp01 } from '../math';
import { L, MIN_VIS, type Side } from '../pose/landmarks';
import type { GestureOpts, PlayerPose } from '../types';
import type { BalanceOpts, BalanceSignal } from './index';
import { DetectorBase, HoldTimer, Stats, Trigger, distN, opt, scaleOf, seen1 } from './trigger';

/** Standing hip-to-ankle distance, shoulder widths. Anatomy, not a guess:
 *  this repo's own skeleton (synth.ts P.thigh 1.12 + P.shin 1.05) is 2.17, and
 *  child anthropometry gives 2.0-2.2 for a leg over a biacromial width. Used
 *  only as the SEED of a reference that then tracks the player's real maximum,
 *  and only on the one-ankle rung of the ladder. */
export const STANDING_LEG_SW = 2.1;

/** Lateral sway, in shoulder widths of shoulder-centre standard deviation,
 *  that scores `quality` 0. A child wobbling 0.1sw is visibly unsteady. */
export const SWAY_BAD = 0.1;

export class BalanceDetector extends DetectorBase<'balance'> {
  readonly kind = 'balance' as const;
  protected readonly s: BalanceSignal = {
    onOneFoot: false,
    liftedFoot: null,
    sway: 0,
    quality: 0,
    heldMs: 0,
    ok: false,
  };

  private liftAt = 0.35;
  private want: Side | 'either' = 'either';
  private readonly tr: Trigger;
  private readonly sway = new Stats(1, 64);
  private readonly timer = new HoldTimer();
  private refL = STANDING_LEG_SW;
  private refR = STANDING_LEG_SW;
  private value = 0;

  constructor(o: BalanceOpts = {}) {
    super(o, 0);
    this.tr = new Trigger(0.35, 0.18, 0, this.confirmFrames);
    this.apply(o);
  }

  private apply(o: Partial<BalanceOpts>): void {
    this.liftAt = opt(o.liftAt, 0.35, 0.05, 2);
    if (o.foot !== undefined) this.want = o.foot;
    this.tr.set(this.liftAt, this.liftAt * 0.5);
    this.tr.confirmFrames = this.confirmFrames;
  }

  protected override onConfigure(o: Partial<GestureOpts['balance']>): void {
    this.apply(o as Partial<BalanceOpts>);
  }

  protected clearEdges(): void {
    // Sustained state; `heldMs` is cumulative.
  }

  protected step(p: PlayerPose): void {
    const aL = seen1(p, L.LEFT_ANKLE);
    const aR = seen1(p, L.RIGHT_ANKLE);
    const kL = seen1(p, L.LEFT_KNEE);
    const kR = seen1(p, L.RIGHT_KNEE);
    const hips = p.vis[L.LEFT_HIP]! >= MIN_VIS || p.vis[L.RIGHT_HIP]! >= MIN_VIS;

    let lift = 0;
    let side: Side | null = null;
    let ok = false;

    if (aL && aR) {
      // Rung 1: y difference between the two ankles. Self-referential, so it
      // needs no baseline, no anatomy and no trust in a held coordinate.
      // +y is DOWN, so the lifted ankle is the one with the smaller n.y.
      const dy = p.n[L.RIGHT_ANKLE * 2 + 1]! - p.n[L.LEFT_ANKLE * 2 + 1]!;
      lift = Math.abs(dy);
      side = dy > 0 ? 'L' : 'R';
      ok = true;
      // Both feet down: a standing frame, so refresh the references.
      if (lift < this.liftAt * 0.4 && hips) {
        this.refL = this.track(this.refL, distN(p, L.LEFT_HIP, L.LEFT_ANKLE));
        this.refR = this.track(this.refR, distN(p, L.RIGHT_HIP, L.RIGHT_ANKLE));
      }
    } else if ((aL || aR) && hips) {
      // Rung 2: exactly one ankle. This is the `hold-poses` one-leg case — the
      // LIFTED foot is the one that rises into frame while the standing one
      // stays cropped — so it must be tried before the knee rung, which cannot
      // see a foot lift at all.
      const s: Side = aL ? 'L' : 'R';
      const hip = s === 'L' ? L.LEFT_HIP : L.RIGHT_HIP;
      const ankle = s === 'L' ? L.LEFT_ANKLE : L.RIGHT_ANKLE;
      const d = distN(p, hip, ankle);
      const ref = s === 'L' ? this.refL : this.refR;
      lift = clamp(ref - d, 0, 3);
      side = s;
      ok = true;
      if (lift < this.liftAt * 0.4) {
        if (s === 'L') this.refL = this.track(this.refL, d);
        else this.refR = this.track(this.refR, d);
      }
    } else if (kL && kR) {
      // Rung 3: BOTH knees, compared against each other — never one knee
      // against a hip-distance reference. That version read a squat as a
      // permanent one-leg stand: `squat-x8` drops the knees out of frame at the
      // bottom, normalize.ts holds their last position for 0.3s, the hip keeps
      // descending, and hip-to-knee collapses by a third of a shoulder width.
      // Comparing the two knees cancels any whole-body motion exactly.
      const dy = p.n[L.RIGHT_KNEE * 2 + 1]! - p.n[L.LEFT_KNEE * 2 + 1]!;
      // A thigh is about half a leg, so the same lift reads half as far here;
      // doubling puts it in the ankle rung's units so one `liftAt` works on all.
      lift = Math.abs(dy) * 2;
      side = dy > 0 ? 'L' : 'R';
      ok = true;
    }

    // A game that asked for a specific foot gets nothing for the other one.
    if (side !== null && this.want !== 'either' && side !== this.want) lift = 0;
    this.value = lift;
    this.setOk(ok);
    this.tr.update(lift, this.tMs, ok);
    this.s.onOneFoot = this.tr.active;
    this.s.liftedFoot = this.tr.active ? side : null;

    // Sway: standard deviation of the shoulder centre over 1s, in shoulder
    // widths. Differenced in px then scaled, so the scale estimate's wobble
    // does not read as a wobbling child.
    if (p.vis[L.LEFT_SHOULDER]! >= MIN_VIS || p.vis[L.RIGHT_SHOULDER]! >= MIN_VIS) {
      const sx = (p.px[L.LEFT_SHOULDER * 2]! + p.px[L.RIGHT_SHOULDER * 2]!) / 2;
      this.sway.push(sx / scaleOf(p), this.t);
    }
    this.s.sway = this.sway.count >= 4 ? this.sway.std : 0;
    this.s.quality = this.s.onOneFoot ? clamp01(1 - this.s.sway / SWAY_BAD) : 0;
    this.timer.update(this.s.onOneFoot, ok ? this.dtMs : 0, 1e9);
    this.s.heldMs = this.timer.ms;
  }

  /** References track the player's own maximum, with a slow decay so one
   *  mis-detected long leg does not poison the round. */
  private track(ref: number, d: number): number {
    if (!(d > 0.3)) return ref;
    if (d > ref) return ref + (d - ref) * 0.2;
    return ref + (d - ref) * 0.01;
  }

  protected onReset(): void {
    this.tr.reset();
    this.sway.reset();
    this.timer.reset();
    this.refL = STANDING_LEG_SW;
    this.refR = STANDING_LEG_SW;
    this.value = 0;
    this.s.onOneFoot = false;
    this.s.liftedFoot = null;
    this.s.sway = 0;
    this.s.quality = 0;
    this.s.heldMs = 0;
  }

  protected override get dbgUnit(): string {
    return 'sw foot lift';
  }
  protected override get dbgValue(): number {
    return this.value;
  }
  protected override get dbgEnter(): number {
    return this.tr.enter;
  }
  protected override get dbgExit(): number {
    return this.tr.exit;
  }
  protected override get dbgActive(): boolean {
    return this.s.onOneFoot;
  }
}

// The ten detectors 58 games read instead of touching landmarks.
//
// Every threshold in this file is in NORMALIZED units — shoulder widths, or
// shoulder widths per second — and every number was chosen against a measured
// value from the clip corpus in src/engine/testing/clips.ts, not invented. The
// evidence for each is in the comment beside it; where a number disagrees with
// the doc comment in index.ts, the comment says so and why.
//
// Three rules, enforced by the shape of the code rather than by review:
//   - Signals are allocated in the constructor and mutated. read() allocates
//     nothing, ever: a game calls it 60 times a second for a whole afternoon.
//   - One-frame flags are cleared in clearEdges() before any work, so a latched
//     `fired` cannot happen.
//   - Visibility gating holds state and fires nothing. We gate, we never guess.
import { DEG, clamp, clamp01 } from '../math';
import { Median3 } from '../pose/oneEuro';
import {
  L,
  MIN_VIS,
  type Joint,
  type Side,
  palm,
} from '../pose/landmarks';
import { angleDeg6 } from '../math';
import type { GestureOpts, PlayerPose, PoseFrame, Pt } from '../types';
import type {
  ClapOpts,
  ClapSignal,
  JumpOpts,
  JumpSignal,
  LeanOpts,
  LeanSignal,
  LimbAngleOpts,
  LimbAngleSignal,
  RaiseOpts,
  RaiseSignal,
  ReachOpts,
  ReachSignal,
  SquatOpts,
  SquatSignal,
  StepOpts,
  StepSignal,
  SwingOpts,
  SwingSignal,
  ZoneOpts,
  ZoneSignal,
} from './index';
import {
  Baseline,
  BodyDrift,
  DetectorBase,
  MIN_COOLDOWN_MS,
  Trigger,
  Vel,
  distN,
  hipPxX,
  hipPxY,
  leanN,
  opt,
  scaleOf,
  seen1,
  seen2,
  seenEither,
} from './trigger';

/** The view rect zone-style detectors measure their 0..1 fractions against.
 *  PoseFrame carries no view size, so the engine must keep this current —
 *  createGestureService(getFrame, view) wires it. See service.ts. */
export interface ViewRef {
  w: number;
  h: number;
}

// ─── jump ───────────────────────────────────────────────────────────────────

/**
 * JUMP — takeoff, not apex.
 *
 * Two paths OR'd into one normalized score, because neither alone survives the
 * corpus:
 *
 *  - VELOCITY (`enter`, shoulder-widths/sec). Fires 1-2 frames after takeoff on
 *    a real jump, which is the whole point: RESEARCH-POSE §5.5 measures 100-150ms
 *    of felt lag if you wait for peak height, and a 7-year-old reads that as
 *    broken. Gated on the hip already being `HEIGHT_MIN` above the baseline,
 *    without which half the corpus fires it: standing up out of `squat-x8`
 *    reaches 1.91 sw/s, running in place 2.73, stepping 2.12, and simply
 *    standing still 1.71.
 *  - DISPLACEMENT (`RISE_ENTER`). The path that carries the weak jumps: one of
 *    `jump-x8`'s eight only reaches 1.39 sw/s of measured velocity and three of
 *    `laggy`'s six only reach 1.2-1.4 (10fps leaves 4 samples per jump), all
 *    below the documented 1.5 — but every one of them displaces at least
 *    0.21 sw, where nothing that is not a jump exceeds 0.153.
 *
 * Plus a veto: if the hips moved further sideways than up, the scale estimate
 * twitched and dragged the whole body with it rather than the child jumping.
 * See `BodyDrift` — it is what takes `far-small` from 21 phantom jumps to 1.
 *
 * Never `worldLandmarks`: its origin IS the hip midpoint, so hip world-y is
 * always ~0. Never `n` either, for the same reason (normalize.ts §header).
 */
export class JumpDetector extends DetectorBase<'jump'> {
  readonly kind = 'jump' as const;
  protected readonly s: JumpSignal = {
    fired: false,
    power: 0,
    airborne: false,
    height: 0,
    ok: false,
  };

  /**
   * Hip must clear this (sw) before the velocity path is allowed to fire.
   *
   * This gate, not the velocity threshold, is what stops everything else in the
   * corpus from firing a jump — because at this camera distance the hip's
   * measured VELOCITY noise alone reaches 1.5 sw/s and beyond on clips with no
   * jump in them at all: idle 1.71, step-lr 2.12, squat-x8 1.91 (standing up),
   * knee-run 2.73 (running in place). Their hip DISPLACEMENT, however, stays
   * at or below 0.153 sw. 0.17 sits above all of it with an 11% margin, and
   * every real jump in `jump-x8` rises at least 0.23 sw.
   *
   * It is also the one knob for jump latency: lowering it fires sooner and
   * reintroduces phantom jumps in running and squatting games.
   */
  static readonly HEIGHT_MIN = 0.17;
  /** Displacement that counts as a jump on its own, at the default `enter`.
   *  Evidence: the 8 jumps of `jump-x8` rise 0.23-0.45 sw and `laggy`'s 6 rise
   *  0.21-0.52; the highest any non-jumping clip reaches is 0.153 sw
   *  (`swing-wide`). Scales with `enter` so a stricter velocity threshold is
   *  stricter overall. */
  static readonly RISE_ENTER = 0.2;
  /** Takeoff velocity treated as a "big jump for this player" until the player
   *  shows otherwise. Seeds `power` so the first jump is not automatically 1.0. */
  static readonly POWER_REF = 3.0;

  private enterV = 1.5;
  private exitDisp = 0.08;
  private riseEnter = JumpDetector.RISE_ENTER;
  private requireFeet = false;

  private readonly med = new Median3();
  /** Short window, fed the UNMEDIANED hip. A windowed derivative reports the
   *  motion at the window's centre, so every extra millisecond of window is
   *  half a millisecond of felt lag on the one gesture where lag is the
   *  complaint. 0.12s leaves a 1.9:1 margin over the measured idle/fidget
   *  velocity noise (0.78 sw/s peak) against a 1.5 sw/s threshold, and the
   *  displacement gate rejects what is left. */
  private readonly vel = new Vel(0.12, 32);
  private readonly base = new Baseline(0.8, 0.08, 1);
  private readonly drift = new BodyDrift();
  private readonly tr: Trigger;
  private bestV = JumpDetector.POWER_REF;

  constructor(o: JumpOpts = {}) {
    super(o, MIN_COOLDOWN_MS);
    this.tr = new Trigger(1, 0.5, Math.max(this.cooldownMs, MIN_COOLDOWN_MS), this.confirmFrames);
    this.tr.express = 1.6;
    this.apply(o);
  }

  private apply(o: JumpOpts): void {
    this.enterV = opt(o.enter, 1.5, 0.3, 12);
    this.exitDisp = opt(o.exit, 0.12, 0.01, 1);
    this.riseEnter = JumpDetector.RISE_ENTER * (this.enterV / 1.5);
    if (o.requireFeetVisible !== undefined) this.requireFeet = o.requireFeetVisible;
    // The normalized score is 1 at either threshold, so one hysteresis pair
    // covers both paths: exit 0.5 == rise back to exitDisp when v is 0.
    this.tr.set(1, this.exitDisp / this.riseEnter);
    this.tr.cooldownMs = Math.max(this.cooldownMs, MIN_COOLDOWN_MS);
    this.tr.confirmFrames = this.confirmFrames;
  }

  protected override onConfigure(o: Partial<GestureOpts['jump']>): void {
    this.apply(o as JumpOpts);
  }

  protected clearEdges(): void {
    this.s.fired = false;
  }

  protected step(p: PlayerPose): void {
    const hipsOk = seenEither(p, L.LEFT_HIP, L.RIGHT_HIP);
    const feetOk =
      !this.requireFeet || seenEither(p, L.LEFT_ANKLE, L.RIGHT_ANKLE);
    const ok = hipsOk && feetOk;
    this.setOk(ok);

    const s = scaleOf(p);
    // Median-of-3 in PIXELS. normalize.ts medians the raw landmarks, but
    // `px = w * scalePx` re-introduces a spike every time the scale estimate
    // twitches, and at 4m that spike is worth 0.3 sw of phantom hip movement.
    // Measured: this median alone cut the fidget displacement floor by 40% and
    // is what lets `laggy` report exactly its 6 jumps.
    const raw = hipPxY(p);
    const y = this.med.push(raw);
    const v = -this.vel.push(raw, this.t) / s;
    this.base.band = 0.1 * s;
    const b = this.base.update(y, this.dt, this.s.airborne || !ok);
    const rise = Number.isFinite(b) ? (b - y) / s : 0;
    this.s.height = rise;

    // A jump is vertical. If the hips moved further sideways than up, the
    // camera's scale estimate twitched and took the whole body with it.
    this.drift.update(hipPxX(p), s, this.dt, this.s.airborne || !ok);
    const vetoed = this.drift.vetoes(rise);

    const byRise = rise / this.riseEnter;
    // The height gate stays on the MEDIANED rise: it is what keeps a squat
    // recovery and a run-in-place from firing a jump, and those margins are too
    // narrow to spend on an unfiltered spike.
    const byVel = rise >= JumpDetector.HEIGHT_MIN ? v / this.enterV : 0;
    const score = vetoed ? 0 : byRise > byVel ? byRise : byVel;

    if (this.tr.update(score, this.tMs, ok)) {
      this.s.fired = true;
      this.s.airborne = true;
      const vAtTakeoff = v > 0 ? v : 0;
      if (vAtTakeoff > this.bestV) this.bestV = vAtTakeoff;
      this.s.power = clamp01(vAtTakeoff / this.bestV);
    }
    if (this.s.airborne && !this.tr.active) this.s.airborne = false;
  }

  protected onReset(): void {
    this.med.reset();
    this.vel.reset();
    this.base.reset();
    this.drift.reset();
    this.tr.reset();
    this.bestV = JumpDetector.POWER_REF;
    this.s.fired = false;
    this.s.power = 0;
    this.s.airborne = false;
    this.s.height = 0;
  }

  protected override get dbgUnit(): string {
    return 'sw rise';
  }
  protected override get dbgValue(): number {
    return this.s.height;
  }
  protected override get dbgEnter(): number {
    return this.riseEnter;
  }
  protected override get dbgExit(): number {
    return this.exitDisp;
  }
  protected override get dbgActive(): boolean {
    return this.s.airborne;
  }
}

// ─── squat ──────────────────────────────────────────────────────────────────

/**
 * SQUAT — hip displacement below the resting baseline.
 *
 * Hip displacement, not knee angle: knee angle is viewpoint-dependent and poor
 * head-on, which is exactly how a party game in front of a laptop is played
 * (RESEARCH-POSE §5.5). It also survives the common case where the knees are
 * cropped out of frame — `squat-x8` loses knee visibility entirely at the
 * bottom of a deep squat.
 *
 * `released` is the counting edge. The corpus proves why: `squat-x8` ends with
 * a 9th partial squat that is deep enough to enter and never comes back up, so
 * counting entries gives 9 and counting releases gives the 8 the clip is named
 * for.
 */
export class SquatDetector extends DetectorBase<'squat'> {
  readonly kind = 'squat' as const;
  protected readonly s: SquatSignal = {
    down: false,
    entered: false,
    released: false,
    depth: 0,
    ok: false,
  };

  private enterD = 0.2;
  private exitD = 0.1;
  private readonly med = new Median3();
  private readonly base = new Baseline(0.8, 0.08, 1);
  private readonly drift = new BodyDrift();
  private readonly tr: Trigger;
  private pending = false;

  constructor(o: SquatOpts = {}) {
    super(o, MIN_COOLDOWN_MS);
    this.tr = new Trigger(0.32, 0.16, MIN_COOLDOWN_MS, this.confirmFrames);
    this.apply(o);
  }

  private apply(o: SquatOpts): void {
    // index.ts documents 0.45 / 0.22, and `squat-x8` is built to reach it: its
    // deepest squats drop a raw 0.6 sw. But the pose pipeline's One Euro filter
    // attenuates a 1.3s squat to ~85% of its amplitude, and the clip's
    // SHALLOWEST squats are a raw 0.45 — which arrive measured at 0.37-0.43. At
    // the documented 0.45 only 5 of the 8 are counted.
    //
    // 0.32/0.16 counts all 8 (the shallowest measures 0.37, a 16% margin) and
    // still sits 2.4x above the `fidget` floor of 0.136 sw and 2.9x above
    // `idle`'s 0.112. Raise it toward 0.45 if the corpus's shallow squats ever
    // get deeper; tune UP to ~0.45 for a game where a deliberate deep squat IS
    // the gesture.
    this.enterD = opt(o.enter, 0.32, 0.05, 1.5);
    this.exitD = opt(o.exit, this.enterD * 0.5, 0.02, 1.4);
    this.tr.set(this.enterD, this.exitD);
    this.tr.cooldownMs = Math.max(this.cooldownMs, MIN_COOLDOWN_MS);
    this.tr.confirmFrames = this.confirmFrames;
  }

  protected override onConfigure(o: Partial<GestureOpts['squat']>): void {
    this.apply(o as SquatOpts);
  }

  protected clearEdges(): void {
    this.s.entered = false;
    this.s.released = false;
  }

  protected step(p: PlayerPose): void {
    const ok = seenEither(p, L.LEFT_HIP, L.RIGHT_HIP);
    this.setOk(ok);
    const s = scaleOf(p);
    const y = this.med.push(hipPxY(p));
    this.base.band = 0.1 * s;
    const b = this.base.update(y, this.dt, this.tr.active || !ok);
    const drop = Number.isFinite(b) ? (y - b) / s : 0;
    this.s.depth = drop;
    // Same veto as jump: a squat is vertical, a scale twitch is not.
    this.drift.update(hipPxX(p), s, this.dt, this.tr.active || !ok);
    const value = this.drift.vetoes(drop) ? 0 : drop;

    if (this.tr.update(value, this.tMs, ok)) {
      this.s.entered = true;
      this.pending = true;
      this.s.down = true;
    }
    if (this.tr.exited && this.pending) {
      this.pending = false;
      this.s.down = false;
      this.s.released = true;
    }
  }

  protected onReset(): void {
    this.med.reset();
    this.base.reset();
    this.drift.reset();
    this.tr.reset();
    this.pending = false;
    this.s.down = false;
    this.s.entered = false;
    this.s.released = false;
    this.s.depth = 0;
  }

  protected override get dbgUnit(): string {
    return 'sw drop';
  }
  protected override get dbgValue(): number {
    return this.s.depth;
  }
  protected override get dbgEnter(): number {
    return this.enterD;
  }
  protected override get dbgExit(): number {
    return this.exitD;
  }
  protected override get dbgActive(): boolean {
    return this.s.down;
  }
}

// ─── clap ───────────────────────────────────────────────────────────────────

/**
 * CLAP — wrist separation collapsing fast.
 *
 * The most reliable gesture in the set, and the corpus says why: across every
 * clip that is not a clap, the two wrists never come closer than 0.78 shoulder
 * widths (`fidget`), 1.06 (`laggy`), 1.21 (`swing-wide`). `clap-x12` closes to
 * 0.007. A falling-distance edge at 0.42 has no overlap with anything.
 *
 * Separation is measured in `n`, a difference of two positions, so it carries
 * ~2% of the scale error rather than the ~200% an absolute position carries.
 */
export class ClapDetector extends DetectorBase<'clap'> {
  readonly kind = 'clap' as const;
  protected readonly s: ClapSignal = {
    fired: false,
    at: { x: 0, y: 0 },
    power: 0,
    ok: false,
  };

  private closeAt = 0.42;
  private openAt = 0.75;
  private minSpeed = 1.2;
  private readonly gapVel = new Vel(0.06, 16);
  private readonly tr: Trigger;
  private armed = true;
  private readonly lp: Pt = { x: 0, y: 0 };
  private readonly rp: Pt = { x: 0, y: 0 };

  constructor(o: ClapOpts = {}) {
    super(o, MIN_COOLDOWN_MS);
    // confirmFrames 1 unless the game asks otherwise: the gate is already
    // triple (near AND closing fast AND re-armed from open), and a clap at
    // 10fps is only 1-2 frames wide, so a 2-frame confirm drops real claps.
    this.tr = new Trigger(1, 0.5, Math.max(this.cooldownMs, MIN_COOLDOWN_MS), o.confirmFrames ?? 1);
    this.apply(o);
  }

  private apply(o: ClapOpts): void {
    this.closeAt = opt(o.closeAt, 0.42, 0.05, 1.2);
    // index.ts documents 0.75 to re-arm. Measured on `clap-x12`: the hands only
    // reopen to 0.60-0.63 sw between every third clap (the chest-height
    // variant), so 0.75 silently drops 4 of its 12 claps — a third of the score
    // in every clapping game. 0.55 catches all 12 with a 0.05 sw margin against
    // a gap signal whose noise is +-0.02. It cannot cost false positives: a
    // clap still needs a fast approach to within `closeAt`, and the closest the
    // two wrists come in any non-clapping clip is 0.78 sw.
    this.openAt = Math.max(opt(o.openAt, 0.55, 0.1, 2.5), this.closeAt * 1.25);
    this.minSpeed = opt(o.minSpeed, 1.2, 0, 20);
    this.tr.cooldownMs = Math.max(this.cooldownMs, MIN_COOLDOWN_MS);
  }

  protected override onConfigure(o: Partial<GestureOpts['clap']>): void {
    const c = o as ClapOpts;
    this.apply(c);
    if (c.confirmFrames !== undefined) this.tr.confirmFrames = Math.max(1, c.confirmFrames);
  }

  protected clearEdges(): void {
    this.s.fired = false;
  }

  protected step(p: PlayerPose): void {
    const ok = seen2(p, L.LEFT_WRIST, L.RIGHT_WRIST);
    this.setOk(ok);
    const gap = distN(p, L.LEFT_WRIST, L.RIGHT_WRIST);
    const closing = -this.gapVel.push(gap, this.t);
    if (gap >= this.openAt) this.armed = true;

    const cond = this.armed && gap <= this.closeAt && closing >= this.minSpeed ? 1 : 0;
    if (this.tr.update(cond, this.tMs, ok)) {
      this.s.fired = true;
      this.armed = false;
      this.s.power = closing;
      palm(p, 'L', this.lp);
      palm(p, 'R', this.rp);
      this.s.at.x = (this.lp.x + this.rp.x) / 2;
      this.s.at.y = (this.lp.y + this.rp.y) / 2;
    }
    this.gap = gap;
    this.closing = closing;
  }

  private gap = 0;
  private closing = 0;

  protected onReset(): void {
    this.gapVel.reset();
    this.tr.reset();
    this.armed = true;
    this.gap = 0;
    this.closing = 0;
    this.s.fired = false;
    this.s.power = 0;
  }

  protected override get dbgUnit(): string {
    return 'sw gap';
  }
  protected override get dbgValue(): number {
    return this.gap;
  }
  /** Drawn inverted in the overlay: this is a FALLING edge. */
  protected override get dbgEnter(): number {
    return this.closeAt;
  }
  protected override get dbgExit(): number {
    return this.openAt;
  }
  protected override get dbgActive(): boolean {
    return !this.armed;
  }
}

// ─── swing ──────────────────────────────────────────────────────────────────

/**
 * SWING — a fast, straight palm sweep.
 *
 * Triple gate, as a child scratching their head will otherwise fire it:
 *   1. instantaneous palm speed over `minSpeed`;
 *   2. NET travel over the last 200ms over `minSpeed` too — a scratch wiggles
 *      back and forth, so its net displacement stays near zero while its
 *      instantaneous speed spikes. Taking the min of the two is one value the
 *      Trigger can threshold, and it is the direction gate at the same time;
 *   3. a refractory period after the swing ends.
 *
 * The speed is measured at the WRIST even though `from`/`to` report the palm.
 * `palm()` extrapolates 1.4x past the wrist toward the finger centroid, which
 * also multiplies the noisiest landmarks in the set: measured on `idle`, the
 * palm's apparent net speed peaks at 3.21 sw/s where the wrist's peaks at
 * 1.56 — and the documented threshold is 2.2. The hit test still wants the
 * palm; the speed gate does not.
 *
 * `from`/`to` are consecutive-frame palm positions in view px, for
 * `hitSegCircle`. A fast swing covers 100+ px between frames, so a point test
 * misses it exactly when the player is trying hardest.
 */
export class SwingDetector extends DetectorBase<'swing'> {
  readonly kind = 'swing' as const;
  protected readonly s: SwingSignal = {
    active: false,
    side: 'R',
    from: { x: 0, y: 0 },
    to: { x: 0, y: 0 },
    speed: 0,
    dirDeg: 0,
    ok: false,
  };

  private minSpeed = 2.2;
  private which: Side | 'both' = 'both';
  private readonly tr: Trigger;
  private readonly tmp: Pt = { x: 0, y: 0 };
  private readonly velLX = new Vel(0.2, 32);
  private readonly velLY = new Vel(0.2, 32);
  private readonly velRX = new Vel(0.2, 32);
  private readonly velRY = new Vel(0.2, 32);
  private prevLX = NaN;
  private prevLY = NaN;
  private prevRX = NaN;
  private prevRY = NaN;
  private value = 0;
  private cooldownUntil = -1e9;

  constructor(o: SwingOpts = {}) {
    super(o, 200);
    this.tr = new Trigger(3.5, 1.6, 0, this.confirmFrames);
    this.apply(o);
  }

  private apply(o: SwingOpts): void {
    // index.ts documents 2.2 sw/s. At this camera distance a RESTING hand
    // measures up to 2.60 sw/s of apparent net wrist speed on `fidget` (whose
    // jitter is 0.005 of frame width, which is what MediaPipe actually does at
    // 2.5m) — so 2.2 fires on a child standing still, which is the one thing a
    // swing detector must never do. 3.5 clears the fidget floor by 35% and is
    // still a quarter of `swing-wide`'s 12.4.
    this.minSpeed = opt(o.minSpeed, 3.5, 0.2, 30);
    if (o.side !== undefined) this.which = o.side;
    this.tr.set(this.minSpeed, this.minSpeed * 0.45);
    this.tr.confirmFrames = this.confirmFrames;
  }

  protected override onConfigure(o: Partial<GestureOpts['swing']>): void {
    this.apply(o as SwingOpts);
  }

  protected clearEdges(): void {
    // `active` is a sustained state, not an edge; nothing to clear.
  }

  protected step(p: PlayerPose): void {
    const s = scaleOf(p);
    const wantL = this.which === 'L' || this.which === 'both';
    const wantR = this.which === 'R' || this.which === 'both';
    const okL = wantL && seen1(p, L.LEFT_WRIST);
    const okR = wantR && seen1(p, L.RIGHT_WRIST);
    const ok = okL || okR;
    this.setOk(ok);
    if (!ok) {
      this.tr.update(0, this.tMs, false);
      this.s.active = this.tr.active;
      return;
    }

    let bestScore = -1;
    let side: Side = 'R';
    let fx = 0;
    let fy = 0;
    let tx = 0;
    let ty = 0;
    let inst = 0;
    let netX = 0;
    let netY = 0;

    if (okL) {
      const vx = this.velLX.push(p.px[L.LEFT_WRIST * 2]!, this.t) / s;
      const vy = this.velLY.push(p.px[L.LEFT_WRIST * 2 + 1]!, this.t) / s;
      palm(p, 'L', this.tmp);
      const net = Math.sqrt(vx * vx + vy * vy);
      const px0 = Number.isFinite(this.prevLX) ? this.prevLX : this.tmp.x;
      const py0 = Number.isFinite(this.prevLY) ? this.prevLY : this.tmp.y;
      const i =
        this.dt > 1e-4
          ? Math.sqrt(
              (this.tmp.x - px0) * (this.tmp.x - px0) + (this.tmp.y - py0) * (this.tmp.y - py0),
            ) /
            s /
            this.dt
          : 0;
      const score = net < i ? net : i;
      if (score > bestScore) {
        bestScore = score;
        side = 'L';
        fx = px0;
        fy = py0;
        tx = this.tmp.x;
        ty = this.tmp.y;
        inst = i;
        netX = vx;
        netY = vy;
      }
      this.prevLX = this.tmp.x;
      this.prevLY = this.tmp.y;
    }
    if (okR) {
      const vx = this.velRX.push(p.px[L.RIGHT_WRIST * 2]!, this.t) / s;
      const vy = this.velRY.push(p.px[L.RIGHT_WRIST * 2 + 1]!, this.t) / s;
      palm(p, 'R', this.tmp);
      const net = Math.sqrt(vx * vx + vy * vy);
      const px0 = Number.isFinite(this.prevRX) ? this.prevRX : this.tmp.x;
      const py0 = Number.isFinite(this.prevRY) ? this.prevRY : this.tmp.y;
      const i =
        this.dt > 1e-4
          ? Math.sqrt(
              (this.tmp.x - px0) * (this.tmp.x - px0) + (this.tmp.y - py0) * (this.tmp.y - py0),
            ) /
            s /
            this.dt
          : 0;
      const score = net < i ? net : i;
      if (score > bestScore) {
        bestScore = score;
        side = 'R';
        fx = px0;
        fy = py0;
        tx = this.tmp.x;
        ty = this.tmp.y;
        inst = i;
        netX = vx;
        netY = vy;
      }
      this.prevRX = this.tmp.x;
      this.prevRY = this.tmp.y;
    }

    this.value = bestScore > 0 ? bestScore : 0;
    const gated = this.tMs < this.cooldownUntil ? 0 : this.value;
    const wasActive = this.tr.active;
    this.tr.update(gated, this.tMs, true);
    if (wasActive && !this.tr.active) this.cooldownUntil = this.tMs + this.cooldownMs;

    this.s.active = this.tr.active;
    this.s.side = side;
    this.s.from.x = fx;
    this.s.from.y = fy;
    this.s.to.x = tx;
    this.s.to.y = ty;
    this.s.speed = inst;
    // 0 = right, 90 = up. Taken from the 120ms net vector, which is far steadier
    // than one frame's difference and is what the direction gate agreed on.
    if (netX !== 0 || netY !== 0) this.s.dirDeg = Math.atan2(-netY, netX) * DEG;
  }

  protected onReset(): void {
    this.tr.reset();
    this.velLX.reset();
    this.velLY.reset();
    this.velRX.reset();
    this.velRY.reset();
    this.prevLX = NaN;
    this.prevLY = NaN;
    this.prevRX = NaN;
    this.prevRY = NaN;
    this.value = 0;
    this.cooldownUntil = -1e9;
    this.s.active = false;
    this.s.speed = 0;
    this.s.dirDeg = 0;
  }

  protected override get dbgUnit(): string {
    return 'sw/s';
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
    return this.tr.active;
  }
}

// ─── raise ──────────────────────────────────────────────────────────────────

/**
 * RAISE — wrist above the shoulder, in shoulder-relative units.
 *
 * Shoulder-relative, never nose-relative, so a 120cm seven-year-old and a
 * 170cm adult need the same gesture. Measured: arms down sits at -1.6 sw;
 * `clap-x12`, whose highest variant claps overhead, still only reaches -0.105,
 * so claps never read as a raise; `hold-poses` reaches +1.36.
 */
export class RaiseDetector extends DetectorBase<'raise'> {
  readonly kind = 'raise' as const;
  protected readonly s: RaiseSignal = {
    left: false,
    right: false,
    both: false,
    entered: false,
    ok: false,
  };

  private above = 0.25;
  private which: Side | 'both' | 'either' = 'both';
  private readonly trL: Trigger;
  private readonly trR: Trigger;
  private chosen = false;

  constructor(o: RaiseOpts = {}) {
    super(o, 0);
    this.trL = new Trigger(0.25, 0.13, 0, this.confirmFrames);
    this.trR = new Trigger(0.25, 0.13, 0, this.confirmFrames);
    this.apply(o);
  }

  private apply(o: RaiseOpts): void {
    this.above = opt(o.above, 0.25, 0.02, 2);
    if (o.side !== undefined) this.which = o.side;
    const exit = Math.max(this.above - 0.12, this.above * 0.4);
    this.trL.set(this.above, exit);
    this.trR.set(this.above, exit);
    this.trL.confirmFrames = this.confirmFrames;
    this.trR.confirmFrames = this.confirmFrames;
  }

  protected override onConfigure(o: Partial<GestureOpts['raise']>): void {
    this.apply(o as RaiseOpts);
  }

  protected clearEdges(): void {
    this.s.entered = false;
  }

  protected step(p: PlayerPose): void {
    const okL = seen2(p, L.LEFT_WRIST, L.LEFT_SHOULDER);
    const okR = seen2(p, L.RIGHT_WRIST, L.RIGHT_SHOULDER);
    // +y is DOWN, so "above" is a positive shoulder-minus-wrist.
    const hL = p.n[L.LEFT_SHOULDER * 2 + 1]! - p.n[L.LEFT_WRIST * 2 + 1]!;
    const hR = p.n[L.RIGHT_SHOULDER * 2 + 1]! - p.n[L.RIGHT_WRIST * 2 + 1]!;
    this.trL.update(hL, this.tMs, okL);
    this.trR.update(hR, this.tMs, okR);
    this.s.left = this.trL.active;
    this.s.right = this.trR.active;
    this.s.both = this.trL.active && this.trR.active;

    const w = this.which;
    const ok = w === 'L' ? okL : w === 'R' ? okR : w === 'either' ? okL || okR : okL && okR;
    this.setOk(ok);
    const now =
      w === 'L'
        ? this.s.left
        : w === 'R'
          ? this.s.right
          : w === 'either'
            ? this.s.left || this.s.right
            : this.s.both;
    if (ok && now && !this.chosen) this.s.entered = true;
    if (ok) this.chosen = now;
    this.value = w === 'R' ? hR : w === 'L' ? hL : Math.max(hL, hR);
  }

  private value = 0;

  protected onReset(): void {
    this.trL.reset();
    this.trR.reset();
    this.chosen = false;
    this.value = 0;
    this.s.left = false;
    this.s.right = false;
    this.s.both = false;
    this.s.entered = false;
  }

  protected override get dbgUnit(): string {
    return 'sw above shoulder';
  }
  protected override get dbgValue(): number {
    return this.value;
  }
  protected override get dbgEnter(): number {
    return this.trL.enter;
  }
  protected override get dbgExit(): number {
    return this.trL.exit;
  }
  protected override get dbgActive(): boolean {
    return this.chosen;
  }
}

// ─── lean ───────────────────────────────────────────────────────────────────

/**
 * LEAN — shoulder centre offset from hip centre.
 *
 * This is a `n`-space measurement: translation-free and scale-normalized by
 * construction, so leaning is the one locomotion signal that needs no baseline
 * at all. Measured: `fidget` (3 degrees of sway) reaches 0.098 sw, `step-lr`
 * (15 degrees) 0.359, `hold-poses` (18 degrees) 0.443. 0.30/0.16 sits in the
 * gap and matches RESEARCH-POSE §5.5's 0.22/0.12 torso lengths exactly.
 *
 * Sign: +x is screen-right (`n` is derived from the mirrored px space), so
 * positive `value` steers the way the player sees themselves lean.
 */
export class LeanDetector extends DetectorBase<'lean'> {
  readonly kind = 'lean' as const;
  protected readonly s: LeanSignal = { value: 0, dir: 0, changed: false, ok: false };

  private enterL = 0.3;
  private exitL = 0.16;
  private readonly pos: Trigger;
  private readonly neg: Trigger;
  private raw = 0;
  private sm = NaN;

  constructor(o: LeanOpts = {}) {
    super(o, 0);
    this.pos = new Trigger(0.3, 0.16, 0, this.confirmFrames);
    this.neg = new Trigger(0.3, 0.16, 0, this.confirmFrames);
    this.apply(o);
  }

  private apply(o: LeanOpts): void {
    this.enterL = opt(o.enter, 0.3, 0.05, 1.5);
    this.exitL = opt(o.exit, this.enterL * 0.53, 0.02, 1.4);
    this.pos.set(this.enterL, this.exitL);
    this.neg.set(this.enterL, this.exitL);
    this.pos.confirmFrames = this.confirmFrames;
    this.neg.confirmFrames = this.confirmFrames;
  }

  protected override onConfigure(o: Partial<GestureOpts['lean']>): void {
    this.apply(o as LeanOpts);
  }

  protected clearEdges(): void {
    this.s.changed = false;
  }

  protected step(p: PlayerPose): void {
    const ok =
      seenEither(p, L.LEFT_SHOULDER, L.RIGHT_SHOULDER) && seenEither(p, L.LEFT_HIP, L.RIGHT_HIP);
    this.setOk(ok);
    // ~80ms EMA. Lean is read straight out of `n`, so it carries no scale-
    // estimate error — but at 4m (`far-small`, 74px shoulders) raw landmark
    // jitter alone is 0.069 sw per coordinate, which crossed the 0.30 threshold
    // 4 times in 16 seconds of standing still. Halving that noise costs a
    // steering signal nothing: steering wants to be smooth.
    const x = leanN(p);
    this.sm = Number.isFinite(this.sm)
      ? this.sm + (x - this.sm) * (this.dt > 0 ? 1 - Math.exp(-12 * this.dt) : 1)
      : x;
    this.raw = this.sm;
    this.pos.update(this.sm, this.tMs, ok);
    this.neg.update(-this.sm, this.tMs, ok);
    // Full lean == full steering deflection: one number for a game to tune.
    this.s.value = clamp(this.sm / this.enterL, -1, 1);
    const dir: -1 | 0 | 1 = this.pos.active ? 1 : this.neg.active ? -1 : 0;
    if (dir !== this.s.dir) {
      this.s.dir = dir;
      this.s.changed = true;
    }
  }

  protected onReset(): void {
    this.pos.reset();
    this.neg.reset();
    this.raw = 0;
    this.sm = NaN;
    this.s.value = 0;
    this.s.dir = 0;
    this.s.changed = false;
  }

  protected override get dbgUnit(): string {
    return 'sw offset';
  }
  protected override get dbgValue(): number {
    return this.raw;
  }
  protected override get dbgEnter(): number {
    return this.enterL;
  }
  protected override get dbgExit(): number {
    return this.exitL;
  }
  protected override get dbgActive(): boolean {
    return this.s.dir !== 0;
  }
}

// ─── step ───────────────────────────────────────────────────────────────────

/**
 * STEP — whole-body translation against a slowly adapting baseline.
 *
 * The baseline FREEZES while a lane is held. RESEARCH-POSE §5.5 is explicit
 * about this and the corpus shows what happens without it: `step-lr` holds each
 * side for ~2s, which a free-running baseline walks into until the signal dies
 * under the player's feet. It adapts again the moment they return to centre, so
 * a player who re-centres slightly off from where they started is not punished
 * for the rest of the round.
 *
 * Measured: `step-lr` reaches 1.07 sw; the idle floor is 0.079 and `fidget`
 * 0.185; a slow sideways body sweep (`reach-grid`, +-0.47 sw) is absorbed by the
 * baseline and does not trip 0.55.
 */
export class StepDetector extends DetectorBase<'step'> {
  readonly kind = 'step' as const;
  protected readonly s: StepSignal = { value: 0, lane: 0, changed: false, ok: false };

  private enterS = 0.55;
  private exitS = 0.28;
  private lanes = 3;
  private centre = 1;
  private offset = 0;
  private readonly med = new Median3();
  /** ONE rate, not the near/far pair the jump and squat baselines use.
   *  Freezing while a lane is held already protects a held step, and the
   *  two-rate version actively broke this detector: a slow sideways sweep
   *  (`reach-grid`, 0.12 sw/s) leaves the near band immediately, drops to the
   *  far rate, and the baseline stops following — so the sweep accumulated into
   *  a phantom lane change. A single ~2s time constant lags a 0.12 sw/s sweep
   *  by 0.24 sw, well under the 0.55 threshold, while `step-lr`'s real 1.0 sw
   *  excursions still trip it. This is RESEARCH-POSE §5.5's own
   *  `baseX*0.98 + hip.x*0.02`. */
  private readonly base = new Baseline(0.5, 0.5, 1e9);
  private confirmUp = 0;
  private confirmDown = 0;

  constructor(o: StepOpts = {}) {
    super(o, 0);
    this.apply(o);
    this.s.lane = this.centre;
  }

  private apply(o: StepOpts): void {
    this.enterS = opt(o.enter, 0.55, 0.1, 3);
    this.exitS = opt(o.exit, this.enterS * 0.51, 0.05, 2.9);
    this.lanes = Math.max(1, Math.round(opt(o.lanes, 3, 1, 9)));
    this.centre = (this.lanes - 1) >> 1;
  }

  protected override onConfigure(o: Partial<GestureOpts['step']>): void {
    this.apply(o as StepOpts);
    this.offset = clamp(this.offset, -this.centre, this.lanes - 1 - this.centre);
    this.s.lane = this.centre + this.offset;
  }

  protected clearEdges(): void {
    this.s.changed = false;
  }

  protected step(p: PlayerPose): void {
    const ok = seenEither(p, L.LEFT_HIP, L.RIGHT_HIP);
    this.setOk(ok);
    const s = scaleOf(p);
    const x = this.med.push(hipPxX(p));
    const b = this.base.update(x, this.dt, this.offset !== 0 || !ok);
    const value = Number.isFinite(b) ? (x - b) / s : 0;
    this.s.value = value;
    if (!ok) {
      this.confirmUp = 0;
      this.confirmDown = 0;
      return;
    }

    // Magnitude-and-sign lane quantizer with hysteresis: leaving lane m needs
    // (m+1)*enter, returning needs (m-1)*enter + exit. One lane per frame.
    const mag = Math.abs(value);
    const m = Math.abs(this.offset);
    const sgn = value >= 0 ? 1 : -1;
    const maxOut = this.lanes - 1 - this.centre;
    const out = m * this.enterS + this.enterS;
    const back = (m - 1) * this.enterS + this.exitS;

    if (m < maxOut && mag >= out && (m > 0 ? sgn === Math.sign(this.offset) : true)) {
      if (++this.confirmUp >= this.confirmFrames) {
        this.confirmUp = 0;
        this.offset = sgn * (m + 1);
        this.commit();
      }
    } else this.confirmUp = 0;

    if (m > 0 && mag <= back) {
      if (++this.confirmDown >= this.confirmFrames) {
        this.confirmDown = 0;
        this.offset = Math.sign(this.offset) * (m - 1);
        this.commit();
      }
    } else this.confirmDown = 0;
  }

  private commit(): void {
    const lane = clamp(this.centre + this.offset, 0, this.lanes - 1);
    if (lane !== this.s.lane) {
      this.s.lane = lane;
      this.s.changed = true;
    }
  }

  protected onReset(): void {
    this.med.reset();
    this.base.reset();
    this.offset = 0;
    this.confirmUp = 0;
    this.confirmDown = 0;
    this.s.value = 0;
    this.s.lane = this.centre;
    this.s.changed = false;
  }

  protected override get dbgUnit(): string {
    return 'sw from centre';
  }
  protected override get dbgValue(): number {
    return this.s.value;
  }
  protected override get dbgEnter(): number {
    return this.enterS;
  }
  protected override get dbgExit(): number {
    return this.exitS;
  }
  protected override get dbgActive(): boolean {
    return this.offset !== 0;
  }
}

// ─── reach ──────────────────────────────────────────────────────────────────

/**
 * REACH — palm positions, palm speeds and extension relative to this player's
 * OWN arm length.
 *
 * `leftExtend`/`rightExtend` are shoulder-to-wrist over `calib.armLen`, so a
 * shorter child at full stretch reads 1.0 exactly like a taller one. A game that
 * places targets at `leftExtend == 1` is fair by construction; one that places
 * them at fixed screen positions is not (AGENTS.md § Fairness).
 *
 * Speeds are in view px/sec and differenced from px rather than taken from
 * `palmSpeedPx`, which reads `p.v` and therefore carries the scale-estimate
 * noise amplified by the body's distance from the view origin.
 */
export class ReachDetector extends DetectorBase<'reach'> {
  readonly kind = 'reach' as const;
  protected readonly s: ReachSignal = {
    leftPalm: { x: 0, y: 0 },
    rightPalm: { x: 0, y: 0 },
    leftSpeed: 0,
    rightSpeed: 0,
    leftExtend: 0,
    rightExtend: 0,
    ok: false,
  };

  private which: Side | 'both' = 'both';
  private readonly lx = new Vel(0.08, 16);
  private readonly ly = new Vel(0.08, 16);
  private readonly rx = new Vel(0.08, 16);
  private readonly ry = new Vel(0.08, 16);

  constructor(o: ReachOpts = {}) {
    super(o, 0);
    if (o.side !== undefined) this.which = o.side;
  }

  protected override onConfigure(o: Partial<GestureOpts['reach']>): void {
    const r = o as ReachOpts;
    if (r.side !== undefined) this.which = r.side;
  }

  protected clearEdges(): void {
    // Continuous signal: no edges.
  }

  protected step(p: PlayerPose): void {
    const okL = seen1(p, L.LEFT_WRIST);
    const okR = seen1(p, L.RIGHT_WRIST);
    const armLen = p.calib.armLen > 0.5 ? p.calib.armLen : 1.6;

    if (okL) {
      palm(p, 'L', this.s.leftPalm);
      const vx = this.lx.push(this.s.leftPalm.x, this.t);
      const vy = this.ly.push(this.s.leftPalm.y, this.t);
      this.s.leftSpeed = Math.sqrt(vx * vx + vy * vy);
      this.s.leftExtend = distN(p, L.LEFT_SHOULDER, L.LEFT_WRIST) / armLen;
    }
    if (okR) {
      palm(p, 'R', this.s.rightPalm);
      const vx = this.rx.push(this.s.rightPalm.x, this.t);
      const vy = this.ry.push(this.s.rightPalm.y, this.t);
      this.s.rightSpeed = Math.sqrt(vx * vx + vy * vy);
      this.s.rightExtend = distN(p, L.RIGHT_SHOULDER, L.RIGHT_WRIST) / armLen;
    }
    // `both` needs only one hand usable to stay ok: a wrist drops below
    // MIN_VIS constantly, the other hand's hit tests are still perfectly good,
    // and the stale hand holds its last position as the contract promises.
    this.setOk(this.which === 'L' ? okL : this.which === 'R' ? okR : okL || okR);
  }

  protected onReset(): void {
    this.lx.reset();
    this.ly.reset();
    this.rx.reset();
    this.ry.reset();
    this.s.leftSpeed = 0;
    this.s.rightSpeed = 0;
    this.s.leftExtend = 0;
    this.s.rightExtend = 0;
  }

  protected override get dbgUnit(): string {
    return 'extend (1 = full reach)';
  }
  protected override get dbgValue(): number {
    return Math.max(this.s.leftExtend, this.s.rightExtend);
  }
  protected override get dbgEnter(): number {
    return 1;
  }
}

// ─── limbAngle ──────────────────────────────────────────────────────────────

/** LIMB ANGLE — interior angle at `b`, degrees, 0..180.
 *
 *  Angle-based comparison is independent of height, build and camera distance,
 *  which makes it the fairest signal available — but it punishes landmark error
 *  much harder than event detection does (RESEARCH-POSE §5.4), so the angle is
 *  EMA-smoothed before it is thresholded and `matched` carries hysteresis. */
export class LimbAngleDetector extends DetectorBase<'limbAngle'> {
  readonly kind = 'limbAngle' as const;
  protected readonly s: LimbAngleSignal = { deg: 0, matched: false, error: 0, ok: false };

  private a: Joint = L.LEFT_SHOULDER;
  private b: Joint = L.LEFT_ELBOW;
  private c: Joint = L.LEFT_WRIST;
  private target = NaN;
  private tol = 15;
  private readonly tr: Trigger;
  private sm = NaN;

  constructor(o: LimbAngleOpts) {
    super(o, 0);
    // Thresholds a NEGATED error, so "matched" is a rising edge like everything
    // else and gets hysteresis for free.
    this.tr = new Trigger(0, -1, 0, this.confirmFrames);
    this.apply(o);
  }

  private apply(o: Partial<LimbAngleOpts>): void {
    if (o.a !== undefined) this.a = o.a;
    if (o.b !== undefined) this.b = o.b;
    if (o.c !== undefined) this.c = o.c;
    if (o.target !== undefined) this.target = o.target;
    this.tol = opt(o.tolDeg, 15, 1, 90);
    this.tr.set(-this.tol, -this.tol * 1.35);
    this.tr.confirmFrames = this.confirmFrames;
  }

  protected override onConfigure(o: Partial<GestureOpts['limbAngle']>): void {
    this.apply(o as Partial<LimbAngleOpts>);
  }

  protected clearEdges(): void {
    // `matched` is sustained.
  }

  protected step(p: PlayerPose): void {
    const ok = p.vis[this.a]! >= MIN_VIS && p.vis[this.b]! >= MIN_VIS && p.vis[this.c]! >= MIN_VIS;
    this.setOk(ok);
    if (ok) {
      const deg = angleDeg6(
        p.n[this.a * 2]!,
        p.n[this.a * 2 + 1]!,
        p.n[this.b * 2]!,
        p.n[this.b * 2 + 1]!,
        p.n[this.c * 2]!,
        p.n[this.c * 2 + 1]!,
      );
      // ~60ms time constant: enough to kill landmark jitter on a straight limb,
      // short enough that a pose-match game still feels immediate.
      this.sm = Number.isFinite(this.sm)
        ? this.sm + (deg - this.sm) * (this.dt > 0 ? 1 - Math.exp(-16 * this.dt) : 1)
        : deg;
      this.s.deg = this.sm;
    }
    if (Number.isFinite(this.target)) {
      this.s.error = Math.abs(this.s.deg - this.target);
      this.tr.update(-this.s.error, this.tMs, ok);
      this.s.matched = this.tr.active;
    } else {
      this.s.error = 0;
      this.s.matched = false;
    }
  }

  protected onReset(): void {
    this.tr.reset();
    this.sm = NaN;
    this.s.deg = 0;
    this.s.matched = false;
    this.s.error = 0;
  }

  protected override get dbgUnit(): string {
    return 'deg error';
  }
  protected override get dbgValue(): number {
    return this.s.error;
  }
  protected override get dbgEnter(): number {
    return this.tol;
  }
  protected override get dbgExit(): number {
    return this.tol * 1.35;
  }
  protected override get dbgActive(): boolean {
    return this.s.matched;
  }
}

// ─── zone ───────────────────────────────────────────────────────────────────

/**
 * ZONE — a rect in 0..1 view fractions, with a dead-zone margin and a dwell
 * timer.
 *
 * The margin is spatial hysteresis: the rect is shrunk by `margin` to get in and
 * grown by it to get out, so a hand resting on the boundary does not strobe
 * `entered`/`exited` and burn a selection. `progress` exists because a dwell
 * ring is the only way a player can tell a selection is in progress — there is
 * no cursor and no click.
 */
export class ZoneDetector extends DetectorBase<'zone'> {
  readonly kind = 'zone' as const;
  protected readonly s: ZoneSignal = {
    inside: false,
    entered: false,
    exited: false,
    dwellMs: 0,
    progress: 0,
    held: false,
    ok: false,
  };

  private x = 0;
  private y = 0;
  private w = 1;
  private h = 1;
  private holdMs = 0;
  private margin = 0.12;
  private joints: readonly Joint[] | null = null;
  private readonly tmp: Pt = { x: 0, y: 0 };
  private confirm = 0;
  private complete = false;

  constructor(
    o: ZoneOpts,
    private readonly view: ViewRef,
  ) {
    super(o, 0);
    this.apply(o);
  }

  private apply(o: Partial<ZoneOpts>): void {
    if (o.x !== undefined) this.x = o.x;
    if (o.y !== undefined) this.y = o.y;
    if (o.w !== undefined) this.w = o.w;
    if (o.h !== undefined) this.h = o.h;
    this.holdMs = Math.max(0, opt(o.holdMs, this.holdMs, 0, 60_000));
    this.margin = clamp(opt(o.margin, 0.12, 0, 0.45), 0, 0.45);
    if (o.joints !== undefined) this.joints = o.joints.length > 0 ? o.joints : null;
  }

  protected override onConfigure(o: Partial<GestureOpts['zone']>): void {
    this.apply(o as Partial<ZoneOpts>);
  }

  protected clearEdges(): void {
    this.s.entered = false;
    this.s.exited = false;
  }

  private hit(px: number, py: number, grow: number): boolean {
    const vw = this.view.w > 0 ? this.view.w : 1280;
    const vh = this.view.h > 0 ? this.view.h : 720;
    const mx = this.w * this.margin * grow;
    const my = this.h * this.margin * grow;
    const x0 = (this.x - mx) * vw;
    const y0 = (this.y - my) * vh;
    const x1 = (this.x + this.w + mx) * vw;
    const y1 = (this.y + this.h + my) * vh;
    return px >= x0 && px <= x1 && py >= y0 && py <= y1;
  }

  protected step(p: PlayerPose): void {
    // Shrink to get in, grow to get out.
    const grow = this.s.inside ? 1 : -1;
    let any = false;
    let ok = false;
    const js = this.joints;
    if (js === null) {
      for (let i = 0; i < 2; i++) {
        const side: Side = i === 0 ? 'L' : 'R';
        const wrist = side === 'L' ? L.LEFT_WRIST : L.RIGHT_WRIST;
        if (!seen1(p, wrist)) continue;
        ok = true;
        palm(p, side, this.tmp);
        if (this.hit(this.tmp.x, this.tmp.y, grow)) any = true;
      }
    } else {
      for (let i = 0; i < js.length; i++) {
        const j = js[i]!;
        if (p.vis[j]! < MIN_VIS) continue;
        ok = true;
        if (this.hit(p.px[j * 2]!, p.px[j * 2 + 1]!, grow)) any = true;
      }
    }
    this.setOk(ok);
    if (!ok) {
      this.confirm = 0;
      return;
    }

    if (any !== this.s.inside) {
      if (++this.confirm >= this.confirmFrames) {
        this.confirm = 0;
        this.s.inside = any;
        if (any) this.s.entered = true;
        else {
          this.s.exited = true;
          this.s.dwellMs = 0;
          this.complete = false;
          this.s.held = false;
        }
      }
    } else this.confirm = 0;

    if (this.s.inside) {
      if (!this.complete) {
        this.s.dwellMs += this.dtMs;
        if (this.s.dwellMs >= this.holdMs) {
          this.complete = true;
          this.s.held = true;
        }
      }
    }
    this.s.progress = this.holdMs <= 0 ? (this.s.inside ? 1 : 0) : clamp01(this.s.dwellMs / this.holdMs);
  }

  protected onReset(): void {
    this.confirm = 0;
    this.complete = false;
    this.s.inside = false;
    this.s.entered = false;
    this.s.exited = false;
    this.s.dwellMs = 0;
    this.s.progress = 0;
    this.s.held = false;
  }

  protected override get dbgUnit(): string {
    return 'dwell 0..1';
  }
  protected override get dbgValue(): number {
    return this.s.progress;
  }
  protected override get dbgEnter(): number {
    return 1;
  }
  protected override get dbgActive(): boolean {
    return this.s.inside;
  }
}

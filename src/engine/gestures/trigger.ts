// Shared state machines for every detector in this folder.
//
// Four primitives and one base class. Everything in detectors.ts, reps.ts,
// holds.ts, stillness.ts, balance.ts, stroke.ts and similarity.ts is built from
// these, so a bug fixed here is fixed for all 58 games at once — which is the
// only reason one agent can be responsible for the whole gesture layer.
//
// ── Two rules this file exists to enforce ────────────────────────────────────
//
// 1. HYSTERESIS, ALWAYS. `Trigger` takes `enter` AND `exit` and physically
//    cannot be constructed with one threshold. A single threshold flickers on
//    noise, and a flickering boolean is a double-counted rep in a game whose
//    author will never see this file.
//
// 2. ONE EDGE ONLY. `Trigger.update()` returns true on the rising edge and
//    never again until the value has fallen back past `exit`. Counting both
//    edges doubles every score in the catalogue.
//
// ── Why displacements are differenced in PIXELS, then scaled ────────────────
//
// `n` is hip-centred, so whole-body motion (jump, squat, step) is invisible in
// it by construction — normalize.ts says so explicitly. The absolute body
// position lives in `px / scalePx` (that is exactly the normalizer's internal
// `w`), but `px/scalePx` is a position ~2 shoulder widths from the VIEW ORIGIN,
// so it carries the scale estimate's error multiplied by that distance.
// Measured on this repo's own clips: `scalePx` wobbles ~2% on `fidget` and ~3.4%
// at 4m (`far-small`), which turns into 0.17sw and 0.49sw of phantom hip
// movement — the latter being almost the entire documented `step` threshold.
//
// So: `Baseline` tracks the raw PIXEL position and the detector divides the
// DELTA by the current scale. The scale error then multiplies a 0.1sw
// displacement instead of a 2sw position, and the phantom movement drops to
// ~0.01sw. Same for velocity: `Vel` differences pixels and the caller divides
// the slope by `scalePx`.
//
// This is also why these detectors do not read `p.v` for hip motion even though
// it is free: it is the One Euro derivative of `px/scalePx`, so it inherits the
// amplified scale noise AND attenuates a real 1.1Hz jump by ~33% (measured: the
// true 1.8-3.0 sw/s takeoff of `jump-x8` arrives as 1.14 sw/s). A windowed
// difference over 120ms attenuates the same motion by 3%.
import { approach, clamp } from '../math';
import { Median3 } from '../pose/oneEuro';
import { L, MIN_VIS, type Joint } from '../pose/landmarks';
import type { GestureKind, PlayerPose, PoseFrame, Slot } from '../types';
import type { BaseOpts, Detector, GestureOpts, SignalOf } from './index';

/** The engine's floor on any gesture that scores. AGENTS.md: "Never fire a
 *  scoring event from a single frame... hysteresis plus a >=250ms cooldown." */
export const MIN_COOLDOWN_MS = 250;

/** Default differencing window for velocity, seconds. Long enough that landmark
 *  jitter averages down (~0.25 sw/s residual), short enough that a 1.1Hz jump
 *  takeoff passes through at 97% amplitude. */
export const VEL_WINDOW_SEC = 0.12;

/** Largest frame gap we are willing to treat as continuous. Beyond this the
 *  round was paused or the tab was backgrounded; velocity is meaningless. */
export const MAX_DT_SEC = 0.5;

// ─── Trigger ────────────────────────────────────────────────────────────────

/**
 * Schmitt trigger with confirm-frames and a refractory period.
 *
 * `enter` must be greater than `exit`; the constructor enforces it rather than
 * trusting 58 call sites. Feed a value every frame and read the return value:
 * true for EXACTLY ONE frame per rising edge.
 */
export class Trigger {
  enter = 1;
  exit = 0;
  cooldownMs = 0;
  confirmFrames = 2;
  /**
   * A value this many times `enter` is taken as unambiguous and fires on the
   * first frame, skipping the confirm wait.
   *
   * Confirm frames cost real latency where it is most visible: at 10fps on a
   * school Chromebook, two frames is 200ms, and a jump takeoff that only clears
   * the threshold for one sample is missed entirely. 0 disables it.
   */
  express = 0;

  private on = false;
  private confirm = 0;
  private lastFireMs = -1e9;
  private _entered = false;
  private _exited = false;

  constructor(enter: number, exit: number, cooldownMs = 0, confirmFrames = 2) {
    this.set(enter, exit);
    this.cooldownMs = Math.max(0, cooldownMs);
    this.confirmFrames = Math.max(1, Math.round(confirmFrames));
  }

  /** Retune without losing the current state (engine `configure()` path). */
  set(enter: number, exit: number): void {
    this.enter = enter;
    // A hysteresis gap of zero is a single threshold wearing a disguise.
    this.exit = Math.min(exit, enter - Math.abs(enter) * 0.05 - 1e-6);
  }

  /** True while the condition is latched (between enter and exit). */
  get active(): boolean {
    return this.on;
  }

  /** True for one frame when the trigger latched, fire or not. */
  get entered(): boolean {
    return this._entered;
  }

  /** True for one frame when the value fell back past `exit`. */
  get exited(): boolean {
    return this._exited;
  }

  /**
   * @param ok false when the landmarks are not trustworthy: the latch HOLDS,
   *        the confirm counter resets, and nothing fires. Gate, don't guess.
   * @returns true for exactly one frame, on the rising edge.
   */
  update(value: number, tMs: number, ok = true): boolean {
    this._entered = false;
    this._exited = false;
    if (!ok || !Number.isFinite(value)) {
      this.confirm = 0;
      return false;
    }
    if (this.on) {
      if (value <= this.exit) {
        this.on = false;
        this.confirm = 0;
        this._exited = true;
      }
      return false;
    }
    if (value < this.enter) {
      this.confirm = 0;
      return false;
    }
    this.confirm++;
    const sure = this.express > 0 && value >= this.enter * this.express;
    if (this.confirm < this.confirmFrames && !sure) return false;
    this.on = true;
    this.confirm = 0;
    this._entered = true;
    if (tMs - this.lastFireMs < this.cooldownMs) return false; // edge consumed
    this.lastFireMs = tMs;
    return true;
  }

  reset(): void {
    this.on = false;
    this.confirm = 0;
    this.lastFireMs = -1e9;
    this._entered = false;
    this._exited = false;
  }
}

// ─── Vel ────────────────────────────────────────────────────────────────────

/**
 * Derivative over a TIME window, not a frame delta.
 *
 * Frame-rate safety is the whole point: at 60Hz it averages 7 samples, at 10fps
 * it degenerates to a single difference, and in both cases it reports
 * units-per-second over the same ~120ms of real time. A per-frame difference
 * would report a 6x larger number on the Chromebook than on the Mac.
 */
export class Vel {
  value = 0;

  private readonly ts: Float64Array;
  private readonly ys: Float64Array;
  private readonly cap: number;
  private n = 0;
  private head = -1;

  constructor(
    public windowSec = VEL_WINDOW_SEC,
    cap = 24,
  ) {
    this.cap = Math.max(2, cap);
    this.ts = new Float64Array(this.cap);
    this.ys = new Float64Array(this.cap);
  }

  push(y: number, t: number): number {
    if (!Number.isFinite(y)) return this.value;
    const cap = this.cap;
    this.head = (this.head + 1) % cap;
    this.ts[this.head] = t;
    this.ys[this.head] = y;
    if (this.n < cap) this.n++;

    // Newest sample that is at least a window old; the oldest held otherwise.
    let bi = -1;
    for (let k = 1; k < this.n; k++) {
      const i = (this.head - k + cap * 2) % cap;
      bi = i;
      if (t - this.ts[i]! >= this.windowSec) break;
    }
    if (bi < 0) {
      this.value = 0;
      return 0;
    }
    const dt = t - this.ts[bi]!;
    this.value = dt > 1e-4 && dt <= MAX_DT_SEC ? (y - this.ys[bi]!) / dt : 0;
    return this.value;
  }

  reset(): void {
    this.n = 0;
    this.head = -1;
    this.value = 0;
  }
}

// ─── Baseline ───────────────────────────────────────────────────────────────

/**
 * Slowly adapting reference, in whatever units it is fed (pixels, here).
 *
 * Two rates and a freeze, all three load-bearing:
 *  - `freeze` stops the baseline mid-gesture. Without it the baseline walks
 *    into a held squat or a held step and the signal dies under the player.
 *  - `rateFar` is ~10x slower than `rateNear`, so a posture the player is
 *    actively holding barely moves the reference, while a genuine re-centre
 *    (they stepped back, someone bumped the laptop) is still absorbed within a
 *    few seconds instead of breaking the detector for the rest of the round.
 */
export class Baseline {
  value = NaN;

  constructor(
    public rateNear = 0.8,
    public rateFar = 0.08,
    public band = 0.1,
  ) {}

  /** @param v current raw measurement. @returns the baseline after updating. */
  update(v: number, dt: number, freeze: boolean): number {
    if (!Number.isFinite(v)) return this.value;
    if (!Number.isFinite(this.value)) {
      this.value = v;
      return v;
    }
    if (freeze || dt <= 0) return this.value;
    const rate = Math.abs(v - this.value) <= this.band ? this.rateNear : this.rateFar;
    this.value = approach(this.value, v, rate, dt);
    return this.value;
  }

  get primed(): boolean {
    return Number.isFinite(this.value);
  }

  reset(): void {
    this.value = NaN;
  }
}

// ─── BodyDrift ──────────────────────────────────────────────────────────────

/**
 * Horizontal body displacement, used to VETO a vertical gesture.
 *
 * The one failure mode no vertical threshold can tune away: when the scale
 * estimate twitches, `px = w * scalePx` scales the whole body about the view
 * ORIGIN, so the body appears to move in proportion to how far it is from the
 * top-left corner. At 4m (`far-small`, 96px shoulders) that is worth 0.25-0.29
 * shoulder widths of phantom hip rise — which overlaps the 0.21-0.23 sw rise of
 * a REAL jump sampled at 10fps on a Chromebook. The two are not separable by
 * any vertical threshold.
 *
 * They are separable by direction. The artifact scales x and y together, and
 * the hip sits further from the origin horizontally than vertically, so a
 * phantom "jump" always drags the hips sideways at least as far as it lifts
 * them. A real jump is vertical. So: if the horizontal displacement exceeds the
 * vertical one, this was the camera, not the child.
 *
 * Deliberately generous (`RATIO` 1.2): a child who genuinely leaps sideways
 * further than they rise is rare, and a missed jump costs more than a phantom.
 */
export class BodyDrift {
  static readonly RATIO = 1.2;

  private readonly med = new Median3();
  private readonly base = new Baseline(0.8, 0.08, 1);
  /** Absolute horizontal displacement from the resting position, sw. */
  value = 0;

  /** @param xPx hip-centre x in view px. @param scalePx shoulder width in px. */
  update(xPx: number, scalePx: number, dt: number, freeze: boolean): number {
    const x = this.med.push(xPx);
    this.base.band = 0.1 * scalePx;
    const b = this.base.update(x, dt, freeze);
    this.value = Number.isFinite(b) ? Math.abs(x - b) / scalePx : 0;
    return this.value;
  }

  /** True when `rise` is more likely a scale twitch than a real movement. */
  vetoes(rise: number): boolean {
    return this.value > BodyDrift.RATIO * Math.abs(rise);
  }

  reset(): void {
    this.med.reset();
    this.base.reset();
    this.value = 0;
  }
}

// ─── HoldTimer ──────────────────────────────────────────────────────────────

/** Accumulates time while a condition holds. `done` is true for exactly one
 *  frame, and stays complete (progress 1) until the condition breaks. */
export class HoldTimer {
  ms = 0;
  done = false;
  complete = false;

  update(cond: boolean, dtMs: number, holdMs: number): void {
    this.done = false;
    if (!cond) {
      this.ms = 0;
      this.complete = false;
      return;
    }
    if (this.complete) {
      this.ms = holdMs;
      return;
    }
    this.ms += dtMs;
    if (this.ms >= holdMs) {
      this.ms = holdMs;
      this.complete = true;
      this.done = true;
    }
  }

  progress(holdMs: number): number {
    return holdMs <= 0 ? 1 : clamp(this.ms / holdMs, 0, 1);
  }

  reset(): void {
    this.ms = 0;
    this.done = false;
    this.complete = false;
  }
}

// ─── Stats ──────────────────────────────────────────────────────────────────

/** Rolling mean / std / max over a time window. Fixed storage, no allocation
 *  after construction. Used for balance sway and poseMatch rolling-best. */
export class Stats {
  private readonly ts: Float64Array;
  private readonly vs: Float64Array;
  private readonly cap: number;
  private n = 0;
  private head = -1;

  constructor(
    public windowSec = 1,
    cap = 64,
  ) {
    this.cap = Math.max(2, cap);
    this.ts = new Float64Array(this.cap);
    this.vs = new Float64Array(this.cap);
  }

  push(v: number, t: number): void {
    if (!Number.isFinite(v)) return;
    this.head = (this.head + 1) % this.cap;
    this.ts[this.head] = t;
    this.vs[this.head] = v;
    if (this.n < this.cap) this.n++;
    this.tNow = t;
  }

  private tNow = 0;

  /** Samples inside the window. */
  get count(): number {
    let c = 0;
    for (let k = 0; k < this.n; k++) {
      const i = (this.head - k + this.cap * 2) % this.cap;
      if (this.tNow - this.ts[i]! > this.windowSec) break;
      c++;
    }
    return c;
  }

  get mean(): number {
    let s = 0;
    let c = 0;
    for (let k = 0; k < this.n; k++) {
      const i = (this.head - k + this.cap * 2) % this.cap;
      if (this.tNow - this.ts[i]! > this.windowSec) break;
      s += this.vs[i]!;
      c++;
    }
    return c === 0 ? 0 : s / c;
  }

  get std(): number {
    const m = this.mean;
    let s = 0;
    let c = 0;
    for (let k = 0; k < this.n; k++) {
      const i = (this.head - k + this.cap * 2) % this.cap;
      if (this.tNow - this.ts[i]! > this.windowSec) break;
      const d = this.vs[i]! - m;
      s += d * d;
      c++;
    }
    return c < 2 ? 0 : Math.sqrt(s / (c - 1));
  }

  get max(): number {
    let m = -Infinity;
    for (let k = 0; k < this.n; k++) {
      const i = (this.head - k + this.cap * 2) % this.cap;
      if (this.tNow - this.ts[i]! > this.windowSec) break;
      if (this.vs[i]! > m) m = this.vs[i]!;
    }
    return m === -Infinity ? 0 : m;
  }

  reset(): void {
    this.n = 0;
    this.head = -1;
    this.tNow = 0;
  }
}

// ─── Reads off a PlayerPose ─────────────────────────────────────────────────

export function pickPlayer(f: PoseFrame, slot: Slot): PlayerPose | undefined {
  const ps = f.players;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]!;
    if (p.slot === slot) return p;
  }
  return undefined;
}

/** Shoulder width in view px, floored so a divide can never explode. */
export const scaleOf = (p: PlayerPose): number => (p.scalePx > 1 ? p.scalePx : 1);

/** Hip-centre y in view px. ALWAYS the mean of both hips, even when one has
 *  dropped below MIN_VIS: swapping to a single hip mid-round would step the
 *  value by half the hip offset and hand the jump detector a fake takeoff. */
export const hipPxY = (p: PlayerPose): number =>
  (p.px[L.LEFT_HIP * 2 + 1]! + p.px[L.RIGHT_HIP * 2 + 1]!) / 2;
export const hipPxX = (p: PlayerPose): number =>
  (p.px[L.LEFT_HIP * 2]! + p.px[L.RIGHT_HIP * 2]!) / 2;
export const shoulderPxY = (p: PlayerPose): number =>
  (p.px[L.LEFT_SHOULDER * 2 + 1]! + p.px[L.RIGHT_SHOULDER * 2 + 1]!) / 2;

/** Shoulder-centre offset from hip-centre in `n` — i.e. lean, already
 *  normalized and translation-free. */
export const leanN = (p: PlayerPose): number =>
  (p.n[L.LEFT_SHOULDER * 2]! + p.n[L.RIGHT_SHOULDER * 2]!) / 2;

/** Distance between two joints in `n` (shoulder widths). A difference of two
 *  positions, so it carries 2% of the scale error, not 200%. */
export function distN(p: PlayerPose, a: Joint, b: Joint): number {
  const dx = p.n[a * 2]! - p.n[b * 2]!;
  const dy = p.n[a * 2 + 1]! - p.n[b * 2 + 1]!;
  return Math.sqrt(dx * dx + dy * dy);
}

/** True if every listed joint is at or above MIN_VIS. `vis` already carries
 *  normalize.ts's 0.3s staleness grace, so this tolerates a one-frame dropout
 *  without any grace logic of its own. */
export function seen2(p: PlayerPose, a: Joint, b: Joint): boolean {
  return p.vis[a]! >= MIN_VIS && p.vis[b]! >= MIN_VIS;
}
export function seen1(p: PlayerPose, a: Joint): boolean {
  return p.vis[a]! >= MIN_VIS;
}
/** Either of a pair — the fallback rung for hips, shoulders and ankles. */
export function seenEither(p: PlayerPose, a: Joint, b: Joint): boolean {
  return p.vis[a]! >= MIN_VIS || p.vis[b]! >= MIN_VIS;
}

// ─── Debug ──────────────────────────────────────────────────────────────────

/**
 * What the `?debug=1` overlay draws per detector: the raw value it is
 * thresholding plus the two lines it is thresholding against. Nobody can tune a
 * threshold without seeing all three at once, and the overlay is the only place
 * a teacher's Chromebook can be diagnosed.
 */
export interface GestureDebug {
  kind: GestureKind;
  slot: Slot;
  /** Units of the raw value, for the overlay's axis label. */
  unit: string;
  value: number;
  enter: number;
  exit: number;
  /** Latched state of the primary trigger. */
  active: boolean;
  /** False when gated on visibility. */
  ok: boolean;
}

// ─── DetectorBase ───────────────────────────────────────────────────────────

/**
 * Lifecycle shared by every detector: slot lookup, frame-rate-safe `dt`,
 * one-frame edge clearing, visibility gating, reset and debug.
 *
 * `read()` is idempotent within a frame — two calls with the same `f.t` return
 * the same signal object without stepping the state machine. That makes the
 * debug overlay safe to read a detector the game is also reading, in either
 * order, without consuming an event.
 */
export abstract class DetectorBase<K extends GestureKind> implements Detector<K> {
  abstract readonly kind: K;
  /** Allocated ONCE by the subclass constructor and mutated forever after.
   *  Games call read() 60 times a second for a whole afternoon. */
  protected abstract readonly s: SignalOf<K>;

  protected slot: Slot = 0;
  protected cooldownMs = 0;
  protected confirmFrames = 2;
  /** Seconds since round start, this frame. */
  protected t = 0;
  protected tMs = 0;
  /** Seconds since the previous read, 0 on the first read, capped. */
  protected dt = 0;
  protected dtMs = 0;

  private lastT = -1;
  private dbg: GestureDebug | null = null;

  protected constructor(o: BaseOpts | undefined, defaultCooldownMs: number) {
    this.slot = o?.slot ?? 0;
    this.cooldownMs = Math.max(0, o?.cooldownMs ?? defaultCooldownMs);
    this.confirmFrames = Math.max(1, Math.round(o?.confirmFrames ?? 2));
  }

  read(f: PoseFrame): SignalOf<K> {
    if (f.t === this.lastT) return this.s;
    const prev = this.lastT;
    this.lastT = f.t;
    this.t = f.t;
    this.tMs = f.t * 1000;
    this.dt = prev < 0 || f.t <= prev ? 0 : Math.min(f.t - prev, MAX_DT_SEC);
    this.dtMs = this.dt * 1000;
    this.clearEdges();
    const p = pickPlayer(f, this.slot);
    if (p === undefined || !p.present) {
      this.setOk(false);
      this.onAbsent();
      return this.s;
    }
    this.step(p, f);
    return this.s;
  }

  reset(): void {
    this.lastT = -1;
    this.t = 0;
    this.tMs = 0;
    this.dt = 0;
    this.dtMs = 0;
    this.clearEdges();
    this.setOk(false);
    this.onReset();
  }

  configure(o: Partial<GestureOpts[K]>): void {
    const b = o as BaseOpts;
    if (b.slot !== undefined && b.slot !== this.slot) {
      this.slot = b.slot;
      this.onReset(); // different body, different baselines
    }
    if (b.cooldownMs !== undefined) this.cooldownMs = Math.max(0, b.cooldownMs);
    if (b.confirmFrames !== undefined) {
      this.confirmFrames = Math.max(1, Math.round(b.confirmFrames));
    }
    this.onConfigure(o);
  }

  /** Live value + thresholds for the debug overlay. Allocated on first use. */
  debug(): GestureDebug {
    let d = this.dbg;
    if (d === null) {
      d = { kind: this.kind, slot: this.slot, unit: this.dbgUnit, value: 0, enter: 0, exit: 0, active: false, ok: false };
      this.dbg = d;
    }
    d.slot = this.slot;
    d.unit = this.dbgUnit;
    d.value = this.dbgValue;
    d.enter = this.dbgEnter;
    d.exit = this.dbgExit;
    d.active = this.dbgActive;
    d.ok = (this.s as unknown as { ok: boolean }).ok;
    return d;
  }

  protected setOk(v: boolean): void {
    (this.s as unknown as { ok: boolean }).ok = v;
  }

  /** Clear every one-frame flag. Called before any work, every frame, so a
   *  latched `fired` is impossible by construction. */
  protected abstract clearEdges(): void;
  protected abstract step(p: PlayerPose, f: PoseFrame): void;
  protected abstract onReset(): void;

  /** The player vanished mid-round. Default: hold everything, fire nothing. */
  protected onAbsent(): void {}
  protected onConfigure(_o: Partial<GestureOpts[K]>): void {}

  protected get dbgUnit(): string {
    return '';
  }
  protected get dbgValue(): number {
    return 0;
  }
  protected get dbgEnter(): number {
    return 0;
  }
  protected get dbgExit(): number {
    return 0;
  }
  protected get dbgActive(): boolean {
    return false;
  }
}

/** Clamp an incoming option to a sane range without silently ignoring it. */
export const opt = (v: number | undefined, dflt: number, lo = -1e9, hi = 1e9): number =>
  v === undefined || !Number.isFinite(v) ? dflt : clamp(v, lo, hi);

// Generic rep counter over any scalar a game can compute from a PlayerPose.
//
// This is the escape hatch that stops ~8 games from each writing their own
// hysteresis: run-in-place, pedalling, swimming, arm circles, step-ups,
// pumping, drumming. The game supplies the scalar; the counter supplies the
// state machine, the confidence gate, the smoothing and the cadence.
import { approach, clamp, clamp01 } from '../math';
import { MIN_VIS, type Joint } from '../pose/landmarks';
import type { GestureOpts, PlayerPose } from '../types';
import type { RepOpts, RepSignal } from './index';
import { DetectorBase, Trigger, opt } from './trigger';

/**
 * REP — one cycle per rising edge, never two.
 *
 * RESEARCH-POSE §5.5 spells out the pipeline and the trap: confidence gate,
 * then EMA, then hysteresis, and count on ONE edge because "counting on both
 * double-counts". The edge here is the RISING one (`signal` crossing `enter`),
 * which also makes `rate` feel immediate — a run-in-place game credits the
 * knee-up, not the knee-down 200ms later.
 *
 * `signal` must be in normalized units. It is the game's own closure, so this
 * is the one detector where an author can still smuggle a pixel threshold in;
 * the doc comment on RepOpts says so and this is why `rate` is reported in
 * cycles/sec rather than anything frame-based.
 */
export class RepDetector extends DetectorBase<'rep'> {
  readonly kind = 'rep' as const;
  protected readonly s: RepSignal = { reps: 0, phase: 0, justCounted: false, rate: 0, ok: false };

  /** Default cadence ceiling. Deliberately NOT the engine's 250ms scoring
   *  floor: a two-legged run-in-place is a legitimate 4+ cycles/sec, and
   *  clamping it would make every running game feel broken. A rep is also
   *  rarely the thing that scores directly. */
  static readonly DEFAULT_COOLDOWN_MS = 120;

  private signal: (p: PlayerPose) => number = () => 0;
  private needs: readonly Joint[] | null = null;
  private readonly tr: Trigger;
  private sm = NaN;
  private raw = 0;
  private lastCountT = -1;
  private period = 0;

  constructor(o: RepOpts) {
    super(o, RepDetector.DEFAULT_COOLDOWN_MS);
    // These defaults are only meaningful for a signal in `kneeLift`'s band —
    // RepOpts documents no numbers because the scalar is the game's own. Always
    // pass both. Measured against `knee-run` (a 2.2Hz run-in-place): kneeLift
    // swings 0.05-0.37, so 0.22/0.10 counts every stride and nothing else.
    this.tr = new Trigger(0.22, 0.1, this.cooldownMs, this.confirmFrames);
    this.apply(o);
  }

  private apply(o: Partial<RepOpts>): void {
    if (typeof o.signal === 'function') this.signal = o.signal;
    if (o.needs !== undefined) this.needs = o.needs.length > 0 ? o.needs : null;
    const enter = opt(o.enter, this.tr.enter, -1e6, 1e6);
    const exit = opt(o.exit, o.enter !== undefined ? enter * 0.45 : this.tr.exit, -1e6, 1e6);
    this.tr.set(enter, exit);
    this.tr.cooldownMs = this.cooldownMs;
    this.tr.confirmFrames = this.confirmFrames;
  }

  protected override onConfigure(o: Partial<GestureOpts['rep']>): void {
    this.apply(o as Partial<RepOpts>);
  }

  protected clearEdges(): void {
    this.s.justCounted = false;
  }

  protected step(p: PlayerPose): void {
    let ok = true;
    const need = this.needs;
    if (need !== null) {
      for (let i = 0; i < need.length; i++) {
        if (p.vis[need[i]!]! < MIN_VIS) {
          ok = false;
          break;
        }
      }
    }
    this.setOk(ok);

    if (ok) {
      this.raw = this.signal(p);
      // Time-based EMA (~17ms) rather than the fixed ALPHA=0.3 of the research
      // pseudocode: at 10fps a per-frame alpha smooths 6x harder than at 60Hz,
      // so the same game would count different reps on a Chromebook and a Mac.
      //
      // Deliberately barely-smoothing. The signal arrives having already been
      // through median-of-3 and One Euro in normalize.ts, and smoothing it
      // twice costs real reps: measured on `knee-run` (2.2Hz run-in-place,
      // whose scalar genuinely crosses the thresholds 35 times) this counted
      // 30 at 30/s, 33 at 45/s and all 35 from 60/s up, with `fidget` counting
      // zero at every setting. There is no false-positive cost here because the
      // hysteresis and confirm frames do that job.
      this.sm = Number.isFinite(this.sm)
        ? this.sm + (this.raw - this.sm) * (this.dt > 0 ? 1 - Math.exp(-60 * this.dt) : 1)
        : this.raw;
    }

    if (this.tr.update(this.sm, this.tMs, ok)) {
      this.s.reps++;
      this.s.justCounted = true;
      if (this.lastCountT >= 0) {
        const gap = this.t - this.lastCountT;
        if (gap > 1e-3 && gap < 5) {
          this.period = this.period > 0 ? this.period + (gap - this.period) * 0.4 : gap;
          this.s.rate += (1 / this.period - this.s.rate) * 0.5;
        }
      }
      this.lastCountT = this.t;
    }

    // Phase runs off the measured period so an animation stays in step with the
    // player; it saturates rather than wrapping when they slow down.
    if (this.lastCountT >= 0 && this.period > 0) {
      this.s.phase = clamp01((this.t - this.lastCountT) / this.period);
      // Cadence decays once they stop, instead of reporting the last sprint
      // forever.
      if (this.t - this.lastCountT > this.period * 1.5) {
        this.s.rate = approach(this.s.rate, 0, 1.5, this.dt);
      }
    } else {
      this.s.phase = 0;
    }
  }

  protected onReset(): void {
    this.tr.reset();
    this.sm = NaN;
    this.raw = 0;
    this.lastCountT = -1;
    this.period = 0;
    this.s.reps = 0;
    this.s.phase = 0;
    this.s.justCounted = false;
    this.s.rate = 0;
  }

  protected override get dbgUnit(): string {
    return 'signal (normalized)';
  }
  protected override get dbgValue(): number {
    return Number.isFinite(this.sm) ? this.sm : 0;
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

/** Knee height above the standing knee line, in shoulder widths — the scalar
 *  run-in-place, stair-climb and pedal games all want.
 *
 *  Exported because "write your own signal closure" is how eight games end up
 *  with eight subtly different definitions of a step. Falls back to the elbow
 *  when the knees are not visible, which is the laptop case and the fallback
 *  ladder RESEARCH-POSE §5.4 recommends (Jumping Jack degrades the RULE, not
 *  the data). */
export function kneeLift(p: PlayerPose, side: 'L' | 'R'): number {
  const knee = side === 'L' ? 25 : 26;
  const hip = side === 'L' ? 23 : 24;
  if (p.vis[knee]! >= MIN_VIS && p.vis[hip]! >= MIN_VIS) {
    // n is hip-centred and +y is down: a raised knee has a SMALLER n.y.
    return clamp(1.1 - (p.n[knee * 2 + 1]! - p.n[hip * 2 + 1]!), -2, 2);
  }
  const elbow = side === 'L' ? 13 : 14;
  const shoulder = side === 'L' ? 11 : 12;
  if (p.vis[elbow]! >= MIN_VIS && p.vis[shoulder]! >= MIN_VIS) {
    // Arm pumping: the other half of a run. Scaled to land in the same band as
    // the knee signal so one threshold works on either rung of the ladder.
    return clamp(0.85 - (p.n[elbow * 2 + 1]! - p.n[shoulder * 2 + 1]!), -2, 2);
  }
  return 0;
}

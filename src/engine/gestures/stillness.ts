// stillness — motion energy against the player's OWN resting energy.
//
// This is the single most important fairness decision in the freeze games
// (statue-hold, scan-hold-still, red-light-green-light, ice-tag-freeze).
// A global "hold still" constant fails this age group completely: children
// cannot hold still, and the ones trying hardest shake the most. So the
// threshold is `factor` x `calib.idleEnergy` — a multiple of what THIS child
// measured while standing still during their own calibration.
//
// The energy definition is deliberately not ours: `motionEnergy()` lives in
// pose/calibration.ts and is what produced `idleEnergy` in the first place. Two
// definitions of energy would make the comparison meaningless, so this file
// imports the one and only one.
import { clamp, clamp01 } from '../math';
import { ENERGY_JOINTS, motionEnergy } from '../pose/calibration';
import { MIN_VIS } from '../pose/landmarks';
import type { GestureOpts, PlayerPose } from '../types';
import type { StillnessOpts, StillnessSignal } from './index';
import { DetectorBase, Stats, Trigger, opt } from './trigger';

/** Clamp on the calibrated idle energy. A calibration taken from a photo held
 *  up to the camera reports ~0, which would make every freeze game impossible;
 *  one taken from a child bouncing through the whole capture reports something
 *  huge, which would make them all trivial. */
export const IDLE_MIN = 0.08;
export const IDLE_MAX = 1.2;

/** How much more energy than `factor x idleEnergy` breaks a held "still". */
const HYSTERESIS = 1.25;

/**
 * STILLNESS — windowed mean of `motionEnergy`, hysteresis on `factor x idle`.
 *
 * Averaged over `windowMs` because a single frame of landmark jitter is not
 * movement; measured on this corpus, the instantaneous energy of a standing
 * body spikes to 0.45 while its 200ms mean stays near 0.16.
 *
 * Measured with a calibration taken from this corpus's own `idle` clip
 * (median energy 0.309 sw/s), sweeping the factor:
 *
 *     factor  limit   idle  fidget  jump  squat  knee-run  swing
 *       1.8    0.56    95%    85%    58%   48%      0%      3%
 *       2.2    0.68    98%    94%    62%   66%      0%     10%
 *       2.5    0.77    99%    96%    65%   74%      1%     14%
 *       3.0    0.93   100%   100%    69%   93%     95%     25%
 *
 * The documented default is 3.0, and the last row is why this ships 2.5: at 3.0
 * the threshold lands just above `knee-run`'s own energy, the "still" latch
 * catches, and a child RUNNING IN PLACE reads as frozen 95% of the time. 2.5
 * keeps a fidgeting child passing 96% of the time — which is the fairness
 * requirement — while catching the runner.
 */
export class StillnessDetector extends DetectorBase<'stillness'> {
  readonly kind = 'stillness' as const;
  protected readonly s: StillnessSignal = { energy: 0, still: false, quality: 0, ok: false };

  private factor = 2.5;
  private windowMs = 200;
  private readonly win: Stats;
  private readonly tr: Trigger;
  private limit = 1;

  constructor(o: StillnessOpts = {}) {
    super(o, 0);
    this.win = new Stats(0.2, 64);
    // Thresholds negated energy, so "still" is a rising edge with hysteresis.
    // The gap is deliberately narrow (25%): a WIDE one makes the "still" latch
    // sticky, and a sticky freeze latch is how a running child keeps a perfect
    // score. Narrow enough to stop boundary strobing, no more.
    this.tr = new Trigger(0, -1, 0, this.confirmFrames);
    this.apply(o);
  }

  private apply(o: Partial<StillnessOpts>): void {
    this.factor = opt(o.factor, 2.5, 0.5, 20);
    this.windowMs = Math.max(40, opt(o.windowMs, 200, 40, 3000));
    this.win.windowSec = this.windowMs / 1000;
    this.tr.confirmFrames = this.confirmFrames;
  }

  protected override onConfigure(o: Partial<GestureOpts['stillness']>): void {
    this.apply(o as Partial<StillnessOpts>);
  }

  protected clearEdges(): void {
    // `still` is a sustained state.
  }

  protected step(p: PlayerPose): void {
    // Needs at least a few of the energy joints, else "no motion" is just "no
    // landmarks" — which must not read as a perfect freeze.
    let seen = 0;
    for (let i = 0; i < ENERGY_JOINTS.length; i++) {
      if (p.vis[ENERGY_JOINTS[i]!]! >= MIN_VIS) seen++;
    }
    const ok = seen >= 4;
    this.setOk(ok);
    if (!ok) {
      this.tr.update(0, this.tMs, false);
      return;
    }

    this.win.push(motionEnergy(p), this.t);
    const e = this.win.mean;
    this.s.energy = e;
    const idle = clamp(p.calib.idleEnergy, IDLE_MIN, IDLE_MAX);
    this.limit = idle * this.factor;
    this.tr.set(-this.limit, -this.limit * HYSTERESIS);
    this.tr.update(-e, this.tMs, true);
    this.s.still = this.tr.active;
    this.s.quality = clamp01(1 - e / this.limit);
  }

  protected onReset(): void {
    this.win.reset();
    this.tr.reset();
    this.s.energy = 0;
    this.s.still = false;
    this.s.quality = 0;
  }

  protected override get dbgUnit(): string {
    return 'sw/s energy';
  }
  protected override get dbgValue(): number {
    return this.s.energy;
  }
  protected override get dbgEnter(): number {
    return this.limit;
  }
  protected override get dbgExit(): number {
    return this.limit * HYSTERESIS;
  }
  protected override get dbgActive(): boolean {
    return this.s.still;
  }
}

// BeatScheduler — the two-clocks lookahead pattern (Chris Wilson, "A Tale of
// Two Clocks"), implemented exactly as docs/RESEARCH-ARCH.md §4.1 specifies.
//
// THE RULE: setTimeout schedules nothing audible. It only decides what to hand
// to the audio clock. A timer wakes every ~25ms, looks ~120ms into the future,
// and calls `onBeat(beat, audioTime)` for every beat due in that window; the
// callback then uses `play(id, { at: audioTime })`, which is sample-accurate.
// Scheduling a note *when the timer fires* drifts by tens of milliseconds
// because the JS timer and the audio clock are different clocks and the main
// thread is busy running pose inference and 60fps render.
//
// ───────────────────────────────────────────────────────────────────────────────
// WHICH CLOCK IS `judge(inputTimeMs)` ON?  <- read this before writing a rhythm
//                                             game
//
// `inputTimeMs` is AUDIO-CLOCK MILLISECONDS: `ctx.audio.now * 1000`, sampled at
// the moment you detected the player's action, MINUS `frame.inferenceAgeMs`.
//
//     const tMs = ctx.audio.now * 1000 - frame.inferenceAgeMs;
//     const { grade } = beats.judge(tMs);
//
// The `inferenceAgeMs` subtraction is the caller's job and it is not optional.
// Pose inference runs at ~25Hz and the filter adds group delay, so the body
// position you are reacting to is 40-90ms old. Judge without subtracting it and
// EVERY CHILD READS AS LATE — they will be told they are bad at a game they are
// playing correctly. This is the single biggest "feels broken" bug in webcam
// rhythm games.
//
// Output latency (the gap between scheduling a sound and the speaker producing
// it) is subtracted HERE, inside judge, because only the engine knows it.
// ───────────────────────────────────────────────────────────────────────────────
import type { BeatScheduler } from './index';

/** Kid-calibrated hit windows, in ms. Adult rhythm games use ±30/±60; a
 *  7-year-old plus pose latency plus a Bluetooth speaker would miss everything
 *  at those. Generous windows are a design decision, not sloppiness. */
export const WINDOW_PERFECT_MS = 60;
export const WINDOW_GOOD_MS = 120;
export const WINDOW_OK_MS = 200;

export const LOOKAHEAD_MS = 25;
export const SCHEDULE_AHEAD_SEC = 0.12;

export interface SchedulerClock {
  /** Audio-clock seconds. */
  now(): number;
  /** Device output latency in seconds, if the browser reports it. */
  outputLatencySec(): number;
  /** Calibrated latency in ms from the A/V screen. Takes precedence over
   *  `outputLatencySec` when non-zero — it already includes it. */
  latencyMs(): number;
}

export interface BeatsOpts {
  /** Shift the grid. Negative starts the grid in the past. */
  offsetBeats?: number;
  /** Called once per beat, ~0-120ms BEFORE that beat is due, with the absolute
   *  audio time to schedule at. Omit for a pure-maths grid with no timer. */
  onBeat?: (beat: number, time: number) => void;
  /** Injected so tests can drive the lookahead loop by hand. */
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
  lookaheadMs?: number;
  scheduleAheadSec?: number;
}

export class Beats implements BeatScheduler {
  readonly bpm: number;
  /** Seconds per beat. */
  readonly spb: number;

  private start: number;
  private nextBeat = 0;
  private lastTick = -1;
  private timer: number | null = null;
  private stopped = false;

  private readonly clock: SchedulerClock;
  private readonly onBeat: ((beat: number, time: number) => void) | undefined;
  private readonly setTimer: (fn: () => void, ms: number) => number;
  private readonly clearTimer: (id: number) => void;
  private readonly lookaheadMs: number;
  private readonly aheadSec: number;

  constructor(clock: SchedulerClock, bpm: number, o?: BeatsOpts) {
    this.clock = clock;
    this.bpm = Number.isFinite(bpm) && bpm > 0 ? Math.min(400, Math.max(20, bpm)) : 110;
    this.spb = 60 / this.bpm;
    this.lookaheadMs = o?.lookaheadMs ?? LOOKAHEAD_MS;
    this.aheadSec = o?.scheduleAheadSec ?? SCHEDULE_AHEAD_SEC;
    this.onBeat = o?.onBeat;
    const g = globalThis as unknown as {
      setTimeout: (fn: () => void, ms: number) => number;
      clearTimeout: (id: number) => void;
    };
    this.setTimer = o?.setTimer ?? ((fn, ms) => g.setTimeout(fn, ms));
    this.clearTimer = o?.clearTimer ?? ((id) => g.clearTimeout(id));
    // A small lead-in: beat 0 must be schedulable, and `now` is already past.
    this.start = this.clock.now() + 0.06 + (o?.offsetBeats ?? 0) * this.spb;
    if (this.onBeat) this.pump();
  }

  /**
   * Re-anchor beat 0 to `atSec` (default: a hair in the future).
   *
   * Needed because games rent the scheduler in `init()` but the round starts
   * seconds later, after the 3-2-1 countdown. The session calls this on
   * `start()` so beat 0 is the start of play. Not part of the frozen interface.
   */
  restart(atSec?: number): void {
    this.start = atSec ?? this.clock.now() + 0.06;
    this.nextBeat = 0;
    this.lastTick = -1;
    this.stopped = false;
    if (this.onBeat && this.timer === null) this.pump();
  }

  /** Fractional beats elapsed on the SCHEDULING clock. Exact inverse of
   *  `timeOfBeat`; latency compensation happens only in `judge`, so these two
   *  can never disagree. */
  get beat(): number {
    return (this.clock.now() - this.start) / this.spb;
  }

  timeOfBeat(n: number): number {
    return this.start + n * this.spb;
  }

  /** Effective latency in seconds. The calibrated value wins when it exists —
   *  it was measured end to end and already contains the device latency, so
   *  adding `outputLatency` on top would double-count it. */
  private latencySec(): number {
    const m = this.clock.latencyMs();
    if (Number.isFinite(m) && m !== 0) return m / 1000;
    return this.clock.outputLatencySec();
  }

  judge(inputTimeMs: number): {
    grade: 'perfect' | 'good' | 'ok' | 'miss';
    deltaMs: number;
    beat: number;
  } {
    if (!Number.isFinite(inputTimeMs)) {
      return { grade: 'miss', deltaMs: WINDOW_OK_MS + 1, beat: Math.round(this.beat) };
    }
    // The player reacted to what they HEARD. A sound heard at audio time T was
    // scheduled at T - latency, so shift the input back by the latency before
    // comparing it against the grid.
    const t = inputTimeMs / 1000 - this.latencySec();
    const b = (t - this.start) / this.spb;
    const nearest = Math.round(b);
    const deltaMs = (b - nearest) * this.spb * 1000;
    const a = Math.abs(deltaMs);
    const grade =
      a <= WINDOW_PERFECT_MS ? 'perfect'
      : a <= WINDOW_GOOD_MS ? 'good'
      : a <= WINDOW_OK_MS ? 'ok'
      : 'miss';
    return { grade, deltaMs, beat: nearest };
  }

  /** True for exactly one frame per beat. Drives the visual beat ring.
   *
   *  Skipped beats (a 300ms stall) do NOT produce a burst of ticks: the counter
   *  jumps, which is right — the ring should show where the music IS, not replay
   *  where it was. */
  tick(): boolean {
    const b = Math.floor(this.beat);
    if (b > this.lastTick) {
      this.lastTick = b;
      return b >= 0;
    }
    return false;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /** One pass of the lookahead loop. Exposed so a test can step it without a
   *  real timer. */
  pump = (): void => {
    if (this.stopped) return;
    const horizon = this.clock.now() + this.aheadSec;
    let guard = 0;
    while (this.timeOfBeat(this.nextBeat) < horizon && guard++ < 512) {
      this.onBeat?.(this.nextBeat, this.timeOfBeat(this.nextBeat));
      this.nextBeat++;
    }
    this.timer = this.setTimer(this.pump, this.lookaheadMs);
  };
}

/** The bar/step grid `music()` runs on, factored out so a rhythm game can use
 *  the same subdivision the backing track does. */
export const STEPS_PER_BEAT = 4;

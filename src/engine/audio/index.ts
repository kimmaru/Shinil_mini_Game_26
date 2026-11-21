// ══ FROZEN CONTRACT ══ imported by 58 game modules.
import type { SfxId } from './sfx';
export { SFX_IDS, isSfxId } from './sfx';
export type { SfxId } from './sfx';

export interface PlayOpts {
  /** 0..1. Default 1. */
  gain?: number;
  /** Playback rate / pitch multiplier. 1.06 per semitone. Rising pitch on a
   *  combo is the cheapest reward signal there is. */
  rate?: number;
  /** Stereo pan, -1..1. */
  pan?: number;
  /** Schedule at an absolute audio-clock time (see `now`). Omit to play ASAP. */
  at?: number;
}

/** A beat grid driven by the Web Audio clock. */
export interface BeatScheduler {
  readonly bpm: number;
  /** Beats elapsed since start, fractional. */
  readonly beat: number;
  /** Audio-clock time of beat `n`. */
  timeOfBeat(n: number): number;
  /**
   * Judge a player action against the nearest beat.
   *
   * `inputTimeMs` is on the AUDIO CLOCK, in milliseconds — NOT `frame.t`,
   * which starts at the round and would be wrong by the whole countdown.
   * Compute it exactly like this:
   *
   *     const at = ctx.audio.now * 1000 - frame.inferenceAgeMs;
   *     const { grade } = beat.judge(at);
   *
   * Subtracting `inferenceAgeMs` is not optional: without it you are judging
   * where the body was ~60ms ago and every child reads as late. Output
   * latency is already folded in by the implementation.
   *
   * Windows are deliberately generous for 7-year-olds: 60/120/200ms.
   */
  judge(inputTimeMs: number): { grade: 'perfect' | 'good' | 'ok' | 'miss'; deltaMs: number; beat: number };
  /** True for exactly one frame per beat; drives the visual beat ring. */
  tick(): boolean;
  stop(): void;
}

export interface AudioService {
  /** Audio-clock seconds. The ONLY reliable clock for musical timing —
   *  requestAnimationFrame drifts and stalls. */
  readonly now: number;
  /** Measured output latency in ms (device + filter + inference), from the A/V
   *  calibration screen. Already folded into `judge`. */
  readonly latencyMs: number;
  readonly muted: boolean;

  play(id: SfxId, o?: PlayOpts): void;
  /**
   * The combo ladder: pitch rises one semitone per `index`, capped at an
   * octave (past that a bright pluck becomes an ice pick), after which the
   * reward continues as a gain bump instead.
   *
   * `index` is authoritative and stateless — pass your own combo counter, so
   * the same combo always sounds the same and a replay is reproducible.
   * A rising pitch per combo step is the cheapest strong reward signal in
   * game design; use it.
   */
  playLadder(id: SfxId, index: number, o?: PlayOpts): void;
  /** Start a looping background pulse at `bpm`. One per game. */
  music(o?: { bpm?: number; key?: number; gain?: number }): void;
  stopMusic(): void;
  /** Rent a beat scheduler. init() only. */
  beat(bpm: number, o?: { offsetBeats?: number }): BeatScheduler;
  /** Korean voice prompt. Optional by design: speechSynthesis ko-KR quality
   *  varies wildly by device, so this is OFF unless the player enables it and
   *  every line is mirrored by hud.announce(). */
  speak(textKo: string): void;
}

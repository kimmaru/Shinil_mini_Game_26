// createAudioService(): the AudioService 58 games call.
//
// Everything here degrades to silence rather than throwing: no AudioContext
// (node, a locked-down kiosk, audio drivers asleep) must never be able to stop
// a game from running. `manifest.a11y.audioOptional` exists because sound is
// garnish — the engine draws a beat ring when it is not.
import { clamp } from '../math';
import { Beats, STEPS_PER_BEAT, type BeatsOpts, type SchedulerClock } from './scheduler';
import { AudioEngine, type AudioEngineOpts } from './engine';
import type { AudioService, BeatScheduler, PlayOpts } from './index';
import type { SfxId } from './sfx';
import {
  MUSICAL_IDS,
  SFX,
  durationOf,
  ladderGain,
  ladderRate,
  voice,
  type SynthDef,
} from './synth';

/** Per-id retrigger guard. Two hits inside this window play once: without it,
 *  a swing detector firing on consecutive frames machine-guns the same sound
 *  and the result is a buzz, not a hit. */
const RETRIGGER_SEC = 0.034;

/** Deterministic jitter source for the ±1.5% detune that keeps repeated sfx
 *  from sounding mechanical. Seeded, so audio is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface AudioRuntime extends AudioService {
  /** Call from a real user gesture (the priming screen's button). */
  unlock(): void;
  setMuted(m: boolean): void;
  setMasterGain(v: number): void;
  /** From the A/V calibration screen. Folded into every `judge()`. */
  setLatencyMs(ms: number): void;
  /** speechSynthesis is OFF by default — see `speak`. */
  setSpeechEnabled(on: boolean): void;
  readonly speechEnabled: boolean;
  /** 0..3. Call as a combo builds: the music gains a layer per level, which the
   *  research names as the most effective reward signal in this genre. */
  setMusicIntensity(level: number): void;
  /** Resets the `playLadder` pitch floor. */
  resetCombo(): void;
  /** Between rounds: stops music and every rented scheduler. */
  endRound(): void;
  readonly available: boolean;
  dispose(): void;
}

export interface AudioServiceOpts extends AudioEngineOpts {
  latencyMs?: number;
  speech?: boolean;
  seed?: number;
}

// ─── Music bed ───────────────────────────────────────────────────────────────

const M_KICK: SynthDef = { v: 'blip', wave: 'sine', f0: 150, f1: 46, dur: 0.16, atk: 0.002, gain: 0.6 };
const M_HAT: SynthDef = { v: 'noise', type: 'highpass', f0: 7600, dur: 0.028, gain: 0.1 };
const M_BASS: SynthDef = { v: 'blip', wave: 'triangle', f0: 110, dur: 0.17, atk: 0.006, gain: 0.3, lp: 700 };
const M_ARP: SynthDef = { v: 'pluck', f: 523.25, dur: 0.16, gain: 0.17, bright: 2.6 };
const M_PAD: SynthDef = { v: 'blip', wave: 'triangle', f0: 261.63, dur: 0.6, atk: 0.12, gain: 0.08, lp: 1400 };

/** A major pentatonic, which is the cheapest way to guarantee that any two
 *  notes played together sound deliberate. Semitones from the key root. */
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16];
/** 16 steps of a bar: which pentatonic degree the arp plays. */
const ARP = [0, 2, 4, 5, 4, 2, 3, 1, 0, 2, 4, 6, 5, 4, 2, 1];
const KICK_STEPS = [0, 8];
const KICK_STEPS_BUSY = [0, 6, 8, 14];
const BASS_STEPS = [0, 3, 6, 8, 11, 14];

class MusicBed {
  private beats: Beats | null = null;
  private level = 1;
  private key = 0;
  private gain = 1;
  private bar = 0;

  constructor(
    private readonly play: (def: SynthDef, at: number, gain: number, rate: number) => void,
    private readonly clock: SchedulerClock,
  ) {}

  get running(): boolean {
    return this.beats !== null;
  }

  start(bpm: number, key: number, gain: number): void {
    this.stop();
    this.key = key;
    this.gain = gain;
    this.bar = 0;
    const o: BeatsOpts = { onBeat: (beat, time) => this.onBeat(beat, time) };
    this.beats = new Beats(this.clock, bpm, o);
  }

  setLevel(n: number): void {
    this.level = clamp(Math.round(n), 0, 3);
  }

  stop(): void {
    this.beats?.stop();
    this.beats = null;
  }

  /** The lookahead callback: schedules a beat's worth of 16th-note steps on the
   *  audio clock, never on a timer. */
  private onBeat(beat: number, time: number): void {
    const b = this.beats;
    if (!b) return;
    const stepSec = b.spb / STEPS_PER_BEAT;
    const root = Math.pow(2, this.key / 12);
    for (let s = 0; s < STEPS_PER_BEAT; s++) {
      const step = ((beat * STEPS_PER_BEAT + s) % 16 + 16) % 16;
      const at = time + s * stepSec;
      const g = this.gain;

      const kicks = this.level >= 2 ? KICK_STEPS_BUSY : KICK_STEPS;
      if (kicks.indexOf(step) >= 0) this.play(M_KICK, at, g, 1);
      if (step % 2 === 1) this.play(M_HAT, at, g * (this.level >= 1 ? 1 : 0.5), 1);

      if (this.level >= 1 && BASS_STEPS.indexOf(step) >= 0) {
        const deg = PENTA[(step >> 2) % PENTA.length]!;
        this.play(M_BASS, at, g, root * Math.pow(2, deg / 12));
      }
      if (this.level >= 2 && step % 2 === 0) {
        const deg = PENTA[ARP[step]! % PENTA.length]!;
        this.play(M_ARP, at, g, root * Math.pow(2, deg / 12) * 2);
      }
      if (this.level >= 3 && step === 0) {
        this.play(M_PAD, at, g, root);
        this.play(M_PAD, at, g, root * Math.pow(2, 7 / 12));
      }
    }
    if (beat % 4 === 0) this.bar++;
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

class AudioImpl implements AudioRuntime {
  private readonly eng: AudioEngine;
  private readonly rng: () => number;
  private readonly last = new Map<string, number>();
  private readonly schedulers: Beats[] = [];
  private readonly bed: MusicBed;
  private readonly clock: SchedulerClock;

  private _latencyMs: number;
  private _speech: boolean;
  private ladderBase = 0;
  private voiceReady: Promise<unknown> | null = null;
  private koVoice: SpeechSynthesisVoice | null = null;

  constructor(o?: AudioServiceOpts) {
    this.eng = new AudioEngine(o);
    this.rng = mulberry32(o?.seed ?? 0x51f_c0de);
    this._latencyMs = o?.latencyMs ?? 0;
    this._speech = o?.speech ?? false;
    this.clock = {
      now: () => this.eng.now,
      outputLatencySec: () => this.eng.outputLatencySec,
      latencyMs: () => this._latencyMs,
    };
    this.bed = new MusicBed(
      (def, at, gain, rate) => this.raw(def, at, gain, rate, 'music'),
      this.clock,
    );
  }

  get available(): boolean {
    return this.eng.available;
  }

  get now(): number {
    return this.eng.now;
  }

  get latencyMs(): number {
    return this._latencyMs;
  }

  get muted(): boolean {
    return this.eng.muted;
  }

  get speechEnabled(): boolean {
    return this._speech;
  }

  unlock(): void {
    this.eng.unlock();
  }

  setMuted(m: boolean): void {
    this.eng.setMuted(m);
  }

  setMasterGain(v: number): void {
    this.eng.setMasterGain(v);
  }

  setLatencyMs(ms: number): void {
    // A ±150ms slider: beyond that it is not latency, it is a broken clock.
    this._latencyMs = Number.isFinite(ms) ? clamp(ms, -150, 300) : 0;
  }

  setSpeechEnabled(on: boolean): void {
    this._speech = on;
  }

  // ─── play ──────────────────────────────────────────────────────────────────

  private raw(
    def: SynthDef, at: number, gain: number, rate: number,
    bus: 'sfx' | 'music' | 'voice',
  ): void {
    const ctx = this.eng.ensure();
    if (!ctx) return;
    const dest = bus === 'music' ? this.eng.music : bus === 'voice' ? this.eng.voice : this.eng.sfx;
    if (!dest) return;
    voice(ctx, def, dest, at, gain, rate, this.eng.noise());
  }

  play(id: SfxId, o?: PlayOpts): void {
    const def = SFX[id];
    if (!def) return; // unreachable: SFX is Record<SfxId, _> and typechecked
    const ctx = this.eng.ensure();
    if (!ctx) return;
    const now = ctx.currentTime;
    const scheduled = o?.at !== undefined && Number.isFinite(o.at);
    let when = scheduled ? (o!.at as number) : now;
    // Never schedule in the past: the Web Audio spec plays it immediately,
    // which silently collapses a rhythm pattern into a single cluster.
    if (when < now) when = now;

    if (!scheduled) {
      const prev = this.last.get(id);
      if (prev !== undefined && when - prev < RETRIGGER_SEC) return;
      this.last.set(id, when);
    }

    let dest: AudioNode | null = this.eng.sfx;
    if (!dest) return;
    const pan = o?.pan;
    if (pan !== undefined && pan !== 0 && Number.isFinite(pan) && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      p.connect(dest);
      dest = p;
      const ttl = (when - now + durationOf(def) + 0.25) * 1000;
      const g = globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown };
      g.setTimeout?.(() => p.disconnect(), ttl);
    }

    // Musical ids keep their exact pitch; everything else gets ±1.5% so ten
    // claps in a row sound like ten claps and not like a stuck sample.
    const jitter = MUSICAL_IDS.has(id) ? 1 : 0.985 + this.rng() * 0.03;
    const rate = (o?.rate ?? 1) * jitter;
    const gain = clamp(o?.gain ?? 1, 0, 2);
    voice(ctx, def, dest, when, gain, rate, this.eng.noise());
  }

  /**
   * The combo ladder — rising pitch per consecutive call.
   *
   * Cheapest reward signal in game design, and the reason it lives in the
   * engine: the rise has to be CONSISTENT across 58 games, or the party stops
   * sounding like one product. One semitone per step, capped at one octave (see
   * LADDER_CAP) so a 40-combo does not end in an ice pick.
   *
   * `index` is authoritative, so the ladder is deterministic and testable;
   * `resetCombo()` only moves the floor for callers that pass a running index.
   */
  playLadder(id: SfxId, index: number, o?: PlayOpts): void {
    const i = Math.max(0, Math.floor(Number.isFinite(index) ? index : 0) - this.ladderBase);
    this.play(id, {
      gain: (o?.gain ?? 1) * ladderGain(i),
      rate: (o?.rate ?? 1) * ladderRate(i),
      pan: o?.pan,
      at: o?.at,
    });
  }

  resetCombo(): void {
    this.ladderBase = 0;
  }

  // ─── music ─────────────────────────────────────────────────────────────────

  music(o?: { bpm?: number; key?: number; gain?: number }): void {
    if (!this.eng.ensure()) return;
    this.bed.start(o?.bpm ?? 108, o?.key ?? 0, clamp(o?.gain ?? 1, 0, 1.5));
  }

  stopMusic(): void {
    this.bed.stop();
  }

  setMusicIntensity(level: number): void {
    this.bed.setLevel(level);
  }

  // ─── beat ──────────────────────────────────────────────────────────────────

  beat(bpm: number, o?: { offsetBeats?: number }): BeatScheduler {
    this.eng.ensure();
    const b = new Beats(this.clock, bpm, { offsetBeats: o?.offsetBeats ?? 0 });
    this.schedulers.push(b);
    return b;
  }

  endRound(): void {
    this.stopMusic();
    for (const s of this.schedulers) s.stop();
    this.schedulers.length = 0;
    this.last.clear();
    this.resetCombo();
  }

  // ─── speech ────────────────────────────────────────────────────────────────

  /**
   * Korean voice prompt. OFF by default, and that is a product decision.
   *
   * ko-KR `speechSynthesis` quality is all over the map: Chrome desktop's Korean
   * voice is network-backed (school Wi-Fi = silence), Firefox frequently has no
   * Korean voice at all, the voice list loads asynchronously so setting
   * `utterance.voice` too early silently does nothing, and none of it routes
   * through our AudioContext, so it cannot be ducked, scheduled or volume-
   * controlled. A bad robot voice reading Korean to a 7-year-old is worse than
   * no voice.
   *
   * The caller ALWAYS mirrors the line via `hud.announce()`, so this failing
   * silently costs nothing.
   */
  speak(textKo: string): void {
    if (!this._speech || !textKo) return;
    const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
    const Utter = (globalThis as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance })
      .SpeechSynthesisUtterance;
    if (!synth || !Utter) return;
    const say = (): void => {
      try {
        const u = new Utter(textKo);
        if (this.koVoice) u.voice = this.koVoice;
        u.lang = 'ko-KR';
        u.rate = 1;
        u.pitch = 1.1;
        synth.cancel();
        synth.speak(u);
        this.eng.duckForVoice(900);
      } catch {
        /* a device with a broken speech stack is not a reason to stop the game */
      }
    };
    if (this.koVoice) {
      say();
      return;
    }
    if (!this.voiceReady) {
      this.voiceReady = new Promise<void>((res) => {
        const pick = (): SpeechSynthesisVoice | null =>
          synth.getVoices().find((v) => v.lang?.toLowerCase().startsWith('ko')) ?? null;
        const v = pick();
        if (v) {
          this.koVoice = v;
          res();
          return;
        }
        // Chrome populates the list asynchronously; without this wait, the
        // voice is never set and Korean comes out in an English voice.
        const on = (): void => {
          this.koVoice = pick();
          res();
        };
        synth.addEventListener?.('voiceschanged', on, { once: true });
        const g = globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown };
        g.setTimeout?.(() => {
          this.koVoice = this.koVoice ?? pick();
          res();
        }, 1500);
      });
    }
    void this.voiceReady.then(say);
  }

  dispose(): void {
    this.endRound();
    this.eng.dispose();
  }
}

export function createAudioService(o?: AudioServiceOpts): AudioRuntime {
  return new AudioImpl(o);
}

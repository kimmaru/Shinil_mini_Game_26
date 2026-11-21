// Every sound in the game, synthesized from oscillators and filtered noise.
//
// There are no audio files in this project. That is not an austerity measure:
// it means zero licensing homework for 58 parallel authors, zero bundle weight,
// zero third-party requests (which is what makes the privacy claim auditable),
// and sounds that can be pitched, layered and scheduled sample-accurately
// without a decode step.
//
// The design is five parametric voices and a sequencer:
//
//   blip    an oscillator with a pitch envelope. The workhorse: UI, pops,
//           jumps, notes, countdown beeps. Pitch envelopes are what make a
//           sine wave read as "pop" or "boing" rather than "beep".
//   noise   one shared white-noise buffer through a swept filter. Every
//           percussive non-pitched sound: hats, snares, claps, whooshes,
//           impacts, splashes, breaks.
//   fm      a carrier modulated by one operator. Bells, chimes, clangs, ice.
//           Cheap, and the only way to get metallic from two oscillators.
//   pluck   a saw through a fast-closing lowpass. Short, warm, toy-xylophone.
//   chord   several blips at semitone offsets, optionally staggered into an
//           arpeggio. Stabs and triads.
//   seq     a list of (time, def) pairs. Fanfares, star tiers, round results —
//           the sounds that carry the emotional payoff — are composed from the
//           four voices above rather than being special-cased.
//
// Tone target: warm, bright, toy-like. Triangle and sine dominate; square and
// sawtooth appear only where harshness is the point (buzz, zap, alarm). Nothing
// is allowed to be shrill — a 7-year-old is 40cm from a laptop speaker.
//
// The table is typed `Record<SfxId, SynthDef>`, so a missing id is a COMPILE
// error, not a silent game nobody notices until a child plays it.
import type { SfxId } from './sfx';

export type Wave = 'sine' | 'triangle' | 'square' | 'sawtooth';

export interface BlipDef {
  v: 'blip';
  wave?: Wave;
  /** Start frequency, Hz. */
  f0: number;
  /** End frequency. Omit for a steady tone. */
  f1?: number;
  dur: number;
  atk?: number;
  gain?: number;
  /** Lowpass cutoff, swept f -> lp1 if given. */
  lp?: number;
  lp1?: number;
  hp?: number;
  q?: number;
  /** Second oscillator detuned by this many cents. Thickens a thin tone. */
  detune?: number;
  /** Vibrato. Big depth + low rate = "boing"/"wobble". */
  vib?: { hz: number; cents: number };
  /** Pitch glide shape. 'exp' (default) sounds natural; 'lin' sounds synthetic
   *  and is right for sirens. */
  glide?: 'exp' | 'lin';
}

export interface NoiseDef {
  v: 'noise';
  type?: BiquadFilterType;
  f0: number;
  f1?: number;
  q?: number;
  dur: number;
  atk?: number;
  gain?: number;
}

export interface FmDef {
  v: 'fm';
  f: number;
  /** Modulator frequency = f * ratio. Non-integer ratios go metallic. */
  ratio: number;
  /** Modulation index at the attack, in Hz of deviation. */
  index: number;
  /** Index at the end of the note. Defaults to 0 — bells lose their clang. */
  index1?: number;
  dur: number;
  atk?: number;
  gain?: number;
  wave?: Wave;
}

export interface PluckDef {
  v: 'pluck';
  f: number;
  dur: number;
  gain?: number;
  /** 1 = dark and woody, 4 = bright and plasticky. */
  bright?: number;
}

export interface ChordDef {
  v: 'chord';
  /** Root frequency, Hz. */
  root: number;
  /** Semitone offsets from the root. */
  semis: readonly number[];
  wave?: Wave;
  dur: number;
  atk?: number;
  gain?: number;
  /** Seconds between notes. > 0 turns the chord into an arpeggio. */
  stagger?: number;
}

export interface SeqDef {
  v: 'seq';
  parts: readonly { at: number; def: SynthDef; gain?: number; rate?: number }[];
}

export type SynthDef = BlipDef | NoiseDef | FmDef | PluckDef | ChordDef | SeqDef;

const SEMI = 1.0594630943592953; // 2^(1/12)
const st = (f: number, semis: number): number => f * Math.pow(SEMI, semis);

// Note frequencies, octave 5 — the register that cuts through a laptop speaker
// without being shrill.
const C5 = 523.25;
const D5 = 587.33;
const E5 = 659.25;
const F5 = 698.46;
const G5 = 783.99;
const A5 = 880.0;
const B5 = 987.77;
const G4 = 392.0;
const C6 = 1046.5;
const E6 = 1318.51;
const G6 = 1567.98;

// ─── Rendering ───────────────────────────────────────────────────────────────

/** Total scheduled length of a def, in seconds. Used to clean nodes up. */
export function durationOf(def: SynthDef): number {
  switch (def.v) {
    case 'seq': {
      let m = 0;
      for (const p of def.parts) m = Math.max(m, p.at + durationOf(p.def));
      return m;
    }
    case 'chord':
      return def.dur + (def.stagger ?? 0) * Math.max(0, def.semis.length - 1);
    default:
      return def.dur;
  }
}

function env(p: AudioParam, t: number, atk: number, dur: number, peak: number): void {
  const a = Math.max(0.0008, atk);
  const d = Math.max(a + 0.012, dur);
  p.setValueAtTime(0.0001, t);
  p.linearRampToValueAtTime(Math.max(0.0002, peak), t + a);
  p.exponentialRampToValueAtTime(0.0001, t + d);
}

function sweep(
  p: AudioParam, t: number, f0: number, f1: number, dur: number, lin = false,
): void {
  const a = Math.max(1, f0);
  p.setValueAtTime(a, t);
  if (f1 === f0) return;
  const b = Math.max(1, f1);
  if (lin) p.linearRampToValueAtTime(b, t + dur);
  else p.exponentialRampToValueAtTime(b, t + dur);
}

/**
 * Schedule `def` on the audio clock.
 *
 * `when` is an absolute `AudioContext.currentTime` value — never "now plus a
 * setTimeout". `rate` multiplies every frequency (the pitch/ladder knob) and
 * never the durations: a combo ladder rises in pitch, it does not speed up.
 *
 * Returns the scheduled length in seconds.
 */
export function voice(
  ctx: BaseAudioContext,
  def: SynthDef,
  dest: AudioNode,
  when: number,
  gain: number,
  rate: number,
  noise: AudioBuffer | null,
): number {
  const r = rate > 0 ? rate : 1;
  switch (def.v) {
    case 'blip':
      return blip(ctx, def, dest, when, gain, r);
    case 'noise':
      return noiseVoice(ctx, def, dest, when, gain, r, noise);
    case 'fm':
      return fm(ctx, def, dest, when, gain, r);
    case 'pluck':
      return pluck(ctx, def, dest, when, gain, r);
    case 'chord':
      return chord(ctx, def, dest, when, gain, r, noise);
    case 'seq': {
      let m = 0;
      for (const p of def.parts) {
        const d = voice(
          ctx, p.def, dest, when + p.at,
          gain * (p.gain ?? 1), r * (p.rate ?? 1), noise,
        );
        m = Math.max(m, p.at + d);
      }
      return m;
    }
  }
}

/** Disconnect a node graph once the voice has finished, so a 60-minute party
 *  does not accumulate ten thousand dead oscillators. */
function cleanup(src: AudioScheduledSourceNode, nodes: AudioNode[]): void {
  src.onended = () => {
    src.disconnect();
    for (const n of nodes) n.disconnect();
  };
}

function blip(
  ctx: BaseAudioContext, d: BlipDef, dest: AudioNode,
  t: number, gain: number, rate: number,
): number {
  const osc = ctx.createOscillator();
  osc.type = d.wave ?? 'triangle';
  const f0 = d.f0 * rate;
  const f1 = (d.f1 ?? d.f0) * rate;
  sweep(osc.frequency, t, f0, f1, d.dur, d.glide === 'lin');

  const g = ctx.createGain();
  env(g.gain, t, d.atk ?? 0.004, d.dur, (d.gain ?? 0.5) * gain);

  const extra: AudioNode[] = [g];
  let node: AudioNode = g;

  if (d.lp !== undefined || d.hp !== undefined) {
    const f = ctx.createBiquadFilter();
    if (d.hp !== undefined) {
      f.type = 'highpass';
      f.frequency.setValueAtTime(d.hp * rate, t);
    } else {
      f.type = 'lowpass';
      sweep(f.frequency, t, d.lp! * rate, (d.lp1 ?? d.lp!) * rate, d.dur);
    }
    f.Q.value = d.q ?? 0.9;
    g.connect(f);
    f.connect(dest);
    extra.push(f);
    node = f;
  } else {
    g.connect(dest);
  }
  void node;

  osc.connect(g);
  osc.start(t);
  osc.stop(t + d.dur + 0.02);
  cleanup(osc, extra);

  if (d.detune) {
    const o2 = ctx.createOscillator();
    o2.type = osc.type;
    sweep(o2.frequency, t, f0, f1, d.dur, d.glide === 'lin');
    o2.detune.value = d.detune;
    o2.connect(g);
    o2.start(t);
    o2.stop(t + d.dur + 0.02);
    cleanup(o2, []);
  }
  if (d.vib) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = d.vib.hz;
    const amt = ctx.createGain();
    // Cents -> Hz at the start frequency: close enough over a short note.
    amt.gain.value = (Math.pow(SEMI, d.vib.cents / 100) - 1) * f0;
    lfo.connect(amt);
    amt.connect(osc.frequency);
    lfo.start(t);
    lfo.stop(t + d.dur + 0.02);
    cleanup(lfo, [amt]);
  }
  return d.dur;
}

/**
 * Filter make-up gain.
 *
 * Measured by rendering every id through an OfflineAudioContext: a bandpass at
 * Q~1 passes only a narrow slice of white noise and comes out ~0.25x the
 * requested amplitude, a lowpass ~0.4x, a highpass ~1x. Without this, every
 * claps-whooshes-footsteps sound in the game is three times quieter than every
 * oscillator sound, and `gain` in the table means something different depending
 * on the voice — which is exactly the kind of thing nobody notices until the
 * motion feedback is inaudible over a classroom.
 */
function noiseMakeup(type: BiquadFilterType): number {
  return type === 'bandpass' ? 3.2 : type === 'lowpass' ? 2.2 : 1;
}

function noiseVoice(
  ctx: BaseAudioContext, d: NoiseDef, dest: AudioNode,
  t: number, gain: number, rate: number, buf: AudioBuffer | null,
): number {
  if (!buf) return d.dur;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  // Start at a varied offset so two hats in a row are not bit-identical.
  const off = (t * 7.31) % Math.max(0.01, buf.duration - d.dur - 0.05);
  const f = ctx.createBiquadFilter();
  f.type = d.type ?? 'bandpass';
  sweep(f.frequency, t, d.f0 * rate, (d.f1 ?? d.f0) * rate, d.dur);
  f.Q.value = d.q ?? 1;
  const g = ctx.createGain();
  env(g.gain, t, d.atk ?? 0.002, d.dur, (d.gain ?? 0.4) * gain * noiseMakeup(f.type));
  src.connect(f);
  f.connect(g);
  g.connect(dest);
  src.start(t, Math.max(0, off), d.dur + 0.05);
  cleanup(src, [f, g]);
  return d.dur;
}

function fm(
  ctx: BaseAudioContext, d: FmDef, dest: AudioNode,
  t: number, gain: number, rate: number,
): number {
  const car = ctx.createOscillator();
  car.type = d.wave ?? 'sine';
  car.frequency.value = d.f * rate;
  const mod = ctx.createOscillator();
  mod.type = 'sine';
  mod.frequency.value = d.f * d.ratio * rate;
  const idx = ctx.createGain();
  idx.gain.setValueAtTime(d.index * rate, t);
  idx.gain.exponentialRampToValueAtTime(Math.max(0.5, (d.index1 ?? 0.5) * rate), t + d.dur);
  const g = ctx.createGain();
  env(g.gain, t, d.atk ?? 0.003, d.dur, (d.gain ?? 0.4) * gain);
  mod.connect(idx);
  idx.connect(car.frequency);
  car.connect(g);
  g.connect(dest);
  mod.start(t);
  mod.stop(t + d.dur + 0.02);
  car.start(t);
  car.stop(t + d.dur + 0.02);
  cleanup(car, [g, idx]);
  cleanup(mod, []);
  return d.dur;
}

function pluck(
  ctx: BaseAudioContext, d: PluckDef, dest: AudioNode,
  t: number, gain: number, rate: number,
): number {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  const f = d.f * rate;
  // A few cents of downward drift is what separates "plucked" from "beeped".
  osc.frequency.setValueAtTime(f * 1.012, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, f), t + Math.min(0.06, d.dur));
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  const b = d.bright ?? 2.4;
  sweep(lp.frequency, t, f * b * 2.2, Math.max(140, f * 0.9), d.dur);
  lp.Q.value = 1.1;
  const g = ctx.createGain();
  env(g.gain, t, 0.0015, d.dur, (d.gain ?? 0.4) * gain);
  osc.connect(lp);
  lp.connect(g);
  g.connect(dest);
  osc.start(t);
  osc.stop(t + d.dur + 0.02);
  cleanup(osc, [lp, g]);
  return d.dur;
}

function chord(
  ctx: BaseAudioContext, d: ChordDef, dest: AudioNode,
  t: number, gain: number, rate: number, noise: AudioBuffer | null,
): number {
  const stag = d.stagger ?? 0;
  const perNote = (d.gain ?? 0.34) / Math.max(1, Math.sqrt(d.semis.length));
  for (let i = 0; i < d.semis.length; i++) {
    voice(
      ctx,
      {
        v: 'blip',
        wave: d.wave ?? 'triangle',
        f0: st(d.root, d.semis[i]!),
        dur: d.dur,
        atk: d.atk ?? 0.008,
        gain: perNote,
        lp: 5200,
        lp1: 1800,
      },
      dest, t + stag * i, gain, rate, noise,
    );
  }
  return d.dur + stag * Math.max(0, d.semis.length - 1);
}

// ─── The table ───────────────────────────────────────────────────────────────
//
// `Record<SfxId, SynthDef>` — TypeScript refuses to compile a missing id.

const sparkleSeq: SeqDef = {
  v: 'seq',
  parts: [
    { at: 0, def: { v: 'fm', f: C6, ratio: 3.01, index: 420, dur: 0.22, gain: 0.2 } },
    { at: 0.055, def: { v: 'fm', f: E6, ratio: 3.01, index: 380, dur: 0.22, gain: 0.18 } },
    { at: 0.11, def: { v: 'fm', f: G6, ratio: 2.01, index: 300, dur: 0.26, gain: 0.17 } },
    { at: 0.17, def: { v: 'fm', f: st(C6, 24), ratio: 2.01, index: 240, dur: 0.3, gain: 0.13 } },
  ],
};

const kick: BlipDef = {
  v: 'blip', wave: 'sine', f0: 155, f1: 46, dur: 0.17, atk: 0.002, gain: 0.72, glide: 'exp',
};

export const SFX: Record<SfxId, SynthDef> = {
  // ─── UI ───────────────────────────────────────────────────────────────────
  // Short, soft, high. A UI sound that is even slightly long turns a lobby into
  // a slot machine.
  'ui.click': {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'blip', wave: 'triangle', f0: 920, f1: 760, dur: 0.055, atk: 0.001, gain: 0.3 } },
      { at: 0, def: { v: 'noise', type: 'highpass', f0: 3200, dur: 0.018, gain: 0.1 } },
    ],
  },
  'ui.hover': { v: 'blip', wave: 'sine', f0: 1240, dur: 0.03, atk: 0.003, gain: 0.08 },
  'ui.back': {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'blip', wave: 'triangle', f0: 620, dur: 0.07, gain: 0.24 } },
      { at: 0.06, def: { v: 'blip', wave: 'triangle', f0: 440, dur: 0.1, gain: 0.2 } },
    ],
  },
  'ui.confirm': {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'blip', wave: 'triangle', f0: C5, dur: 0.08, gain: 0.3 } },
      { at: 0.07, def: { v: 'blip', wave: 'triangle', f0: G5, dur: 0.16, gain: 0.3 } },
    ],
  },
  // Soft and low, never a scold. Children quit when failure sounds angry.
  'ui.deny': {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'blip', wave: 'sine', f0: 330, dur: 0.09, gain: 0.22, lp: 1200 } },
      { at: 0.07, def: { v: 'blip', wave: 'sine', f0: 262, dur: 0.14, gain: 0.2, lp: 1000 } },
    ],
  },
  // The roulette's slice-boundary tick. Tiny and dry; the slot-machine feeling
  // comes from the RATE the caller plays it at, not from the sound.
  'ui.tick': {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'noise', type: 'highpass', f0: 2600, dur: 0.016, atk: 0.0008, gain: 0.22 } },
      { at: 0, def: { v: 'blip', wave: 'triangle', f0: 1500, f1: 1150, dur: 0.02, atk: 0.0008, gain: 0.14 } },
    ],
  },

  // ─── Round structure ──────────────────────────────────────────────────────
  'count.beep': {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'blip', wave: 'triangle', f0: A5, dur: 0.14, atk: 0.004, gain: 0.34, lp: 4000, lp1: 2200 } },
      { at: 0, def: { v: 'blip', wave: 'sine', f0: st(A5, -12), dur: 0.16, gain: 0.16 } },
    ],
  },
  'count.go': {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'chord', root: C6, semis: [0, 4, 7], dur: 0.34, gain: 0.36 } },
      { at: 0, def: kick, gain: 0.78 },
      { at: 0.01, def: { v: 'noise', type: 'highpass', f0: 2400, f1: 6000, dur: 0.12, gain: 0.14 } },
    ],
  },
  'round.start': {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'noise', type: 'bandpass', f0: 300, f1: 3000, q: 0.8, dur: 0.3, atk: 0.1, gain: 0.14 } },
      { at: 0.2, def: { v: 'chord', root: C5, semis: [0, 7, 12], dur: 0.4, gain: 0.34, stagger: 0.035 } },
      { at: 0.2, def: kick },
    ],
  },
  // The payoff sounds. These get the most parts, on purpose: this is the moment
  // a child decides whether to play again.
  'round.win': {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'blip', wave: 'triangle', f0: G4, f1: C5, dur: 0.1, gain: 0.3 } },
      { at: 0, def: kick },
      { at: 0.1, def: { v: 'pluck', f: E5, dur: 0.16, gain: 0.34 } },
      { at: 0.2, def: { v: 'pluck', f: G5, dur: 0.16, gain: 0.34 } },
      { at: 0.3, def: { v: 'pluck', f: C6, dur: 0.22, gain: 0.38 } },
      { at: 0.38, def: { v: 'chord', root: C5, semis: [0, 4, 7, 12], dur: 0.8, gain: 0.4, stagger: 0.02 } },
      { at: 0.38, def: { v: 'fm', f: G6, ratio: 2.01, index: 500, dur: 0.9, gain: 0.16 } },
      { at: 0.38, def: kick },
      { at: 0.5, def: sparkleSeq, gain: 0.8 },
    ],
  },
  // Lose is a soft descending shrug, not a death knell. AGENTS.md: misses are
  // quiet. A round the child did badly in should not sound like a punishment.
  'round.lose': {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'blip', wave: 'triangle', f0: G5, dur: 0.16, gain: 0.26, lp: 2200, lp1: 900 } },
      { at: 0.14, def: { v: 'blip', wave: 'triangle', f0: E5, dur: 0.18, gain: 0.24, lp: 2000, lp1: 800 } },
      { at: 0.3, def: { v: 'chord', root: st(C5, -5), semis: [0, 3, 7], dur: 0.6, gain: 0.26, wave: 'sine' } },
    ],
  },
  // star.1/2/3 are a RISING PHRASE, so the results screen staggering them 160ms
  // apart plays a tune instead of the same noise three times.
  'star.1': {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'fm', f: A5, ratio: 2.01, index: 600, dur: 0.5, gain: 0.3 } },
      { at: 0, def: { v: 'blip', wave: 'triangle', f0: st(A5, -12), dur: 0.22, gain: 0.18 } },
    ],
  },
  'star.2': {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'fm', f: st(A5, 5), ratio: 2.01, index: 620, dur: 0.5, gain: 0.3 } },
      { at: 0, def: { v: 'chord', root: st(C5, 5), semis: [0, 4], dur: 0.3, gain: 0.2 } },
      { at: 0.02, def: { v: 'noise', type: 'highpass', f0: 4000, f1: 8000, dur: 0.1, gain: 0.08 } },
    ],
  },
  'star.3': {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'fm', f: st(A5, 12), ratio: 2.01, index: 700, dur: 0.6, gain: 0.3 } },
      { at: 0, def: { v: 'chord', root: C6, semis: [0, 4, 7], dur: 0.5, gain: 0.3, stagger: 0.018 } },
      { at: 0, def: kick, gain: 0.8 },
      { at: 0.08, def: sparkleSeq, gain: 0.9 },
    ],
  },

  // ─── Scoring ──────────────────────────────────────────────────────────────
  'hit.soft': {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'blip', wave: 'triangle', f0: 540, f1: 300, dur: 0.085, atk: 0.001, gain: 0.3 } },
      { at: 0, def: { v: 'noise', type: 'bandpass', f0: 1400, q: 1.4, dur: 0.045, gain: 0.06 } },
    ],
  },
  'hit.hard': {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'fm', f: 260, ratio: 1.41, index: 900, index1: 20, dur: 0.14, gain: 0.34 } },
      { at: 0, def: { v: 'noise', type: 'bandpass', f0: 2200, f1: 700, q: 0.9, dur: 0.1, gain: 0.1 } },
      { at: 0, def: { v: 'blip', wave: 'sine', f0: 150, f1: 70, dur: 0.12, gain: 0.3 } },
    ],
  },
  'hit.crit': {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'fm', f: 320, ratio: 1.73, index: 1400, index1: 30, dur: 0.18, gain: 0.3 } },
      { at: 0, def: { v: 'noise', type: 'bandpass', f0: 3200, f1: 800, q: 0.8, dur: 0.14, gain: 0.11 } },
      { at: 0, def: kick },
      { at: 0.04, def: { v: 'fm', f: G6, ratio: 2.01, index: 400, dur: 0.4, gain: 0.16 } },
      { at: 0.07, def: { v: 'blip', wave: 'triangle', f0: C6, f1: st(C6, 7), dur: 0.14, gain: 0.2 } },
    ],
  },
  // A rising pitch envelope on a sine IS the bubble-pop sound. No sample needed.
  pop: { v: 'blip', wave: 'sine', f0: 620, f1: 1280, dur: 0.075, atk: 0.001, gain: 0.3 },
  'pop.low': { v: 'blip', wave: 'sine', f0: 380, f1: 720, dur: 0.09, atk: 0.001, gain: 0.3 },
  'pop.high': { v: 'blip', wave: 'sine', f0: 980, f1: 1820, dur: 0.065, atk: 0.001, gain: 0.26 },
  // The base rung of playLadder(). Bright, very short, pitch-stable so twelve of
  // them in a row read as a scale and not as mush.
  'combo.up': {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'pluck', f: C6, dur: 0.12, gain: 0.34, bright: 3 } },
      { at: 0, def: { v: 'blip', wave: 'sine', f0: C5, dur: 0.07, gain: 0.12 } },
    ],
  },
  'combo.break': {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'blip', wave: 'sine', f0: 520, dur: 0.08, gain: 0.16, lp: 1400 } },
      { at: 0.065, def: { v: 'blip', wave: 'sine', f0: 390, dur: 0.12, gain: 0.14, lp: 1100 } },
    ],
  },
  // Plays once per counted point on the results screen: must be nearly
  // subliminal, or counting up to 40 is torture.
  'score.tick': { v: 'blip', wave: 'triangle', f0: 1520, dur: 0.022, atk: 0.001, gain: 0.1 },
  bonus: {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'pluck', f: G5, dur: 0.1, gain: 0.3, bright: 3 } },
      { at: 0.06, def: { v: 'pluck', f: C6, dur: 0.1, gain: 0.3, bright: 3 } },
      { at: 0.12, def: { v: 'pluck', f: E6, dur: 0.2, gain: 0.32, bright: 3.4 } },
      { at: 0.12, def: { v: 'fm', f: G6, ratio: 2.01, index: 300, dur: 0.35, gain: 0.12 } },
    ],
  },

  // ─── Failure ──────────────────────────────────────────────────────────────
  // All of these are deliberately QUIET and LOW. A miss breaks the combo; it
  // does not need to be announced.
  miss: {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'noise', type: 'lowpass', f0: 700, f1: 260, dur: 0.1, gain: 0.08 } },
      { at: 0, def: { v: 'blip', wave: 'sine', f0: 200, f1: 130, dur: 0.1, gain: 0.14 } },
    ],
  },
  buzz: { v: 'blip', wave: 'square', f0: 148, dur: 0.16, atk: 0.004, gain: 0.14, lp: 900, q: 1.2 },
  thud: {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'blip', wave: 'sine', f0: 120, f1: 52, dur: 0.16, gain: 0.44 } },
      { at: 0, def: { v: 'noise', type: 'lowpass', f0: 420, f1: 140, dur: 0.11, gain: 0.1 } },
    ],
  },
  break: {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'noise', type: 'bandpass', f0: 3600, f1: 900, q: 0.7, dur: 0.16, gain: 0.16 } },
      { at: 0.03, def: { v: 'noise', type: 'highpass', f0: 2400, dur: 0.05, gain: 0.16 } },
      { at: 0.08, def: { v: 'noise', type: 'highpass', f0: 1800, dur: 0.06, gain: 0.12 } },
      { at: 0.14, def: { v: 'noise', type: 'bandpass', f0: 1200, q: 1.4, dur: 0.09, gain: 0.07 } },
    ],
  },
  // A two-tone alternation, filtered down so it warns without frightening.
  alarm: {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'blip', wave: 'square', f0: 740, dur: 0.11, gain: 0.16, lp: 1700 } },
      { at: 0.13, def: { v: 'blip', wave: 'square', f0: 560, dur: 0.11, gain: 0.16, lp: 1500 } },
      { at: 0.26, def: { v: 'blip', wave: 'square', f0: 740, dur: 0.11, gain: 0.16, lp: 1700 } },
      { at: 0.39, def: { v: 'blip', wave: 'square', f0: 560, dur: 0.14, gain: 0.16, lp: 1500 } },
    ],
  },

  // ─── Motion feedback ──────────────────────────────────────────────────────
  swing: { v: 'noise', type: 'bandpass', f0: 420, f1: 2600, q: 1.1, dur: 0.18, atk: 0.04, gain: 0.3 },
  // A hand clap is three micro-bursts (the flam of two palms), not one.
  clap: {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'noise', type: 'bandpass', f0: 1500, q: 1.6, dur: 0.02, gain: 0.22 } },
      { at: 0.009, def: { v: 'noise', type: 'bandpass', f0: 1200, q: 1.5, dur: 0.025, gain: 0.2 } },
      { at: 0.021, def: { v: 'noise', type: 'bandpass', f0: 1000, q: 1.2, dur: 0.09, gain: 0.24 } },
    ],
  },
  jump: {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'blip', wave: 'triangle', f0: 300, f1: 820, dur: 0.17, atk: 0.004, gain: 0.3 } },
      { at: 0, def: { v: 'noise', type: 'highpass', f0: 1800, dur: 0.05, gain: 0.08 } },
    ],
  },
  land: {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'blip', wave: 'sine', f0: 170, f1: 72, dur: 0.13, gain: 0.36 } },
      { at: 0, def: { v: 'noise', type: 'lowpass', f0: 900, f1: 220, dur: 0.1, gain: 0.1 } },
    ],
  },
  step: { v: 'noise', type: 'lowpass', f0: 1100, f1: 420, dur: 0.055, gain: 0.18 },
  whoosh: { v: 'noise', type: 'bandpass', f0: 240, f1: 1900, q: 0.7, dur: 0.34, atk: 0.14, gain: 0.26 },
  splash: {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'noise', type: 'highpass', f0: 1200, f1: 4200, dur: 0.17, gain: 0.22 } },
      { at: 0.02, def: { v: 'blip', wave: 'sine', f0: 420, f1: 980, dur: 0.07, gain: 0.14 } },
      { at: 0.07, def: { v: 'blip', wave: 'sine', f0: 320, f1: 760, dur: 0.07, gain: 0.1 } },
    ],
  },
  // Icy: a falling FM shimmer with the brightness closing down.
  freeze: {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'fm', f: 1200, ratio: 3.51, index: 900, index1: 40, dur: 0.4, gain: 0.2 } },
      { at: 0, def: { v: 'blip', wave: 'sine', f0: 700, f1: 240, dur: 0.34, gain: 0.2, lp: 2600, lp1: 600 } },
    ],
  },
  unfreeze: {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'blip', wave: 'sine', f0: 260, f1: 820, dur: 0.3, gain: 0.2, lp: 700, lp1: 3400 } },
      { at: 0.08, def: { v: 'fm', f: 1400, ratio: 2.01, index: 400, dur: 0.3, gain: 0.14 } },
    ],
  },

  // ─── Musical / rhythm ─────────────────────────────────────────────────────
  // beat.lo / beat.hi are the metronome pair. Dry and short so they sit UNDER
  // the player's own movement sounds instead of competing with them.
  'beat.lo': { v: 'blip', wave: 'sine', f0: 130, f1: 110, dur: 0.1, atk: 0.002, gain: 0.3 },
  'beat.hi': { v: 'blip', wave: 'sine', f0: 560, dur: 0.07, atk: 0.002, gain: 0.22 },
  'note.c': { v: 'pluck', f: C5, dur: 0.3, gain: 0.34 },
  'note.d': { v: 'pluck', f: D5, dur: 0.3, gain: 0.34 },
  'note.e': { v: 'pluck', f: E5, dur: 0.3, gain: 0.34 },
  'note.f': { v: 'pluck', f: F5, dur: 0.3, gain: 0.34 },
  'note.g': { v: 'pluck', f: G5, dur: 0.3, gain: 0.34 },
  'note.a': { v: 'pluck', f: A5, dur: 0.3, gain: 0.34 },
  'note.b': { v: 'pluck', f: B5, dur: 0.3, gain: 0.34 },
  'drum.kick': kick,
  'drum.snare': {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'noise', type: 'bandpass', f0: 1900, q: 0.7, dur: 0.11, gain: 0.16 } },
      { at: 0, def: { v: 'blip', wave: 'triangle', f0: 200, f1: 150, dur: 0.08, gain: 0.26 } },
    ],
  },
  'drum.hat': { v: 'noise', type: 'highpass', f0: 7200, dur: 0.035, gain: 0.16 },
  chime: { v: 'fm', f: A5, ratio: 2.01, index: 700, dur: 0.9, gain: 0.26 },
  // The big one. A bugle call (G-G-C) into a stacked triad with a bell on top
  // and a kick underneath. Spend the voices here: this is the sound a child
  // remembers.
  fanfare: {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'blip', wave: 'triangle', f0: G4, dur: 0.1, atk: 0.004, gain: 0.32, lp: 4200, lp1: 2000 } },
      { at: 0, def: kick, gain: 0.8 },
      { at: 0.13, def: { v: 'blip', wave: 'triangle', f0: G4, dur: 0.09, atk: 0.004, gain: 0.3, lp: 4200, lp1: 2000 } },
      { at: 0.25, def: { v: 'blip', wave: 'triangle', f0: C5, dur: 0.14, atk: 0.004, gain: 0.34, lp: 4600, lp1: 2200 } },
      { at: 0.25, def: { v: 'noise', type: 'highpass', f0: 7200, dur: 0.035, gain: 0.12 } },
      { at: 0.42, def: { v: 'chord', root: C5, semis: [0, 4, 7, 12, 16], dur: 0.95, gain: 0.42, stagger: 0.022 } },
      { at: 0.42, def: kick },
      { at: 0.42, def: { v: 'fm', f: C6, ratio: 2.01, index: 620, dur: 1.0, gain: 0.18 } },
      { at: 0.56, def: sparkleSeq, gain: 0.85 },
      { at: 0.95, def: { v: 'noise', type: 'highpass', f0: 5200, f1: 9000, dur: 0.3, atk: 0.02, gain: 0.07 } },
    ],
  },

  // ─── Flavour ──────────────────────────────────────────────────────────────
  // Heavy vibrato on a rising-then-falling sine: the cartoon boing.
  boing: {
    v: 'blip',
    wave: 'sine',
    f0: 180, f1: 520, dur: 0.3, atk: 0.006, gain: 0.3,
    vib: { hz: 17, cents: 320 },
  },
  zap: {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'blip', wave: 'square', f0: 1900, f1: 190, dur: 0.11, atk: 0.001, gain: 0.2, lp: 4200, lp1: 900 } },
      { at: 0, def: { v: 'noise', type: 'bandpass', f0: 3000, f1: 600, q: 1.8, dur: 0.1, gain: 0.07 } },
    ],
  },
  sparkle: sparkleSeq,
  wobble: {
    v: 'blip',
    wave: 'sine',
    f0: 420, dur: 0.45, atk: 0.02, gain: 0.22,
    vib: { hz: 7.5, cents: 420 },
  },
  // 0.9s rising sweep with the filter opening — the "hold this pose" charge-up.
  charge: {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'blip', wave: 'sawtooth', f0: 150, f1: 880, dur: 0.9, atk: 0.12, gain: 0.16, lp: 500, lp1: 4200, glide: 'lin' } },
      { at: 0, def: { v: 'blip', wave: 'sine', f0: 300, f1: 1760, dur: 0.9, atk: 0.2, gain: 0.1, glide: 'lin' } },
    ],
  },
  release: {
    v: 'seq',
    parts: [
      { at: 0, def: { v: 'blip', wave: 'triangle', f0: 1200, f1: 300, dur: 0.16, atk: 0.001, gain: 0.26 } },
      { at: 0, def: { v: 'noise', type: 'bandpass', f0: 2600, f1: 500, q: 0.8, dur: 0.18, gain: 0.09 } },
      { at: 0, def: kick, gain: 0.6 },
    ],
  },
};

// ─── The combo ladder ────────────────────────────────────────────────────────

/** Semitones added per consecutive `playLadder` call. */
export const LADDER_STEP = 1;
/**
 * Ceiling, in semitones.
 *
 * One octave. Past that a 1.5kHz pluck becomes a 3kHz ice pick, and a child on
 * a 40-combo would be rewarded with pain. The ladder stops rising and the
 * reward carries on through the (capped) gain bump instead.
 */
export const LADDER_CAP = 12;

/** Pitch multiplier for ladder index `i` (0-based). */
export function ladderRate(i: number): number {
  if (!Number.isFinite(i)) return 1;
  const n = Math.min(LADDER_CAP, Math.max(0, Math.floor(i)) * LADDER_STEP);
  return Math.pow(SEMI, n);
}

/** Gain multiplier for ladder index `i`. Capped, so a long combo gets brighter
 *  rather than louder and louder. */
export function ladderGain(i: number): number {
  if (!Number.isFinite(i)) return 1;
  return 1 + Math.min(0.18, Math.max(0, i) * 0.02);
}

/** Ids whose pitch is musically meaningful: these must never get the random
 *  detune that keeps repeated sfx from sounding machine-gunned. */
export const MUSICAL_IDS: ReadonlySet<string> = new Set<string>([
  'note.c', 'note.d', 'note.e', 'note.f', 'note.g', 'note.a', 'note.b',
  'beat.lo', 'beat.hi', 'drum.kick', 'drum.snare', 'drum.hat',
  'chime', 'fanfare', 'star.1', 'star.2', 'star.3', 'round.win', 'count.go',
]);

// AudioContext lifecycle, the bus graph, and mute.
//
// Three browser realities shape this file:
//
//  1. Autoplay policy. An AudioContext constructed before a user gesture starts
//     `suspended`, and on some Safari builds constructing one at page load
//     burns the gesture allowance entirely. So the context is created LAZILY on
//     the first real gesture (or the first `play()` that follows one) — never
//     at import time, never in a module initialiser.
//  2. Tab switching. A context gets suspended when the tab is hidden and does
//     not always resume itself. A child alt-tabs to show their sibling and
//     comes back to a silent game, which reads as "the sound broke".
//     `visibilitychange` resumes it.
//  3. Node. The whole engine has to import cleanly under
//     `environment: 'node'`, where there is no AudioContext at all. Every
//     method here degrades to a no-op instead of throwing, so headless tests
//     exercise the real service rather than a mock of it.
//
// The bus graph is deliberately tiny:
//     sfx ─┐
//   music ─┼─> master ─> destination
//   voice ─┘
// Music ducks under voice; master carries mute and the volume slider.

type Ctor = new (o?: AudioContextOptions) => AudioContext;

function audioCtor(): Ctor | null {
  const g = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/** Fallback clock for when there is no AudioContext (node, or audio blocked).
 *  Good enough to keep a BeatScheduler's maths working; never used for actual
 *  sample scheduling, because there are no samples to schedule. */
function wallSeconds(): number {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p ? p.now() / 1000 : Date.now() / 1000;
}

export interface AudioEngineOpts {
  /** Master gain. 0.85 leaves headroom for a star fanfare stacking six voices. */
  masterGain?: number;
  sfxGain?: number;
  musicGain?: number;
  voiceGain?: number;
  /** Start muted (the settings screen remembers this). */
  muted?: boolean;
  /** Don't install the gesture/visibility listeners (tests, SSR). */
  autoUnlock?: boolean;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  sfx: GainNode | null = null;
  music: GainNode | null = null;
  voice: GainNode | null = null;

  private _muted: boolean;
  private readonly gains: Required<Pick<AudioEngineOpts, 'masterGain' | 'sfxGain' | 'musicGain' | 'voiceGain'>>;
  private noiseBuf: AudioBuffer | null = null;
  private teardown: Array<() => void> = [];
  private startedWall = wallSeconds();
  private failed = false;

  constructor(o?: AudioEngineOpts) {
    this._muted = o?.muted ?? false;
    this.gains = {
      masterGain: o?.masterGain ?? 0.85,
      sfxGain: o?.sfxGain ?? 1,
      musicGain: o?.musicGain ?? 0.5,
      voiceGain: o?.voiceGain ?? 1,
    };
    if (o?.autoUnlock !== false) this.installAutoUnlock();
  }

  /** True when this browser has Web Audio at all. */
  get available(): boolean {
    return audioCtor() !== null && !this.failed;
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /**
   * Create the context if it does not exist yet, and return it.
   *
   * Safe to call on every `play()`: after the first success it is a field read.
   * Returns null in node, or if construction throws (some locked-down kiosk
   * builds), and then stays null — we do not retry forever.
   */
  ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (this.failed) return null;
    const Ctor = audioCtor();
    if (!Ctor) {
      this.failed = true;
      return null;
    }
    try {
      const ctx = new Ctor({ latencyHint: 'interactive' });
      const master = ctx.createGain();
      master.gain.value = this._muted ? 0 : this.gains.masterGain;
      master.connect(ctx.destination);
      const mk = (v: number): GainNode => {
        const g = ctx.createGain();
        g.gain.value = v;
        g.connect(master);
        return g;
      };
      this.sfx = mk(this.gains.sfxGain);
      this.music = mk(this.gains.musicGain);
      this.voice = mk(this.gains.voiceGain);
      this.master = master;
      this.ctx = ctx;
      return ctx;
    } catch {
      this.failed = true;
      return null;
    }
  }

  /** Call from a real user gesture. Idempotent. */
  unlock(): void {
    const ctx = this.ensure();
    if (!ctx) return;
    if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
  }

  /** Audio-clock seconds. Falls back to the wall clock so musical maths still
   *  works with no context — see the note on `wallSeconds`. */
  get now(): number {
    return this.ctx ? this.ctx.currentTime : wallSeconds() - this.startedWall;
  }

  /** Device output latency in seconds, when the browser reports it. Chrome
   *  gives `outputLatency`; Safari only `baseLatency`; Firefox neither. */
  get outputLatencySec(): number {
    const c = this.ctx as (AudioContext & { outputLatency?: number }) | null;
    if (!c) return 0;
    const o = typeof c.outputLatency === 'number' ? c.outputLatency : 0;
    if (o > 0) return o;
    return typeof c.baseLatency === 'number' ? c.baseLatency : 0;
  }

  get muted(): boolean {
    return this._muted;
  }

  setMuted(m: boolean): void {
    this._muted = m;
    const g = this.master?.gain;
    if (!g || !this.ctx) return;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    // A ramp, not a jump: an instant gain change on a live voice clicks.
    g.setTargetAtTime(m ? 0.0001 : this.gains.masterGain, t, 0.015);
  }

  setMasterGain(v: number): void {
    this.gains.masterGain = Math.max(0, Math.min(1, v));
    const g = this.master?.gain;
    if (!g || !this.ctx || this._muted) return;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(this.gains.masterGain, t, 0.02);
  }

  /** Dip the music bed while a Korean voice line plays, then bring it back. */
  duckForVoice(ms = 900): void {
    const ctx = this.ctx;
    const g = this.music?.gain;
    if (!ctx || !g) return;
    const t = ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(this.gains.musicGain * 0.25, t, 0.05);
    g.setTargetAtTime(this.gains.musicGain, t + ms / 1000, 0.12);
  }

  /**
   * One second of mono white noise, shared by every noise voice.
   *
   * Every percussive non-pitched sound in the game (hats, snares, claps,
   * whooshes, splashes, impacts) is this buffer through a different filter. One
   * 48KB allocation for the whole project's "sample library".
   */
  noise(): AudioBuffer | null {
    if (this.noiseBuf) return this.noiseBuf;
    const ctx = this.ensure();
    if (!ctx) return null;
    const n = Math.floor(ctx.sampleRate);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Deterministic noise: the same buffer every run, so an audio regression is
    // reproducible rather than "sounds a bit different today".
    let s = 0x1234567;
    for (let i = 0; i < n; i++) {
      s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
      d[i] = (s / 0x3fffffff) - 1;
    }
    this.noiseBuf = buf;
    return buf;
  }

  private installAutoUnlock(): void {
    const d = (globalThis as { document?: Document }).document;
    if (!d) return;
    const once = (): void => this.unlock();
    const evs: Array<keyof DocumentEventMap> = ['pointerdown', 'keydown', 'touchend'];
    for (const e of evs) {
      d.addEventListener(e, once, { capture: true, passive: true });
      this.teardown.push(() => d.removeEventListener(e, once, { capture: true }));
    }
    const vis = (): void => {
      if (d.visibilityState === 'visible') {
        if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined);
      }
    };
    d.addEventListener('visibilitychange', vis);
    this.teardown.push(() => d.removeEventListener('visibilitychange', vis));
  }

  dispose(): void {
    for (const t of this.teardown) t();
    this.teardown = [];
    const ctx = this.ctx;
    this.ctx = null;
    this.master = this.sfx = this.music = this.voice = null;
    this.noiseBuf = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }
}

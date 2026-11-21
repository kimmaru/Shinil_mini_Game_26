// Headless doubles for the side-effect services.
//
// A headless round needs the engine's BEHAVIOUR (gestures, scoring, the fixed
// clock) but not its OUTPUT. These stand in for audio/hud/fx the way
// NullRenderer stands in for drawing: they record calls so a test can assert on
// them, and they never touch the DOM or Web Audio, both of which are absent
// under `environment: 'node'`.
import type { AudioService, HudService, SfxId, Slot } from '../types';
import type { BeatScheduler, PlayOpts } from '../audio/index';
import type { FxRuntime } from '../fx/service';
import type { Renderer } from '../render/renderer';

export interface CallLog {
  /** Call counts keyed by `service.method`. */
  counts: Record<string, number>;
  /** Sounds played, in order. */
  sfx: SfxId[];
  /** HUD announcements, for checking a game actually tells the player things. */
  announced: string[];
  lastScore: number;
  lastCombo: number;
}

const bump = (log: CallLog, k: string): void => {
  log.counts[k] = (log.counts[k] ?? 0) + 1;
};

export function createCallLog(): CallLog {
  return { counts: {}, sfx: [], announced: [], lastScore: 0, lastCombo: 0 };
}

/** A beat scheduler on a plain numeric clock the caller advances. */
export function stubBeats(bpm: number, now: () => number): BeatScheduler {
  const spb = 60 / bpm;
  let last = -1;
  return {
    bpm,
    get beat() { return now() / spb; },
    timeOfBeat: (n: number) => n * spb,
    judge(inputTimeMs: number) {
      const b = inputTimeMs / 1000 / spb;
      const nearest = Math.round(b);
      const deltaMs = (b - nearest) * spb * 1000;
      const a = Math.abs(deltaMs);
      const grade = a <= 60 ? 'perfect' : a <= 120 ? 'good' : a <= 200 ? 'ok' : 'miss';
      return { grade, deltaMs, beat: nearest };
    },
    tick() {
      const b = Math.floor(now() / spb);
      if (b === last) return false;
      last = b;
      return true;
    },
    stop() {},
  };
}

export function stubAudio(log: CallLog, now: () => number): AudioService {
  return {
    get now() { return now(); },
    latencyMs: 0,
    muted: true,
    play(id: SfxId, _o?: PlayOpts) { bump(log, 'audio.play'); log.sfx.push(id); },
    playLadder(id: SfxId, _i: number, _o?: PlayOpts) { bump(log, 'audio.playLadder'); log.sfx.push(id); },
    music() { bump(log, 'audio.music'); },
    stopMusic() { bump(log, 'audio.stopMusic'); },
    beat: (bpm: number) => stubBeats(bpm, now),
    speak(textKo: string) { bump(log, 'audio.speak'); log.announced.push(textKo); },
  };
}

export function stubHud(log: CallLog): HudService {
  return {
    setGoal(t: string) { bump(log, 'hud.setGoal'); log.announced.push(t); },
    setScore(n: number, _s?: Slot) { bump(log, 'hud.setScore'); log.lastScore = n; },
    setCombo(n: number, _s?: Slot) { bump(log, 'hud.setCombo'); log.lastCombo = n; },
    setBar() { bump(log, 'hud.setBar'); },
    clearBar() { bump(log, 'hud.clearBar'); },
    toast(t: string) { bump(log, 'hud.toast'); log.announced.push(t); },
    announce(t: string) { bump(log, 'hud.announce'); log.announced.push(t); },
    beatRing() { bump(log, 'hud.beatRing'); },
    setLives() { bump(log, 'hud.setLives'); },
    setTime() { bump(log, 'hud.setTime'); },
  };
}

/**
 * Effects that record but draw nothing.
 *
 * `hitstop` is honoured for real so a game that calls it every frame is caught
 * by the harness as a frozen round rather than shipping.
 */
export function stubFx(log: CallLog): FxRuntime {
  let hitstop = 0;
  const squashes = new Map<string, number>();
  return {
    burst() { bump(log, 'fx.burst'); },
    confetti() { bump(log, 'fx.confetti'); },
    shake() { bump(log, 'fx.shake'); },
    flash() { bump(log, 'fx.flash'); },
    pop() { bump(log, 'fx.pop'); },
    trail() { bump(log, 'fx.trail'); },
    hitstop(sec: number) { bump(log, 'fx.hitstop'); hitstop = Math.max(hitstop, sec); },
    squash(key: string, amount = 1) { bump(log, 'fx.squash'); squashes.set(key, amount); },
    squashAt: (key: string) => squashes.get(key) ?? 0,
    popText() { bump(log, 'fx.popText'); },
    impact(_x: number, _y: number, level: string) { bump(log, 'fx.impact'); bump(log, `fx.impact.${level}`); },
    miss() { bump(log, 'fx.miss'); },
    telegraph() { bump(log, 'fx.telegraph'); },
    configureForGame() {},
    slotColor: () => '#2FA8FF',
    reducedMotion: false,
    update(dt: number) { if (hitstop > 0) hitstop = Math.max(0, hitstop - dt); },
    applyCamera(_g: Renderer) {},
    draw(_g: Renderer) {},
    get timeScale() { return hitstop > 0 ? 0 : 1; },
    get hitstopRemaining() { return hitstop; },
    setView() {},
    setReducedMotion() {},
    setFlashEnabled() {},
    resetAll() { hitstop = 0; squashes.clear(); },
    stats: { particles: 0, peakParticles: 0, glowOverflow: 0, drops: 0 },
  } as unknown as FxRuntime;
}

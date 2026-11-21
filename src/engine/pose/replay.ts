// ReplayPoseSource — synthetic clips through the real pipeline, in Node.
//
// Zero DOM: no document, no window, no canvas, no camera. This is what lets 58
// games be verified before anyone plugs in a webcam, and it is only worth
// anything because it runs the SAME code as the camera path: normalize ->
// median -> One Euro -> extrapolate -> identity. A replay source that
// shortcut any of those would pass tests the camera then fails.
//
// `sample(t)` is the only clock. Clip frames are consumed up to `t` at their
// own timestamps, so the filters see the clip's real (and deliberately
// uneven — see BuildOpts.frameDrop) frame intervals.
import type { CalibrationProfile, PoseFrame } from '../types';
import type { PoseClip } from '../testing/synth';
import { CalibrationCapture } from './calibration';
import { MAX_EXTRAPOLATE_SEC } from './frame';
import { PoseIdentity } from './identity';
import type { OneEuroConfig } from './oneEuro';
import { defaultCalibration, type PoseSource, type PoseSourceInfo } from './source';

export interface ReplayOpts {
  view?: { w: number; h: number };
  /** Re-run the clip from the start when it ends. Default true: a 12s clip has
   *  to fill a 40s round. */
  loop?: boolean;
  maxPlayers?: 1 | 2 | 3 | 4;
  filter?: OneEuroConfig;
  calib?: CalibrationProfile;
  /** Default 0.45s, same as the camera. Set 0 in a test that wants a player on
   *  frame 1 — but then you are not testing what ships. */
  probationSec?: number;
  requireUpright?: boolean;
}

export class ReplayPoseSource implements PoseSource {
  readonly info: PoseSourceInfo;
  private clip: PoseClip;
  private identity: PoseIdentity;
  private calib: CalibrationProfile;
  private loop: boolean;
  private viewW: number;
  private viewH: number;
  private idx = 0;
  private base = 0;
  private lastFed = -1;
  private duration: number;
  private paused = false;

  constructor(clip: PoseClip, opts: ReplayOpts = {}) {
    this.clip = clip;
    this.loop = opts.loop ?? true;
    this.viewW = opts.view?.w ?? 1280;
    this.viewH = opts.view?.h ?? 720;
    this.calib = opts.calib ?? defaultCalibration(this.viewW, this.viewH);
    const frames = clip.frames;
    const last = frames.length ? frames[frames.length - 1]!.t : 0;
    this.duration = last + 1 / Math.max(1, clip.fps);
    this.identity = new PoseIdentity({
      maxPlayers: opts.maxPlayers ?? 2,
      calib: this.calib,
      filter: opts.filter,
      probationSec: opts.probationSec,
      requireUpright: opts.requireUpright,
    });
    this.info = { kind: 'replay', fps: clip.fps, tier: `replay:${clip.name}` };
  }

  get view(): { w: number; h: number } {
    return { w: this.viewW, h: this.viewH };
  }

  setView(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
  }

  start(): Promise<void> {
    // Prime with the clip's first frame so a first PoseFrame really is
    // available when this resolves.
    this.feedUpTo(0);
    return Promise.resolve();
  }

  stop(): void {
    this.identity.reset();
    this.idx = 0;
    this.base = 0;
    this.lastFed = -1;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    // Re-anchor rather than snap: the clip kept running while the round did
    // not, exactly as a camera would have.
    this.paused = false;
    this.identity.teleport();
  }

  sample(tSec: number): PoseFrame {
    if (!this.paused) this.feedUpTo(tSec);
    // Paused means paused: extrapolating from a clock that is still running
    // would drift the body across the screen behind the pause menu.
    const age =
      this.paused || this.lastFed < 0
        ? 0
        : Math.min(MAX_EXTRAPOLATE_SEC, Math.max(0, tSec - this.lastFed));
    return this.identity.project(tSec, age, this.clip.fps, this.viewW, this.viewH);
  }

  setCalibration(c: CalibrationProfile): void {
    this.calib = c;
    this.identity.setCalibration(c);
  }

  /**
   * Deterministic calibration: consume the next `ms` of clip at clip rate.
   *
   * Synchronous in effect (the promise is already resolved) because there is no
   * real clock to wait for — a test that awaited a 4-second timer 58 times
   * would take four minutes.
   */
  calibrate(ms: number): Promise<CalibrationProfile> {
    const cap = new CalibrationCapture({ ms, mirrored: this.calib.mirrored });
    const step = 1 / Math.max(1, this.clip.fps);
    const t0 = this.lastFed >= 0 ? this.lastFed : 0;
    let t = t0;
    const limit = ms / 1000 + 3;
    while (!cap.done && t - t0 < limit) {
      t += step;
      this.feedUpTo(t);
      const f = this.identity.project(t, 0, this.clip.fps, this.viewW, this.viewH);
      const p = f.p1;
      if (p && p.present) cap.feed(p, t, this.viewH);
    }
    if (!cap.usable) {
      return Promise.reject(
        new Error(`[replay] clip "${this.clip.name}" never showed a usable body (${cap.samples} frames)`),
      );
    }
    const profile = cap.finish(t * 1000);
    this.setCalibration(profile);
    return Promise.resolve(profile);
  }

  /** Loop count so far, for tests that care about the seam. */
  get loops(): number {
    return this.duration > 0 ? Math.round(this.base / this.duration) : 0;
  }

  get trackStates(): PoseIdentity['trackStates'] {
    return this.identity.trackStates;
  }

  private feedUpTo(tSec: number): void {
    const frames = this.clip.frames;
    if (frames.length === 0) return;
    let guard = 0;
    while (guard++ < 20_000) {
      if (this.idx >= frames.length) {
        if (!this.loop) return;
        this.idx = 0;
        this.base += this.duration;
        // Same bodies, teleported back to the clip's first pose. Keep slots,
        // ids and scores; drop positional history and the filter state, or the
        // seam fires every velocity-triggered detector in the catalogue and
        // the round scores a phantom jump at second 12.
        this.identity.teleport();
        continue;
      }
      const fr = frames[this.idx]!;
      const ft = this.base + fr.t;
      if (ft > tSec) return;
      this.identity.update(fr.people, ft, this.viewW, this.viewH);
      this.lastFed = ft;
      this.idx++;
    }
  }
}

/** Convenience for the replay harness and for tests. */
export function replaySource(clip: PoseClip, opts?: ReplayOpts): ReplayPoseSource {
  return new ReplayPoseSource(clip, opts);
}

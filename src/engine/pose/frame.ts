// Shared PoseFrame / PlayerPose construction and pooling.
//
// Every PoseSource hands games the SAME objects frame after frame — the arrays,
// the box, the Map and the players array are all allocated here, once, and then
// mutated in place. Games are told not to retain references across frames
// (gestures/index.ts says the same about signals), and `sample()` is called 60
// times a second, so anything allocated per frame is garbage by design.
import type { CalibrationProfile, PlayerId, PlayerPose, PoseFrame, Slot } from '../types';
import { LANDMARK_COUNT } from './landmarks';
import { defaultCalibration, type PoseSource, type PoseSourceInfo } from './source';

/** The writable view of a PoseFrame, for the engine side of the seam. */
export interface MutablePoseFrame extends PoseFrame {
  t: number;
  inferenceAgeMs: number;
  fps: number;
  players: PlayerPose[];
  byId: Map<PlayerId, PlayerPose>;
  p1: PlayerPose | undefined;
}

export function createPlayerPose(
  id: PlayerId,
  slot: Slot,
  calib: CalibrationProfile = defaultCalibration(),
): PlayerPose {
  return {
    id,
    slot,
    present: false,
    conf: 0,
    n: new Float32Array(LANDMARK_COUNT * 2),
    v: new Float32Array(LANDMARK_COUNT * 2),
    px: new Float32Array(LANDMARK_COUNT * 2),
    vis: new Float32Array(LANDMARK_COUNT),
    box: { x: 0, y: 0, w: 0, h: 0 },
    rollDeg: 0,
    scalePx: calib.shoulderW,
    calib,
  };
}

export function createPoseFrame(): MutablePoseFrame {
  return {
    t: 0,
    inferenceAgeMs: 0,
    fps: 0,
    players: [],
    byId: new Map<PlayerId, PlayerPose>(),
    p1: undefined,
  };
}

/** Cap on how far ahead of the last inference we are willing to extrapolate.
 *  Uncapped extrapolation overshoots badly the moment a frame is dropped, and
 *  a dropped frame is the normal case on a school Chromebook. */
export const MAX_EXTRAPOLATE_SEC = 0.06;

/** Exponentially smoothed inference rate, for the debug overlay and the
 *  quality ladder. Raw 1/dt reads as 11-47fps on a steady 25Hz stream. */
export class FpsMeter {
  /** Smoothed INTERVAL, seconds. Averaging 1/dt instead reads high whenever
   *  the gaps are uneven (33, 33, 66 ms is 25 Hz, but averages to 27). */
  private emaDt = 0;

  get fps(): number {
    return this.emaDt > 0 ? 1 / this.emaDt : 0;
  }

  /** `dt` is the interval between two consecutive inferences, in seconds. */
  sample(dt: number): void {
    if (!(dt > 1e-4) || dt > 2) return;
    this.emaDt = this.emaDt === 0 ? dt : this.emaDt + 0.15 * (dt - this.emaDt);
  }

  reset(): void {
    this.emaDt = 0;
  }
}

/**
 * Nobody present. Used while the camera is being granted, after a permission
 * denial, and by the attract screen before anyone steps up.
 *
 * Games already handle `p1 === undefined` (they must — a player can walk out of
 * frame mid-round), so this needs no special case anywhere.
 */
export function nullPoseSource(calib?: CalibrationProfile): PoseSource {
  const frame = createPoseFrame();
  let profile = calib ?? defaultCalibration();
  const info: PoseSourceInfo = { kind: 'null', fps: 0, tier: 'none' };
  return {
    info,
    sample(tSec: number): PoseFrame {
      frame.t = tSec;
      frame.inferenceAgeMs = 0;
      frame.fps = 0;
      frame.players.length = 0;
      frame.p1 = undefined;
      return frame;
    },
    start: () => Promise.resolve(),
    stop: () => {},
    calibrate: () => Promise.resolve(profile),
    setCalibration: (c: CalibrationProfile) => {
      profile = c;
    },
    pause: () => {},
    resume: () => {},
  };
}

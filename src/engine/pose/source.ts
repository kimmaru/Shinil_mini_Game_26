// ══ FROZEN CONTRACT ══ the seam that makes everything else testable.
//
// Four implementations, one interface:
//   MediaPipePoseSource  real camera
//   VirtualPoseSource    keyboard / mouse / gamepad  -> a11y.keyboardFallback
//   ReplayPoseSource     synthetic clips             -> headless tests
//   NullPoseSource       nobody present
//
// Games NEVER branch on input source. That single rule is what makes keyboard
// fallback free for ~55 games and lets the whole catalogue be verified in Node.
import type { CalibrationProfile, PoseFrame } from '../types';

export interface PoseSourceInfo {
  kind: 'camera' | 'virtual' | 'replay' | 'null';
  /** Inference fps, smoothed. */
  fps: number;
  /** Model/quality tier currently in use, for the debug overlay. */
  tier: string;
  /** Human-readable problem, shown as a gentle toast. Never fail silently:
   *  "the game stopped responding" is the worst possible failure mode. */
  warning?: string;
}

export interface PoseSource {
  readonly info: PoseSourceInfo;

  /**
   * The frame for logical time `tSec`.
   *
   * Inference runs at ~25Hz while the game steps at 60Hz, so this
   * EXTRAPOLATES from the last inference using filtered velocity and reports
   * how stale it is in `inferenceAgeMs`. Decoupling these two rates is the
   * highest-value decision in the engine: 12fps inference still feels fine if
   * the game itself is smooth.
   *
   * Must be cheap and allocation-free — it is called every fixed step.
   */
  sample(tSec: number): PoseFrame;

  /** Begin producing frames. Resolves once a first frame is available. */
  start(): Promise<void>;
  stop(): void;

  /** Collect a calibration profile over `ms`. Resolves with the median-based
   *  profile; rejects if the body is never adequately visible. */
  calibrate(ms: number): Promise<CalibrationProfile>;
  /** Override the profile (restored from localStorage, or a test default). */
  setCalibration(c: CalibrationProfile): void;

  /** Stop consuming frames while a round is paused. */
  pause(): void;
  resume(): void;
}

/** A standing-adult default, used when calibration is skipped (keyboard mode,
 *  tests, `?skip=calib`). Every value is in the units documented on
 *  CalibrationProfile. */
export function defaultCalibration(viewW = 1280, viewH = 720): CalibrationProfile {
  return {
    shoulderW: viewW * 0.17,
    armSpan: 2.1,
    armLen: 1.6,
    standHipY: 0.62,
    squatHipY: 0.74,
    reachUpY: 0.18,
    floorY: 0.98,
    idleEnergy: 0.35,
    lowerBodyVisible: true,
    mirrored: true,
    capturedAt: 0,
  };
}

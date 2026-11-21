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

/**
 * The profile used when calibration is skipped — keyboard mode, tests,
 * `?skip=calib`. Every value is in the units documented on CalibrationProfile,
 * and every number here is measured off the synthetic corpus rather than
 * guessed, because a wrong default silently mis-sizes every game's targets.
 */
export function defaultCalibration(viewW = 1280, viewH = 720): CalibrationProfile {
  return {
    // A whole body only fits a 16:9 frame below ~0.13 of the width; 0.17 would
    // put the ankles outside the image.
    shoulderW: viewW * 0.105,
    // Wrist to wrist with arms out is 2*armLen + 1 shoulder width, ~4.3 in
    // anthropometry. (This read 2.1, which is barely wider than the shoulders.)
    armSpan: 4.3,
    armLen: 1.6,
    standHipY: 0.52,
    squatHipY: 0.64,
    reachUpY: 0.12,
    floorY: 0.93,
    // Mean per-joint motion while standing still, SW/sec. Measured at ~0.13 on
    // the idle clip. Freeze games threshold against a multiple of the player's
    // OWN value, because children cannot hold still and a global constant
    // fails them.
    idleEnergy: 0.15,
    lowerBodyVisible: true,
    mirrored: true,
    capturedAt: 0,
  };
}

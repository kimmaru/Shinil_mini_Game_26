// "한 걸음 앞으로 / 뒤로" — the distance hint, shared by attract and the
// countdown. The signal is the engine's (AutoCalibrator.tooFar / tooClose,
// both false when nobody is there); the wording is the shell's.
//
// "One step" is literal. On a laptop's 720p camera a child's shoulders are
// ~20% of the width at 1.2m — the intended head-to-waist framing, which sets
// off neither hint. "Back" fires only once their own arm span no longer fits
// across the view (inside ~1m) and clears by ~1.1m; "forward" only past ~4m.
import type { AutoCalibrator } from '@/engine/pose/calibration';

export type Distance = 'far' | 'close' | null;

export const distanceOf = (c: AutoCalibrator | null | undefined): Distance =>
  c?.tooFar ? 'far' : c?.tooClose ? 'close' : null;

export const DISTANCE_KO: Record<Exclude<Distance, null>, string> = {
  far: '한 걸음 앞으로 와 볼까요?',
  close: '한 걸음 뒤로 가 볼까요?',
};

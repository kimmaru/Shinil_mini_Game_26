// Session phases and the camera-lifecycle predicates.
//
// The React shell owns the reducer (`src/shell/useSession.ts`); this file owns
// the PHASE VOCABULARY and the questions the engine needs answered about a
// phase — chiefly "should the camera be running right now?", which is the
// property the 개인정보 안내 page's promises actually rest on.
//
// Keeping the type here rather than in the shell means the engine can answer
// those questions without importing React.

/** The flow in docs/PLAN.md § 쉘 흐름, in order. */
export type Phase =
  | 'boot'
  | 'priming'        // privacy copy; model prefetch runs behind the reading
  | 'prePrompt'      // ~1.2s warning before the browser's permission dialog
  | 'cameraRequest'
  | 'cameraHelp'     // distinct copy per failure; always a keyboard route out
  | 'warmup'         // the lazy shader compile that must not land mid-round
  | 'calibration'
  | 'safety'         // 2m of space; shown once, before the first standing game
  | 'attract'        // "점프하면 시작!"
  | 'roulette'
  | 'intro'
  | 'countdown'
  | 'play'
  | 'paused'
  | 'results'
  | 'breakPrompt'
  | 'partySummary';

/** 설정 / 개인정보 안내 open from anywhere and return to where they were
 *  opened, so they are overlays rather than phases. */
export type Overlay = 'none' | 'settings' | 'privacy';

export type InputMode = 'camera' | 'keyboard';

export type CameraErrorKind = 'denied' | 'notFound' | 'inUse' | 'insecure' | 'unknown';

export type PauseReason = 'hidden' | 'user' | 'trackingLost' | 'cameraLost';

/** Phases that consume pose frames. */
const POSE_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'calibration', 'attract', 'intro', 'countdown', 'play',
]);

/** Phases that show the live skeleton. `attract` is deliberately included:
 *  showing a parent exactly what the camera extracts — joints, not a face — is
 *  what makes the privacy copy credible rather than merely present. */
const SKELETON_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'calibration', 'attract', 'intro', 'play',
]);

/** Phases where the camera track may stay open. Everything else must call
 *  `track.stop()`, which is what drops the browser's recording indicator and
 *  makes "녹화하지 않아요" true in a way a parent can verify. */
const CAMERA_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'warmup', 'calibration', 'attract', 'roulette', 'intro', 'countdown', 'play', 'results',
]);

export const needsPose = (p: Phase): boolean => POSE_PHASES.has(p);
export const showsSkeleton = (p: Phase): boolean => SKELETON_PHASES.has(p);
export const cameraShouldRun = (p: Phase, mode: InputMode): boolean =>
  mode === 'camera' && CAMERA_PHASES.has(p);

/** Phases during which a round is in flight, so a visibility change must pause
 *  rather than abandon it. */
export const isRoundActive = (p: Phase): boolean =>
  p === 'countdown' || p === 'play' || p === 'paused';

/**
 * Map a getUserMedia rejection to the copy variant to show.
 * Each kind gets different instructions on screen — "허용을 눌러 주세요" is
 * useless advice to someone whose laptop has no camera.
 */
export function cameraErrorKind(e: unknown): CameraErrorKind {
  const name = (e as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'notFound';
  if (name === 'NotReadableError' || name === 'AbortError') return 'inUse';
  // getUserMedia is absent entirely: not a secure context (http://192.168.x.x
  // is the usual cause, and it is the single most common support question).
  if (name === 'TypeError') return 'insecure';
  return 'unknown';
}

/** A person must be present and upright this long before the attract screen's
 *  start button arms, so a passing teacher or an empty chair cannot launch a
 *  game. 0.45s matches the probation used by shipped webcam party games. */
export const ATTRACT_PROBATION_SEC = 0.45;

/** After this long with no jump, surface the keyboard hint. The jump must
 *  never be the only way in. */
export const ATTRACT_HINT_SEC = 25;

/** Stricter than the in-game jump preset: on the attract screen a false start
 *  is more annoying than a missed one, because it drags the player into a game
 *  they did not choose. */
export const ATTRACT_JUMP_OPTS = {
  enter: 1.9,
  exit: 0.6,
  cooldownMs: 900,
  confirmFrames: 2,
  requireFeetVisible: false, // children stand close to a laptop; feet are cropped
} as const;

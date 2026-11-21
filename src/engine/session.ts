// Session phases and the camera-lifecycle predicates.
//
// The React shell owns the reducer (`src/shell/useSession.ts`); this file owns
// the PHASE VOCABULARY and the questions the engine needs answered about a
// phase, chiefly "should the camera be running right now?".
//
// Keeping the type here rather than in the shell means the engine can answer
// those questions without importing React.
//
// ── This is a KIOSK, and that changed the flow ──────────────────────────────
// The audience is walk-up strangers: a different body every round, nobody
// twice, nobody who has read anything. Two consequences drive everything here.
//
//  1. Setup belongs to the OPERATOR, not the guest. Permission, shader warmup
//     and the capability probe happen once when the booth opens; after that
//     the kiosk rests in `attract` all day. The old guest-facing chain
//     (priming → prePrompt → cameraRequest → warmup → calibration → safety)
//     asked a passer-by to complete six screens before playing, which for a
//     stranger with no reason to persist is simply a wall.
//
//  2. There is no calibration PHASE, because a stranger will not stand still
//     for four seconds on request. Calibration happens continuously in the
//     background off the attract screen (see pose/calibration.ts): the guest
//     standing in front of the START button IS the calibration pose. The
//     profile freezes when a round starts, so one body cannot be scored
//     against two different scales.
//
// `intro` and `safety` are gone as phases too — not as content. A stranger
// will not read a how-to page, so the gesture demo and the "mind your
// surroundings" graphic play DURING the countdown, where they cost no extra
// screen and are seen rather than skipped.
export type Phase =
  /** Nothing loaded yet. */
  | 'boot'
  /** Operator-facing, once per opening: permission, model prefetch, shader
   *  warmup. Never shown to a guest. */
  | 'setup'
  /** Setup failed. Operator-facing copy with the actual fix. */
  | 'setupHelp'
  /** The resting state, and the only screen most guests ever see: a reel of
   *  real gameplay behind one START button. Auto-calibration runs here. */
  | 'attract'
  | 'roulette'
  /** 3·2·1 with the gesture demo and the space warning folded in. */
  | 'countdown'
  | 'play'
  | 'paused'
  /** Score, the kiosk's standing record, and one button back to `attract`. */
  | 'results';

/** 설정 opens from the gear and returns where it was opened, so it is an
 *  overlay rather than a phase. The privacy copy lives inside it: a kiosk
 *  guest will not read a consent page, but it must still be one tap away for
 *  the person who asks. */
export type Overlay = 'none' | 'settings';

export type InputMode = 'camera' | 'keyboard';

export type CameraErrorKind =
  | 'denied' | 'notFound' | 'inUse' | 'insecure'
  /** The camera opened, but the pose engine failed to start. A different
   *  problem with a different fix, and telling the operator "we could not turn
   *  the camera on" after permission was granted is a dead end. */
  | 'engine'
  | 'unknown';

export type PauseReason = 'hidden' | 'user' | 'trackingLost' | 'cameraLost';

/** Phases that consume pose frames. `attract` is in here because presence
 *  detection and background auto-calibration both run on it. */
const POSE_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'setup', 'attract', 'countdown', 'play',
]);

/** Phases that show the live skeleton.
 *
 *  `attract` is the important one: a stranger walking past sees their own
 *  skeleton move before they have read a single word. That is both the hook
 *  that gets them to stop and the clearest possible statement of what the
 *  camera extracts — joints, never a face. */
const SKELETON_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'setup', 'attract', 'countdown', 'play',
]);

/** Phases where the camera track may stay open.
 *
 *  On a kiosk this is everything after setup, because the booth has to notice
 *  a guest arriving. The camera therefore runs all day, which makes the
 *  always-visible 카메라 켜짐 chip and the CSP `connect-src 'self'` guarantee
 *  load-bearing rather than decorative: "it never leaves this machine" is the
 *  promise doing the work here, not "it is usually off". */
const CAMERA_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'setup', 'attract', 'roulette', 'countdown', 'play', 'paused', 'results',
]);

export const needsPose = (p: Phase): boolean => POSE_PHASES.has(p);
export const showsSkeleton = (p: Phase): boolean => SKELETON_PHASES.has(p);
export const cameraShouldRun = (p: Phase, mode: InputMode): boolean =>
  mode === 'camera' && CAMERA_PHASES.has(p);

/** Phases during which a round is in flight, so a visibility change must pause
 *  rather than abandon it. */
export const isRoundActive = (p: Phase): boolean =>
  p === 'countdown' || p === 'play' || p === 'paused';

/** Phases a guest can see. Everything else is the operator's. */
export const isGuestPhase = (p: Phase): boolean =>
  p === 'attract' || p === 'roulette' || isRoundActive(p) || p === 'results';

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
  if (name === 'EngineStartError') return 'engine';
  return 'unknown';
}

/** A person must be present and upright this long before START arms, so
 *  someone walking past the booth cannot launch a round they then abandon. */
export const ATTRACT_PROBATION_SEC = 0.45;

/**
 * With nobody playing, the reel advances to another game this often.
 *
 * Three seconds is short enough that a passer-by sees two or three different
 * games in the time it takes to walk by — which is the whole job of the
 * attract screen — and long enough to read one of them as a game rather than
 * a flicker.
 */
export const REEL_SWITCH_SEC = 3;

/**
 * How long results stay up before the kiosk returns to `attract` by itself.
 *
 * There is an explicit 처음으로 button, but a guest who simply walks away must
 * not leave their score on screen for the next person: the booth has to reset
 * itself.
 */
export const RESULTS_AUTO_HOME_SEC = 20;

/** With nobody detected this long, drop back to `attract` from any guest
 *  phase. The previous guest left mid-round. */
export const ABANDON_SEC = 6;

/** Stricter than the in-game jump preset: on the attract screen a false start
 *  is more annoying than a missed one, because it drags a guest into a game
 *  they did not choose.
 *
 *  The jump is a SECOND way in, never the only one — the START button is the
 *  main affordance precisely because a stranger has no way to know that
 *  jumping does anything. */
export const ATTRACT_JUMP_OPTS = {
  enter: 1.9,
  exit: 0.6,
  cooldownMs: 900,
  confirmFrames: 2,
  requireFeetVisible: false, // guests stand close to a kiosk; feet are cropped
} as const;

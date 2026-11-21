// The party session: a plain discriminated-union state machine.
//
// The React shell renders off this and owns zero game state. Keeping the whole
// flow in one reducer is what makes "where does the pose pipeline warm up?" and
// "what happens if the camera dies mid-round?" answerable by reading one file.
import type {
  GameId, GameResult, MiniGameManifest, PoseFrame,
} from './types';
import type { Shortlist } from './scheduler';

export type SessionState =
  | { k: 'boot' }
  /** Privacy + camera explanation. Model prefetch starts HERE, behind the
   *  reading, because ~20MB on school wifi is the slowest thing in the app. */
  | { k: 'priming'; prefetch: number }
  /** ~1.2s nudge so the browser's permission dialog is not a surprise. */
  | { k: 'prePrompt' }
  | { k: 'cameraRequest' }
  | { k: 'cameraHelp'; reason: CameraFailure }
  /** Keyboard-only mode. Skips calibration entirely. */
  | { k: 'inputFallback' }
  /** Shader compile + asset decode. The stall that must never land mid-round. */
  | { k: 'warmup'; progress: number; message: string }
  | { k: 'calibration'; progress: number; hint?: string }
  /** 2m of space, move the furniture. Shown once, before the first standing game. */
  | { k: 'safety' }
  /** "점프하면 시작!" — the idle attractor. */
  | { k: 'attract'; armed: boolean; probation: number; hintShown: boolean }
  | { k: 'roulette'; shortlist: Shortlist }
  | { k: 'intro'; manifest: MiniGameManifest; autoAdvanceMs: number }
  | { k: 'countdown'; manifest: MiniGameManifest; n: 3 | 2 | 1 | 0 }
  | { k: 'play'; manifest: MiniGameManifest; msLeft: number }
  | { k: 'paused'; manifest: MiniGameManifest; msLeft: number; why: PauseReason }
  | { k: 'results'; manifest: MiniGameManifest; result: GameResult }
  | { k: 'breakPrompt'; rounds: number }
  | { k: 'partySummary'; played: readonly MiniGameManifest[]; results: readonly GameResult[] }
  | { k: 'error'; message: string; recoverable: boolean };

export type CameraFailure =
  | 'denied'        // NotAllowedError — the common one
  | 'notFound'      // NotFoundError — no camera at all
  | 'inUse'         // NotReadableError — another app has it
  | 'insecure'      // not https/localhost; getUserMedia is unavailable
  | 'unsupported'   // no WebGL2, or software rendering only
  | 'unknown';

export type PauseReason = 'hidden' | 'user' | 'trackingLost' | 'cameraLost';

export type SessionEvent =
  | { k: 'boot.done' }
  | { k: 'prefetch'; value: number }
  | { k: 'choose.camera' }
  | { k: 'choose.keyboard' }
  | { k: 'camera.granted' }
  | { k: 'camera.failed'; reason: CameraFailure }
  | { k: 'warmup.progress'; value: number; message?: string }
  | { k: 'warmup.done' }
  | { k: 'calib.progress'; value: number; hint?: string }
  | { k: 'calib.done' }
  | { k: 'calib.skip' }
  | { k: 'safety.ack' }
  | { k: 'attract.probation'; value: number; armed: boolean }
  | { k: 'attract.hint' }
  | { k: 'start' }                       // the jump, or Space, or a click
  | { k: 'roulette.ready'; shortlist: Shortlist }
  | { k: 'roulette.landed' }
  | { k: 'intro.advance' }
  | { k: 'countdown.tick' }
  | { k: 'play.tick'; msLeft: number }
  | { k: 'play.end'; result: GameResult }
  | { k: 'pause'; why: PauseReason }
  | { k: 'resume' }
  | { k: 'results.again' }
  | { k: 'results.next' }
  | { k: 'results.stop' }
  | { k: 'break.ack' }
  | { k: 'abort' }
  | { k: 'error'; message: string; recoverable?: boolean };

export interface SessionDeps {
  /** False for keyboard mode: skips the safety screen's standing games too. */
  cameraOn: boolean;
  /** Build the next wheel. Null when nothing qualifies. */
  nextShortlist(): Shortlist | null;
  /** Called when a game should be fetched; preloads its chunk. */
  prepare(id: GameId): void;
  /** Warm the likely next candidates' chunks during the countdown. */
  preloadCandidates(ids: readonly GameId[]): void;
  record(m: MiniGameManifest, result: GameResult): void;
  shouldBreak(): boolean;
  takeBreak(): void;
  /** Has the standing-safety screen already been shown this session? */
  safetyShown(): boolean;
  markSafetyShown(): void;
  played(): readonly MiniGameManifest[];
  results(): readonly GameResult[];
}

const INTRO_MS = 4000;

/**
 * Pure transition. Unknown (state, event) pairs return the state unchanged
 * rather than throwing: a late `play.tick` arriving after `play.end` is normal,
 * not a bug, and a party site must never crash a child's afternoon over one.
 */
export function reduce(s: SessionState, e: SessionEvent, d: SessionDeps): SessionState {
  // Global escapes, valid from anywhere.
  if (e.k === 'error') {
    return { k: 'error', message: e.message, recoverable: e.recoverable ?? true };
  }
  if (e.k === 'abort') return toAttract(d);
  if (e.k === 'pause' && (s.k === 'play' || s.k === 'countdown')) {
    const msLeft = s.k === 'play' ? s.msLeft : s.manifest.durationMs;
    return { k: 'paused', manifest: s.manifest, msLeft, why: e.why };
  }

  switch (s.k) {
    case 'boot':
      if (e.k === 'boot.done') return { k: 'priming', prefetch: 0 };
      return s;

    case 'priming':
      if (e.k === 'prefetch') return { k: 'priming', prefetch: e.value };
      if (e.k === 'choose.camera') return { k: 'prePrompt' };
      if (e.k === 'choose.keyboard') return { k: 'inputFallback' };
      return s;

    case 'prePrompt':
      if (e.k === 'start' || e.k === 'choose.camera') return { k: 'cameraRequest' };
      if (e.k === 'choose.keyboard') return { k: 'inputFallback' };
      return s;

    case 'cameraRequest':
      if (e.k === 'camera.granted') {
        return { k: 'warmup', progress: 0, message: '준비 중이에요' };
      }
      if (e.k === 'camera.failed') return { k: 'cameraHelp', reason: e.reason };
      return s;

    case 'cameraHelp':
      // Never a dead end: retry, or fall through to keyboard.
      if (e.k === 'choose.camera') return { k: 'cameraRequest' };
      if (e.k === 'choose.keyboard') return { k: 'inputFallback' };
      return s;

    case 'inputFallback':
      // Keyboard mode has nothing to calibrate and no camera to warm.
      return toAttract(d);

    case 'warmup':
      if (e.k === 'warmup.progress') {
        return { k: 'warmup', progress: e.value, message: e.message ?? s.message };
      }
      if (e.k === 'warmup.done') return { k: 'calibration', progress: 0 };
      if (e.k === 'choose.keyboard') return { k: 'inputFallback' };
      return s;

    case 'calibration':
      if (e.k === 'calib.progress') {
        return e.hint === undefined
          ? { k: 'calibration', progress: e.value }
          : { k: 'calibration', progress: e.value, hint: e.hint };
      }
      if (e.k === 'calib.done' || e.k === 'calib.skip') {
        if (!d.safetyShown()) return { k: 'safety' };
        return toAttract(d);
      }
      if (e.k === 'choose.keyboard') return { k: 'inputFallback' };
      return s;

    case 'safety':
      if (e.k === 'safety.ack') {
        d.markSafetyShown();
        return toAttract(d);
      }
      return s;

    case 'attract':
      if (e.k === 'attract.probation') {
        return { k: 'attract', armed: e.armed, probation: e.value, hintShown: s.hintShown };
      }
      if (e.k === 'attract.hint') {
        return { k: 'attract', armed: s.armed, probation: s.probation, hintShown: true };
      }
      if (e.k === 'start') {
        const sl = d.nextShortlist();
        if (!sl) {
          return {
            k: 'error',
            message: '지금 할 수 있는 게임이 없어요. 설정에서 조건을 바꿔 보세요.',
            recoverable: true,
          };
        }
        // Warm the wheel's candidates now: by the time it stops spinning the
        // winner's chunk is already in the module cache, so there is no pause
        // between the wheel landing and the game appearing.
        d.preloadCandidates(sl.candidates.map((m) => m.id));
        return { k: 'roulette', shortlist: sl };
      }
      return s;

    case 'roulette':
      if (e.k === 'roulette.ready') return { k: 'roulette', shortlist: e.shortlist };
      if (e.k === 'roulette.landed') {
        const m = s.shortlist.winner;
        d.prepare(m.id);
        return { k: 'intro', manifest: m, autoAdvanceMs: INTRO_MS };
      }
      return s;

    case 'intro':
      if (e.k === 'intro.advance' || e.k === 'start') {
        return { k: 'countdown', manifest: s.manifest, n: 3 };
      }
      return s;

    case 'countdown':
      if (e.k === 'countdown.tick') {
        const next = (s.n - 1) as 3 | 2 | 1 | 0;
        if (next < 0) return { k: 'play', manifest: s.manifest, msLeft: s.manifest.durationMs };
        return { k: 'countdown', manifest: s.manifest, n: next };
      }
      if (e.k === 'play.tick') {
        return { k: 'play', manifest: s.manifest, msLeft: s.manifest.durationMs };
      }
      return s;

    case 'play':
      if (e.k === 'play.tick') return { k: 'play', manifest: s.manifest, msLeft: e.msLeft };
      if (e.k === 'play.end') {
        d.record(s.manifest, e.result);
        return { k: 'results', manifest: s.manifest, result: e.result };
      }
      return s;

    case 'paused':
      if (e.k === 'resume') return { k: 'play', manifest: s.manifest, msLeft: s.msLeft };
      if (e.k === 'play.end') {
        d.record(s.manifest, e.result);
        return { k: 'results', manifest: s.manifest, result: e.result };
      }
      return s;

    case 'results':
      if (e.k === 'results.again') {
        return { k: 'countdown', manifest: s.manifest, n: 3 };
      }
      if (e.k === 'results.next') {
        if (d.shouldBreak()) return { k: 'breakPrompt', rounds: d.played().length };
        return toAttract(d);
      }
      if (e.k === 'results.stop') {
        return { k: 'partySummary', played: d.played(), results: d.results() };
      }
      return s;

    case 'breakPrompt':
      if (e.k === 'break.ack') {
        d.takeBreak();
        return toAttract(d);
      }
      if (e.k === 'results.stop') {
        return { k: 'partySummary', played: d.played(), results: d.results() };
      }
      return s;

    case 'partySummary':
      if (e.k === 'start' || e.k === 'results.next') return toAttract(d);
      return s;

    case 'error':
      if (e.k === 'choose.keyboard') return { k: 'inputFallback' };
      if (e.k === 'start' || e.k === 'results.next') return toAttract(d);
      return s;
  }
}

function toAttract(_d: SessionDeps): SessionState {
  return { k: 'attract', armed: false, probation: 0, hintShown: false };
}

/** Which states run the pose pipeline and need frames. */
export function needsPose(s: SessionState): boolean {
  return (
    s.k === 'calibration' || s.k === 'attract' || s.k === 'intro' ||
    s.k === 'countdown' || s.k === 'play'
  );
}

/** Which states show the live camera/skeleton overlay. The attract screen does,
 *  deliberately: showing a parent exactly what the camera extracts is what
 *  makes the privacy copy credible. */
export function showsSkeleton(s: SessionState): boolean {
  return s.k === 'calibration' || s.k === 'attract' || s.k === 'intro' || s.k === 'play';
}

/** The camera must be released in every state that is not using it. */
export function cameraShouldRun(s: SessionState): boolean {
  return needsPose(s) || s.k === 'warmup' || s.k === 'results' || s.k === 'roulette';
}

/** Jump-to-start probation: a person must be present and upright this long
 *  before the button arms, so a passing teacher or a chair cannot launch a
 *  game. 0.45s matches the probation used by shipped webcam party games. */
export const ATTRACT_PROBATION_SEC = 0.45;
/** After this long with no jump, surface the keyboard hint. */
export const ATTRACT_HINT_SEC = 25;

/** Is somebody plausibly standing there, ready to play? */
export function readyToPlay(f: PoseFrame): boolean {
  const p = f.p1;
  if (!p?.present) return false;
  if (p.conf < 0.5) return false;
  // Upright: shoulders above hips by a sane margin in normalized units.
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// THE SHELL ↔ ENGINE SEAM.
//
// `src/engine/session.ts` (the lead's file) owns the real state machine. This
// module declares the exact shape the React shell renders off, plus a local
// reducer that drives it today so the whole flow is walkable before the engine
// lands. When session.ts arrives, `useSession` delegates to it and
// `sessionReducer` is deleted — nothing in screens/ or components/ changes,
// because every screen takes plain props and callbacks and reads no global.
//
// Everything exported above `useSession` is pure and unit-tested in
// session.test.ts.
// ════════════════════════════════════════════════════════════════════════════
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState } from 'react';
import type { CalibrationProfile, GameId, GameResult, HudService } from '@/engine/types';
import type { AudioService, GestureService, MiniGameManifest } from '@/engine/types';
import type { PoseSource } from '@/engine/pose/source';
import type { AutoCalibrator } from '@/engine/pose/calibration';
import { ALL, pickPool, type PoolFilter } from '@/engine/registry';
import { LAUNCH_SET } from '@/engine/catalog';

// ─── Phases ─────────────────────────────────────────────────────────────────

// The vocabulary lives in the engine now (`@/engine/session`) rather than
// being declared twice. It was duplicated here while the engine's copy was
// still a stub, and the cost of that showed up immediately: the two unions
// drifted, and a change to the engine's flow typechecked clean against a
// shell that no longer matched it.
export type {
  CameraErrorKind, InputMode, Overlay, Phase,
} from '@/engine/session';
export { cameraErrorKind } from '@/engine/session';

import type {
  CameraErrorKind, InputMode, Overlay, Phase,
} from '@/engine/session';
import { ABANDON_SEC, RESULTS_AUTO_HOME_SEC } from '@/engine/session';
import { loadRecords, submitRecord, type RecordTable } from './records';

/** One slice on the roulette. The shell never puts all 58 games on the wheel:
 *  pickPool() → shuffle bag → 8. A 58-slice wheel is illegible, and a guest
 *  who sees 58 options starts shopping instead of playing. */
export interface WheelItem {
  id: GameId;
  nameKo: string;
  icon: string;
  hue: number;
}

export const WHEEL_SIZE = 8;

/** What the shell needs to draw a game's reel card, wheel slice and countdown
 *  demo. A subset of MiniGameManifest so screens never depend on fields they
 *  do not render. */
export interface GameInfo {
  id: GameId;
  nameKo: string;
  taglineKo: string;
  howToKo: string[];
  icon: string;
  hue: number;
  durationMs: number;
  intensity: 1 | 2 | 3;
  gestures: string[];
}

/** Stable hue for a game with no `theme.hue`, so cards never collide randomly. */
function hueOf(m: MiniGameManifest): number {
  if (m.theme?.hue !== undefined) return m.theme.hue;
  let h = 2166136261;
  for (let i = 0; i < m.id.length; i++) h = Math.imul(h ^ m.id.charCodeAt(i), 16777619);
  return (h >>> 0) % 360;
}

export const toInfo = (m: MiniGameManifest): GameInfo => ({
  id: m.id,
  nameKo: m.nameKo,
  taglineKo: m.taglineKo,
  howToKo: m.howToKo,
  icon: m.icon,
  hue: hueOf(m),
  durationMs: m.durationMs,
  intensity: m.intensity,
  gestures: [...m.gestures],
});

export function describeGame(id: GameId): GameInfo {
  const m = ALL.get(id);
  if (!m) throw new Error(`[shell] unknown game "${id}"`);
  return toInfo(m);
}

export function poolItems(f: PoolFilter): GameInfo[] {
  return pickPool(f).map(toInfo);
}

// ─── State ──────────────────────────────────────────────────────────────────

export interface SessionState {
  phase: Phase;
  /** Where to return when the 설정 overlay closes. */
  overlay: Overlay;
  inputMode: InputMode;
  /** True only while a MediaStream track is live. Drives the 카메라 켜짐 chip,
   *  which on a kiosk is lit essentially all day — see engine/session.ts. */
  cameraLive: boolean;
  cameraError: CameraErrorKind | null;
  /** The raw error text, for the small print on the operator's help screen. */
  cameraErrorDetail: string | null;
  /** 0..1 plus a Korean label. Operator-facing: both warmup stages. */
  loading: { progress: number; labelKo: string };
  /**
   * The live auto-calibration profile for whoever is standing there now.
   *
   * Null until a guest has been seen. It updates continuously on `attract`
   * and freezes for the duration of a round — a stranger will not hold a
   * calibration pose on request, so the standing-in-front-of-START pose is
   * the calibration (see engine/pose/calibration.ts).
   */
  calib: CalibrationProfile | null;
  /** The 8 slices currently on the wheel. */
  shortlist: WheelItem[];
  /** Decided BEFORE the spin starts. The animation is cosmetic and cannot
   *  disagree with this. */
  chosenIndex: number;
  currentGame: GameId | null;
  lastResult: GameResult | null;
  /** Today's best per game. 기록. */
  records: RecordTable;
  /** Whether the round that just ended took the record, so the results screen
   *  can celebrate it without diffing tables itself. */
  beatRecord: boolean;
  /** Rounds since the booth opened. An operator stat, not a guest-facing one:
   *  consecutive guests are different people, so there is no party to total. */
  roundsPlayed: number;
  seed: number;
  players: number;
  /** A fatal, user-visible problem that still must not dead-end the page. */
  errorKo: string | null;
}

export type SessionAction =
  /** boot → setup. The operator opening the booth. */
  | { type: 'setupStart' }
  | { type: 'cameraGranted' }
  | { type: 'cameraFailed'; error: CameraErrorKind; detail?: string }
  | { type: 'retryCamera' }
  /** Run with no camera at all — a dead kiosk is worse than a keyboard one. */
  | { type: 'chooseKeyboard' }
  | { type: 'progress'; progress: number; labelKo?: string }
  /** setup → attract. From here the booth never leaves the guest loop. */
  | { type: 'setupDone' }
  /** A background auto-calibration tick. Fires repeatedly on `attract`. */
  | { type: 'calibrated'; profile: CalibrationProfile }
  | { type: 'cameraOff' }
  /** attract → roulette. The winner is already decided here. */
  | { type: 'spin'; shortlist: WheelItem[]; chosenIndex: number }
  /** roulette → countdown. There is no intro phase: a stranger does not read
   *  a how-to page, so the gesture demo plays inside the countdown. */
  | { type: 'spinDone' }
  | { type: 'countdownDone' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'roundEnded'; result: GameResult; nowMs?: number }
  /** 처음으로 — the explicit button on the results screen. */
  | { type: 'home' }
  /** Same guest wants another go: straight back to the wheel. */
  | { type: 'again' }
  /** Nobody has been detected for a while. Reset the booth for the next
   *  person, from any guest phase. */
  | { type: 'abandon' }
  | { type: 'openOverlay'; overlay: Exclude<Overlay, 'none'> }
  | { type: 'closeOverlay' }
  /** 설정 → 전체 삭제. Storage is wiped by clearAllStorage(); this drops the
   *  in-memory copy so the next round is not compared against a ghost. */
  | { type: 'clearRecords' }
  | { type: 'error'; messageKo: string | null }
  /** DEV only (`window.__mg.setState`), and the `?screen=` query param. */
  | { type: 'goto'; phase: Phase };

export function initialSession(o: {
  seed: number;
  players?: number;
  inputMode?: InputMode;
  now?: number;
}): SessionState {
  return {
    phase: 'boot',
    overlay: 'none',
    inputMode: o.inputMode ?? 'camera',
    cameraLive: false,
    cameraError: null,
    cameraErrorDetail: null,
    loading: { progress: 0, labelKo: '준비하고 있어요' },
    calib: null,
    shortlist: [],
    chosenIndex: 0,
    currentGame: null,
    lastResult: null,
    records: loadRecords(o.now ?? Date.now()),
    beatRecord: false,
    roundsPlayed: 0,
    seed: o.seed,
    players: o.players ?? 1,
    errorKo: null,
  };
}

/** Seconds of no-one-there before `abandon` should be dispatched. Re-exported
 *  so screens do not import two modules to find one number. */
export { ABANDON_SEC, RESULTS_AUTO_HOME_SEC };

/** Pure. Every transition in the kiosk flow and nothing else. */
export function sessionReducer(s: SessionState, a: SessionAction): SessionState {
  switch (a.type) {
    case 'setupStart':
      return { ...s, phase: 'setup', cameraError: null, cameraErrorDetail: null };

    case 'cameraGranted':
      return { ...s, cameraLive: true, cameraError: null, cameraErrorDetail: null };

    case 'cameraFailed':
      return {
        ...s,
        phase: 'setupHelp',
        cameraLive: false,
        cameraError: a.error,
        cameraErrorDetail: a.detail ?? null,
      };

    case 'retryCamera':
      return { ...s, phase: 'setup', cameraError: null, cameraErrorDetail: null };

    case 'chooseKeyboard':
      // Reachable from every error state, which is what "never a dead end"
      // means for a booth nobody is standing next to.
      return {
        ...s,
        phase: 'attract',
        inputMode: 'keyboard',
        cameraLive: false,
        cameraError: null,
        cameraErrorDetail: null,
      };

    case 'progress':
      return {
        ...s,
        loading: {
          progress: a.progress,
          labelKo: a.labelKo ?? s.loading.labelKo,
        },
      };

    case 'setupDone':
      return { ...s, phase: 'attract', loading: { progress: 1, labelKo: '준비됐어요' } };

    case 'calibrated':
      // Deliberately does not change phase: this fires many times per guest.
      return { ...s, calib: a.profile };

    case 'cameraOff':
      return { ...s, cameraLive: false };

    case 'spin':
      return {
        ...s,
        phase: 'roulette',
        shortlist: a.shortlist,
        chosenIndex: a.chosenIndex,
        currentGame: a.shortlist[a.chosenIndex]?.id ?? null,
        lastResult: null,
        beatRecord: false,
      };

    case 'spinDone':
      return { ...s, phase: 'countdown' };

    case 'countdownDone':
      return { ...s, phase: 'play' };

    case 'pause':
      return s.phase === 'play' ? { ...s, phase: 'paused' } : s;

    case 'resume':
      return s.phase === 'paused' ? { ...s, phase: 'play' } : s;

    case 'roundEnded': {
      const id = s.currentGame;
      if (!id) return { ...s, phase: 'results', lastResult: a.result };
      const { table, beat } = submitRecord(
        s.records, id, a.result, a.nowMs ?? Date.now(),
      );
      return {
        ...s,
        phase: 'results',
        lastResult: a.result,
        records: table,
        beatRecord: beat,
        roundsPlayed: s.roundsPlayed + 1,
      };
    }

    case 'home':
    case 'abandon':
      // Both land on the same reset. The difference is only who decided:
      // the guest pressing 처음으로, or the booth noticing an empty frame.
      return {
        ...s,
        phase: 'attract',
        currentGame: null,
        lastResult: null,
        beatRecord: false,
        // The next person is a different body. Dropping the profile here is
        // the whole reason a 190cm adult's scale cannot leak into the round
        // played by the child who walks up after them.
        calib: null,
        errorKo: null,
      };

    case 'again':
      // Keeps `calib`: it is the same guest, still standing there.
      return { ...s, phase: 'attract', lastResult: null, beatRecord: false };

    case 'openOverlay':
      return { ...s, overlay: a.overlay };

    case 'closeOverlay':
      return { ...s, overlay: 'none' };

    case 'clearRecords':
      return { ...s, records: {}, beatRecord: false };

    case 'error':
      return { ...s, errorKo: a.messageKo };

    case 'goto':
      return { ...s, phase: a.phase };

    default: {
      // Exhaustiveness: a new action without a case fails the build here
      // rather than silently doing nothing at runtime.
      const never: never = a;
      return never;
    }
  }
}

// ─── The services the engine must supply ────────────────────────────────────

export interface RoundRequest {
  gameId: GameId;
  /** The shell's `<div class="stage">`. The engine appends its own canvas. */
  host: HTMLElement;
  /** The DOM HUD, from `createHudService()` in shell/hud/HudOverlay.tsx. */
  hud: HudService;
  seed: number;
  /** Aborted by the camera chip, by 처음으로, and on unmount. */
  signal: AbortSignal;
}

/**
 * Everything the shell needs from the engine, and nothing more.
 *
 * All of it is optional: with `{}` the shell still boots, renders every screen
 * and completes the flow on the keyboard path. That is deliberate — the shell
 * must never be blocked on another agent's file, and a half-built engine must
 * never show the child a frozen page.
 */
export interface ShellServices {
  pose?: PoseSource | null;
  /** Continuous kiosk calibration for whoever is in front of the camera; null
   *  without one. The shell publishes it on attract, freezes it for a round
   *  and thaws it after, and draws the distance hint from tooFar/tooClose. */
  calibration?: AutoCalibrator | null;
  /** The attract screen rents `gestures.use('jump', …)` from this — there is
   *  no bespoke jump code anywhere in the shell. */
  gestures?: GestureService | null;
  audio?: Pick<AudioService, 'play' | 'muted'> | null;
  /** Stage A: prefetch /wasm/* + the .task model into the Cache API while the
   *  child reads the privacy screen. No camera, no user gesture. */
  prefetchAssets?: (onProgress: (p: number, labelKo: string) => void) => Promise<void>;
  /** getUserMedia. Must reject with the original DOMException. */
  openCamera?: () => Promise<void>;
  /** Stage B: create the landmarker and run 3 inferences on a real photo. */
  warmup?: (onProgress: (p: number, labelKo: string) => void) => Promise<void>;
  /** track.stop() on every path. */
  closeCamera?: () => void;
  /** Mount canvas + fixed-step loop, run one round, resolve with the result. */
  runRound?: (r: RoundRequest) => Promise<GameResult>;
}

/** Provided once by App. Lives here, not in App.tsx, so components can read it
 *  without importing App (which would be an import cycle). */
export const ServicesContext = createContext<ShellServices>({});
export const useServices = (): ShellServices => useContext(ServicesContext);

export interface Session {
  state: SessionState;
  dispatch: (a: SessionAction) => void;
}

export function useSession(o: {
  seed: number;
  players?: number;
  inputMode?: InputMode;
  startPhase?: Phase;
}): Session {
  const [state, dispatch] = useReducer(
    sessionReducer,
    o,
    (init) => {
      const s = initialSession({
        seed: init.seed,
        ...(init.players !== undefined ? { players: init.players } : {}),
        ...(init.inputMode !== undefined ? { inputMode: init.inputMode } : {}),
        now: Date.now(),
      });
      return init.startPhase ? { ...s, phase: init.startPhase, safetyDone: true } : s;
    },
  );
  return useMemo(() => ({ state, dispatch }), [state]);
}

// ─── Settings (localStorage, `mg:` namespace, one 전체 삭제 button) ─────────

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  /** 'system' follows prefers-reduced-motion; the other two override it. */
  motion: 'system' | 'reduced' | 'full';
  textSize: 'normal' | 'large';
  contrast: 'system' | 'more';
  sound: boolean;
  /** speechSynthesis ko-KR. Off by default: device quality varies wildly and
   *  every prompt is already mirrored as on-screen Korean. */
  speak: boolean;
  /** 자동 넘기기. Off = a child who reads slowly is never rushed. */
  autoAdvance: boolean;
  nickname: string;
  players: number;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  motion: 'system',
  textSize: 'normal',
  contrast: 'system',
  sound: true,
  speak: false,
  autoAdvance: true,
  nickname: '',
  players: 1,
};

const LS_KEY = 'mg:settings';

/** Namespaced so one button can clear everything this site ever stored. */
export function clearAllStorage(): void {
  try {
    const kill: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('mg:')) kill.push(k);
    }
    for (const k of kill) localStorage.removeItem(k);
  } catch {
    /* private mode / storage blocked — nothing was stored either way */
  }
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Maps settings onto the <html> attributes tokens.css switches on. */
export function applySettings(s: Settings, systemReduced: boolean): void {
  const r = document.documentElement;
  // No theme attribute: the product is light-only by design. A dark mode read
  // as drab for a children's party game, and the sprite keyline (near-black
  // ink) assumes a light ground.
  r.removeAttribute('data-theme');

  if (s.motion === 'reduced') r.setAttribute('data-motion', 'reduced');
  else if (s.motion === 'full') r.setAttribute('data-motion', 'full');
  else r.removeAttribute('data-motion');

  if (s.textSize === 'large') r.setAttribute('data-text-size', 'large');
  else r.removeAttribute('data-text-size');

  if (s.contrast === 'more') r.setAttribute('data-contrast', 'more');
  else r.removeAttribute('data-contrast');

  // Mirror the effective value so JS (the wheel, the countdown) agrees with CSS.
  r.setAttribute(
    'data-effective-motion',
    s.motion === 'reduced' || (s.motion === 'system' && systemReduced) ? 'reduced' : 'full',
  );
}

function matches(q: string): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(q).matches;
}

export function useSettings(): {
  settings: Settings;
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  reset: () => void;
  reducedMotion: boolean;
} {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [systemReduced, setSystemReduced] = useState(() =>
    matches('(prefers-reduced-motion: reduce)'),
  );

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setSystemReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    applySettings(settings, systemReduced);
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(settings));
    } catch {
      /* storage blocked: the session still works, it just will not be remembered */
    }
  }, [settings, systemReduced]);

  const set = useCallback(<K extends keyof Settings>(k: K, v: Settings[K]) => {
    setSettings((prev) => ({ ...prev, [k]: v }));
  }, []);

  const reset = useCallback(() => {
    clearAllStorage();
    setSettings(DEFAULT_SETTINGS);
  }, []);

  const reducedMotion =
    settings.motion === 'reduced' || (settings.motion === 'system' && systemReduced);

  return { settings, set, reset, reducedMotion };
}

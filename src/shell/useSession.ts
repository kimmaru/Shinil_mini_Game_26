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
import { ALL, pickPool, type PoolFilter } from '@/engine/registry';
import { LAUNCH_SET } from '@/engine/catalog';
import { recordRound, shouldBreak as schedulerShouldBreak, takeBreak } from './rounds';

// ─── Phases ─────────────────────────────────────────────────────────────────

/** Mirrors docs/PLAN.md § 쉘 흐름 exactly, in order. */
export type Phase =
  | 'boot'
  | 'priming'
  | 'prePrompt'
  | 'cameraRequest'
  | 'cameraHelp'
  | 'warmup'
  | 'calibration'
  | 'safety'
  | 'attract'
  | 'roulette'
  | 'intro'
  | 'countdown'
  | 'play'
  | 'paused'
  | 'results'
  | 'breakPrompt'
  | 'partySummary';

/** 설정 / 개인정보 안내 are overlays, not phases: they open from anywhere
 *  (including mid-party) and return to exactly where they were opened. */
export type Overlay = 'none' | 'settings' | 'privacy';

export type InputMode = 'camera' | 'keyboard';

/** Distinct copy per kind — see screens/CameraHelp.tsx. Mapped from the
 *  DOMException name by `cameraErrorKind`. */
export type CameraErrorKind = 'denied' | 'notFound' | 'inUse' | 'insecure' | 'engine' | 'unknown';

export function cameraErrorKind(e: unknown): CameraErrorKind {
  const name = (e as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'notFound';
  if (name === 'NotReadableError' || name === 'AbortError') return 'inUse';
  if (name === 'TypeError') return 'insecure'; // getUserMedia missing: not https
  if (name === 'EngineStartError') return 'engine';
  return 'unknown';
}

/** One slice on the roulette. The shell never puts all 58 games on the wheel:
 *  pickPool() → shuffle bag → 8. A 58-slice wheel is illegible. */
export interface WheelItem {
  id: GameId;
  nameKo: string;
  icon: string;
  hue: number;
}

export const WHEEL_SIZE = 8;
/** Fallback break thresholds, used only when no round has been recorded with
 *  the scheduler (dev placeholder games). The real decision is intensity-
 *  weighted and lives in RoundScheduler — see ./rounds.ts. */
export const BREAK_AFTER_ROUNDS = 8;
export const BREAK_AFTER_MS = 10 * 60_000;

/** What the shell needs to draw a game's card, intro and wheel slice. A subset
 *  of MiniGameManifest so screens never depend on fields they do not render. */
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

// shortcut: DEV-only placeholders so every screen downstream of the roulette can
// be built and reviewed before src/games/** exists. Returns [] in production —
// with zero authored games the shell shows "아직 게임이 없어요" instead of lying.
// Delete this table once Wave 1 lands.
const DEV_GAMES: readonly GameInfo[] = [
  ['mosquito-clap', '모기 잡기', '손뼉으로 모기를 잡아요', 'mosquito', 120, 'clap'],
  ['candy-rain-catch', '사탕 받기', '떨어지는 사탕을 받아요', 'candy', 330, 'reach'],
  ['air-whack-mole', '두더지 잡기', '튀어나오면 때려요', 'target', 28, 'reach'],
  ['balloon-pop-party', '풍선 터뜨리기', '풍선을 모두 터뜨려요', 'balloon', 285, 'swing'],
  ['fruit-slash', '과일 자르기', '손으로 쓱 베어요', 'star', 8, 'swing'],
  ['wrist-aim-target', '과녁 맞히기', '손으로 조준해요', 'target', 200, 'reach'],
  ['spider-touch', '거미 쫓기', '다가오면 손으로 쳐요', 'bug', 265, 'reach'],
  ['cheer-combo', '응원 콤보', '박자에 맞춰 응원해요', 'g-raise', 45, 'raise'],
].map(([id, nameKo, taglineKo, icon, hue, g]) => ({
  id: id as string,
  nameKo: nameKo as string,
  taglineKo: taglineKo as string,
  howToKo: ['화면을 보고 몸을 움직여요!', '빠르게 움직이면 점수가 올라가요.'],
  icon: icon as string,
  hue: hue as number,
  durationMs: 40_000,
  intensity: 2 as 1 | 2 | 3,
  gestures: [g as string],
}));

const devGames = (): readonly GameInfo[] => (import.meta.env.DEV ? DEV_GAMES : []);

/** Everything a screen knows about a game id. Never throws: an unknown id
 *  degrades to a readable placeholder rather than a blank screen. */
export function describeGame(id: GameId): GameInfo {
  const m = ALL.get(id);
  if (m) return toInfo(m);
  const dev = devGames().find((g) => g.id === id);
  if (dev) return dev;
  return {
    id,
    nameKo: id,
    taglineKo: '',
    howToKo: [],
    icon: 'ui-dice',
    hue: 230,
    durationMs: 40_000,
    intensity: 2,
    gestures: [],
  };
}

/** The roulette candidate set: pickPool, as GameInfo. */
export function poolItems(f: PoolFilter): GameInfo[] {
  const real = pickPool(f).map(toInfo);
  if (real.length > 0) return real;
  // Keyboard mode must not silently serve games that need a body.
  return [...devGames()].filter(() => LAUNCH_SET.length > 0);
}

export interface SessionState {
  phase: Phase;
  /** Where to return when an overlay closes. */
  overlay: Overlay;
  inputMode: InputMode;
  /** True only while a MediaStream track is live. Drives the 카메라 켜짐 chip. */
  cameraLive: boolean;
  cameraError: CameraErrorKind | null;
  /** The raw error text, for the small print on the help screen. */
  cameraErrorDetail: string | null;
  /** 0..1 plus a Korean label, for both warmup stages. */
  loading: { progress: number; labelKo: string };
  calib: CalibrationProfile | null;
  /** e.g. "발이 보이게 뒤로 가 볼까요?" — shown on the calibration screen. */
  calibHintKo: string | null;
  /** Safety screen is shown once per session, before the first standing game. */
  safetyDone: boolean;
  /** The 8 slices currently on the wheel. */
  shortlist: WheelItem[];
  /** Decided BEFORE the spin starts. The animation is cosmetic and cannot
   *  disagree with this. */
  chosenIndex: number;
  currentGame: GameId | null;
  lastResult: GameResult | null;
  /** Every finished round this session, for 파티 결과. */
  history: GameResult[];
  roundsSinceBreak: number;
  partyStartedAt: number;
  seed: number;
  players: number;
  /** A fatal, user-visible problem that still must not dead-end the page. */
  errorKo: string | null;
}

export type SessionAction =
  | { type: 'chooseCamera' }
  | { type: 'chooseKeyboard' }
  | { type: 'promptNow' }
  | { type: 'cameraGranted' }
  | { type: 'cameraFailed'; error: CameraErrorKind; detail?: string }
  | { type: 'retryCamera' }
  | { type: 'progress'; progress: number; labelKo?: string }
  | { type: 'warmupDone' }
  | { type: 'calibHint'; hintKo: string | null }
  | { type: 'calibrated'; profile: CalibrationProfile }
  | { type: 'safetyAck' }
  | { type: 'cameraOff' }
  /** attract → roulette. The winner is already decided here. */
  | { type: 'spin'; shortlist: WheelItem[]; chosenIndex: number }
  | { type: 'spinDone' }
  | { type: 'introDone' }
  | { type: 'countdownDone' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'roundEnded'; result: GameResult }
  | { type: 'again' }
  | { type: 'next' }
  | { type: 'stop' }
  | { type: 'breakDone' }
  | { type: 'openOverlay'; overlay: Exclude<Overlay, 'none'> }
  | { type: 'closeOverlay' }
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
    phase: 'priming',
    overlay: 'none',
    inputMode: o.inputMode ?? 'camera',
    cameraLive: false,
    cameraError: null,
    cameraErrorDetail: null,
    loading: { progress: 0, labelKo: '준비하고 있어요' },
    calib: null,
    calibHintKo: null,
    safetyDone: false,
    shortlist: [],
    chosenIndex: 0,
    currentGame: null,
    lastResult: null,
    history: [],
    roundsSinceBreak: 0,
    partyStartedAt: o.now ?? 0,
    seed: o.seed,
    players: o.players ?? 1,
    errorKo: null,
  };
}

/**
 * True when the round that just finished should be followed by a rest.
 *
 * Prefers the scheduler's intensity-weighted judgement — a run of 점프 games
 * earns a break sooner than a run of seated ones, which a flat round count
 * cannot express. Falls back to the round/time thresholds when the scheduler
 * has no history (dev placeholder games are not in the registry).
 */
export function needsBreak(s: SessionState, now: number): boolean {
  if (schedulerShouldBreak()) return true;
  return (
    s.roundsSinceBreak >= BREAK_AFTER_ROUNDS ||
    (s.partyStartedAt > 0 && now - s.partyStartedAt >= BREAK_AFTER_MS)
  );
}

/** Pure. Every transition in docs/PLAN.md § 쉘 흐름 and nothing else. */
export function sessionReducer(s: SessionState, a: SessionAction): SessionState {
  switch (a.type) {
    case 'chooseCamera':
      return { ...s, phase: 'prePrompt', inputMode: 'camera', cameraError: null };

    case 'chooseKeyboard':
      // Keyboard mode skips camera, warmup and calibration entirely — and it is
      // reachable from every error state, which is what "never a dead end" means.
      return {
        ...s,
        phase: s.safetyDone ? 'attract' : 'safety',
        inputMode: 'keyboard',
        cameraLive: false,
        cameraError: null,
    cameraErrorDetail: null,
      };

    case 'promptNow':
      return { ...s, phase: 'cameraRequest' };

    case 'cameraGranted':
      return { ...s, phase: 'warmup', cameraLive: true, cameraError: null };

    case 'cameraFailed':
      return { ...s, phase: 'cameraHelp', cameraLive: false, cameraError: a.error, cameraErrorDetail: a.detail ?? null };

    case 'retryCamera':
      return { ...s, phase: 'prePrompt', cameraError: null };

    case 'progress':
      return {
        ...s,
        loading: {
          progress: Math.max(0, Math.min(1, a.progress)),
          labelKo: a.labelKo ?? s.loading.labelKo,
        },
      };

    case 'warmupDone':
      return { ...s, phase: 'calibration', loading: { progress: 1, labelKo: '준비 끝!' } };

    case 'calibHint':
      return { ...s, calibHintKo: a.hintKo };

    case 'calibrated':
      return {
        ...s,
        phase: s.safetyDone ? 'attract' : 'safety',
        calib: a.profile,
        calibHintKo: null,
      };

    case 'safetyAck':
      return { ...s, phase: 'attract', safetyDone: true };

    case 'cameraOff':
      // The 끄기 chip. The camera dies immediately; play continues on the
      // keyboard source rather than stranding the player on a dead screen.
      return { ...s, inputMode: 'keyboard', cameraLive: false };

    case 'spin':
      if (a.shortlist.length === 0) return s;
      return {
        ...s,
        phase: 'roulette',
        shortlist: a.shortlist,
        chosenIndex: Math.max(0, Math.min(a.shortlist.length - 1, a.chosenIndex)),
      };

    case 'spinDone': {
      const pick = s.shortlist[s.chosenIndex];
      if (!pick) return s;
      return { ...s, phase: 'intro', currentGame: pick.id };
    }

    case 'introDone':
      return s.currentGame ? { ...s, phase: 'countdown' } : { ...s, phase: 'attract' };

    case 'countdownDone':
      return { ...s, phase: 'play' };

    case 'pause':
      return s.phase === 'play' ? { ...s, phase: 'paused' } : s;

    case 'resume':
      return s.phase === 'paused' ? { ...s, phase: 'play' } : s;

    case 'roundEnded':
      // Tell the scheduler, so the next wheel respects the safety pacing
      // (never three hard games in a row) and the break timer is weighted.
      if (s.currentGame) recordRound(s.currentGame, a.result);
      return {
        ...s,
        phase: 'results',
        lastResult: a.result,
        history: [...s.history, a.result],
        roundsSinceBreak: s.roundsSinceBreak + 1,
      };

    case 'again':
      return s.currentGame ? { ...s, phase: 'countdown' } : s;

    case 'next':
      return { ...s, phase: 'attract', currentGame: null };

    case 'stop':
      return { ...s, phase: 'partySummary' };

    case 'breakDone':
      takeBreak();
      return { ...s, phase: 'attract', roundsSinceBreak: 0, partyStartedAt: 0 };

    case 'openOverlay':
      return { ...s, overlay: a.overlay };

    case 'closeOverlay':
      return { ...s, overlay: 'none' };

    case 'error':
      return { ...s, errorKo: a.messageKo };

    case 'goto':
      return { ...s, phase: a.phase };
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
  /** Aborted by 그만하기, by the camera chip, and on unmount. */
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

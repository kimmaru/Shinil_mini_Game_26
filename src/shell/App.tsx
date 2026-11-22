// ════════════════════════════════════════════════════════════════════════════
// APP — routes the session phase to a screen, and owns the side effects the
// screens must not: the camera, the two warmup stages, calibration, the round,
// and teardown.
//
// Every screen below is a pure function of props, which is what lets each one
// be redesigned on its own without touching this file. App owns the PROP
// CONTRACTS; the screens own what they look like.
//
// ── Kiosk flow ─────────────────────────────────────────────────────────────
//   boot → setup ⇄ setupHelp        operator, once, when the booth opens
//   attract ⇄ settings              the resting state, all day
//     └ START → roulette → countdown → play → results → attract
//
// Setup is not a guest's problem and results do not accumulate into a party:
// every round is a different stranger. See engine/session.ts for why each
// phase in the old classroom chain is gone.
//
// Query params (all DEV-friendly, all harmless in production):
//   ?debug=1        the debug overlay
//   ?screen=attract jump straight to a phase
//   ?seed=hello     deterministic round
//   ?all=1          include games the lead has not switched on
//   ?fakepose=1     DEV: animate a synthetic skeleton (no camera needed)
// ════════════════════════════════════════════════════════════════════════════
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GameResult } from '@/engine/types';
import { ABANDON_SEC, RESULTS_AUTO_HOME_SEC } from '@/engine/session';
import { defaultCalibration } from '@/engine/pose/source';
import { hashSeed } from '@/engine/rng';

import { CameraBackdrop } from './components/CameraBackdrop';
import { CameraChip } from './components/CameraChip';
import { ToastHost, useToasts } from './components/Toast';
import { createHudService, HudOverlay } from './hud/HudOverlay';
import { DebugOverlay, type DebugPush } from './debug/DebugOverlay';

import { Attract } from './screens/Attract';
import { Countdown } from './screens/Countdown';
import { Results } from './screens/Results';
import { Roulette, decideRound } from './screens/Roulette';
import { recordRound } from './rounds';
import { Settings } from './screens/Settings';
import { Setup } from './screens/Setup';
import { SetupHelp } from './screens/SetupHelp';

import {
  ServicesContext,
  cameraErrorKind,
  describeGame,
  poolItems,
  useSession,
  useSettings,
  type Phase,
  type ShellServices,
} from './useSession';

const PHASES: readonly Phase[] = [
  'boot', 'setup', 'setupHelp', 'attract', 'roulette', 'countdown',
  'play', 'paused', 'results',
];

/** Hidden this long and we give the camera back — a tab nobody is looking at
 *  has no business holding the webcam, kiosk or not. */
const CAMERA_IDLE_MS = 60_000;

/** Stage B can hang on a cold shader cache. Measured at ~20s in the worst
 *  case, so this is generous rather than optimistic. */
const WARMUP_TIMEOUT_MS = 60_000;

/** How often the booth checks whether anybody is still standing there. */
const PRESENCE_POLL_MS = 500;

export interface AppProps {
  services?: ShellServices;
}

export function App({ services = {} }: AppProps): React.ReactElement {
  const q = useMemo(() => new URLSearchParams(window.location.search), []);
  const debugOn = q.get('debug') === '1';
  const includeDisabled = q.get('all') === '1';
  const fakePose = import.meta.env.DEV && q.get('fakepose') === '1';
  const seed = useMemo(() => {
    const raw = q.get('seed');
    if (!raw) return (Date.now() ^ 0x9e3779b9) >>> 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n >>> 0 : hashSeed(raw);
  }, [q]);

  const { settings, set, reset, reducedMotion } = useSettings();
  const startPhase = useMemo(() => {
    const p = q.get('screen') as Phase | null;
    return p && PHASES.includes(p) ? p : undefined;
  }, [q]);

  const { state, dispatch } = useSession({
    seed,
    players: Number(q.get('players')) || settings.players,
    ...(startPhase ? { startPhase } : {}),
  });
  const { toasts, push } = useToasts();

  // Sound respects the setting at the edge, so no screen has to remember to.
  const ctxValue = useMemo<ShellServices>(() => {
    const audio = services.audio;
    return {
      ...services,
      audio: audio
        ? {
            get muted() {
              return !settings.sound || audio.muted;
            },
            play: (id, o) => {
              if (settings.sound) audio.play(id, o);
            },
          }
        : null,
    };
  }, [services, settings.sound]);

  const hud = useMemo(
    () => createHudService({ reducedMotion }),
    // One HUD per app instance; reducedMotion is read at construction only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => () => hud.dispose(), [hud]);

  const pushRef = useRef<DebugPush>({});
  const stageRef = useRef<HTMLDivElement>(null);
  const [roundSecondsLeft, setRoundSecondsLeft] = useState<number | null>(null);
  const [setupStarted, setSetupStarted] = useState(false);

  const pose = services.pose ?? null;
  const game = state.currentGame ? describeGame(state.currentGame) : null;

  // The dimmed camera backdrop: on when the setting is on AND a real stream
  // is live (never in keyboard mode). Read through a ref by the round effect,
  // so a re-render cannot restart a round.
  const camStream =
    state.cameraLive && settings.cameraBackdrop ? (services.cameraStream?.() ?? null) : null;
  const backdropRef = useRef(false);
  backdropRef.current = camStream !== null;

  /** The games the attract reel cycles through. Real playable games, because
   *  there are no video files anywhere in this project and there is no reason
   *  to add any: the reel runs the games themselves. */
  const reel = useMemo(
    () => poolItems({
      players: 1,
      space: ['seated', 'standing', 'room'],
      cameraOn: true,
      ...(includeDisabled ? { includeDisabled: true } : {}),
    }),
    [includeDisabled],
  );

  // ─── DEV console API ────────────────────────────────────────────────────
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__mg = {
      pushDebug: (d) => {
        pushRef.current = { ...pushRef.current, ...d };
      },
      setState: (phase) => dispatch({ type: 'goto', phase }),
      debug: () => ({
        phase: state.phase,
        seed: state.seed,
        inputMode: state.inputMode,
        cameraLive: state.cameraLive,
        currentGame: state.currentGame,
        shortlist: state.shortlist.map((s) => s.id),
        chosenIndex: state.chosenIndex,
        rounds: state.roundsPlayed,
        ...pushRef.current,
      }),
    };
    return () => {
      delete window.__mg;
    };
  }, [state, dispatch]);

  // ─── Setup: prefetch → permission → warmup, as one chain ────────────────
  //
  // These were three phases with three screens. They are one effect now
  // because the operator has no decision to make between them — splitting
  // them only ever served the guest-facing copy that no longer exists.
  useEffect(() => {
    if (state.phase !== 'setup' || !setupStarted) return;
    let alive = true;
    const timeout = window.setTimeout(() => {
      if (!alive) return;
      push('준비가 너무 오래 걸려요. 카메라 없이도 쓸 수 있어요.', 'warn', 8000);
      dispatch({ type: 'setupDone' });
    }, WARMUP_TIMEOUT_MS);

    const progress = (lo: number, hi: number) => (p: number, labelKo: string) => {
      if (alive) dispatch({ type: 'progress', progress: lo + (hi - lo) * p, labelKo });
    };

    (async () => {
      // Stage A is advisory: a slow prefetch means a slow first round, not a
      // broken booth, so its failure must not stop the chain.
      if (services.prefetchAssets) {
        await services.prefetchAssets(progress(0, 0.5)).catch(() => undefined);
      }
      if (!alive) return;

      if (!services.openCamera) {
        // No engine attached: do not pretend a camera is coming.
        dispatch({ type: 'cameraFailed', error: 'unknown' });
        return;
      }
      try {
        await services.openCamera();
      } catch (e) {
        if (!alive) return;
        // Carry the real error text through. Without it the help screen is a
        // dead end for whoever has to fix the problem.
        const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        dispatch({ type: 'cameraFailed', error: cameraErrorKind(e), detail });
        return;
      }
      // Dispatched even if this chain was cancelled meanwhile (the 60 s
      // timeout already moved on to attract): the camera IS live, and the
      // 카메라 켜짐 chip must say so. A deliberate cancel (카메라 없이 쓰기)
      // closes the camera first, and openCamera then rejects instead.
      dispatch({ type: 'cameraGranted' });
      if (!alive) return;

      // Stage B is NOT advisory: this is the lazy shader compile, and letting
      // it land mid-round is the stutter it exists to prevent.
      if (services.warmup) {
        try {
          await services.warmup(progress(0.5, 1));
        } catch (e) {
          if (!alive) return;
          const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          dispatch({ type: 'cameraFailed', error: 'engine', detail });
          return;
        }
      }
      if (alive) dispatch({ type: 'setupDone' });
    })();

    return () => {
      alive = false;
      window.clearTimeout(timeout);
    };
  }, [state.phase, setupStarted, services, dispatch, push]);

  // ─── Background calibration ─────────────────────────────────────────────
  //
  // The engine's AutoCalibrator measures whoever is standing there,
  // continuously, without asking anybody to hold a pose. On attract the shell
  // only PUBLISHES it into session state — on a new customer or when the
  // profile becomes their own (`ready`), not every tick. `services` is read
  // directly (not ctxValue): `calibration` is a getter that only becomes
  // non-null once the camera is up, hence `cameraLive` in the deps.
  useEffect(() => {
    const cal = services.calibration;
    if (state.phase !== 'attract' || !cal) return;
    let key = '';
    const id = window.setInterval(() => {
      const k = `${cal.customerId}:${cal.ready}`;
      if (k !== key) {
        key = k;
        dispatch({ type: 'calibrated', profile: { ...cal.profile } });
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [state.phase, state.cameraLive, services, dispatch]);

  // A profile that moved mid-round would score the same movement differently
  // in the two halves of it: freeze for the round, thaw after. Forgetting the
  // thaw would leave the next customer playing on this one's body.
  useEffect(() => {
    const cal = services.calibration;
    if (!cal) return;
    const inRound = state.phase === 'play' || state.phase === 'paused';
    if (inRound && !cal.frozen) pose?.setCalibration(cal.freeze());
    else if (!inRound && cal.frozen) cal.thaw();
  }, [state.phase, services, pose]);

  // Keyboard mode has no body to measure, so it gets the measured default
  // immediately rather than a null profile every game has to guard against.
  useEffect(() => {
    if (state.inputMode === 'keyboard' && !state.calib) {
      dispatch({ type: 'calibrated', profile: defaultCalibration() });
    }
  }, [state.inputMode, state.calib, dispatch]);

  // ─── Nobody there: reset the booth for the next person ──────────────────
  useEffect(() => {
    if (state.inputMode !== 'camera' || !pose) return;
    if (state.phase !== 'results' && state.phase !== 'countdown') return;
    let empty = 0;
    const id = window.setInterval(() => {
      const f = pose.sample(performance.now() / 1000);
      const here = f.players.some((p) => p.present);
      empty = here ? 0 : empty + PRESENCE_POLL_MS / 1000;
      if (empty >= ABANDON_SEC) dispatch({ type: 'abandon' });
    }, PRESENCE_POLL_MS);
    return () => window.clearInterval(id);
  }, [state.phase, state.inputMode, pose, dispatch]);

  // A guest who walks off without pressing 처음으로 must not leave their score
  // up for the next person.
  useEffect(() => {
    if (state.phase !== 'results') return;
    const id = window.setTimeout(
      () => dispatch({ type: 'home' }),
      RESULTS_AUTO_HOME_SEC * 1000,
    );
    return () => window.clearTimeout(id);
  }, [state.phase, dispatch]);

  // ─── The round ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (state.phase !== 'play' || !state.currentGame) return;
    const host = stageRef.current;
    const run = services.runRound;
    hud.reset();

    const durMs = describeGame(state.currentGame).durationMs;
    const t0 = performance.now();
    const ticker = window.setInterval(
      () => setRoundSecondsLeft(Math.max(0, Math.ceil((durMs - (performance.now() - t0)) / 1000))),
      200,
    );

    if (!run || !host) {
      return () => window.clearInterval(ticker);
    }
    const ac = new AbortController();
    run({
      gameId: state.currentGame,
      host,
      hud: hud.service,
      seed: state.seed,
      signal: ac.signal,
      backdrop: backdropRef.current,
    })
      .then((result: GameResult) => {
        // Feeds the scheduler's "not the same kind of game twice running".
        recordRound(result.gameId, result);
        dispatch({ type: 'roundEnded', result });
      })
      .catch(() => {
        // Never strand the child on an empty stage: back to the start screen.
        push('게임을 불러오지 못했어요. 다른 게임을 해 볼까요?', 'warn');
        dispatch({ type: 'home' });
      });

    return () => {
      ac.abort();
      window.clearInterval(ticker);
    };
  }, [state.phase, state.currentGame, state.seed, services, hud, dispatch, push]);

  // ─── Pose source warnings surface as gentle toasts ──────────────────────
  useEffect(() => {
    if (!pose) return;
    let lastWarning = '';
    const id = window.setInterval(() => {
      const w = pose.info.warning ?? '';
      if (w && w !== lastWarning) push(w, 'warn');
      lastWarning = w;
    }, 1500);
    return () => window.clearInterval(id);
  }, [pose, push]);

  // ─── Teardown: the camera dies on every exit path ───────────────────────
  //
  // STABLE on purpose. This used to depend on `pose`, which is read from the
  // `services.pose` getter at render time: the render after openCamera()
  // resolved gave it a new identity, the teardown effect below re-ran, and
  // its CLEANUP stopped the camera that had just started — while the chip
  // still said 카메라 켜짐. Read the live source at call time instead.
  const closeCamera = useCallback(() => {
    services.closeCamera?.();
    services.pose?.stop();
    dispatch({ type: 'cameraOff' });
  }, [services, dispatch]);
  const closeCameraRef = useRef(closeCamera);
  closeCameraRef.current = closeCamera;
  const inputModeRef = useRef(state.inputMode);
  inputModeRef.current = state.inputMode;

  /** The 끄기 chip. Back to 게임 준비, where 시작 turns the camera on again —
   *  otherwise attract would keep asking a child to stand in front of a
   *  camera that is off, with no way back short of a reload. */
  const turnCameraOff = useCallback(() => {
    closeCamera();
    setSetupStarted(false);
    dispatch({ type: 'setupStart' });
  }, [closeCamera, dispatch]);

  // Rule for every effect in this file: one whose CLEANUP stops the camera
  // must not list `pose` or anything derived from it in its deps, or a
  // re-render tears the camera down. Effects that only READ pose may re-run.
  useEffect(() => {
    const onHide = () => services.closeCamera?.();
    window.addEventListener('pagehide', onHide);
    let idle = 0;
    let idleClosed = false;
    const onVisibility = () => {
      if (document.hidden) {
        dispatch({ type: 'pause' });
        idle = window.setTimeout(() => {
          idleClosed = true;
          closeCameraRef.current();
        }, CAMERA_IDLE_MS);
      } else {
        window.clearTimeout(idle);
        if (idleClosed) {
          idleClosed = false;
          // We gave the camera back while nobody was looking; take it again.
          // Permission is already granted, so this is the quick path.
          if (inputModeRef.current === 'camera') {
            setSetupStarted(true);
            dispatch({ type: 'setupStart' });
          }
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearTimeout(idle);
      services.closeCamera?.();
    };
  }, [services, dispatch]);

  // Esc closes an overlay, then pauses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (state.overlay !== 'none') dispatch({ type: 'closeOverlay' });
      else if (state.phase === 'play') dispatch({ type: 'pause' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.overlay, state.phase, dispatch]);

  // ─── Transitions the shell owns ─────────────────────────────────────────
  const startRound = useCallback(() => {
    // Read the calibrator live: `state.calib` is only republished on a new
    // guest, so it holds whatever the legs looked like in their first second.
    const cal = services.calibration;
    const legs = cal?.ready ? cal.lowerBodyVisible : state.calib?.lowerBodyVisible;
    const pick = decideRound({
      players: state.players,
      space: ['seated', 'standing', 'room'],
      cameraOn: state.inputMode === 'camera',
      ...(legs === false ? { lowerBodyVisible: false } : {}),
      ...(includeDisabled ? { includeDisabled: true } : {}),
    });
    dispatch({ type: 'spin', shortlist: pick.shortlist, chosenIndex: pick.chosenIndex });
  }, [state.players, state.inputMode, state.calib, services, includeDisabled, dispatch]);

  // Transitions a screen fires from a TIMER must be referentially stable, or a
  // re-render here (a toast, a pose warning) restarts that timer and the
  // auto-advance never completes. `dispatch` from useReducer is stable.
  const goKeyboard = useCallback(() => {
    // "카메라 없이 쓰기" can be pressed while the camera is still starting:
    // close it, or it ends up live with no chip and steals the keyboard body.
    services.closeCamera?.();
    dispatch({ type: 'chooseKeyboard' });
  }, [services, dispatch]);
  const goRetry = useCallback(() => {
    setSetupStarted(true);
    dispatch({ type: 'retryCamera' });
  }, [dispatch]);
  const goSpinDone = useCallback(() => dispatch({ type: 'spinDone' }), [dispatch]);
  const goCountdownDone = useCallback(() => dispatch({ type: 'countdownDone' }), [dispatch]);
  const goHome = useCallback(() => dispatch({ type: 'home' }), [dispatch]);
  // 다시 하기: same guest (calib kept by 'again'), straight back to the roulette
  // — pressing it IS pressing START again.
  const goAgain = useCallback(() => {
    dispatch({ type: 'again' });
    startRound();
  }, [dispatch, startRound]);
  const resetAll = useCallback(() => {
    reset();
    dispatch({ type: 'clearRecords' });
  }, [reset, dispatch]);

  const onSetupStart = useCallback(() => {
    setSetupStarted(true);
    dispatch({ type: 'setupStart' });
  }, [dispatch]);

  // Boot goes straight to setup so the operator sees one screen, not two.
  useEffect(() => {
    if (state.phase === 'boot') dispatch({ type: 'setupStart' });
  }, [state.phase, dispatch]);

  // ─── Render ─────────────────────────────────────────────────────────────
  const openSettings = useCallback(
    () => dispatch({ type: 'openOverlay', overlay: 'settings' }),
    [dispatch],
  );
  const closeOverlay = useCallback(() => dispatch({ type: 'closeOverlay' }), [dispatch]);

  let screen: React.ReactElement;
  switch (state.phase) {
    case 'boot':
    case 'setup':
      screen = (
        <Setup
          progress={state.loading.progress}
          labelKo={state.loading.labelKo}
          started={setupStarted}
          onStart={onSetupStart}
          onKeyboard={goKeyboard}
        />
      );
      break;

    case 'setupHelp':
      screen = (
        <SetupHelp
          error={state.cameraError}
          detailKo={state.cameraErrorDetail}
          onRetry={goRetry}
          onKeyboard={goKeyboard}
        />
      );
      break;

    case 'attract':
      screen = (
        <Attract
          pose={pose}
          calibration={services.calibration ?? null}
          gestures={services.gestures}
          inputMode={state.inputMode}
          reel={reel}
          reducedMotion={reducedMotion}
          onStart={startRound}
          onSettings={openSettings}
          blocked={state.overlay !== 'none'}
          {...(fakePose ? { fakePose: true } : {})}
        />
      );
      break;

    case 'roulette':
      screen = (
        <Roulette
          shortlist={state.shortlist}
          chosenIndex={state.chosenIndex}
          reducedMotion={reducedMotion}
          onDone={goSpinDone}
          onBack={goHome}
        />
      );
      break;

    case 'countdown':
      screen = (
        <Countdown
          game={game}
          pose={pose}
          calibration={services.calibration ?? null}
          reducedMotion={reducedMotion}
          onDone={goCountdownDone}
        />
      );
      break;

    case 'play':
    case 'paused':
      screen = <div className="stage" ref={stageRef} />;
      break;

    case 'results':
      screen = state.lastResult && game ? (
        <Results
          result={state.lastResult}
          gameNameKo={game.nameKo}
          hue={game.hue}
          record={state.records[game.id] ?? null}
          beatRecord={state.beatRecord}
          reducedMotion={reducedMotion}
          onHome={goHome}
          onAgain={goAgain}
        />
      ) : (
        <div className="stage" />
      );
      break;

    default: {
      const never: never = state.phase;
      throw new Error(`[App] unhandled phase ${String(never)}`);
    }
  }

  return (
    <ServicesContext.Provider value={ctxValue}>
      <div className="app" data-phase={state.phase}>
        {camStream ? <CameraBackdrop stream={camStream} /> : null}
        {screen}

        {/* The camera runs all day on a kiosk, so this chip is the honest
            indicator rather than a formality. It is never hidden. */}
        <CameraChip live={state.cameraLive} onOff={turnCameraOff} />

        {(state.phase === 'play' || state.phase === 'paused') && (
          <HudOverlay
            handle={hud}
            roundSecondsLeft={roundSecondsLeft}
            players={state.players}
            onPause={() => dispatch({ type: 'pause' })}
          />
        )}

        {state.overlay === 'settings' && (
          <Settings
            settings={settings}
            set={set}
            onReset={resetAll}
            onClose={closeOverlay}
          />
        )}

        <ToastHost toasts={toasts} />
        {debugOn && (
          <DebugOverlay
            phase={state.phase}
            seed={state.seed}
            players={state.players}
            pose={pose}
            calib={state.calib}
            getPush={() => pushRef.current}
          />
        )}
      </div>
    </ServicesContext.Provider>
  );
}

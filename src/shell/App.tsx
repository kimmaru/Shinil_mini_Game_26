// ════════════════════════════════════════════════════════════════════════════
// APP — routes the session phase to a screen, and owns the side effects the
// screens must not: the camera, the two warmup stages, calibration, the round,
// and teardown.
//
// Every screen below is a pure function of props. That is what lets the real
// `src/engine/session.ts` replace `useSession`'s local reducer without touching
// a single screen, and what lets each screen be reviewed on its own.
//
// Query params (all DEV-friendly, all harmless in production):
//   ?debug=1        the debug overlay
//   ?screen=attract jump straight to a phase
//   ?seed=hello     deterministic round
//   ?all=1          include games the lead has not switched on
//   ?players=2      multi-player layout
//   ?fakepose=1     DEV: animate a synthetic skeleton (no camera needed)
// ════════════════════════════════════════════════════════════════════════════
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GameResult } from '@/engine/types';
import { defaultCalibration } from '@/engine/pose/source';
import { hashSeed } from '@/engine/rng';

import { Button } from './components/Button';
import { CameraChip } from './components/CameraChip';
import { ToastHost, useToasts } from './components/Toast';
import { createHudService, HudOverlay } from './hud/HudOverlay';
import { DebugOverlay, type DebugPush } from './debug/DebugOverlay';

import { Attract } from './screens/Attract';
import { BreakPrompt } from './screens/BreakPrompt';
import { Calibration, CALIBRATION_MS } from './screens/Calibration';
import { CameraHelp } from './screens/CameraHelp';
import { Countdown } from './screens/Countdown';
import { Intro } from './screens/Intro';
import { PartySummary } from './screens/PartySummary';
import { PrePrompt } from './screens/PrePrompt';
import { Priming } from './screens/Priming';
import { Privacy } from './screens/Privacy';
import { Results } from './screens/Results';
import { Roulette, decideRound } from './screens/Roulette';
import { Safety } from './screens/Safety';
import { Settings } from './screens/Settings';
import { Warmup, WARMUP_TIMEOUT_MS } from './screens/Warmup';

import {
  ServicesContext,
  cameraErrorKind,
  describeGame,
  needsBreak,
  useSession,
  useSettings,
  type Phase,
  type ShellServices,
} from './useSession';

const PHASES: readonly Phase[] = [
  'boot', 'priming', 'prePrompt', 'cameraRequest', 'cameraHelp', 'warmup',
  'calibration', 'safety', 'attract', 'roulette', 'intro', 'countdown',
  'play', 'paused', 'results', 'breakPrompt', 'partySummary',
];

/** Hidden this long and we give the camera back — a tab nobody is looking at
 *  has no business holding the webcam. */
const CAMERA_IDLE_MS = 60_000;

// ─── localStorage: best scores only, namespaced, wipeable in one press ──────
const BEST_KEY = 'mg:best';

function readBest(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(BEST_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

function writeBest(id: string, score: number): void {
  try {
    const all = readBest();
    if ((all[id] ?? -1) >= score) return;
    all[id] = score;
    localStorage.setItem(BEST_KEY, JSON.stringify(all));
  } catch {
    /* storage blocked: records just are not kept */
  }
}

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
    () =>
      createHudService({
        reducedMotion,
        ...(settings.speak && services.audio
          ? { speak: (t: string) => (services.audio as { speak?: (s: string) => void }).speak?.(t) }
          : {}),
      }),
    // One HUD per app instance; reducedMotion is read at construction only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => () => hud.dispose(), [hud]);

  const pushRef = useRef<DebugPush>({});
  const stageRef = useRef<HTMLDivElement>(null);
  const [roundSecondsLeft, setRoundSecondsLeft] = useState<number | null>(null);
  const [calibProgress, setCalibProgress] = useState(0);

  const pose = services.pose ?? null;
  const game = state.currentGame ? describeGame(state.currentGame) : null;

  // ─── DEV console API (docs/PLAN.md § Browser pane 검증) ──────────────────
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
        rounds: state.history.length,
        ...pushRef.current,
      }),
    };
    return () => {
      delete window.__mg;
    };
  }, [state, dispatch]);

  // ─── Stage A: prefetch the 20MB of wasm + model while they read ─────────
  useEffect(() => {
    if (state.phase !== 'priming' || !services.prefetchAssets) return;
    let alive = true;
    services
      .prefetchAssets((p, labelKo) => {
        if (alive) dispatch({ type: 'progress', progress: p, labelKo });
      })
      .catch(() => {
        // Not fatal: the model will simply be fetched later, more slowly.
        if (alive) push('준비가 조금 늦어요. 그래도 놀 수 있어요!', 'warn');
      });
    return () => {
      alive = false;
    };
  }, [state.phase, services, dispatch, push]);

  // ─── getUserMedia ────────────────────────────────────────────────────────
  useEffect(() => {
    if (state.phase !== 'cameraRequest') return;
    let alive = true;
    const open = services.openCamera;
    if (!open) {
      // No engine attached: do not pretend. Offer the keyboard route.
      dispatch({ type: 'cameraFailed', error: 'unknown' });
      return;
    }
    open()
      .then(() => alive && dispatch({ type: 'cameraGranted' }))
      .catch((e: unknown) => alive && dispatch({ type: 'cameraFailed', error: cameraErrorKind(e) }));
    return () => {
      alive = false;
    };
  }, [state.phase, services, dispatch]);

  // ─── Stage B: landmarker + 3 real inferences (shader compile) ────────────
  useEffect(() => {
    if (state.phase !== 'warmup') return;
    let alive = true;
    const timeout = window.setTimeout(() => {
      if (!alive) return;
      push('준비가 너무 오래 걸려요. 키보드로 놀아도 재미는 똑같아요!', 'warn', 8000);
      dispatch({ type: 'warmupDone' });
    }, WARMUP_TIMEOUT_MS);

    const run = services.warmup;
    if (!run) {
      dispatch({ type: 'warmupDone' });
    } else {
      run((p, labelKo) => alive && dispatch({ type: 'progress', progress: p, labelKo }))
        .then(() => alive && dispatch({ type: 'warmupDone' }))
        .catch(() => {
          if (!alive) return;
          push('카메라 준비에 실패했어요. 키보드로 놀 수 있어요!', 'warn');
          dispatch({ type: 'chooseKeyboard' });
        });
    }
    return () => {
      alive = false;
      window.clearTimeout(timeout);
    };
  }, [state.phase, services, dispatch, push]);

  // ─── Calibration: 4s, median over ~60 frames ─────────────────────────────
  useEffect(() => {
    if (state.phase !== 'calibration') return;
    let alive = true;
    setCalibProgress(0);
    const t0 = performance.now();
    const ticker = window.setInterval(() => {
      if (alive) setCalibProgress(Math.min(1, (performance.now() - t0) / CALIBRATION_MS));
    }, 80);

    const finish = (profile: ReturnType<typeof defaultCalibration>) => {
      if (!alive) return;
      if (!profile.lowerBodyVisible) {
        push('발이 안 보여요. 다리를 쓰는 게임은 잠깐 쉴게요!', 'info', 5000);
      }
      dispatch({ type: 'calibrated', profile });
    };

    if (!pose) {
      // Keyboard / no engine: a standing-adult default is honest and instant.
      const id = window.setTimeout(() => finish(defaultCalibration()), CALIBRATION_MS);
      return () => {
        alive = false;
        window.clearInterval(ticker);
        window.clearTimeout(id);
      };
    }

    pose
      .calibrate(CALIBRATION_MS)
      .then(finish)
      .catch(() => {
        if (!alive) return;
        dispatch({ type: 'calibHint', hintKo: '잘 안 보여요. 뒤로 한 걸음 가 볼까요?' });
        finish(defaultCalibration());
      });
    return () => {
      alive = false;
      window.clearInterval(ticker);
    };
  }, [state.phase, pose, dispatch, push]);

  // ─── The round ───────────────────────────────────────────────────────────
  const finishRound = useCallback(
    (result: GameResult) => {
      writeBest(result.gameId, result.rawScore);
      dispatch({ type: 'roundEnded', result });
    },
    [dispatch],
  );

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
    })
      .then(finishRound)
      .catch(() => push('게임을 불러오지 못했어요. 다른 게임을 해 볼까요?', 'warn'));

    return () => {
      ac.abort();
      window.clearInterval(ticker);
    };
  }, [state.phase, state.currentGame, state.seed, services, hud, finishRound, push]);

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
  const closeCamera = useCallback(() => {
    services.closeCamera?.();
    pose?.stop();
    dispatch({ type: 'cameraOff' });
  }, [services, pose, dispatch]);

  useEffect(() => {
    const onHide = () => services.closeCamera?.();
    window.addEventListener('pagehide', onHide);
    let idle = 0;
    const onVisibility = () => {
      if (document.hidden) {
        dispatch({ type: 'pause' });
        idle = window.setTimeout(() => closeCamera(), CAMERA_IDLE_MS);
      } else {
        window.clearTimeout(idle);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearTimeout(idle);
      services.closeCamera?.();
    };
  }, [services, dispatch, closeCamera]);

  // Esc pauses, and closes an overlay first.
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
    const pick = decideRound({
      players: state.players,
      space: state.safetyDone ? ['seated', 'standing', 'room'] : ['seated', 'standing'],
      cameraOn: state.inputMode === 'camera',
      ...(state.calib && !state.calib.lowerBodyVisible ? { lowerBodyVisible: false } : {}),
      ...(includeDisabled ? { includeDisabled: true } : {}),
    });
    dispatch({ type: 'spin', shortlist: pick.shortlist, chosenIndex: pick.chosenIndex });
  }, [state.players, state.safetyDone, state.inputMode, state.calib, includeDisabled, dispatch]);

  const afterResults = useCallback(() => {
    if (needsBreak(state, Date.now())) dispatch({ type: 'goto', phase: 'breakPrompt' });
    else startRound();
  }, [state, dispatch, startRound]);

  // Transitions that a screen fires from a TIMER must be referentially stable,
  // or a re-render here (a toast, a pose warning) restarts that timer and the
  // auto-advance never completes. `dispatch` from useReducer is stable.
  const goKeyboard = useCallback(() => dispatch({ type: 'chooseKeyboard' }), [dispatch]);
  const goPromptNow = useCallback(() => dispatch({ type: 'promptNow' }), [dispatch]);
  const goSpinDone = useCallback(() => dispatch({ type: 'spinDone' }), [dispatch]);
  const goIntroDone = useCallback(() => dispatch({ type: 'introDone' }), [dispatch]);
  const goCountdownDone = useCallback(() => dispatch({ type: 'countdownDone' }), [dispatch]);
  const goNext = useCallback(() => dispatch({ type: 'next' }), [dispatch]);

  // ─── Render ─────────────────────────────────────────────────────────────
  const openSettings = () => dispatch({ type: 'openOverlay', overlay: 'settings' });
  const openPrivacy = () => dispatch({ type: 'openOverlay', overlay: 'privacy' });
  const closeOverlay = () => dispatch({ type: 'closeOverlay' });

  let screen: React.ReactElement;
  switch (state.phase) {
    case 'boot':
    case 'priming':
      screen = (
        <Priming
          progress={state.loading.progress}
          progressLabelKo={state.loading.labelKo}
          onCamera={() => dispatch({ type: 'chooseCamera' })}
          onKeyboard={() => dispatch({ type: 'chooseKeyboard' })}
          onPrivacy={openPrivacy}
          onSettings={openSettings}
        />
      );
      break;

    case 'prePrompt':
      screen = (
        <PrePrompt onReady={goPromptNow} onKeyboard={goKeyboard} />
      );
      break;

    case 'cameraRequest':
      screen = (
        <Warmup progress={0} labelKo="카메라를 켜고 있어요…" onKeyboard={goKeyboard} />
      );
      break;

    case 'cameraHelp':
      screen = (
        <CameraHelp
          error={state.cameraError}
          onKeyboard={goKeyboard}
          onRetry={() => dispatch({ type: 'retryCamera' })}
        />
      );
      break;

    case 'warmup':
      screen = (
        <Warmup
          progress={state.loading.progress}
          labelKo={state.loading.labelKo}
          onKeyboard={goKeyboard}
        />
      );
      break;

    case 'calibration':
      screen = (
        <Calibration
          pose={pose}
          progress={calibProgress}
          hintKo={state.calibHintKo}
          onSkip={() => dispatch({ type: 'calibrated', profile: defaultCalibration() })}
          {...(fakePose ? { fakePose: true } : {})}
        />
      );
      break;

    case 'safety':
      screen = <Safety onAck={() => dispatch({ type: 'safetyAck' })} />;
      break;

    case 'attract':
      screen = (
        <Attract
          pose={pose}
          gestures={services.gestures}
          inputMode={state.inputMode}
          nicknameKo={settings.nickname}
          players={state.players}
          returning={state.history.length > 0}
          onStart={startRound}
          onSettings={openSettings}
          onPrivacy={openPrivacy}
          onFinish={() => dispatch({ type: 'stop' })}
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
          onBack={goNext}
        />
      );
      break;

    case 'intro':
      screen = (
        <Intro
          gameId={state.currentGame ?? ''}
          nextIds={state.shortlist.map((s) => s.id).filter((id) => id !== state.currentGame)}
          autoAdvance={settings.autoAdvance}
          onReady={goIntroDone}
          onBack={goNext}
        />
      );
      break;

    case 'countdown':
      screen = (
        <Countdown
          {...(game ? { gameNameKo: game.nameKo } : {})}
          onDone={goCountdownDone}
        />
      );
      break;

    case 'play':
    case 'paused':
      screen = (
        <main className="screen screen--full stage-wrap">
          <div ref={stageRef} className="stage" />
          <HudOverlay
            handle={hud}
            roundSecondsLeft={roundSecondsLeft}
            players={state.players}
            onPause={() => dispatch({ type: 'pause' })}
          />
          {!services.runRound ? (
            <div className="stage__placeholder card">
              <p className="h3">게임 엔진을 아직 붙이지 않았어요</p>
              <p className="body dim">
                {game ? `«${game.nameKo}»` : '게임'} 은 엔진이 연결되면 여기에서 바로 시작해요.
              </p>
              <div className="row">
                {import.meta.env.DEV ? (
                  <Button
                    variant="primary"
                    onClick={() =>
                      finishRound({
                        gameId: state.currentGame ?? 'dev',
                        cleared: true,
                        rawScore: 42,
                        maxScore: 60,
                        normalized: 0.7,
                        stars: 2,
                        durationMs: 40_000,
                        perPlayer: [
                          { playerId: 0, slot: 0, score: 42, hits: 21, misses: 3, bestCombo: 7 },
                        ],
                        highlightsKo: ['콤보 7연속!'],
                      })
                    }
                  >
                    결과 화면 보기 (dev)
                  </Button>
                ) : null}
                <Button variant="ghost" onClick={() => dispatch({ type: 'next' })}>
                  다른 게임 하기
                </Button>
              </div>
            </div>
          ) : null}
          {state.phase === 'paused' ? (
            <div className="pause-veil" aria-live="assertive">
              <div className="card center stack pop-in">
                <p className="h1">잠깐 멈췄어요</p>
                <div className="actions">
                  <Button
                    variant="primary"
                    size="huge"
                    icon="▶"
                    onClick={() => dispatch({ type: 'resume' })}
                  >
                    계속하기
                  </Button>
                  <Button variant="ghost" size="huge" icon="🎲" onClick={() => dispatch({ type: 'next' })}>
                    다른 게임
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </main>
      );
      break;

    case 'results':
      screen = state.lastResult ? (
        <Results
          result={state.lastResult}
          gameNameKo={game?.nameKo ?? ''}
          bestScore={readBest()[state.lastResult.gameId] ?? -1}
          reducedMotion={reducedMotion}
          onAgain={() => dispatch({ type: 'again' })}
          onNext={afterResults}
          onStop={() => dispatch({ type: 'stop' })}
        />
      ) : (
        <Attract
          pose={pose}
          gestures={services.gestures}
          inputMode={state.inputMode}
          nicknameKo={settings.nickname}
          players={state.players}
          returning
          onStart={startRound}
          onSettings={openSettings}
          onPrivacy={openPrivacy}
          onFinish={() => dispatch({ type: 'stop' })}
        />
      );
      break;

    case 'breakPrompt':
      screen = (
        <BreakPrompt
          rounds={state.history.length}
          onContinue={() => dispatch({ type: 'breakDone' })}
          onStop={() => dispatch({ type: 'stop' })}
        />
      );
      break;

    case 'partySummary':
      screen = (
        <PartySummary
          history={state.history}
          nicknameKo={settings.nickname}
          onAgain={() => dispatch({ type: 'breakDone' })}
          onHome={() => dispatch({ type: 'goto', phase: 'priming' })}
        />
      );
      break;
  }

  return (
    <ServicesContext.Provider value={ctxValue}>
      <div className="app" data-phase={state.phase}>
        {state.overlay === 'settings' ? (
          <Settings
            settings={settings}
            set={set}
            onReset={() => {
              reset();
              push('저장된 기록을 모두 지웠어요.', 'success');
            }}
            onClose={closeOverlay}
            onPrivacy={openPrivacy}
          />
        ) : state.overlay === 'privacy' ? (
          <Privacy onClose={closeOverlay} onSettings={openSettings} />
        ) : (
          screen
        )}

        <CameraChip live={state.cameraLive} onOff={closeCamera} />
        <ToastHost toasts={toasts} />
        {debugOn ? (
          <DebugOverlay
            phase={state.phase}
            seed={state.seed}
            players={state.players}
            pose={pose}
            calib={state.calib}
            getPush={() => pushRef.current}
          />
        ) : null}
      </div>
    </ServicesContext.Provider>
  );
}

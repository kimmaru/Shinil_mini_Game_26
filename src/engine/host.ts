// Runs one round in the browser: mount a canvas, build the context, drive the
// fixed-step loop, resolve with the result.
//
// This is the counterpart to `testing/harness.ts`. The two share the engine and
// differ only in their services — the harness uses NullRenderer and stubs, this
// uses a real canvas, real audio and the DOM HUD. Keeping the lifecycle
// identical in both is what makes a headless pass meaningful.
import type { GameContext, GameEvent, GameId, GameResult, HudService } from './types';
import type { PoseSource } from './pose/source';
import { ALL, load } from './registry';
import { createLoop, type Loop } from './loop';
import { Canvas2DRenderer } from './render/canvas2d';
import { createGestureService } from './gestures/service';
import { createFxService, type FxRuntime } from './fx/service';
import type { AudioRuntime } from './audio/service';
import { mulberry32 } from './rng';
import { applyScoring } from './stars';

export interface RoundRequest {
  gameId: GameId;
  /** The shell's stage element. The engine appends its own canvas. */
  host: HTMLElement;
  hud: HudService;
  seed: number;
  /** Aborted by 그만하기, by the camera chip, and on unmount. */
  signal: AbortSignal;
}

export interface HostDeps {
  pose: PoseSource;
  audio: AudioRuntime;
  fx?: FxRuntime;
  /** Mirror of the player's "화면 효과 줄이기" setting. */
  reducedMotion?: boolean;
  /** Called every frame with diagnostics, for the ?debug=1 overlay. */
  onStats?: (s: { fps: number; steps: number; updateMs: number; renderMs: number }) => void;
}

/**
 * Run one round. Resolves when the clock runs out, the game clears early, or
 * the request is aborted — and ALWAYS tears down the canvas, the loop and the
 * game, including when the game throws.
 */
export async function runRound(req: RoundRequest, deps: HostDeps): Promise<GameResult> {
  const manifest = ALL.get(req.gameId);
  if (manifest === undefined) throw new Error(`[host] unknown game "${req.gameId}"`);
  const man = manifest;

  const canvas = document.createElement('canvas');
  canvas.className = 'game-canvas';
  // CSS owns layout; the renderer owns the backing store. Writing an inline
  // size here pins the element to its first measured size forever.
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  req.host.appendChild(canvas);

  const measure = (): { w: number; h: number } => {
    const r = req.host.getBoundingClientRect();
    return { w: Math.max(320, Math.round(r.width)), h: Math.max(240, Math.round(r.height)) };
  };
  let view = measure();

  const g = new Canvas2DRenderer(canvas, { dpr: window.devicePixelRatio || 1 });
  g.resize(view.w, view.h);

  const fx = deps.fx ?? createFxService({ reducedMotion: deps.reducedMotion ?? null });
  fx.resetAll();
  fx.setView(view.w, view.h, g.s);
  // Guards the author cannot be expected to remember on every call:
  // hitstop desynchronises a rhythm game's audio clock permanently, and
  // freezing the screen during continuous tracking reads as the camera having
  // broken. Screen shake is capped harder when the player is already moving.
  fx.configureForGame({
    rhythm: man.a11y.audioOptional === false,
    continuous: man.gestures.some((k) =>
      k === 'holdPose' || k === 'balance' || k === 'stillness' || k === 'poseMatch'),
    roomScale: man.space === 'room',
  });
  // `noFlashing: true` means the game promises not to flash; the limiter
  // stays on regardless, because the promise is the author's and the rule is ours.
  fx.setFlashEnabled(true);

  const viewRef = { w: view.w, h: view.h };
  let frame = deps.pose.sample(0);
  const gestures = createGestureService(() => frame, viewRef);

  let loop: Loop | null = null;
  let finished = false;
  const events: GameEvent[] = [];

  const ctx: GameContext = {
    manifest,
    view: { w: view.w, h: view.h, dpr: window.devicePixelRatio || 1 },
    rng: mulberry32(req.seed),
    audio: deps.audio,
    gestures,
    fx,
    hud: req.hud,
    t: (k) => k,
    profiles: new Map(),
    emit(ev) {
      events.push(ev);
      if (ev.kind === 'clearEarly') settle('cleared');
    },
  };

  const factory = await load(req.gameId);
  const game = factory();

  let resolveRound!: (r: GameResult) => void;
  let rejectRound!: (e: unknown) => void;
  const done = new Promise<GameResult>((res, rej) => { resolveRound = res; rejectRound = rej; });

  const onResize = (): void => {
    view = measure();
    viewRef.w = view.w;
    viewRef.h = view.h;
    g.resize(view.w, view.h);
    fx.setView(view.w, view.h, g.s);
    game.onResize?.(view.w, view.h);
  };

  const onVisibility = (): void => {
    if (document.hidden) loop?.pause();
    else loop?.resume();
  };

  const teardown = (): void => {
    loop?.stop();
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    req.signal.removeEventListener('abort', onAbort);
    try { game.dispose?.(); } catch { /* a failed teardown must not mask the result */ }
    fx.resetAll();
    deps.audio.stopMusic();
    canvas.remove();
  };

  function settle(reason: 'timeUp' | 'cleared' | 'failed' | 'aborted'): void {
    if (finished) return;
    finished = true;
    try {
      const raw = game.end(reason);
      teardown();
      resolveRound(applyScoring(raw, man));
    } catch (e) {
      teardown();
      rejectRound(e);
    }
  }

  function onAbort(): void { settle('aborted'); }
  req.signal.addEventListener('abort', onAbort, { once: true });

  try {
    await game.init(ctx);
  } catch (e) {
    teardown();
    throw e;
  }

  let elapsedMs = 0;
  let lastShownSec = -1;

  loop = createLoop(game, deps.pose, g, {
    fx,
    onStep: (dt, f) => {
      frame = f;
      elapsedMs += dt * 1000;
      const left = Math.max(0, man.durationMs - elapsedMs);
      const sec = Math.ceil(left / 1000);
      if (sec !== lastShownSec) {
        lastShownSec = sec;
        req.hud.setTime(sec);
      }
      if (left <= 0) settle('timeUp');
    },
    onFrameStats: deps.onStats,
  });

  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);

  game.start();
  loop.start();

  if (req.signal.aborted) onAbort();
  return done;
}

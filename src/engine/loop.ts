// Fixed-timestep game loop with render interpolation.
//
// The central scheduling decision of the whole project: pose inference arrives
// at ~25Hz (10Hz on a locked-down Chromebook) while the game must look smooth
// at 60. So logic steps at a fixed 1/60 against an EXTRAPOLATED pose frame, and
// render receives an interpolation fraction. 12fps inference still feels fine
// when the game itself is smooth; a game locked to inference rate feels broken.
import type { MiniGame, PoseFrame } from './types';
import type { PoseSource } from './pose/source';
import type { Renderer } from './render/renderer';

export const STEP = 1 / 60;
/** ~83ms of catch-up, then we drop time. Without this cap, a long stall makes
 *  the loop try to simulate the stall, which makes the stall worse. */
const MAX_STEPS = 5;
/** A tab that was backgrounded returns with a huge delta; clamp it rather than
 *  simulating the time the player was away. */
const MAX_FRAME = 0.25;

export interface LoopHooks {
  /** Called after each fixed step, for the engine's own timers (round clock,
   *  HUD, fx). Receives the same fixed dt. */
  onStep?(dt: number, frame: PoseFrame): void;
  /** Called after the game's render pass, for the fx overlay and debug HUD. */
  onAfterRender?(g: Renderer, interp: number): void;
  /** Time-scale provider, so fx.hitstop() can briefly freeze the simulation.
   *  Returns 1 normally, 0 during hitstop. */
  timeScale?(): number;
  /** Per-frame diagnostics for the debug overlay. */
  onFrameStats?(s: FrameStats): void;
}

export interface FrameStats {
  /** Render frames per second, smoothed. */
  fps: number;
  /** Wall ms spent in update() this frame. */
  updateMs: number;
  /** Wall ms spent in render() this frame. */
  renderMs: number;
  steps: number;
  /** True when the loop hit MAX_STEPS and discarded time. */
  starved: boolean;
}

export interface Loop {
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  readonly running: boolean;
  readonly paused: boolean;
  /** Seconds of game time elapsed, excluding paused time. */
  readonly elapsed: number;
  /** Run exactly `n` steps synchronously. Headless tests only. */
  stepManually(n: number): void;
}

type RafLike = (cb: (t: number) => void) => number;

export function createLoop(
  game: MiniGame,
  pose: PoseSource,
  g: Renderer,
  hooks: LoopHooks = {},
): Loop {
  let acc = 0;
  let prev = 0;
  let raf = 0;
  let running = false;
  let paused = false;
  let elapsed = 0;
  let fps = 60;

  const requestFrame: RafLike =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(() => cb(Date.now()), 16) as unknown as number;
  const cancelFrame = (id: number): void => {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
    else clearTimeout(id);
  };

  const step = (): void => {
    const frame = pose.sample(elapsed);
    game.update(STEP, frame);
    hooks.onStep?.(STEP, frame);
    elapsed += STEP;
  };

  const tick = (nowMs: number): void => {
    if (!running) return;
    raf = requestFrame(tick);
    const now = nowMs / 1000;
    let frameTime = now - prev;
    prev = now;
    if (paused) return;
    if (!(frameTime > 0)) frameTime = STEP;
    if (frameTime > MAX_FRAME) frameTime = MAX_FRAME;
    fps += (1 / Math.max(frameTime, 1e-4) - fps) * 0.1;

    acc += frameTime * (hooks.timeScale?.() ?? 1);

    const t0 = perfNow();
    let steps = 0;
    while (acc >= STEP && steps < MAX_STEPS) {
      step();
      acc -= STEP;
      steps++;
    }
    const starved = steps >= MAX_STEPS && acc >= STEP;
    // Dropping the backlog rather than carrying it is what prevents the
    // death spiral where a slow frame guarantees the next frame is slower.
    if (starved) acc = 0;
    const t1 = perfNow();

    const interp = acc / STEP;
    game.render(g, interp);
    hooks.onAfterRender?.(g, interp);
    const t2 = perfNow();

    hooks.onFrameStats?.({
      fps, updateMs: t1 - t0, renderMs: t2 - t1, steps, starved,
    });
  };

  const perfNow = (): number =>
    typeof performance === 'object' ? performance.now() : Date.now();

  return {
    start(): void {
      if (running) return;
      running = true;
      paused = false;
      acc = 0;
      prev = perfNow() / 1000;
      raf = requestFrame(tick);
    },
    stop(): void {
      running = false;
      cancelFrame(raf);
    },
    pause(): void {
      if (paused) return;
      paused = true;
      acc = 0;
      pose.pause();
      game.onPause?.();
    },
    resume(): void {
      if (!paused) return;
      paused = false;
      // Reset the time base so the paused interval is not simulated.
      prev = perfNow() / 1000;
      acc = 0;
      pose.resume();
      game.onResume?.();
    },
    get running() { return running; },
    get paused() { return paused; },
    get elapsed() { return elapsed; },
    stepManually(n: number): void {
      for (let i = 0; i < n; i++) step();
    },
  };
}

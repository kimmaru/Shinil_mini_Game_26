// ══ FROZEN CONTRACT ══ every game author runs this before handing back.
//
// Drives a real MiniGame through its real lifecycle at a true fixed timestep,
// against a synthetic pose clip, in Node, with no DOM and no camera.
//
// A 40-second game is ~2400 steps and costs ~30ms of CPU, which is why 58
// games x 9 assertions finishes in under a minute — and therefore why this can
// be a pre-handback gate rather than a nightly job.
import type {
  EndReason, GameContext, GameId, GameResult, MiniGameManifest,
} from '../types';
import { clip, type ClipName } from './clips';
import { NullRenderer, type RenderAudit } from './nullRenderer';
import { createCallLog, stubAudio, stubFx, stubHud, type CallLog } from './stubs';
import { ALL, load } from '../registry';
import { replaySource } from '../pose/replay';
import { createGestureService } from '../gestures/service';
import { mulberry32 } from '../rng';
import { applyScoring } from '../stars';

export interface RunOpts {
  clip: ClipName;
  /** Seeds ctx.rng(). The same seed must give the same score. */
  seed?: number;
  /** Override the manifest duration, to keep tests fast. */
  durationMs?: number;
  view?: { w: number; h: number };
  /** Render every step (default) or skip rendering entirely. */
  render?: boolean;
  /** Re-run the clip from the start when it ends, instead of freezing on the
   *  last frame. Default true: a 12s clip must still fill a 40s game. */
  loopClip?: boolean;
  /** Throw on the first NaN coordinate instead of counting it. */
  strict?: boolean;
  /** Stop early after this many steps, for debugging. */
  maxSteps?: number;
}

export interface RunReport {
  id: GameId;
  manifest: MiniGameManifest;
  result: GameResult;
  reason: EndReason;
  /** The error if any lifecycle call threw, else null. */
  threw: Error | null;
  /** Which lifecycle phase threw. */
  threwIn: 'init' | 'start' | 'update' | 'render' | 'end' | null;
  steps: number;
  audit: RenderAudit;
  /** Heap growth across the run, in KB. A game allocating inside update()
   *  shows up here as a steadily climbing number. */
  allocGrowthKb: number;
  /** Wall time, ms. */
  elapsedMs: number;
  /** Events the game emitted, tallied by kind. */
  events: Record<string, number>;
  /** What the game asked the audio/HUD/fx services to do. Absent on a crash. */
  log?: CallLog;
}

/**
 * Load `id` from the registry, run a full round against a synthetic clip, and
 * report.
 *
 * Never throws for a game's own bug: the error is captured in `threw`, so one
 * broken game cannot take down a suite covering 57 others.
 */
export async function runGame(id: GameId, opts: RunOpts): Promise<RunReport> {
  const manifest = ALL.get(id);
  if (!manifest) throw new Error(`[harness] unknown game "${id}" — is src/games/${id}/ present?`);

  const view = opts.view ?? { w: 1280, h: 720 };
  const durationMs = opts.durationMs ?? manifest.durationMs;
  const steps = Math.min(opts.maxSteps ?? Infinity, Math.round((durationMs / 1000) * 60));
  const seed = opts.seed ?? 7;

  const g = new NullRenderer(view.w, view.h);
  g.strict = opts.strict ?? false;
  const log = createCallLog();

  const pose = replaySource(clip(opts.clip), {
    maxPlayers: manifest.players.max,
    view,
    loop: opts.loopClip ?? true,
  });
  await pose.start();
  // Games are entitled to a calibrated player: the real flow always calibrates
  // (or substitutes the default profile) before a round begins.
  await pose.calibrate(1200).catch(() => undefined);

  let t = 0;
  const gestures = createGestureService(() => frame, view);
  const fx = stubFx(log);
  const events: Record<string, number> = {};

  const ctx: GameContext = {
    manifest,
    view: { ...view, dpr: 1 },
    rng: mulberry32(seed),
    audio: stubAudio(log, () => t),
    gestures,
    fx,
    hud: stubHud(log),
    t: (k: string) => k,
    profiles: new Map(),
    emit(ev) { events[ev.kind] = (events[ev.kind] ?? 0) + 1; },
  };

  let frame = pose.sample(0);
  const factory = await load(id);
  const game = factory();

  const fail = (phase: RunReport['threwIn'], e: unknown): RunReport => ({
    id, manifest,
    result: emptyResult(id, manifest.scoring.maxScore),
    reason: 'aborted', threw: e instanceof Error ? e : new Error(String(e)),
    threwIn: phase, steps: done, audit: g.audit, allocGrowthKb: 0,
    elapsedMs: Date.now() - startedAt, events,
  });

  const startedAt = Date.now();
  const heapBefore = heapKb();
  let done = 0;

  try {
    await game.init(ctx);
  } catch (e) { return fail('init', e); }
  try {
    game.start();
  } catch (e) { return fail('start', e); }

  const render = opts.render ?? true;
  let reason: EndReason = 'timeUp';

  for (; done < steps; done++) {
    t = done / 60;
    frame = pose.sample(t);
    try {
      game.update(1 / 60, frame);
    } catch (e) { return fail('update', e); }
    if (render) {
      g.beginFrame(t);
      try {
        game.render(g, 0);
      } catch (e) { return fail('render', e); }
      g.endFrame();
    }
  }

  let result: GameResult;
  try {
    result = applyScoring(game.end(reason), manifest);
  } catch (e) { return fail('end', e); }
  try {
    game.dispose?.();
  } catch { /* a failed teardown must not mask the round's result */ }
  pose.stop();

  return {
    id, manifest, result, reason, threw: null, threwIn: null,
    steps: done, audit: g.audit,
    allocGrowthKb: Math.max(0, heapKb() - heapBefore),
    elapsedMs: Date.now() - startedAt,
    events,
    log,
  };
}

const heapKb = (): number => {
  const mu = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number } } }).process;
  return mu?.memoryUsage ? mu.memoryUsage().heapUsed / 1024 : 0;
};

const emptyResult = (gameId: GameId, maxScore: number): GameResult => ({
  gameId, cleared: false, rawScore: 0, maxScore,
  normalized: 0, stars: 0, durationMs: 0, perPlayer: [],
});

export { NullRenderer };
export type { RenderAudit };

// ══ FROZEN CONTRACT ══ every game author runs this before handing back.
//
// Drives a real MiniGame through its real lifecycle at a true fixed timestep,
// against a synthetic pose clip, in Node, with no DOM and no camera.
//
// A 40-second game is ~2400 steps and costs ~30ms of CPU, which is why 58
// games x 9 assertions finishes in under a minute — and therefore why this can
// be a pre-handback gate rather than a nightly job.
import type { EndReason, GameId, GameResult, MiniGameManifest } from '../types';
import type { ClipName } from './clips';
import { NullRenderer, type RenderAudit } from './nullRenderer';

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
}

/**
 * Load `id` from the registry, run a full round, and report.
 *
 * Never throws for a game's own bug: the error is captured in `threw` so one
 * broken game cannot take the whole suite down with it.
 */
export declare function runGame(id: GameId, opts: RunOpts): Promise<RunReport>;

export { NullRenderer };
export type { RenderAudit };

// Round scheduling: which games the roulette is allowed to offer next.
//
// Two jobs, both of which exist because the player is a child:
//   1. SAFETY — never three high-intensity games in a row, a rest after every
//      two hard ones, and a break prompt on a timer. The 30-60s round length
//      is the primary safety device; this is the secondary one.
//   2. VARIETY — no repeats until the bag empties, and avoid serving the same
//      mechanic family twice in a row, because two swat games back to back
//      read as "the same game again".
import type { MiniGameManifest, SpaceNeed } from './types';
import { ShuffleBag } from './shuffleBag';
import { pickPool, type PoolFilter } from './registry';

export interface SchedulerOpts extends Omit<PoolFilter, 'maxIntensity'> {
  /** Prompt a rest after this many rounds. Default 8. */
  breakEveryRounds?: number;
  /** Prompt a rest after this much play time. Default 10 minutes. */
  breakEveryMs?: number;
  /** Cap exertion globally (slow device, accessibility setting). */
  intensityCap?: 1 | 2 | 3;
}

export interface Shortlist {
  /** The 8 candidates shown on the wheel. */
  candidates: MiniGameManifest[];
  /** The pre-decided winner. The animation is cosmetic and cannot disagree. */
  winner: MiniGameManifest;
  winnerIndex: number;
}

/** Deliberately small — a 58-slice wheel is illegible and raises the
 *  "I didn't want that one" rate. */
export const WHEEL_SLICES = 8;

export class RoundScheduler {
  private bag = new ShuffleBag<string>();
  private history: MiniGameManifest[] = [];
  private playedMs = 0;
  private roundsSinceBreak = 0;
  private opts: SchedulerOpts;
  private lastPoolKey = '';

  constructor(opts: SchedulerOpts) {
    this.opts = { breakEveryRounds: 8, breakEveryMs: 10 * 60_000, ...opts };
  }

  /** Update the live constraints (a player joined, legs became invisible, the
   *  device got slow). Cheap to call every round. */
  configure(patch: Partial<SchedulerOpts>): void {
    this.opts = { ...this.opts, ...patch };
  }

  /** Exertion ceiling for the next round. */
  private intensityCeiling(): 1 | 2 | 3 {
    const cap = this.opts.intensityCap ?? 3;
    const recent = this.history.slice(-2);
    // Two hard games in a row forces a rest game next. This is the rule that
    // keeps a 20-minute party from turning into interval training.
    if (recent.length === 2 && recent.every((m) => m.intensity >= 3)) return 1;
    if (recent.length >= 1 && recent.at(-1)!.intensity >= 3) return Math.min(cap, 2) as 1 | 2 | 3;
    return cap;
  }

  private spaces(): readonly SpaceNeed[] {
    return this.opts.space;
  }

  /** Build the wheel for the next round. Returns null when nothing qualifies. */
  next(rngPick: (n: number) => number): Shortlist | null {
    const ceiling = this.intensityCeiling();
    const pool = pickPool({
      players: this.opts.players,
      space: this.spaces(),
      cameraOn: this.opts.cameraOn,
      maxIntensity: ceiling,
      ...(this.opts.lowerBodyVisible !== undefined
        ? { lowerBodyVisible: this.opts.lowerBodyVisible }
        : {}),
      ...(this.opts.includeDisabled !== undefined
        ? { includeDisabled: this.opts.includeDisabled }
        : {}),
    });
    if (pool.length === 0) {
      // Relax the exertion ceiling before giving up: a dead wheel is worse
      // than a slightly tiring round.
      const relaxed = pickPool({
        players: this.opts.players, space: this.spaces(), cameraOn: this.opts.cameraOn,
      });
      if (relaxed.length === 0) return null;
      pool.push(...relaxed);
    }

    const byId = new Map(pool.map((m) => [m.id, m]));
    const poolKey = [...byId.keys()].sort().join(',');
    if (poolKey !== this.lastPoolKey) {
      this.bag.setItems([...byId.keys()]);
      this.lastPoolKey = poolKey;
    }

    // Draw candidates for the wheel. The bag guarantees no repeat until it
    // empties, which is what makes the wheel read as fair.
    const candidates: MiniGameManifest[] = [];
    const seen = new Set<string>();
    const lastTags = new Set(this.history.at(-1)?.tags ?? []);
    const deferred: MiniGameManifest[] = [];

    for (let guard = 0; candidates.length < WHEEL_SLICES && guard < byId.size * 3; guard++) {
      const id = this.bag.draw();
      if (id === undefined) break;
      const m = byId.get(id);
      if (!m || seen.has(id)) continue;
      seen.add(id);
      // Push same-family games to the back of the queue rather than dropping
      // them: two swat games in a row reads as a repeat.
      if (candidates.length < WHEEL_SLICES - 2 && m.tags.some((t) => lastTags.has(t))) {
        deferred.push(m);
        continue;
      }
      candidates.push(m);
    }
    for (const m of deferred) {
      if (candidates.length >= WHEEL_SLICES) break;
      candidates.push(m);
    }
    if (candidates.length === 0) return null;

    const winnerIndex = rngPick(candidates.length);
    return { candidates, winner: candidates[winnerIndex]!, winnerIndex };
  }

  /** Record a completed round. */
  record(m: MiniGameManifest, durationMs: number): void {
    this.history.push(m);
    this.playedMs += durationMs;
    this.roundsSinceBreak++;
  }

  /** True when the player should be offered a rest. Intensity-weighted: a run
   *  of hard games earns a break sooner than a run of seated ones. */
  shouldBreak(): boolean {
    const weighted = this.history
      .slice(-this.roundsSinceBreak)
      .reduce((s, m) => s + m.intensity, 0);
    return (
      this.roundsSinceBreak >= (this.opts.breakEveryRounds ?? 8) ||
      weighted >= (this.opts.breakEveryRounds ?? 8) * 2 ||
      this.playedMs >= (this.opts.breakEveryMs ?? 600_000)
    );
  }

  takeBreak(): void {
    this.roundsSinceBreak = 0;
    this.playedMs = 0;
  }

  get rounds(): number {
    return this.history.length;
  }

  get played(): readonly MiniGameManifest[] {
    return this.history;
  }
}

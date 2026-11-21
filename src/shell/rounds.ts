// Round selection and pacing for the shell.
//
// Thin adapter over `RoundScheduler`, which is the single implementation of:
//   - the shuffle bag's no-repeat guarantee (children notice a repeat in two
//     minutes, and "또 이거야?" is the end of the party)
//   - mechanic variety (two swat games in a row read as the same game twice)
//
// On a kiosk the no-repeat guarantee matters for a different reason than it
// did in a classroom: consecutive rounds are played by different strangers,
// so a repeat is not "또 이거야?" but a booth that appears to contain one
// game. Intensity PACING, by contrast, is gone — it balanced exertion across
// one child's eight rounds, and there is no such person here. Each guest
// plays once and leaves.
//
// The scheduler is stateful (it owns the bag and the history), so it lives
// here as a module singleton while the reducer stays pure — the reducer only
// ever receives the already-decided result, which is also what guarantees the
// wheel animation cannot disagree with the winner.
import { ALL } from '@/engine/registry';
import type { PoolFilter } from '@/engine/registry';
import { RoundScheduler, WHEEL_SLICES } from '@/engine/scheduler';
import { secureInt } from '@/engine/rng';
import type { GameId, GameResult, MiniGameManifest } from '@/engine/types';
import { poolItems, toInfo, type GameInfo, type WheelItem } from './useSession';

let scheduler: RoundScheduler | null = null;
let lastFilter: PoolFilter | null = null;

function ensure(f: PoolFilter): RoundScheduler {
  if (!scheduler) {
    scheduler = new RoundScheduler({
      players: f.players,
      space: f.space,
      cameraOn: f.cameraOn,
      ...(f.lowerBodyVisible !== undefined ? { lowerBodyVisible: f.lowerBodyVisible } : {}),
      ...(f.includeDisabled !== undefined ? { includeDisabled: f.includeDisabled } : {}),
      ...(f.maxIntensity !== undefined ? { intensityCap: f.maxIntensity } : {}),
    });
  } else if (JSON.stringify(f) !== JSON.stringify(lastFilter)) {
    // Re-filtering mid-party (a player joins, the device slows down) updates
    // the constraints without resetting the no-repeat guarantee.
    scheduler.configure({
      players: f.players,
      space: f.space,
      cameraOn: f.cameraOn,
      ...(f.lowerBodyVisible !== undefined ? { lowerBodyVisible: f.lowerBodyVisible } : {}),
      ...(f.includeDisabled !== undefined ? { includeDisabled: f.includeDisabled } : {}),
      ...(f.maxIntensity !== undefined ? { intensityCap: f.maxIntensity } : {}),
    });
  }
  lastFilter = f;
  return scheduler;
}

export interface RoundPick {
  shortlist: WheelItem[];
  chosenIndex: number;
}

const asWheelItem = (g: GameInfo): WheelItem => ({
  id: g.id, nameKo: g.nameKo, icon: g.icon, hue: g.hue,
});

/**
 * Step 1 of the three-step rule: decide the winner BEFORE the wheel mounts.
 * The animation is purely cosmetic and cannot disagree with this result.
 */
export function decideRound(f: PoolFilter): RoundPick {
  const pick = ensure(f).next(secureInt);
  if (pick) {
    return {
      shortlist: pick.candidates.map((m) => asWheelItem(toInfo(m))),
      chosenIndex: pick.winnerIndex,
    };
  }
  // The scheduler can come up empty when the filter excludes everything (no
  // camera plus no lower body, say). Falling back to the unscheduled pool
  // keeps the booth playable; an empty shortlist makes the roulette say
  // "아직 게임이 없어요" rather than spin on nothing.
  const fallback: readonly GameInfo[] = poolItems(f);
  if (fallback.length === 0) return { shortlist: [], chosenIndex: 0 };
  const picked = fallback.slice(0, WHEEL_SLICES);
  return { shortlist: picked.map(asWheelItem), chosenIndex: secureInt(picked.length) };
}

/** Record a finished round so the no-repeat bag stays correct. */
export function recordRound(id: GameId, result: GameResult): void {
  const m: MiniGameManifest | undefined = ALL.get(id);
  if (!m || !scheduler) return;
  scheduler.record(m, result.durationMs);
}

export const roundsPlayed = (): number => scheduler?.rounds ?? 0;

/** Tests only. */
export function __resetRounds(): void {
  scheduler = null;
  lastFilter = null;
}

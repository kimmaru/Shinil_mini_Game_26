// Star rating, computed by the ENGINE from `manifest.scoring.starCuts`.
//
// Deliberately not left to games: 58 independent authors produce 58 difficulty
// curves, and left alone every one of them awards three stars for showing up.
// Re-tuning a game's difficulty is then a one-line manifest change with no code
// touched, which is what makes the enable pass cheap.
import { clamp01 } from './math';
import type { GameResult, MiniGameManifest } from './types';

export function normalizeScore(raw: number, maxScore: number): number {
  return maxScore <= 0 ? 0 : clamp01(raw / maxScore);
}

export function starsFor(normalized: number, cuts: readonly [number, number, number]): 0 | 1 | 2 | 3 {
  const n = clamp01(normalized);
  if (n >= cuts[2]) return 3;
  if (n >= cuts[1]) return 2;
  if (n >= cuts[0]) return 1;
  return 0;
}

/** Overwrite whatever the game reported for `normalized` and `stars`, so the
 *  rating system means the same thing across the whole catalogue. */
export function applyScoring(r: GameResult, m: MiniGameManifest): GameResult {
  const maxScore = r.maxScore > 0 ? r.maxScore : m.scoring.maxScore;
  const normalized = normalizeScore(r.rawScore, maxScore);
  return { ...r, maxScore, normalized, stars: starsFor(normalized, m.scoring.starCuts) };
}

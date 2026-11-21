import { describe, expect, it } from 'vitest';
import { applyScoring, normalizeScore, starsFor } from './stars';
import type { GameResult, MiniGameManifest } from './types';

const cuts = [0.25, 0.5, 0.75] as const;

describe('star rating', () => {
  it('awards stars at the cut boundaries inclusively', () => {
    expect(starsFor(0, cuts)).toBe(0);
    expect(starsFor(0.249, cuts)).toBe(0);
    expect(starsFor(0.25, cuts)).toBe(1);
    expect(starsFor(0.5, cuts)).toBe(2);
    expect(starsFor(0.75, cuts)).toBe(3);
    expect(starsFor(1, cuts)).toBe(3);
  });

  it('clamps scores beyond maxScore instead of awarding 4 stars', () => {
    expect(normalizeScore(999, 10)).toBe(1);
    expect(starsFor(normalizeScore(999, 10), cuts)).toBe(3);
  });

  it('survives a maxScore of zero', () => {
    expect(normalizeScore(5, 0)).toBe(0);
  });

  it('overrides whatever the game reported', () => {
    // A game cannot award itself three stars: the engine recomputes from the
    // manifest, which is what keeps the rating meaningful across 58 authors.
    const m = { scoring: { maxScore: 20, starCuts: cuts } } as MiniGameManifest;
    const cheeky: GameResult = {
      gameId: 'x', cleared: true, rawScore: 2, maxScore: 20,
      normalized: 1, stars: 3, durationMs: 1, perPlayer: [],
    };
    const fixed = applyScoring(cheeky, m);
    expect(fixed.normalized).toBeCloseTo(0.1);
    expect(fixed.stars).toBe(0);
  });

  it('falls back to the manifest maxScore when the result omits it', () => {
    const m = { scoring: { maxScore: 50, starCuts: cuts } } as MiniGameManifest;
    const r: GameResult = {
      gameId: 'x', cleared: true, rawScore: 25, maxScore: 0,
      normalized: 0, stars: 0, durationMs: 1, perPlayer: [],
    };
    expect(applyScoring(r, m).stars).toBe(2);
  });
});

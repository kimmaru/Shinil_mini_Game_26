import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'balloon-pop-party',
  nameKo: '풍선 폭발 파티',
  taglineKo: '몸 어디든 닿으면 터져요!',
  howToKo: ['풍선에 몸을 대면 터져요', '가시 풍선만 피해요'],
  icon: 'balloon',
  theme: { hue: 322 },

  // The easiest game in the catalogue on purpose: a first-timer's first game,
  // no way to lose, every body part works.
  difficulty: 1,
  intensity: 2,
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  // Every one of the 33 landmarks is a hit zone, not just the hands — the
  // closest declared tag is 'fullBody'.
  requiredLandmarks: ['fullBody'],
  // No detector drives the scoring (see index.ts); 'reach' is the closest
  // existing demo hint to "move your hands toward things" for the intro
  // screen's badge, even though the real mechanic is whole-body contact.
  gestures: ['reach'],

  durationMs: 40_000,
  scoring: { kind: 'count', maxScore: 70, starCuts: [0.22, 0.48, 0.74] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['첫게임', '전신', '파티'],
  version: 1,
  author: 'A1',
  enabled: false,
  dev: { clip: 'reach-grid' },
};

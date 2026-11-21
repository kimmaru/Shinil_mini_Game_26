import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'max-reach-stretch',
  nameKo: '쭉쭉 스트레칭',
  taglineKo: '별까지 팔을 쭉 뻗어요!',
  howToKo: ['별이 나온 쪽 팔을 쭉 뻗어요', '별에 손을 대고 잠깐 버텨요', '별이 두 개면 양팔을 함께 뻗어요'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. */
  icon: 'gi-max-reach-stretch',
  theme: { hue: 168 },

  difficulty: 1,
  // A stretch, not cardio: slow reaches and short holds, alternating sides.
  // Still on your feet with arms moving the whole round, so not a 1.
  intensity: 2,
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['reach'],

  durationMs: 45_000,
  // A strong player finishes ~17 stretches (every 5th two-armed, 20) with most
  // held all the way out (+5): ~240. reach-grid, which sweeps every direction
  // without following the stars, lands on one star (seed 3: 65).
  scoring: { kind: 'count', maxScore: 240, starCuts: [0.2, 0.5, 0.75] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['스트레칭', '공정', '서서'],
  version: 1,
  author: 'A5',
  enabled: true,
  dev: { clip: 'reach-grid' },
};

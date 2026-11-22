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
  // A child who stretches every star all the way out at ~1.2 m (scratch
  // oracle, 0.5 s reaction) finishes ~20 stretches, every one a +5 "all the
  // way": ~315. reach-grid, which sweeps every direction without following
  // the stars, lands on one star (seed 3: 95); hold-poses on two.
  scoring: { kind: 'count', maxScore: 290, starCuts: [0.2, 0.5, 0.75] },

  a11y: {
    // Every 5th star needs BOTH arms out at once; the mouse drives one hand
    // and Z/X only raise straight up, so those stars cannot be finished.
    keyboardFallback: false,
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

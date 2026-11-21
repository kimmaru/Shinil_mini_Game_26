import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'web-cut',
  nameKo: '거미줄 자르기',
  taglineKo: '줄을 비껴 베어요!',
  howToKo: ['손으로 거미줄을 쓱 베어요', '줄을 가로질러야 끊어져요', '노란 줄과 거미는 피해요'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. */
  icon: 'gi-web-cut',
  theme: { hue: 266 },

  difficulty: 2,
  intensity: 2,
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['swing'],

  durationMs: 45_000,
  // A stroke only cuts a thread when it crosses at 45 degrees or more, so a
  // blind sweep lands only some of its crossings: `swing-wide`, which has no
  // idea where the threads are, scores about a third of maxScore. A competent
  // child cuts ~25 threads and frees a few friends, which is three stars.
  scoring: { kind: 'count', maxScore: 500, starCuts: [0.26, 0.5, 0.74] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['순발력', '집중', '서서'],
  version: 1,
  author: 'A3',
  enabled: true,
  dev: { clip: 'swing-wide' },
};

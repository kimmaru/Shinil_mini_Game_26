import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'web-cut',
  nameKo: '거미줄 자르기',
  taglineKo: '줄을 비껴 베어요!',
  howToKo: ['거미줄을 손으로 가로질러 쓱!', '줄과 비스듬히 베야 끊어져요', '노란 줄과 거미는 피해요'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. */
  icon: 'cross',
  theme: { hue: 266 },

  difficulty: 2,
  intensity: 2,
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['swing'],

  durationMs: 45_000,
  // The angle gate is what sets this apart from `fruit-slash`: a stroke only
  // cuts when it crosses the thread at 60 degrees or more, so a blind sweep
  // lands roughly a third of its crossings. Measured against `swing-wide`,
  // which has no idea where the threads are.
  scoring: { kind: 'count', maxScore: 460, starCuts: [0.26, 0.5, 0.74] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['순발력', '집중', '서서'],
  version: 1,
  author: 'A3',
  enabled: false,
  dev: { clip: 'swing-wide' },
};

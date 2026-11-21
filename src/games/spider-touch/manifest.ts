import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'spider-touch',
  nameKo: '거미 손 터치',
  taglineKo: '기어오르는 점을 짚어요!',
  howToKo: ['벽을 기어오르는 점을 손으로 짚어요', '점점 더 먼 곳에 나타나요', '가끔 한쪽 손만 써야 해요'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. */
  icon: 'target',
  theme: { hue: 266 },

  difficulty: 2,
  intensity: 2,
  // Reaching to the sides and overhead needs room to extend both arms.
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['reach'],

  durationMs: 50_000,
  // ~55-60 spider-dots appear in a round (mix of 1 and simultaneous-2 spawns).
  // A confident player clears most of them; late far/max-distance dots and the
  // single-hand-only dots are where the real challenge lives.
  scoring: { kind: 'count', maxScore: 420, starCuts: [0.25, 0.5, 0.78] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['정확도', '파티', '서서'],
  version: 1,
  author: 'A5',
  enabled: false,
  dev: { clip: 'reach-grid' },
};

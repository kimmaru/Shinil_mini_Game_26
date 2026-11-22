import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'spider-touch',
  nameKo: '거미 손 터치',
  taglineKo: '거미를 손으로 짚어요!',
  howToKo: ['거미 동그라미를 손으로 짚어요', '점점 더 멀리 나타나요', '왼손만, 오른손만 쓸 때도 있어요'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. */
  icon: 'gi-spider-touch',
  theme: { hue: 266 },

  difficulty: 2,
  intensity: 2,
  // Reaching to the sides and overhead needs room to extend both arms.
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['reach'],

  durationMs: 50_000,
  // A spider counts after a 200ms press (index.ts CONFIRM). Measured with an
  // aiming player on the virtual body (reaction 0.3-0.6s): 34-38 spiders for
  // 560-680. The dev clip (far-small, a slow arm sweep at 4 m that pauses at
  // each end) scores 260-285 = 1 star; a fast flail (swing-wide) scores 0.
  scoring: { kind: 'count', maxScore: 600, starCuts: [0.25, 0.5, 0.78] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['정확도', '파티', '서서'],
  version: 1,
  author: 'A5',
  enabled: true,
  dev: { clip: 'far-small' },
};

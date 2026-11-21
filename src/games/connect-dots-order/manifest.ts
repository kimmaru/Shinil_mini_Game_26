import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'connect-dots-order',
  nameKo: '점 잇기',
  taglineKo: '번호대로 점을 이어요!',
  howToKo: ['손을 다음 번호 점에 가져가요', '틀린 점은 그냥 지나쳐요', '끝까지 이으면 완성!'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. */
  icon: 'circle',
  theme: { hue: 42 },

  difficulty: 2,
  // Dots spread toward the view's edges late on — a standing, stepping game.
  intensity: 2,
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['reach'],

  durationMs: 50_000,
  // 3 drawings (the third is two at once, one per hand). Checked with the
  // replay harness.
  scoring: { kind: 'time', maxScore: 250, starCuts: [0.25, 0.5, 0.75] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    // Dots are told apart by their printed number, never by colour alone.
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['그리기', '기억력', '파티'],
  version: 1,
  author: 'A4',
  enabled: false,
  // reach-grid sweeps both hands across the whole frame — needed here more
  // than anywhere else in the batch, since dots sit at reach-scaled, not
  // fixed, positions.
  dev: { clip: 'reach-grid' },
};

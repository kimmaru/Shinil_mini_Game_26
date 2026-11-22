import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'connect-dots-order',
  nameKo: '점 잇기',
  taglineKo: '번호대로 점을 이어요!',
  howToKo: ['손으로 1번 점부터 차례로 만져요', '순서가 다른 점은 그냥 둬요', '끝까지 이으면 그림 완성!'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. */
  icon: 'gi-connect-dots-order',
  theme: { hue: 42 },

  difficulty: 2,
  // Arms only: every dot sits inside the nearest hand's reach.
  intensity: 1,
  space: 'seated',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['reach'],

  durationMs: 50_000,
  // 5 pictures (two are drawn by both hands at once), 27 dots at 4 plus 20-30
  // a picture: 258 if all five are fast. A pointer oracle draws each in ~5.5 s
  // (all five fit in 50 s); a competent 9-year-old finishes ~4 (~190-220).
  scoring: { kind: 'time', maxScore: 220, starCuts: [0.15, 0.45, 0.72] },

  a11y: {
    // False: the mouse drives one hand at a time and the body walks under the
    // pointer, so a left-hand dot that ends up right of the body can only be
    // reached by the right hand. A pointer run stalls on the first
    // two-hand picture.
    keyboardFallback: false,
    noFlashing: true,
    // Dots are told apart by their printed number, never by colour alone.
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['그리기', '기억력', '파티'],
  version: 1,
  author: 'A4',
  enabled: true,
  // No synthetic clip aims at numbered dots; swing-wide sweeps both arms
  // through the whole reach shell, so it is the closest honest probe.
  dev: { clip: 'swing-wide' },
};

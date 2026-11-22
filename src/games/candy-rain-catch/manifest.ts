import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'candy-rain-catch',
  nameKo: '사탕비 받아요',
  taglineKo: '머리 바구니로 받아요!',
  howToKo: ['머리 위에 바구니가 있어요', '몸을 움직여 사탕을 받아요', '돌멩이는 피해요!'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. */
  icon: 'gi-candy-rain-catch',
  theme: { hue: 320 },

  difficulty: 1,
  intensity: 2,
  // Side-to-side movement, so the player needs to be on their feet.
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['head', 'arms', 'hands', 'torso'],
  gestures: ['reach'],

  durationMs: 45_000,
  // ~75 drops, ~65 sweets worth 264-288 before combo bonuses. Measured at
  // 1440x900, seeds 1-5: clips that never chase anything top out at 166
  // (knee-run) and 139 (arm flailing at 1.2 m), so both stay under three stars;
  // step-lr lands on one. A pointer bot that follows every sweet scores
  // 235-296 (~1.1). One star at 0.25: the step-lr dev clip (sidestepping,
  // never chasing) scores 69 at 1280x720 and must still earn it.
  scoring: { kind: 'count', maxScore: 240, starCuts: [0.25, 0.55, 0.78] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['순발력', '파티', '움직임'],
  version: 1,
  author: 'lead',
  enabled: true,
  dev: { clip: 'step-lr' },
};

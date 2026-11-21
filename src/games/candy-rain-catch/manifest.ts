import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'candy-rain-catch',
  nameKo: '사탕비 받아요',
  taglineKo: '머리 바구니로 받아요!',
  howToKo: ['머리 위에 바구니가 있어요', '몸을 움직여 사탕을 받으세요', '돌멩이는 피해요!'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. */
  icon: 'candy',
  theme: { hue: 320 },

  difficulty: 1,
  intensity: 2,
  // Side-to-side movement, so the player needs to be on their feet.
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['head', 'arms', 'hands', 'torso'],
  gestures: ['reach'],

  durationMs: 45_000,
  // ~60 sweets fall in a round. Calibrated against the step-lr clip, which
  // sweeps side to side WITHOUT chasing anything — roughly the floor of real
  // play — and lands on one star. A child who actually follows the sweets
  // should reach two or three.
  scoring: { kind: 'count', maxScore: 110, starCuts: [0.3, 0.55, 0.78] },

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

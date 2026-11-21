import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'color-shield-block',
  nameKo: '색깔 방패',
  taglineKo: '색에 맞는 곳으로 막아요!',
  howToKo: ['빨간 세모 공은 오른손으로 막아요', '파란 네모 공은 왼손으로 막아요', '노란 동그라미 공은 머리로 막아요'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. */
  icon: 'gi-color-shield-block',
  theme: { hue: 212 },

  // A choice reaction, not a reflex: the child has to read the badge and pick
  // a limb. That is the cognitive load the 3 is for.
  difficulty: 3,
  intensity: 2,
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['head', 'arms', 'hands', 'torso'],
  gestures: ['reach'],

  durationMs: 50_000,
  // About 54 balls arrive in a round at 20 points each. A strong child blocks
  // 30 of them. `swing-wide` sweeps both arms through the hand slots without
  // ever leaning its head, so it blocks only the red and blue ones (22) and
  // sits just under three stars.
  scoring: { kind: 'count', maxScore: 600, starCuts: [0.26, 0.5, 0.74] },

  a11y: {
    // A yellow ball is blocked by moving the HEAD half a shoulder-width off
    // centre. `VirtualPoseSource`'s lean reaches about 0.19, which is inside
    // the fidget noise floor, so keyboard play would hand a third of the balls
    // to nobody. The pool filter hides the game instead of serving a broken
    // round — docs/GAME_AUTHORING.md §11.
    keyboardFallback: false,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['순발력', '판단력', '서서'],
  version: 1,
  author: 'A3',
  enabled: true,
  dev: { clip: 'swing-wide' },
};

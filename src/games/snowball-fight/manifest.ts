import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'snowball-fight',
  nameKo: '눈싸움',
  taglineKo: '피하고 던져요!',
  howToKo: [
    '표시된 자리에서 옆으로 피해요',
    '큰 눈덩이는 몸을 숙여요',
    '팔을 접었다가 눈사람 쪽으로 쭉 뻗어요',
  ],
  icon: 'gi-snowball-fight',
  theme: { hue: 192 },

  difficulty: 2,
  // Sidesteps, ducks and overarm throws for a minute: the most tiring game of
  // this set, and honestly a 3 so the scheduler will not stack it.
  intensity: 3,
  space: 'room',
  // 1v1 is Wave 5's problem (it needs reliable two-person identity). This is
  // one child against the snowmen.
  players: { min: 1, max: 1, mode: 'solo' },

  // No 'legs': the torso is the shoulder centre plus the origin of `n`, which
  // the engine estimates from the shoulders when the hips are out of frame,
  // so a waist-up child close to the laptop can dodge and throw.
  requiredLandmarks: ['head', 'arms', 'hands', 'torso'],
  gestures: ['reach'],

  durationMs: 60_000,
  // Measured on synthetic clips: an honest thrower (wind up, hold, extend
  // toward a snowman every 2s) lands ~29 throws for 441 (0.92); the same
  // waist-up with the hips out of frame 377-416; throwing while stepping
  // side to side 341. A windmill no longer throws at all. Dodging alone
  // (step-lr, the dev clip: no clip throws honestly) earns ~90-100 = 1 star.
  scoring: { kind: 'count', maxScore: 480, starCuts: [0.15, 0.55, 0.78] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['순발력', '파티', '움직임'],
  version: 1,
  author: 'A2',
  enabled: true,
  dev: { clip: 'step-lr' },
};

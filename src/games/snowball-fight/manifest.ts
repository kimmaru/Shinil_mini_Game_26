import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'snowball-fight',
  nameKo: '눈싸움',
  taglineKo: '피하고 던져요!',
  howToKo: [
    '표시된 자리에서 옆으로 피해요',
    '큰 눈덩이는 몸을 숙여요',
    '팔을 당겼다가 앞으로 던져요',
  ],
  icon: 'circle',
  theme: { hue: 192 },

  difficulty: 2,
  // Sidesteps, ducks and overarm throws for a minute: the most tiring game of
  // this set, and honestly a 3 so the scheduler will not stack it.
  intensity: 3,
  space: 'room',
  // 1v1 is Wave 5's problem (it needs reliable two-person identity). This is
  // one child against the snowmen.
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['head', 'arms', 'hands', 'torso'],
  gestures: ['reach'],

  durationMs: 60_000,
  // ~22 counter-throws land in a strong round at 15 each, and the player keeps
  // most of their 5 hearts. Calibrated against swing-wide — the closest thing
  // in the clip corpus to a throw, and a clip that never dodges anything.
  scoring: { kind: 'count', maxScore: 330, starCuts: [0.3, 0.55, 0.8] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['순발력', '파티', '움직임'],
  version: 1,
  author: 'A2',
  enabled: false,
  dev: { clip: 'swing-wide' },
};

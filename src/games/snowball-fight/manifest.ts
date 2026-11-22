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

  // 'legs': hits and dodges are judged on the shoulder-to-hip torso, so with
  // the hips out of frame nothing can hit or be dodged.
  requiredLandmarks: ['head', 'arms', 'hands', 'torso', 'legs'],
  gestures: ['reach'],

  durationMs: 60_000,
  // ~25 counter-throws land in a strong round at 15-20 each, plus 8 for every
  // snowball dodged. Being hit only breaks the combo and never ends the round.
  // swing-wide is the closest clip to a throw and never dodges, and lands above
  // maxScore: a perfect flail is better than a real child.
  scoring: { kind: 'count', maxScore: 480, starCuts: [0.3, 0.55, 0.78] },

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
  dev: { clip: 'swing-wide' },
};

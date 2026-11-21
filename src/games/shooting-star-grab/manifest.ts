import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'shooting-star-grab',
  nameKo: '별똥별 잡기',
  taglineKo: '별이 가는 쪽으로 쓸어요!',
  howToKo: [
    '별똥별을 손으로 쓸어 잡아요',
    '별이 가는 쪽으로 쓸면 점수가 더 커요!',
    '두 개가 오면 양손을 써요',
  ],
  icon: 'gi-shooting-star-grab',
  theme: { hue: 266 },

  difficulty: 2,
  // Big arm sweeps, feet planted. Tiring for the shoulders, not for the legs.
  intensity: 2,
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['reach'],

  durationMs: 50_000,
  // ~41 stars cross in a round. A catch is 10, a catch swept the way the star
  // is going is 30. A competent 9-year-old catches ~28 with over half swept
  // right (~600); maxScore sits below that so 3 stars is reachable. The dev
  // clip, a blind arm-windmill, catches ~14 by luck and lands one star.
  scoring: { kind: 'count', maxScore: 520, starCuts: [0.3, 0.55, 0.8] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['순발력', '집중', '움직임'],
  version: 1,
  author: 'A2',
  enabled: true,
  dev: { clip: 'swing-wide' },
};

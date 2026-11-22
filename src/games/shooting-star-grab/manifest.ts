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
  // ~43 stars cross in a round. A catch is 10, a catch swept the way the star
  // is going is 30. A pointer oracle at the 1.2 m framing catches 21-34
  // (430-720); a competent 9-year-old ~25 with half swept right (~500). The
  // dev clip, a blind arm-windmill, catches up to 19 (390): 2 stars, not 3.
  scoring: { kind: 'count', maxScore: 560, starCuts: [0.3, 0.55, 0.8] },

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

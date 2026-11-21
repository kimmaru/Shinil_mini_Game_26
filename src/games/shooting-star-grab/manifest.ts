import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'shooting-star-grab',
  nameKo: '별똥별 낚아채기',
  taglineKo: '별이 가는 쪽으로 쓸어요!',
  howToKo: [
    '별똥별이 가는 쪽으로 손을 움직여요',
    '별이 손에 붙으면 그대로 쓸어요',
    '두 개가 오면 양손을 써요',
  ],
  icon: 'star',
  theme: { hue: 266 },

  difficulty: 2,
  // Big arm sweeps, feet planted. Tiring for the shoulders, not for the legs.
  intensity: 2,
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['head', 'arms', 'hands', 'torso'],
  gestures: ['reach'],

  durationMs: 50_000,
  // ~30 stars cross in a round. A catch is 20, a direction-matched catch 40,
  // plus a small combo bonus — so a strong round is ~26 catches with half of
  // them clean. Calibrated against the swing-wide clip, which sweeps hard but
  // matches nothing on purpose, and lands around two stars.
  scoring: { kind: 'count', maxScore: 620, starCuts: [0.3, 0.55, 0.8] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['순발력', '집중', '움직임'],
  version: 1,
  author: 'A2',
  enabled: false,
  dev: { clip: 'swing-wide' },
};

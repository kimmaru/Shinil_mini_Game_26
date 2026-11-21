import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'balloon-pop-party',
  nameKo: '풍선 폭발 파티',
  taglineKo: '몸으로 풍선을 터뜨려요!',
  howToKo: ['손과 몸으로 풍선을 터뜨려요', '뾰족한 가시 풍선은 피해요'],
  icon: 'gi-balloon-pop-party',
  theme: { hue: 322 },

  // The easiest game in the catalogue on purpose: a first-timer's first game,
  // no way to lose, every body part works.
  difficulty: 1,
  intensity: 2,
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  // Hands do most of the work; legs and feet pop balloons too when visible,
  // but a child standing close to the laptop is never left out.
  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['reach'],

  durationMs: 40_000,
  // ~110 balloons spawn; a competent 9-year-old pops ~50-60 plus a few 10-combo
  // bonuses. The dev clip (stepping side to side) scores ~80% of maxScore.
  scoring: { kind: 'count', maxScore: 80, starCuts: [0.22, 0.48, 0.74] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['첫게임', '전신', '파티'],
  version: 1,
  author: 'A1',
  enabled: true,
  dev: { clip: 'step-lr' },
};

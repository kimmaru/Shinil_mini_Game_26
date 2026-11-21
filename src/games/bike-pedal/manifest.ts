import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'bike-pedal',
  nameKo: '자전거 페달',
  taglineKo: '손으로 페달을 굴려요!',
  howToKo: ['두 손으로 둥글게 돌려요', '번갈아 돌리면 더 좋아요', '반대로! 할 때도 계속 돌려요'],
  // A sprite id from src/engine/render/sprites.ts — never an emoji.
  icon: 'ui-gear',
  theme: { hue: 238 },

  // Needs real left-right coordination, so difficulty 2; seated and gentle,
  // so intensity 1 (the validator also rejects seated + intensity >= 2).
  difficulty: 2,
  intensity: 1,
  space: 'seated',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['rep'],

  durationMs: 40_000,
  // No real playtest data yet — distance is a cadence integral with hill and
  // form multipliers, estimated against a perfectly alternating metronome.
  // The lead should re-check starCuts after a real play.
  scoring: { kind: 'count', maxScore: 120, starCuts: [0.3, 0.55, 0.85] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['페달', '협응력', '앉아서'],
  version: 1,
  author: 'A7',
  enabled: false,
  dev: { clip: 'knee-run' },
};

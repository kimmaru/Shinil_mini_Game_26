import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'bike-pedal',
  nameKo: '자전거 페달',
  taglineKo: '손으로 페달을 굴려요!',
  howToKo: ['두 손을 번갈아 둥글게 돌려요', '빨리 돌릴수록 자전거가 빨라요', '오르막에서는 힘을 내요!'],
  icon: 'gi-bike-pedal',
  theme: { hue: 192 },

  // Seated and gentle: intensity 1 (the validator rejects seated + 2).
  difficulty: 2,
  intensity: 1,
  space: 'seated',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['rep'],

  durationMs: 40_000,
  // A star is worth 10 and arrives every 5 alternating strides, so the score
  // is distance ridden. See NEEDS.md for why cadence, not rotation, is read.
  scoring: { kind: 'count', maxScore: 170, starCuts: [0.3, 0.55, 0.8] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['페달', '협응력', '앉아서'],
  version: 2,
  author: 'A7',
  enabled: true,
  dev: { clip: 'swing-wide' },
};

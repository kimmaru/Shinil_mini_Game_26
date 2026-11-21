import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'wrist-maze',
  nameKo: '손끝 미로',
  taglineKo: '빛구슬로 미로를 통과해요',
  howToKo: ['손끝의 빛구슬을 움직여요', '벽에 닿으면 처음으로 돌아가요', '끝까지 가면 통과!'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. */
  icon: 'droplet',
  theme: { hue: 168 },

  // The filtering litmus test: no smoothing here is the worst-feeling game
  // in the batch.
  difficulty: 2,
  intensity: 1,
  space: 'seated',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['reach'],

  durationMs: 40_000,
  // 3 mazes; a strong clear of all three (fast, no wall touches) lands near
  // maxScore. Checked with the replay harness.
  scoring: { kind: 'time', maxScore: 130, starCuts: [0.25, 0.5, 0.75] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['집중력', '미로', '파티'],
  version: 1,
  author: 'A4',
  enabled: false,
  // reach-grid sweeps both hands across the whole frame, which is what
  // answers "can a hand actually travel this corridor" for free.
  dev: { clip: 'reach-grid' },
};

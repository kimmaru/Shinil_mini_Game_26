import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'wrist-maze',
  nameKo: '손끝 미로',
  taglineKo: '빛구슬을 길 끝까지!',
  howToKo: ['손을 시작 동그라미에 올려요', '길 안에서 빛구슬을 옮겨요', '별까지 가면 통과!'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. */
  icon: 'gi-wrist-maze',
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
  // Up to 6 mazes (3 shapes, run twice with the hands swapped). A competent
  // 9-year-old clears ~5 at 20-35 plus checkpoints (~180); maxScore sits below
  // that so three stars is reachable.
  scoring: { kind: 'time', maxScore: 140, starCuts: [0.16, 0.45, 0.72] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['집중력', '미로', '파티'],
  version: 1,
  author: 'A4',
  enabled: true,
  // reach-grid sweeps the hands across the whole frame, which
  // answers "can a hand actually travel this corridor" for free.
  dev: { clip: 'reach-grid' },
};

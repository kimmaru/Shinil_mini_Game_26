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
  // Up to 6 mazes (3 shapes, run twice with the hands swapped; one that takes
  // 14 s moves on). A maze is 20/28/35 plus 8 for checkpoints. A pointer
  // oracle clears 4-5 (184-219); a competent 9-year-old ~4-5 (~150-200). A
  // blind arm-swing (swing-wide) lucks into up to 3 (129): 2 stars, not 3.
  scoring: { kind: 'time', maxScore: 200, starCuts: [0.16, 0.45, 0.72] },

  a11y: {
    // False: the mouse drives one hand at a time and the body walks under the
    // pointer, so a pointer run could not clear every left-hand / gate maze.
    keyboardFallback: false,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['집중력', '미로', '파티'],
  version: 1,
  author: 'A4',
  enabled: true,
  // reach-grid's slow raster now meets each maze only after its 14 s timeout
  // has moved on, so it scores 0. laggy's arm arcs trace two mazes, which is
  // the anti-dead-game probe: "a hand can travel this corridor".
  dev: { clip: 'laggy' },
};

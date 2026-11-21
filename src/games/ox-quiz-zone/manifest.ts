import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'ox-quiz-zone',
  nameKo: 'OX 퀴즈',
  taglineKo: '문제를 읽고 몸으로 이동해요!',
  howToKo: ['문제를 읽고 잘 생각해요', '맞으면 왼쪽(O)으로 가요', '아니면 오른쪽(X)으로 가요'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. The
   *  giant O/X zone backgrounds are drawn by this game, not this lobby icon. */
  icon: 'gi-ox-quiz-zone',
  theme: { hue: 92 },

  // Reading + judging a statement, not just reacting to a cue — this is the
  // "think" game of the trio, not the "reflex" one.
  difficulty: 2,
  intensity: 2,
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  // Hips only: ankles/feet are deliberately NOT required, or the game would
  // hide itself for every laptop player whose feet are cropped out of frame.
  requiredLandmarks: ['torso'],
  gestures: ['zone'],

  durationMs: 50_000,
  // 8 questions x 20 points: a strong child gets every one, so maxScore is the
  // full 160. Guessing (4 of 8) lands on one star; 6 of 8 earns the third.
  // `step-lr` commits to a side every ~4s without reading, so it gets about half.
  scoring: { kind: 'count', maxScore: 160, starCuts: [0.3, 0.55, 0.74] },

  a11y: {
    // ←/→ translate the whole virtual body's hip x, which is exactly the
    // signal the zone detectors read — no camera-only dead end here.
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['상식', 'OX퀴즈', '서서'],
  version: 1,
  author: 'A6',
  enabled: true,
  dev: { clip: 'step-lr' },
};

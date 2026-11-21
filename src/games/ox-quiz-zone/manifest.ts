import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'ox-quiz-zone',
  nameKo: 'OX 퀴즈',
  taglineKo: '문제를 듣고 몸으로 이동해요!',
  howToKo: ['문제를 잘 듣고 생각하세요', '맞으면 왼쪽(O), 틀리면 오른쪽(X)', '마감 전에 자리를 정하세요'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. The
   *  giant O/X zone backgrounds are drawn by this game, not this lobby icon. */
  icon: 'ring',
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
  // A strong player's score, not a theoretical maximum. 9 questions x 20pts
  // is 180 if every single one lands; measured on `step-lr` (a body that
  // actually commits to a side every ~4s, not a metronome) the round scores
  // 140, just past three stars.
  scoring: { kind: 'count', maxScore: 140, starCuts: [0.3, 0.55, 0.8] },

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
  enabled: false,
  dev: { clip: 'step-lr' },
};

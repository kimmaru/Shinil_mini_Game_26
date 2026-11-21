import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'wrist-aim-target',
  nameKo: '레이저 과녁',
  taglineKo: '손끝으로 과녁을 맞혀요!',
  howToKo: ['손끝 레이저를 과녁에 겨눠요', '1초 가만히 있으면 명중!', '폭탄 과녁은 피해요'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. */
  icon: 'target',
  theme: { hue: 238 },

  // Needs real stillness-over-a-point, not reflex timing.
  difficulty: 2,
  // Upper body only — this batch's "sit down and rest" slot in the schedule.
  intensity: 1,
  space: 'seated',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['reach'],

  durationMs: 45_000,
  // ~18-22 targets resolve in a strong round at 15-30pts each, minus the
  // occasional deliberate bomb dwell. Checked with the replay harness.
  scoring: { kind: 'count', maxScore: 260, starCuts: [0.26, 0.5, 0.74] },

  a11y: {
    // Mouse = dominant hand under VirtualPoseSource, which is exactly an aim
    // cursor — this game is fully playable with the keyboard fallback.
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['집중력', '조준', '파티'],
  version: 1,
  author: 'A4',
  enabled: false,
  // reach-grid sweeps both hands across the whole frame — the engine's own
  // "can the player actually reach my targets" clip, which is exactly what a
  // random reach-anchored target layout needs to be checked against.
  dev: { clip: 'reach-grid' },
};

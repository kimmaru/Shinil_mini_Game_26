import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'wrist-aim-target',
  nameKo: '레이저 과녁',
  taglineKo: '손끝으로 과녁을 맞혀요!',
  howToKo: ['손끝 불빛을 과녁에 올려요', '잠깐 멈추면 명중!', '검은 폭탄은 피해요'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. */
  icon: 'gi-wrist-aim-target',
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
  // A child who watches the laser dot and corrects (scratch oracle at ~1.2 m,
  // 0.45 s reaction) lands ~21 targets, ~15 of them bullseyes: ~360. A mouse
  // aimed perfectly in keyboard mode gets ~470. The blind-sweep dev clip parks
  // on a few targets by luck (seed 3: 60), so the 1-star cut sits at 0.15.
  scoring: { kind: 'count', maxScore: 360, starCuts: [0.15, 0.48, 0.72] },

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
  enabled: true,
  // reach-grid sweeps both hands across the whole frame — the engine's own
  // "can the player actually reach my targets" clip, which is exactly what a
  // random reach-anchored target layout needs to be checked against.
  dev: { clip: 'reach-grid' },
};

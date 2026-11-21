import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'koko-ko-touch',
  nameKo: '코코코 눈!',
  taglineKo: '말한 곳을 손으로 짚어요!',
  howToKo: ['코코코코... 하고 외쳐요', '마지막에 말한 곳을 짚어요', '후반엔 두 곳을 동시에 짚어요'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. */
  icon: 'check',
  theme: { hue: 26 },

  difficulty: 2,
  // A seated rest game for the scheduler — upper body only, no exertion.
  intensity: 1,
  space: 'seated',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['head', 'arms', 'hands', 'torso'],
  // No single built-in gesture matches "touch your own named landmark";
  // closest declared intent is holdPose (a pose check) — see NEEDS.md.
  gestures: ['holdPose'],

  durationMs: 40_000,
  // The very first prompt is a deterministic, generous freebie (see index.ts)
  // so a strong player's floor is never zero; everything after that is
  // random among whichever of 코/귀/눈/입/어깨/무릎 are actually visible.
  scoring: { kind: 'count', maxScore: 220, starCuts: [0.15, 0.45, 0.75] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['전래놀이', '반응', '앉아서'],
  version: 1,
  author: 'A5',
  enabled: false,
  dev: { clip: 'clap-x12' },
};

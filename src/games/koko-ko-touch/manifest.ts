import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'koko-ko-touch',
  nameKo: '코코코 눈!',
  taglineKo: '말한 곳을 손으로 짚어요!',
  howToKo: ['코코코 할 때 코를 콕콕 짚어요', '외친 곳을 얼른 손으로 짚어요', '손가락 말고 말을 따라가요!'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. */
  icon: 'gi-koko-ko-touch',
  theme: { hue: 26 },

  // 2: the trick prompts need inhibition ("ignore the finger"), not just speed.
  difficulty: 2,
  // A seated rest game for the scheduler — upper body only, no exertion.
  intensity: 1,
  space: 'seated',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['head', 'arms', 'hands', 'torso'],
  // Palms come from the rented reach detector; "touch your own landmark" is
  // judged locally — see NEEDS.md.
  gestures: ['reach'],

  durationMs: 40_000,
  // A strong player answers ~13 prompts in 40s, ~4 of them tricks (+15): ~140.
  // The clap-x12 clip brushes belly and shoulders on a metronome without
  // listening, and lands on one star (seed 3: 35).
  scoring: { kind: 'count', maxScore: 140, starCuts: [0.2, 0.5, 0.75] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['전래놀이', '반응', '앉아서'],
  version: 1,
  author: 'A5',
  enabled: true,
  dev: { clip: 'clap-x12' },
};

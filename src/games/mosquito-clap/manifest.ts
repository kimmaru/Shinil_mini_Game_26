import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'mosquito-clap',
  nameKo: '모기 박수',
  taglineKo: '모기를 박수로 잡아요!',
  howToKo: ['모기가 두 손 사이로 오면', '손뼉을 짝! 치세요'],
  icon: '🦟',
  theme: { hue: 142 },

  difficulty: 1,
  intensity: 1,
  // Playable sitting down, so the scheduler can use it as the rest game after
  // two hard ones.
  space: 'seated',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['clap'],

  durationMs: 40_000,
  // A strong player's score, not a theoretical maximum. ~40 bugs appear in a
  // round; a good 9-year-old catches most of them, and combo bonuses carry the
  // rest. Measured: the clap-x12 clip — a metronome, better than any child —
  // scores 36, which lands exactly on three stars.
  scoring: { kind: 'count', maxScore: 48, starCuts: [0.27, 0.52, 0.75] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['반사신경', '파티', '앉아서'],
  version: 1,
  author: 'lead',
  enabled: true,
  dev: { clip: 'clap-x12' },
};

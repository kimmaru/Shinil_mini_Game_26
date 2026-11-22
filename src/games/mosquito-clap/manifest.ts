import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'mosquito-clap',
  nameKo: '모기 박수',
  taglineKo: '모기를 박수로 잡아요!',
  howToKo: ['모기가 두 손 사이로 오면', '손뼉을 짝! 치세요', '벌은 잡지 마세요'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. */
  icon: 'gi-mosquito-clap',
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
  // A strong player's score, not a theoretical maximum. Measured with an
  // aiming player on the virtual body (walks to the nearest mosquito, claps
  // every 0.9-1.4s): 24-29 catches for 79-104. clap-x12 claps at chest height
  // without aiming: 25-36, i.e. one star — clapping alone is not the skill.
  scoring: { kind: 'count', maxScore: 90, starCuts: [0.2, 0.52, 0.75] },

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

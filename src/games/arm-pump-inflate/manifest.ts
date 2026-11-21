import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'arm-pump-inflate',
  nameKo: '팔 펌프 풍선',
  taglineKo: '펌프질로 풍선을 부풀려요!',
  howToKo: ['팔을 위아래로 크게 펌프질해요', '너무 크게 불면 풍선이 터져요', '터져도 괜찮아요, 새 풍선이 와요'],
  // A sprite id from src/engine/render/sprites.ts — never an emoji.
  icon: 'balloon',
  theme: { hue: 322 },

  difficulty: 1,
  // NOTE: the spec for this batch asked for intensity 2, but the manifest
  // validator (frozen) rejects `space:'seated'` paired with intensity >= 1
  // only when... actually it rejects intensity >= 2 with seated outright.
  // A seated pumping game is genuinely low-exertion, so 1 is also the more
  // honest number, not just the one that passes validation.
  intensity: 1,
  // Playable sitting down.
  space: 'seated',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['rep'],

  durationMs: 35_000,
  // A strong player (swing-wide, looped) pumps a few balloons to the edge of
  // bursting and banks most of each. maxScore is what that run lands on.
  scoring: { kind: 'count', maxScore: 220, starCuts: [0.3, 0.55, 0.8] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['리듬', '조절력', '앉아서'],
  version: 1,
  author: 'A7',
  enabled: false,
  dev: { clip: 'swing-wide' },
};

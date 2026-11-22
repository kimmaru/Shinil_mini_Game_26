import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'blue-flag-white-flag',
  nameKo: '청기백기',
  taglineKo: '청기 올려! 백기 내려!',
  howToKo: ['지시를 잘 읽어요', '오른손은 청기, 왼손은 백기예요', '"하지 말고"는 조심해요'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. The
   *  flags themselves are drawn by this game, not this lobby icon. */
  icon: 'gi-blue-flag-white-flag',
  theme: { hue: 212 },

  // The whole point is cognitive load, not coordination: color + verb +
  // negation, judged together. This is the hardest of the three A6 games.
  difficulty: 3,
  intensity: 1,
  space: 'seated',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['raise'],

  durationMs: 50_000,
  // 10 points per instruction. A keyboard oracle that reads, waits 0.6 s and
  // answers gets 20-21 (200-210); a competent child ~16-17. `swing-wide`
  // waves both arms on a fixed rhythm without reading anything and lands 12
  // (120): 2 stars, not 3.
  scoring: { kind: 'count', maxScore: 180, starCuts: [0.27, 0.5, 0.75] },

  a11y: {
    // Z/X raise the subject's own left/right wrist independently, which is
    // exactly the one signal this game reads.
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['인지력', '전래놀이', '앉아서'],
  version: 1,
  author: 'A6',
  enabled: true,
  dev: { clip: 'swing-wide' },
};

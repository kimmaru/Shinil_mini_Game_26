import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'blue-flag-white-flag',
  nameKo: '청기백기',
  taglineKo: '청기 올리고 백기 내려요!',
  howToKo: ['지시를 잘 듣고 보세요', '오른손=청기, 왼손=백기', '"~하지 말고"를 조심하세요'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. The
   *  flags themselves are drawn by this game, not this lobby icon. */
  icon: 'triangle',
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
  // A strong player's score, not a theoretical maximum. Measured: the
  // `swing-wide` clip — both arms sweeping opposite arcs, so every up/down x
  // left/right combination recurs every ~2s — scores 150, just past three
  // stars once `npm run shot` confirms the real distribution.
  scoring: { kind: 'count', maxScore: 150, starCuts: [0.27, 0.5, 0.75] },

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
  enabled: false,
  dev: { clip: 'swing-wide' },
};

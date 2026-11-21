import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'air-whack-mole',
  nameKo: '하늘 두더지',
  taglineKo: '손과 무릎으로 톡톡!',
  howToKo: ['손을 뻗어 두더지를 톡 쳐요', '무릎을 올려서 아래 두더지도 잡아요', '검은 폭탄은 피해요'],
  icon: 'gi-air-whack-mole',
  theme: { hue: 92 },

  difficulty: 2,
  // Upper AND lower body in the same round is why this is a 2, not a 1.
  intensity: 2,
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso', 'legs'],
  gestures: ['reach'],

  durationMs: 45_000,
  // ~60 moles spawn in a round. A competent 9-year-old taps ~65% of the plain
  // ones (10-18 pts) plus golds: ~400-450. The dev clip (swing-wide, a
  // metronomic arm flail) scores ~60% of that, i.e. 2 stars.
  scoring: { kind: 'count', maxScore: 480, starCuts: [0.3, 0.55, 0.78] },

  a11y: {
    // The bottom row is a targeted knee-raise into one of three columns.
    // VirtualPoseSource's squat/jump move both legs together with no column
    // aim, so half the grid would be permanently dead in keyboard mode —
    // exactly the "broken round" docs/GAME_AUTHORING.md says to hide instead
    // of serving. The top row (mouse-as-hand) would be fine alone, but the
    // round as a whole would not.
    keyboardFallback: false,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['전신', '반사신경', '파티'],
  version: 1,
  author: 'A1',
  enabled: true,
  dev: { clip: 'swing-wide' },
};

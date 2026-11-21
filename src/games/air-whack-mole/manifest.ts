import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'air-whack-mole',
  nameKo: '하늘 두더지',
  taglineKo: '손과 발로 두더지를 잡아요!',
  howToKo: ['위 칸은 손으로 때려요', '아래 칸은 무릎으로 밟아요'],
  icon: 'target',
  theme: { hue: 92 },

  difficulty: 2,
  // Upper AND lower body in the same round is why this is a 2, not a 1.
  intensity: 2,
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso', 'legs'],
  gestures: ['reach', 'zone'],

  durationMs: 45_000,
  // Measured on this game's own dev clip (reach-grid, which only ever
  // exercises the hand half of the grid — see index.ts): a full round scores
  // ~30. A real two-limbed player clears both rows, so this is a floor, not
  // a ceiling, but it is the only honest number available without a human.
  scoring: { kind: 'count', maxScore: 85, starCuts: [0.3, 0.55, 0.78] },

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
  enabled: false,
  dev: { clip: 'reach-grid' },
};

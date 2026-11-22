import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'air-whack-mole',
  nameKo: '하늘 두더지',
  taglineKo: '두더지를 손으로 톡톡!',
  howToKo: ['손을 뻗어 두더지를 톡 쳐요', '낮은 두더지가 나오면 무릎을 올려요', '검은 폭탄은 피해요'],
  icon: 'gi-air-whack-mole',
  theme: { hue: 92 },

  difficulty: 2,
  // Upper AND lower body in the same round is why this is a 2, not a 1.
  intensity: 2,
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  // No 'legs': knee moles only spawn while the knees are tracked (index.ts
  // spawnMole), so a waist-up child close to the laptop gets a hands-only round.
  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['reach'],

  durationMs: 45_000,
  // Measured with an aiming player on the virtual body (reaction 0.25-0.4s):
  // waist-up (hand moles only) 42-52 hits, combos to 23-30, 640-760; full
  // body while ignoring the knee moles 410-454. The dev clip (swing-wide, a
  // metronomic arm flail) scores 120-210 = 1 star; parked hands score 0.
  scoring: { kind: 'count', maxScore: 600, starCuts: [0.15, 0.55, 0.78] },

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

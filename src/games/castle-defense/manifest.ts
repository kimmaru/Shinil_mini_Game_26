import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'castle-defense',
  nameKo: '성 지키기',
  taglineKo: '떨어지는 바위를 쳐내요!',
  howToKo: ['손과 발로 바위를 쳐내요', '큰 바위는 두 번 쳐야 해요'],
  icon: 'rock',
  theme: { hue: 26 },

  difficulty: 3,
  intensity: 3,
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'legs', 'feet', 'torso'],
  // The hand swing is the rented 'swing' detector; the foot swing is a
  // hand-rolled equivalent (see NEEDS.md) with no matching GestureKind to
  // declare separately.
  gestures: ['swing'],

  durationMs: 60_000,
  // Measured on this game's own dev clip (swing-wide, a metronomic double
  // arm swing — see index.ts): a full round scores ~30. A real player covers
  // a wider spread of rock x-positions with both hands and feet, so this is
  // a floor, not a ceiling.
  scoring: { kind: 'count', maxScore: 95, starCuts: [0.28, 0.55, 0.8] },

  a11y: {
    // Half the catch area is a foot swing with no keyboard equivalent (mouse
    // only drives the dominant HAND). A keyboard round would let every rock
    // that gets past hand reach hit the castle for free — a broken round,
    // not a harder one.
    keyboardFallback: false,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['전신', '방어', '타이밍'],
  version: 1,
  author: 'A1',
  enabled: false,
  dev: { clip: 'swing-wide' },
};

import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'castle-defense',
  nameKo: '성 지키기',
  taglineKo: '떨어지는 바위를 쳐내요!',
  howToKo: ['손으로 바위를 쳐서 날려요', '큰 바위는 두 번 쳐요', '발로 차도 돼요'],
  icon: 'gi-castle-defense',
  theme: { hue: 26 },

  difficulty: 3,
  intensity: 3,
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  // The hand swing is the rented 'swing' detector; the optional foot swat is
  // hand-rolled (see NEEDS.md).
  gestures: ['swing'],

  durationMs: 50_000,
  scoring: { kind: 'count', maxScore: 650, starCuts: [0.25, 0.5, 0.75] },

  a11y: {
    // Hands alone play the whole game; the mouse drives the dominant hand.
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['전신', '방어', '타이밍'],
  version: 1,
  author: 'A1',
  enabled: true,
  dev: { clip: 'swing-wide' },
};

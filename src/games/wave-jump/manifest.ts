import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'wave-jump',
  nameKo: '파도 넘기',
  taglineKo: '파도를 뛰어넘어요!',
  howToKo: ['파도가 발밑으로 와요', '두 발로 콩! 뛰어넘으세요', '거품은 뛰면 안 돼요'],
  icon: '🌊',
  theme: { hue: 200 },

  difficulty: 2,
  intensity: 3,
  space: 'room',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['torso', 'legs', 'feet'],
  gestures: ['jump'],

  // Short on purpose: repeated jumping is the most tiring thing in the
  // catalogue, and the round length is the primary safety device.
  durationMs: 35_000,
  // Calibrated against the jump-x8 clip, which jumps on a fixed 2s metronome
  // without ever looking at the waves — roughly the floor of real play, and it
  // lands on one star. A child who times the waves should reach three.
  // Identical score on the 10fps `laggy` clip, so the rating survives a slow
  // school Chromebook.
  scoring: { kind: 'survival', maxScore: 45, starCuts: [0.25, 0.52, 0.78] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['점프', '순발력', '전신'],
  version: 1,
  author: 'lead',
  enabled: true,
  dev: { clip: 'jump-x8' },
};

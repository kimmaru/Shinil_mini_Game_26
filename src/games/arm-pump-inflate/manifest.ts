import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'arm-pump-inflate',
  nameKo: '팔 펌프 풍선',
  taglineKo: '펌프질로 풍선을 부풀려요!',
  howToKo: ['두 팔을 위아래로 힘껏 흔들어요', '빵빵해지면 풍선이 뻥! 터져요', '터지면 새 풍선이 나와요'],
  icon: 'gi-arm-pump-inflate',
  theme: { hue: 212 },

  difficulty: 1,
  // Seated pumping is gentle, and the validator rejects seated + intensity 2.
  intensity: 1,
  space: 'seated',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['rep'],

  durationMs: 35_000,
  // 10 points per pump, 50 per popped balloon. A strong child pumps ~1.7/s
  // (~55 pumps, ~6 balloons, ~850); the swing-wide metronome (0.5 Hz) lands ~0.3.
  scoring: { kind: 'count', maxScore: 800, starCuts: [0.2, 0.45, 0.75] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['리듬', '조절력', '앉아서'],
  version: 2,
  author: 'A7',
  enabled: true,
  dev: { clip: 'swing-wide' },
};

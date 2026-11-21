import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'run-in-place-sprint',
  nameKo: '제자리 달리기',
  taglineKo: '달려서 결승선까지!',
  howToKo: ['무릎을 번갈아 들며 달려요', '다리가 안 보이면 팔을 흔들어요', '마지막엔 라스트 스퍼트!'],
  // A sprite id from src/engine/render/sprites.ts — never an emoji.
  icon: 's-run',
  theme: { hue: 26 },

  difficulty: 1,
  intensity: 3,
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  // Deliberately NOT 'legs'/'feet': the knee signal falls back to an
  // alternating arm swing when legs are out of frame (the common laptop
  // case), so this game must not be hidden by the small-room filter.
  requiredLandmarks: ['torso', 'arms'],
  gestures: ['rep'],

  // Short on purpose: sustained running in place is the most tiring thing in
  // this catalogue, and the round length is the primary safety device.
  durationMs: 30_000,
  // Distance is a cadence integral capped at the finish line, so a strong
  // run cannot inflate rawScore past maxScore. Calibrated conservatively
  // (no real playtest data yet) against a plausible child cadence; the lead
  // should re-check starCuts once this is played for real.
  scoring: { kind: 'count', maxScore: 50, starCuts: [0.35, 0.65, 0.92] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['달리기', '심박', '전신'],
  version: 1,
  author: 'A7',
  enabled: false,
  dev: { clip: 'knee-run' },
};

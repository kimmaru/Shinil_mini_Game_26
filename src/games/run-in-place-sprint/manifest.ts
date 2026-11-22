import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'run-in-place-sprint',
  nameKo: '제자리 달리기',
  taglineKo: '달려서 결승선까지!',
  howToKo: ['팔을 앞뒤로 크게 흔들며 달려요', '무릎도 올리면 더 신나요', '마지막엔 점수가 두 배예요!'],
  icon: 'gi-run-in-place-sprint',
  theme: { hue: 26 },

  difficulty: 1,
  intensity: 3,
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  // Deliberately NOT 'legs'/'feet': the stride signal falls back to an
  // alternating arm swing when legs are out of frame (the common laptop
  // case), so this game must not be hidden by the small-room filter.
  requiredLandmarks: ['torso', 'arms'],
  gestures: ['rep'],

  // Short on purpose: running in place is the most tiring thing in the
  // catalogue, and the round length is the safety device.
  durationMs: 30_000,
  // One point per alternating stride, two in the last 8 s. Arm-swing running
  // at 1.2 m, 3 strides/s, measures 109 (~1.0); 2 strides/s 73 (two stars);
  // the knee-run metronome (4.4/s) 158.
  scoring: { kind: 'count', maxScore: 105, starCuts: [0.3, 0.55, 0.8] },

  a11y: {
    // The keyboard body cannot lift a knee and always shows its knees, so the
    // arm fallback never engages: no key produces a stride.
    keyboardFallback: false,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['달리기', '심박', '전신'],
  version: 2,
  author: 'A7',
  enabled: true,
  dev: { clip: 'knee-run' },
};

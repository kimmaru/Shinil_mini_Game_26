import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'fruit-slash',
  nameKo: '과일 쓱싹',
  taglineKo: '과일을 쓱 베어요!',
  howToKo: ['날아오는 과일을 손으로 쓱!', '발로 차도 잘려요', '돌은 건드리지 마세요'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. */
  icon: 'star',
  theme: { hue: 26 },

  difficulty: 2,
  // Big arm arcs plus the occasional kick. Tiring, but nothing repetitive and
  // no jumping: honestly a 2.
  intensity: 2,
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  // `legs`/`feet` are deliberately NOT required: the kick is a bonus, and
  // listing them would hide the whole game from every laptop player whose feet
  // are out of frame (the `no-legs` case).
  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['swing', 'rep'],

  durationMs: 60_000,
  // The `swing-wide` clip sweeps both arms at 1.5 Hz without ever LOOKING at
  // the fruit, which for an aiming game is a floor rather than a ceiling: it
  // scores 485, two stars. maxScore is set above that so a child who actually
  // tracks the fruit has somewhere to go; three stars needs ~52 of the ~115
  // fruit a round throws.
  scoring: { kind: 'count', maxScore: 700, starCuts: [0.26, 0.5, 0.75] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['반사신경', '전신', '서서'],
  version: 1,
  author: 'A3',
  enabled: false,
  dev: { clip: 'swing-wide' },
};

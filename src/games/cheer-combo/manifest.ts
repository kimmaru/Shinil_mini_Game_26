import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'cheer-combo',
  nameKo: '응원 콤보',
  taglineKo: '지시대로 손을 들어요!',
  howToKo: ['왼손! 오른손! 양손!', '지시대로 번쩍 들어요', '만세는 번쩍 더 높이!'],
  /** A sprite id from src/engine/render/sprites.ts — never an emoji. */
  icon: 'star',
  theme: { hue: 322 },

  // Reaction + listening, not coordination between limbs: one clean signal
  // per cue. The "반대로" twist in the back half is what earns a 2, not a 3.
  difficulty: 2,
  intensity: 1,
  space: 'seated',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['raise'],

  durationMs: 45_000,
  // A strong player's score, not a theoretical maximum. Measured: the
  // `hold-poses` clip (T / Y / overhead / one-leg / asymmetric / lean, each
  // held ~3s — a real pose, not a metronome) scores 268, just past three stars.
  scoring: { kind: 'count', maxScore: 260, starCuts: [0.26, 0.5, 0.75] },

  a11y: {
    // Z/X raise the subject's own left/right wrist; holding both together
    // drives the virtual body to an overhead pose, which also clears 만세.
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['반응속도', '응원', '앉아서'],
  version: 1,
  author: 'A6',
  enabled: false,
  dev: { clip: 'hold-poses' },
};

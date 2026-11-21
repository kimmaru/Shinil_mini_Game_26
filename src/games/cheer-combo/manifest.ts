import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'cheer-combo',
  nameKo: '응원 콤보',
  taglineKo: '지시대로 손을 들어요!',
  howToKo: ['왼손! 오른손! 양손! 만세!', '말한 손만 번쩍 들어요', '이어서 하면 콤보가 쌓여요'],
  icon: 'gi-cheer-combo',
  theme: { hue: 322 },

  // Reaction + listening, one clean signal per cue.
  difficulty: 2,
  intensity: 1,
  space: 'seated',
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['raise'],

  durationMs: 45_000,
  // A cue plus its rest beat takes ~1.6 s, so a round holds ~28 cues. A strong
  // child lands ~24 of them at 10-20 points each with the combo bonus.
  scoring: { kind: 'count', maxScore: 330, starCuts: [0.2, 0.5, 0.75] },

  a11y: {
    // Z/X raise the subject's own left/right wrist; holding both together
    // drives the virtual body overhead, which also clears 만세.
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['반응속도', '응원', '앉아서'],
  version: 2,
  author: 'A6',
  enabled: true,
  dev: { clip: 'swing-wide' },
};

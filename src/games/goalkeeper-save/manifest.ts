import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'goalkeeper-save',
  nameKo: '골키퍼 선방',
  taglineKo: '두 팔로 공을 막아요!',
  howToKo: [
    '표시된 자리로 미리 움직여요',
    '높은 공도 낮은 공도 손으로 막아요',
    '공이 올 때 팔을 쭉 내밀어요',
  ],
  icon: 'gi-goalkeeper-save',
  theme: { hue: 140 },

  difficulty: 3,
  // Arm reaches high, wide and low, feet planted. No jumping, no floor
  // contact; tiring for the shoulders, not for the legs.
  intensity: 2,
  space: 'standing',
  players: { min: 1, max: 1, mode: 'solo' },

  // Waist-up: every zone is a hand zone laid out from the shoulders, so the
  // game plays 1.2 m from a laptop with the hips out of frame. Only the arms
  // save.
  requiredLandmarks: ['head', 'arms', 'hands', 'torso'],
  gestures: ['reach'],

  durationMs: 50_000,
  // ~45 shots arrive in a round (the late bursts are capped by a pool of 4)
  // at 20-25 a save, and the round always runs its full 50 s. A pointer
  // oracle saves 37-41 (763-903); a competent child ~30-32 (~650-700).
  // Windmilling both arms blind saves up to 29 (swing-wide 586, far-small
  // 591): a goalkeeper who flails does stop balls, so that is 2 stars, not 3.
  scoring: { kind: 'count', maxScore: 800, starCuts: [0.3, 0.55, 0.78] },

  a11y: {
    keyboardFallback: true,
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,
  },
  tags: ['순발력', '전신', '집중'],
  version: 1,
  author: 'A2',
  enabled: true,
  dev: { clip: 'swing-wide' },
};

import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  id: 'goalkeeper-save',
  nameKo: '골키퍼 선방',
  taglineKo: '온몸으로 공을 막아요!',
  howToKo: [
    '표시된 자리로 미리 움직여요',
    '위쪽 공은 손, 아래쪽 공은 발로 막아요',
    '공이 올 때 팔다리를 내밀어요',
  ],
  icon: 'gi-goalkeeper-save',
  theme: { hue: 140 },

  difficulty: 3,
  // Lunges to the corners and low blocks with the feet. No jumping, no floor
  // contact, but a full minute of whole-body reaching.
  intensity: 3,
  space: 'room',
  players: { min: 1, max: 1, mode: 'solo' },

  // Legs are real here: the bottom row of the goal is at ankle height. The
  // pool filter hides this game when the lower body is out of frame rather
  // than serving a round a child can only half play.
  requiredLandmarks: ['head', 'arms', 'hands', 'torso', 'legs'],
  gestures: ['reach'],

  durationMs: 50_000,
  // ~28 shots arrive in a round at 20-25 a save and the round always runs its
  // full 50 s (a goal is quiet and costs only the combo). A strong keeper saves
  // about 20 of them; 3 stars is 16 saves, a bit over half. swing-wide flails
  // at everything and lands above maxScore, which is what a flail should do.
  scoring: { kind: 'count', maxScore: 450, starCuts: [0.3, 0.55, 0.78] },

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

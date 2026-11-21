// COPY THIS FOLDER to src/games/<your-id>/ and rename everything.
// `_`-prefixed folders are excluded from the registry, so this template is
// never served as a game.
//
// manifest.ts imports ONLY @/engine/types. No other import is permitted here —
// it is eagerly bundled into the shell so the lobby can show 58 cards while
// shipping zero game code, and one heavy import would drag a whole game in.
import type { MiniGameManifest } from '@/engine/types';

export const manifest: MiniGameManifest = {
  // MUST equal the folder name, or the registry throws at startup.
  id: '_template',

  nameKo: '템플릿',                      // <= 20 chars
  taglineKo: '여기에 한 줄 설명',          // <= 18 chars reads best
  howToKo: ['이렇게 하세요', '그리고 이렇게'], // 1-3 imperative lines
  // A sprite id from src/engine/render/sprites.ts — NEVER an emoji.
  // `npm run gate` rejects emoji in a game file.
  icon: 'star',
  theme: { hue: 210 },                   // 0-360; tints the card and accents

  difficulty: 1,   // 1 anyone / 2 some skill / 3 needs timing
  intensity: 1,    // 1 seated / 2 moving / 3 hard. Be honest: the scheduler
                   // uses this to avoid serving two hard games back to back.
  space: 'seated', // 'seated' | 'standing' | 'room' (room needs ~2m of floor)
  players: { min: 1, max: 1, mode: 'solo' },

  requiredLandmarks: ['arms', 'hands', 'torso'],
  gestures: ['clap'],

  durationMs: 40_000,
  scoring: {
    kind: 'count',
    // What a STRONG player reaches, not a theoretical maximum.
    maxScore: 20,
    // 1 star = "you played", 3 stars = "that was good" and must be reachable
    // by a competent 9-year-old. The engine computes stars from these.
    starCuts: [0.25, 0.5, 0.75],
  },

  a11y: {
    keyboardFallback: true,  // VirtualPoseSource makes this free for most games
    noFlashing: true,
    colorBlindSafe: true,
    audioOptional: true,     // false => the engine renders a visual beat ring
  },
  tags: ['파티'],
  version: 1,
  author: 'template',

  // Agent-authored games ship disabled. The lead plays it, then flips this.
  enabled: false,

  // The clip that must produce a score > 0 — the anti-dead-game test.
  dev: { clip: 'clap-x12' },
};

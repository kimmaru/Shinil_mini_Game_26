// ══ FROZEN CONTRACT ══ the completeness source of truth.
//
// Every planned game id, with the wave that owns it. The registry test asserts
// that the set of folders in src/games/ matches PLANNED exactly, so a game
// cannot be silently forgotten or silently invented.
//
// Adding a game = add the id here AND create src/games/<id>/. Nothing else.
export const PLANNED = {
  // ── Wave 1: hand-built archetype references ────────────────────────────────
  // Three distinct update-loop shapes. Every later game copies one of these.
  w1: [
    'mosquito-clap',      // discrete trigger x screen-space joints x hit test
    'candy-rain-catch',   // continuous overlap + falling physics + miss penalty
    'wave-jump',          // locomotion gesture vs scrolling world + survival
  ],

  // ── Wave 2: core services only ─────────────────────────────────────────────
  w2: [
    'air-whack-mole', 'balloon-pop-party', 'castle-defense',
    'shooting-star-grab', 'snowball-fight', 'goalkeeper-save',
    'fruit-slash', 'web-cut', 'color-shield-block',
    'wrist-aim-target', 'wrist-maze', 'connect-dots-order',
    'spider-touch', 'koko-ko-touch', 'max-reach-stretch',
    'cheer-combo', 'blue-flag-white-flag', 'ox-quiz-zone',
    'arm-pump-inflate', 'run-in-place-sprint', 'bike-pedal',
  ],

  // ── Wave 3: + scroller, cue, zones, stillness, balance ─────────────────────
  w3: [
    'lane-runner', 'jump-rope-king', 'hopscotch-zones',
    'limbo-king', 'laser-corridor', 'airplane-lean',
    'reflex-ridge', 'ice-tag-freeze', 'red-light-green-light',
    'statue-hold', 'scan-hold-still', 'flamingo-balance',
    'tightrope-walk', 'tree-pose-yoga', 'stair-climb-tower',
    'swim-crawl', 'sky-draw', 'body-simon',
  ],

  // ── Wave 4: + poseSimilarity, jointTargets, beat scheduler ─────────────────
  w4: [
    'pose-match-shadow', 'animal-mimic', 'constellation-pose',
    'human-tetris', 'body-hangul', 'body-number',
    'beat-clap', 'step-rhythm', 'air-drums',
    'move-memory-chain', 'cover-dance',
  ],

  // ── Wave 5: exclusive engine needs; all ship enabled:false ─────────────────
  w5: [
    'high-touch-jump',            // multi-player identity
    'mirror-the-leader',          // multi-player identity
    'body-rock-paper-scissors',   // multi-player identity
    'shadow-puppet-theater',      // poseRig — cut candidate #1
    'photo-pose-booth',           // re-spec: live stickers, NO capture path
  ],
} as const;

export const ALL_PLANNED_IDS: readonly string[] = [
  ...PLANNED.w1, ...PLANNED.w2, ...PLANNED.w3, ...PLANNED.w4, ...PLANNED.w5,
];

export const waveOf = (id: string): keyof typeof PLANNED | undefined =>
  (Object.keys(PLANNED) as (keyof typeof PLANNED)[]).find((w) =>
    (PLANNED[w] as readonly string[]).includes(id));

/**
 * The 12 games that are never cut, chosen for coverage: seated and standing,
 * four mechanic families, intensity 1 through 3, and none needing a service
 * beyond Wave 2.
 */
export const LAUNCH_SET: readonly string[] = [
  'mosquito-clap', 'candy-rain-catch', 'air-whack-mole', 'balloon-pop-party',
  'fruit-slash', 'wrist-aim-target', 'spider-touch', 'max-reach-stretch',
  'cheer-combo', 'wave-jump', 'limbo-king', 'scan-hold-still',
];

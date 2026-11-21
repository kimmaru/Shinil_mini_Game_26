// ══ FROZEN CONTRACT ══ imported by 58 game modules.
//
// The CLOSED set of sound ids. Every sound is synthesized at runtime from
// oscillators and noise (see audio/synth.ts): zero audio files, zero licensing
// questions, zero bundle weight.
//
// A closed union is the point: without it, 58 authors reference 200 sounds that
// do not exist and every one of them fails silently.
export const SFX_IDS = [
  // UI
  'ui.click', 'ui.hover', 'ui.back', 'ui.confirm', 'ui.deny', 'ui.tick',
  // Round structure
  'count.beep', 'count.go', 'round.start', 'round.win', 'round.lose',
  'star.1', 'star.2', 'star.3',
  // Scoring
  'hit.soft', 'hit.hard', 'hit.crit', 'pop', 'pop.low', 'pop.high',
  'combo.up', 'combo.break', 'score.tick', 'bonus',
  // Failure
  'miss', 'buzz', 'thud', 'break', 'alarm',
  // Motion feedback
  'swing', 'clap', 'jump', 'land', 'step', 'whoosh', 'splash', 'freeze', 'unfreeze',
  // Musical / rhythm
  'beat.lo', 'beat.hi', 'note.c', 'note.d', 'note.e', 'note.f', 'note.g', 'note.a', 'note.b',
  'drum.kick', 'drum.snare', 'drum.hat', 'chime', 'fanfare',
  // Flavour
  'boing', 'zap', 'sparkle', 'wobble', 'charge', 'release',
] as const;

export type SfxId = (typeof SFX_IDS)[number];

const SET: ReadonlySet<string> = new Set(SFX_IDS);
export const isSfxId = (s: string): s is SfxId => SET.has(s);

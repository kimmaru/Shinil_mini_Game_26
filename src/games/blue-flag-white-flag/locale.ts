const S = {
  goal: '청기·백기를 지시대로!',
  nice: '좋아요!',
  wow: '정확해요!',
  keepWarn: '그대로 두세요!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

/** What each flag must end up as. 'keep' means "don't care" early in the
 *  round, and "do not move it at all" once `strictKeep` ramps on. */
export type FlagState = 'up' | 'down' | 'keep';

/** One phrase of an instruction, shown on its own beat (staged reveal).
 *  `flag`/`dir` drive the icon; `negate` draws the "don't" slash over it —
 *  the thing that makes a 함정 지시 a trap is the slash, not the color. */
export interface Clause {
  textKo: string;
  flag: 'blue' | 'white';
  dir: 'up' | 'down';
  negate: boolean;
}

export interface Instruction {
  clauses: readonly Clause[];
  blue: FlagState;
  white: FlagState;
  /** 함정 지시: worded as a negation so the obvious first reading is wrong.
   *  Gets extra read time in index.ts. */
  trap: boolean;
}

/**
 * 8 plain instructions (4 single-flag, 4 two-flag) + 6 함정 (trap) ones.
 * Every trap resolves to one of the same target combinations a plain
 * instruction can reach — the trick is entirely in the wording, never in a
 * target state a plain instruction could not also produce, which is what
 * keeps the "안 바뀌면 유지" ramp meaningful instead of arbitrary.
 */
export const INSTRUCTIONS: readonly Instruction[] = [
  { blue: 'up', white: 'keep', trap: false, clauses: [
    { textKo: '청기 올려!', flag: 'blue', dir: 'up', negate: false },
  ] },
  { blue: 'down', white: 'keep', trap: false, clauses: [
    { textKo: '청기 내려!', flag: 'blue', dir: 'down', negate: false },
  ] },
  { blue: 'keep', white: 'up', trap: false, clauses: [
    { textKo: '백기 올려!', flag: 'white', dir: 'up', negate: false },
  ] },
  { blue: 'keep', white: 'down', trap: false, clauses: [
    { textKo: '백기 내려!', flag: 'white', dir: 'down', negate: false },
  ] },
  { blue: 'up', white: 'up', trap: false, clauses: [
    { textKo: '청기 올리고,', flag: 'blue', dir: 'up', negate: false },
    { textKo: '백기도 올려!', flag: 'white', dir: 'up', negate: false },
  ] },
  { blue: 'down', white: 'down', trap: false, clauses: [
    { textKo: '청기 내리고,', flag: 'blue', dir: 'down', negate: false },
    { textKo: '백기도 내려!', flag: 'white', dir: 'down', negate: false },
  ] },
  { blue: 'up', white: 'down', trap: false, clauses: [
    { textKo: '청기 올리고,', flag: 'blue', dir: 'up', negate: false },
    { textKo: '백기는 내려!', flag: 'white', dir: 'down', negate: false },
  ] },
  { blue: 'down', white: 'up', trap: false, clauses: [
    { textKo: '청기 내리고,', flag: 'blue', dir: 'down', negate: false },
    { textKo: '백기는 올려!', flag: 'white', dir: 'up', negate: false },
  ] },
  { blue: 'down', white: 'up', trap: true, clauses: [
    { textKo: '청기 올리지 말고,', flag: 'blue', dir: 'up', negate: true },
    { textKo: '백기 올려!', flag: 'white', dir: 'up', negate: false },
  ] },
  { blue: 'up', white: 'down', trap: true, clauses: [
    { textKo: '백기 올리지 말고,', flag: 'white', dir: 'up', negate: true },
    { textKo: '청기 올려!', flag: 'blue', dir: 'up', negate: false },
  ] },
  { blue: 'up', white: 'down', trap: true, clauses: [
    { textKo: '청기 내리지 말고,', flag: 'blue', dir: 'down', negate: true },
    { textKo: '백기 내려!', flag: 'white', dir: 'down', negate: false },
  ] },
  { blue: 'down', white: 'up', trap: true, clauses: [
    { textKo: '백기 내리지 말고,', flag: 'white', dir: 'down', negate: true },
    { textKo: '청기 내려!', flag: 'blue', dir: 'down', negate: false },
  ] },
  { blue: 'up', white: 'up', trap: true, clauses: [
    { textKo: '청기 내리지 말고,', flag: 'blue', dir: 'down', negate: true },
    { textKo: '백기도 내리지 마!', flag: 'white', dir: 'down', negate: true },
  ] },
  { blue: 'down', white: 'down', trap: true, clauses: [
    { textKo: '백기 올리지 말고,', flag: 'white', dir: 'up', negate: true },
    { textKo: '청기도 올리지 마!', flag: 'blue', dir: 'up', negate: true },
  ] },
];

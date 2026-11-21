// Every Korean string this game shows. 해요체, 2nd-grade vocabulary.
const S = {
  goal: '말한 곳을 짚어요!',
  // The chant: one syllable per beat, four beats.
  chant: '코',
  // What the caller SAYS. Index order matches the word ids in index.ts.
  nose: '코!',
  eye: '눈!',
  mouth: '입!',
  ear: '귀!',
  head: '머리!',
  shoulder: '어깨!',
  belly: '배!',
  nice: '정답!',
  notFooled: '안 속았다!',
  wow: '대단해요!',
  listen: '말을 들어요!',
  ready: '코를 콕콕!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

/** Results-card lines. Called once, from end(), never per frame. */
export const comboLine = (n: number): string => `${n}번 연속 정답!`;
export const notFooledLine = (n: number): string => `속임수를 ${n}번 이겼어요!`;

const S = {
  goal: '코코코... 말한 곳을 짚어요!',
  chant: '코코코코...',
  nose: '코',
  ear: '귀',
  eye: '눈',
  mouth: '입',
  shoulder: '어깨',
  knee: '무릎',
  nice: '정답!',
  wow: '대단해요!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

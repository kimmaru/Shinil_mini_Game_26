// Every Korean string this game shows. 해요체, 2nd-grade vocabulary.
const S = {
  goal: '거미줄을 비껴 베어요!',
  snap: '툭!',
  saved: '친구를 구했어요!',
  slide: '비스듬히 베어 보세요',
  gold: '노란 줄은 그냥 둬요',
  spider: '거미를 건드렸어요',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

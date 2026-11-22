// Every Korean string this game shows. 해요체, 2nd-grade vocabulary.
const S = {
  goal: '거미줄을 가로질러 베어요!',
  saved: '친구를 구했어요!',
  slide: '줄을 가로질러 베어요',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

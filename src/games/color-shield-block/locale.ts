// Every Korean string this game shows. 해요체, 2nd-grade vocabulary.
const S = {
  goal: '색에 맞는 곳으로 막아요!',
  nice: '정확해요!',
  wow: '아주 잘 막아요!',
  both: '초록 공은 두 손으로 막아요!',
  swap: '색이 바뀌어요!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

// Every Korean string this game shows. 해요체, 2nd-grade vocabulary.
const S = {
  goal: '색에 맞는 곳으로 막아요!',
  nice: '정확해요!',
  wow: '아주 잘 막아요!',
  wrong: '거기가 아니에요',
  pass: '놓쳤어요',
  both: '초록 공은 두 손으로!',
  swap: '색이 바뀌어요!',
  mend: '방패를 고쳤어요',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

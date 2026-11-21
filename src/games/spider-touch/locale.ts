const S = {
  goal: '거미가 짚은 자리를 손으로 터치!',
  nice: '잡았다!',
  wow: '최고예요!',
  left: '왼손만!',
  right: '오른손만!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

const S = {
  goal: '거미 동그라미를 손으로 짚어요!',
  nice: '잡았다!',
  wow: '최고예요!',
  left: '왼손만!',
  right: '오른손만!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

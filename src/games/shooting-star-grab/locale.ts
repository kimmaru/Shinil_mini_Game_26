const S = {
  goal: '별이 가는 쪽으로 쓸어요!',
  got: '잡았어요!',
  perfect: '완벽하게 쓸었어요!',
  pair: '두 개가 와요! 양손!',
  hint: '별을 따라 손을 움직여요',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

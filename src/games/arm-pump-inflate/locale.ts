const S = {
  goal: '풍선을 크게 부풀려요!',
  pop: '빵! 괜찮아요, 새 풍선이에요',
  careful: '조금만 더 조심해요',
  secondBalloon: '풍선이 하나 더 왔어요!',
  nice: '잘하고 있어요!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

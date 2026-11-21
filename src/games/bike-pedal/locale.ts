const S = {
  goal: '두 손으로 페달을 돌려요!',
  uphill: '오르막이에요, 힘을 내요!',
  downhill: '내리막이에요, 신나게!',
  reverse: '반대로! 계속 돌려요',
  goodForm: '페달링이 좋아요!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

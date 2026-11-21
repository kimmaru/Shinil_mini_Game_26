const S = {
  goal: '결승선까지 달려가요!',
  spurt: '라스트 스퍼트!',
  finish: '결승선 통과!',
  rest: '숨을 골라요~',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

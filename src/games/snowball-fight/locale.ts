const S = {
  goal: '눈사람을 맞혀요!',
  hit: '맞혔어요!',
  oops: '앗, 맞았어요!',
  duck: '숙여요!',
  dodge: '잘 피했어요!',
  hint: '몸이 다 보이게 서 볼까요?',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

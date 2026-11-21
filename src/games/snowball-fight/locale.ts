const S = {
  goal: '눈사람을 맞혀요!',
  hit: '맞혔어요!',
  oops: '앗, 맞았어요!',
  duck: '숙여요!',
  dodge: '잘 피했어요!',
  hint: '팔을 당겼다가 앞으로 던져요',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

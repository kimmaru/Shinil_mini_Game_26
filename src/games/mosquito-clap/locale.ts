const S = {
  goal: '모기를 박수로 잡아요!',
  nice: '잡았다!',
  wow: '대단해요!',
  bee: '벌은 안 돼요!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

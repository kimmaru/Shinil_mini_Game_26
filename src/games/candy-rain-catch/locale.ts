const S = {
  goal: '사탕을 받아요!',
  nice: '잘 받았어요!',
  golden: '황금 사탕!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

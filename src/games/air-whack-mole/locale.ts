const S = {
  goal: '두더지를 손으로 톡 잡아요!',
  nice: '잡았다!',
  wow: '대단해요!',
  gold: '황금 두더지!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

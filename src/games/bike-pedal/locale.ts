const S = {
  goal: '두 손을 번갈아 돌려 페달을 굴려요!',
  prompt: '두 손으로 페달을 돌려요!',
  promptSub: '손을 번갈아 둥글게 돌려요',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

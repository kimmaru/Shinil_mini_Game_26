const S = {
  goal: '파도를 뛰어넘어요!',
  nice: '멋져요!',
  wet: '발이 젖었어요',
  fake: '거품엔 안 뛰어도 돼요',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

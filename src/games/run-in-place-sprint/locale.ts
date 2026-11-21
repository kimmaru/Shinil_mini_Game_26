const S = {
  goal: '무릎을 번갈아 올려 달려요!',
  prompt: '제자리에서 달려요!',
  promptSub: '무릎을 번갈아 올려요',
  spurt: '마지막 힘내요! 점수 두 배!',
  lap: '결승선 통과!',
  flag: '결승선',
  distance: '달린 거리',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

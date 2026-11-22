const S = {
  goal: '팔을 크게 흔들며 달려요!',
  prompt: '제자리에서 달려요!',
  promptSub: '팔을 앞뒤로 크게 흔들어요',
  spurt: '마지막 힘내요! 점수 두 배!',
  lap: '결승선 통과!',
  flag: '결승선',
  distance: '달린 거리',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

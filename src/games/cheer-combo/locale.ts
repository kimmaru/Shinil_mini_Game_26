const S = {
  goal: '지시대로 손을 번쩍 들어요!',
  cueLeft: '왼손!',
  cueRight: '오른손!',
  cueBoth: '양손!',
  cueMansae: '만세!',
  nice: '좋아요!',
  next: '다음!',
  wow: '대단해요!',
  huge: '최고예요!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

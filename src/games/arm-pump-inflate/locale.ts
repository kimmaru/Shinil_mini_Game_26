const S = {
  goal: '두 팔을 머리까지 쭉, 배까지 쭉!',
  prompt: '두 팔을 머리까지 쭉!',
  promptSub: '올렸다가 배까지 내려요',
  pop: '뻥! 풍선이 터졌어요!',
  nice: '와, 빵빵해요!',
  fill: '풍선',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

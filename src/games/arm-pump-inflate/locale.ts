const S = {
  goal: '두 팔을 위아래로 흔들어 풍선을 불어요!',
  prompt: '두 팔을 위아래로 흔들어요!',
  promptSub: '펌프질하듯이 쭉쭉!',
  pop: '뻥! 풍선이 터졌어요!',
  nice: '와, 빵빵해요!',
  fill: '풍선',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

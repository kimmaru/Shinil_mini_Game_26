const S = {
  goal: '공을 막아요!',
  save: '막았어요!',
  superb: '멋진 선방!',
  low: '아래쪽 공은 손을 쭉 내려 막아요',
  hint: '어깨가 다 보이게 뒤로 가 볼까요?',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

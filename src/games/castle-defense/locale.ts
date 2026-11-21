const S = {
  goal: '바위를 쳐내서 성을 지켜요!',
  castleHp: '성 체력',
  heal: '성이 튼튼해졌어요!',
  big: '큰 바위 조심!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

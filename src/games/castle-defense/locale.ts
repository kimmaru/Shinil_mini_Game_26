const S = {
  goal: '바위를 쳐내서 성을 지켜요!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

const S = {
  goal: '풍선을 몸으로 터뜨려요!',
  spike: '가시 풍선이에요!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

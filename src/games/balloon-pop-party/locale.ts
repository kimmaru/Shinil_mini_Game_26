const S = {
  goal: '풍선을 몸으로 터뜨려요!',
  party: '파티 시간!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

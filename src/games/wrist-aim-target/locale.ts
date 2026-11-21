// Every Korean string this game shows. Never inline; never a shared i18n file.
// Register: 해요체, 2nd-grade vocabulary.
const S = {
  goal: '과녁에 레이저를 1초간 겨눠요!',
  nice: '명중!',
  wow: '정확해요!',
  bombWarn: '폭탄이에요!',
  bothHands: '이번엔 두 손 다 써요!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

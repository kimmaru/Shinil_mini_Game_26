// Every Korean string this game shows. 해요체, 2nd-grade vocabulary.
const S = {
  goal: '과일을 쓱 베어요!',
  double: '두 개 한 번에!',
  triple: '세 개나 베었어요!',
  frenzy: '과일 폭풍이에요!',
  kick: '발로 찼어요!',
  rock: '돌은 피해요',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

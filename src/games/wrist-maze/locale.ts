// Every Korean string this game shows. Never inline; never a shared i18n file.
// Register: 해요체, 2nd-grade vocabulary.
const S = {
  goal: '벽에 닿지 않고 빛구슬을 끝까지 옮겨요!',
  clear: '통과했어요!',
  oppositeHand: '이번엔 반대 손으로 해봐요!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

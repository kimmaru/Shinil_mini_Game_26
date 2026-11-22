// Every Korean string this game shows. Never inline; never a shared i18n file.
// Register: 해요체, 2nd-grade vocabulary.
const S = {
  goal: '손끝 불빛을 과녁에 올려요!',
  nice: '좋아요!',
  wow: '정중앙!',
  bothHands: '이번엔 두 손을 써요!',
  left: '왼손',
  right: '오른손',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

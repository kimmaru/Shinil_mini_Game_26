// Every Korean string this game shows. Never inline; never a shared i18n file.
// Register: 해요체, 2nd-grade vocabulary.
const S = {
  goal: '1번부터 차례로 점을 이어요!',
  pictureDone: '그림 완성!',
  bothHands: '이번엔 두 손으로 같이 그려요!',
  left: '왼손',
  right: '오른손',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

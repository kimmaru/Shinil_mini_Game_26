// Every Korean string this game shows. Never inline; never a shared i18n file.
// Register: 해요체, 2nd-grade vocabulary.
const S = {
  goal: '번호 순서대로 점을 이어 그림을 완성해요!',
  pictureDone: '그림 완성!',
  bothHands: '이번엔 양손으로 같이 그려요!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

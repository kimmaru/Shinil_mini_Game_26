// Every Korean string this game shows. Never inline; never a shared i18n file.
// Register: 해요체, 2nd-grade vocabulary.
const S = {
  goal: '빛구슬을 길 끝까지 옮겨요!',
  clear: '통과했어요!',
  all: '미로를 모두 깼어요!',
  useRight: '오른손으로 해요!',
  useLeft: '이번엔 왼손으로 해요!',
  startRight: '오른손을 여기에!',
  startLeft: '왼손을 여기에!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

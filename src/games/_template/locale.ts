// Every Korean string this game shows. Never inline them, and never reach for
// a shared i18n file — per-game locale files are part of what keeps parallel
// authors from touching the same file.
//
// Register: 해요체 ("잡아요", "뛰어요"), 2nd-grade vocabulary, no 한자어 or
// English loanwords where a plain Korean word exists.
const S = {
  goal: '여기에 목표를 쓰세요',
  great: '좋아요!',
  perfect: '완벽해요!',
  miss: '아쉬워요',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

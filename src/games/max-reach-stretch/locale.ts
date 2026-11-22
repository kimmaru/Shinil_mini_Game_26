// Every Korean string this game shows. 해요체, 2nd-grade vocabulary.
const S = {
  goal: '별까지 팔을 쭉 뻗어요!',
  /** Hand on the star, arm not yet straight. */
  more: '더 쭉!',
  /** Holding the stretch. */
  hold: '그대로!',
  nice: '쭉쭉!',
  perfect: '최고로 쭉!',
  both: '양팔 쭉!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

/** Results-card lines. Called once, from end(), never per frame. */
export const stretchLine = (n: number): string => `${n}번 쭉 뻗었어요!`;
export const perfectLine = (n: number): string => `끝까지 쭉 ${n}번!`;

export interface QuizItem {
  textKo: string;
  answer: 'O' | 'X';
}

/**
 * Elementary-grade common sense: animals, colors, numbers, Korean culture.
 * Deliberately simple enough that an early-grade reader can judge true/false
 * without outside knowledge. Balanced 11 O / 11 X so shuffling never skews
 * the round toward one side.
 */
export const QUIZ_BANK: readonly QuizItem[] = [
  { textKo: '사과는 빨간색이다', answer: 'O' },
  { textKo: '토끼는 하늘을 날 수 있다', answer: 'X' },
  { textKo: '코끼리는 쥐보다 크다', answer: 'O' },
  { textKo: '눈은 더운 여름에 내린다', answer: 'X' },
  { textKo: '한글은 세종대왕이 만들었다', answer: 'O' },
  { textKo: '물고기는 다리가 네 개다', answer: 'X' },
  { textKo: '1 더하기 1은 2다', answer: 'O' },
  { textKo: '하늘은 초록색이다', answer: 'X' },
  { textKo: '강아지는 "멍멍" 소리를 낸다', answer: 'O' },
  { textKo: '고양이는 꼬리가 없다', answer: 'X' },
  { textKo: '여름은 겨울보다 덥다', answer: 'O' },
  { textKo: '바나나는 네모 모양이다', answer: 'X' },
  { textKo: '추석은 한국의 명절이다', answer: 'O' },
  { textKo: '병아리는 "야옹" 하고 운다', answer: 'X' },
  { textKo: '무지개는 일곱 색깔이다', answer: 'O' },
  { textKo: '돼지는 하늘을 날아다닌다', answer: 'X' },
  { textKo: '사자는 고양이와 같은 과 동물이다', answer: 'O' },
  { textKo: '오리는 다리가 네 개다', answer: 'X' },
  { textKo: '숫자 10은 9보다 크다', answer: 'O' },
  { textKo: '얼음은 만지면 뜨겁다', answer: 'X' },
  { textKo: '설날에는 떡국을 먹는다', answer: 'O' },
  { textKo: '거북이는 토끼보다 빠르다', answer: 'X' },
] as const;

const S = {
  goal: '문제를 듣고 O 또는 X로 이동해요!',
  compareHint: '모양이 더 많은 쪽으로!',
  roundQ: '문제',
  correctO: '정답은 O!',
  correctX: '정답은 X!',
  nice: '정답이에요!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

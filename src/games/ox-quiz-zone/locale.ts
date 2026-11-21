export interface QuizItem {
  textKo: string;
  answer: 'O' | 'X';
}

/**
 * Elementary-grade common sense: animals, colors, numbers, Korean culture.
 * Every statement is answerable by a 7-year-old with no outside knowledge, is
 * short enough to read in two seconds, and is plain 해요체.
 */
export const QUIZ_BANK: readonly QuizItem[] = [
  { textKo: '사과는 과일이에요', answer: 'O' },
  { textKo: '코끼리는 쥐보다 커요', answer: 'O' },
  { textKo: '한글은 세종대왕이 만들었어요', answer: 'O' },
  { textKo: '1 더하기 1은 2예요', answer: 'O' },
  { textKo: '강아지는 멍멍 짖어요', answer: 'O' },
  { textKo: '여름은 겨울보다 더워요', answer: 'O' },
  { textKo: '추석은 우리나라 명절이에요', answer: 'O' },
  { textKo: '무지개는 일곱 색깔이에요', answer: 'O' },
  { textKo: '10은 9보다 커요', answer: 'O' },
  { textKo: '설날에는 떡국을 먹어요', answer: 'O' },
  { textKo: '고양이는 야옹 하고 울어요', answer: 'O' },
  { textKo: '물이 얼면 얼음이 돼요', answer: 'O' },
  { textKo: '닭은 알을 낳아요', answer: 'O' },
  { textKo: '토끼는 하늘을 날 수 있어요', answer: 'X' },
  { textKo: '눈은 더운 여름에 내려요', answer: 'X' },
  { textKo: '물고기는 다리가 네 개예요', answer: 'X' },
  { textKo: '하늘은 초록색이에요', answer: 'X' },
  { textKo: '바나나는 네모 모양이에요', answer: 'X' },
  { textKo: '병아리는 야옹 하고 울어요', answer: 'X' },
  { textKo: '돼지는 하늘을 날아다녀요', answer: 'X' },
  { textKo: '오리는 다리가 네 개예요', answer: 'X' },
  { textKo: '얼음은 만지면 뜨거워요', answer: 'X' },
  { textKo: '거북이는 토끼보다 빨라요', answer: 'X' },
  { textKo: '고양이는 꼬리가 없어요', answer: 'X' },
  { textKo: '3 더하기 2는 6이에요', answer: 'X' },
  { textKo: '소는 알을 낳아요', answer: 'X' },
] as const;

const S = {
  goal: '맞으면 왼쪽, 아니면 오른쪽으로 가요!',
  compareHint: '모양이 더 많은 쪽으로!',
  yes: '맞아요',
  no: '아니에요',
  correctO: '정답은 O!',
  correctX: '정답은 X!',
} as const;

export type Key = keyof typeof S;
export const t = (k: Key): string => S[k];

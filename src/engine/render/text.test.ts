import { describe, expect, it } from 'vitest';
import {
  MIN_TEXT_PX,
  clampTextSize,
  clampTextWeight,
  emojiFontString,
  fontString,
  isDigit,
  isHangul,
  tabularWidth,
  tokenize,
  trackingPx,
  wrapText,
} from './text';

/** A measurer with Korean-ish metrics: Hangul is square, Latin is narrow. */
const mk = (size: number) => (s: string): number => {
  let w = 0;
  for (const ch of s) w += isHangul(ch) ? size : ch === ' ' ? size * 0.3 : size * 0.55;
  return w;
};

describe('font stacks', () => {
  it('puts the self-hosted Korean face first', () => {
    expect(fontString(40, 700)).toContain('Pretendard Variable');
    expect(fontString(40, 700, true)).toContain('GmarketSansBold');
  });

  it('returns the identical string for the same request (cached, no churn)', () => {
    const a = fontString(34, 700);
    const b = fontString(34, 700);
    expect(a).toBe(b);
    expect(emojiFontString(48)).toBe(emojiFontString(48));
  });

  it('enforces the size floor and the weight floor', () => {
    expect(clampTextSize(4)).toBe(MIN_TEXT_PX);
    expect(clampTextSize(Number.NaN)).toBe(MIN_TEXT_PX);
    expect(clampTextSize(60)).toBe(60);
    // TextOpts documents "never below 500 for anything a child reads at 2m".
    expect(clampTextWeight(100)).toBe(500);
    expect(clampTextWeight(2000)).toBe(900);
    expect(fontString(10, 100)).toBe(`500 ${MIN_TEXT_PX}px ${fontString(10, 100).split('px ')[1]}`);
  });

  it('tightens tracking only at display sizes', () => {
    expect(trackingPx(24)).toBe(0);
    expect(trackingPx(72)).toBeCloseTo(-1.44, 5);
  });
});

describe('Hangul detection', () => {
  it('knows syllables, jamo and non-Hangul apart', () => {
    expect(isHangul('가')).toBe(true);
    expect(isHangul('왕')).toBe(true);
    expect(isHangul('ㄱ')).toBe(true);
    expect(isHangul('A')).toBe(false);
    expect(isHangul('1')).toBe(false);
    expect(isHangul('🦟')).toBe(false);
  });
});

describe('tokenize', () => {
  it('keeps a 어절 whole', () => {
    expect(tokenize('모기를 잡아요')).toEqual(['모기를 ', '잡아요']);
  });

  it('absorbs runs of spaces into the preceding token', () => {
    expect(tokenize('가   나')).toEqual(['가   ', '나']);
  });

  it('allows a break after punctuation that Korean typography breaks after', () => {
    expect(tokenize('왼손/오른손')).toEqual(['왼손/', '오른손']);
  });
});

describe('wrapText — word-break: keep-all', () => {
  const size = 30;
  const measure = mk(size);

  it('never splits inside a Korean word', () => {
    const lines = wrapText('모기를 손으로 잡아요', size * 6, measure);
    expect(lines.length).toBeGreaterThan(1);
    // Every line must be made of whole 어절.
    const rejoined = lines.join(' ').replace(/\s+/g, ' ').trim();
    expect(rejoined).toBe('모기를 손으로 잡아요');
    for (const l of lines) {
      expect(['모기를', '손으로', '잡아요', '모기를 손으로', '손으로 잡아요']).toContain(l);
    }
  });

  it('fits every line inside the width when it can', () => {
    const w = size * 7;
    const lines = wrapText('손을 높이 들고 크게 흔들어 보세요', w, measure);
    for (const l of lines) expect(measure(l)).toBeLessThanOrEqual(w + 0.001);
  });

  it('honours explicit newlines', () => {
    expect(wrapText('하나\n둘', 9999, measure)).toEqual(['하나', '둘']);
  });

  it('character-breaks only when a single token cannot fit at all', () => {
    // 12 Hangul syllables with no space, in a box 4 wide: no legal break point
    // exists, so the overflow-wrap escape hatch has to kick in.
    const lines = wrapText('가나다라마바사아자차카타', size * 4, measure);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(measure(l)).toBeLessThanOrEqual(size * 4 + 0.001);
    expect(lines.join('')).toBe('가나다라마바사아자차카타');
  });

  it('does not start a line with closing punctuation', () => {
    const lines = wrapText('좋아요 멋져요!', mk(size)('좋아요 멋져요') + 1, measure);
    for (const l of lines) expect(l.startsWith('!')).toBe(false);
  });

  it('degrades gracefully on empty / absurd input', () => {
    expect(wrapText('', 100, measure)).toEqual(['']);
    expect(wrapText('가', 0, measure)).toEqual(['가']);
    expect(wrapText('가', Number.NaN, measure)).toEqual(['가']);
  });
});

describe('tabular figures', () => {
  it('is digit-count dependent but digit-value independent', () => {
    const digitW = 20;
    const other = (ch: string): number => (isDigit(ch) ? 999 : 12);
    // This is the whole point: "1" and "8" occupy the same cell, so a score
    // counter does not twitch sideways as it counts up.
    expect(tabularWidth('11111', digitW, other)).toBe(tabularWidth('88888', digitW, other));
    expect(tabularWidth('999', digitW, other)).toBe(60);
    expect(tabularWidth('99점', digitW, other)).toBe(40 + 12);
  });
});

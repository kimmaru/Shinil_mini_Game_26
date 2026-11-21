import { describe, expect, it } from 'vitest';
import { ShuffleBag } from './shuffleBag';

describe('ShuffleBag', () => {
  it('draws every item once before repeating any', () => {
    // The property that makes the wheel read as fair. Children notice a repeat
    // within two minutes.
    const items = ['a', 'b', 'c', 'd', 'e'];
    const bag = new ShuffleBag(items);
    const first = Array.from({ length: 5 }, () => bag.draw());
    expect(new Set(first).size).toBe(5);
    const second = Array.from({ length: 5 }, () => bag.draw());
    expect(new Set(second).size).toBe(5);
  });

  it('never repeats across a refill boundary', () => {
    for (let trial = 0; trial < 200; trial++) {
      const bag = new ShuffleBag(['a', 'b', 'c']);
      const seq = Array.from({ length: 6 }, () => bag.draw());
      for (let i = 1; i < seq.length; i++) {
        expect(seq[i], `trial ${trial}: ${seq.join(',')}`).not.toBe(seq[i - 1]);
      }
    }
  });

  it('keeps undrawn items when the pool is re-filtered mid-party', () => {
    // A player joining or an intensity cap must not reset the no-repeat
    // guarantee and start serving the same games again.
    const bag = new ShuffleBag(['a', 'b', 'c', 'd']);
    bag.draw();
    const before = bag.remaining;
    bag.setItems(['a', 'b', 'c', 'd', 'e']);
    expect(bag.remaining).toBe(before);
  });

  it('handles an empty and a single-item pool', () => {
    expect(new ShuffleBag([]).draw()).toBeUndefined();
    const one = new ShuffleBag(['only']);
    expect(one.draw()).toBe('only');
    expect(one.draw()).toBe('only');
  });

  it('peeks without consuming', () => {
    const bag = new ShuffleBag(['a', 'b', 'c']);
    const peeked = bag.peek(2);
    expect(peeked).toHaveLength(2);
    expect(bag.draw()).toBe(peeked[0]);
  });
});

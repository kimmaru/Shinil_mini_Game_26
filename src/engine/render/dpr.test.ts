import { describe, expect, it } from 'vitest';
import { DPR_FLOOR, DPR_SLOW_FRAMES, DPR_START, DprGovernor } from './dpr';

const feed = (g: DprGovernor, fps: number, n: number): number => {
  let drops = 0;
  for (let i = 0; i < n; i++) if (g.sample(fps)) drops++;
  return drops;
};

describe('DprGovernor', () => {
  it('starts below a Retina panel\'s native 2x', () => {
    expect(new DprGovernor().cap).toBe(DPR_START);
    expect(DPR_START).toBeLessThan(2);
  });

  it('leaves a smooth machine alone', () => {
    const g = new DprGovernor();
    expect(feed(g, 59, 10_000)).toBe(0);
    expect(g.cap).toBe(DPR_START);
  });

  it('ignores a short hitch', () => {
    const g = new DprGovernor();
    feed(g, 30, DPR_SLOW_FRAMES - 1);
    feed(g, 60, 1); // recovered: the count starts over
    expect(feed(g, 30, DPR_SLOW_FRAMES - 1)).toBe(0);
    expect(g.cap).toBe(DPR_START);
  });

  it('steps down under sustained load and stops at the floor', () => {
    const g = new DprGovernor();
    expect(feed(g, 40, DPR_SLOW_FRAMES)).toBe(1);
    expect(g.cap).toBeLessThan(DPR_START);
    feed(g, 40, DPR_SLOW_FRAMES * 10);
    expect(g.cap).toBe(DPR_FLOOR);
    expect(feed(g, 10, DPR_SLOW_FRAMES * 3)).toBe(0);
  });

  it('never starts above the floor-clamped value it was given', () => {
    // A 1x external monitor: there is nothing to step down from.
    const g = new DprGovernor(1);
    expect(feed(g, 20, DPR_SLOW_FRAMES * 2)).toBe(0);
  });
});

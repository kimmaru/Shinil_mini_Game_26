import { describe, expect, it } from 'vitest';
import { HITSTOP_MAX, Hitstop, SHAKE_MAX_PX, SHAKE_MAX_ROT_DEG, Shake } from './shake';

describe('Shake', () => {
  it('decays to exactly zero and stays there', () => {
    const s = new Shake();
    s.add(0.5, 0.3);
    expect(s.active).toBe(true);
    for (let i = 0; i < 40; i++) s.update(1 / 60);
    expect(s.active).toBe(false);
    expect(s.x).toBe(0);
    expect(s.y).toBe(0);
    expect(s.rot).toBe(0);
    s.update(1 / 60);
    expect(s.amount).toBe(0);
  });

  it('respects the requested duration', () => {
    const quick = new Shake();
    quick.add(1, 0.1);
    const slow = new Shake();
    slow.add(1, 1.0);
    for (let i = 0; i < 12; i++) {
      quick.update(1 / 60);
      slow.update(1 / 60);
    }
    expect(quick.active).toBe(false);
    expect(slow.active).toBe(true);
  });

  it('saturates: twenty hits in one frame do not launch the camera', () => {
    const s = new Shake();
    s.setScale(1);
    for (let i = 0; i < 20; i++) s.add(0.3);
    expect(s.amount).toBe(1);
    s.update(1 / 60);
    expect(Math.abs(s.x)).toBeLessThanOrEqual(SHAKE_MAX_PX);
    expect(Math.abs(s.y)).toBeLessThanOrEqual(SHAKE_MAX_PX);
    expect(Math.abs(s.rot)).toBeLessThanOrEqual((SHAKE_MAX_ROT_DEG * Math.PI) / 180);
  });

  const peakPx = (power: number, scale = 0.72): number => {
    const s = new Shake();
    s.setScale(scale);
    s.add(power, 0.3);
    let m = 0;
    for (let i = 0; i < 20; i++) {
      s.update(1 / 60);
      m = Math.max(m, Math.abs(s.x), Math.abs(s.y));
    }
    return m;
  };

  it('puts the documented power anchors where their descriptions say', () => {
    // "0.12 is a solid hit, 0.5 is a disaster" — at 1280x720 (s = 0.72). The
    // textbook trauma-squared model makes 0.12 a third of a pixel, i.e. a
    // feature 58 authors would call and never see.
    const hit = peakPx(0.12);
    const disaster = peakPx(0.5);
    const total = peakPx(1);
    expect(hit).toBeGreaterThan(2);
    expect(hit).toBeLessThan(9);
    expect(disaster).toBeGreaterThan(hit * 1.8);
    expect(disaster).toBeLessThan(22);
    expect(total).toBeLessThanOrEqual(SHAKE_MAX_PX * 0.72);
  });

  it('lasts the requested duration regardless of how gentle it is', () => {
    const lifetime = (power: number): number => {
      const s = new Shake();
      s.setScale(1);
      s.add(power, 0.3);
      let n = 0;
      while (s.active && n < 600) {
        s.update(1 / 60);
        n++;
      }
      return n / 60;
    };
    // A quiet shake must not also be a two-frame shake.
    expect(lifetime(0.12)).toBeCloseTo(0.3, 1);
    expect(lifetime(1)).toBeCloseTo(0.3, 1);
  });

  it('scales with the viewport so a TV shakes as much as a laptop, relatively', () => {
    const run = (scale: number): number => {
      const s = new Shake();
      s.setScale(scale);
      s.add(1, 0.3);
      let m = 0;
      for (let i = 0; i < 18; i++) {
        s.update(1 / 60);
        m = Math.max(m, Math.abs(s.x));
      }
      return m;
    };
    expect(run(2.16)).toBeGreaterThan(run(0.72) * 2.5);
  });

  it('is deterministic: two shakes driven identically produce identical offsets', () => {
    const run = (): string => {
      const s = new Shake();
      s.setScale(1);
      s.add(0.6, 0.4);
      const acc: string[] = [];
      for (let i = 0; i < 24; i++) {
        s.update(1 / 60);
        acc.push(`${s.x.toFixed(6)}:${s.y.toFixed(6)}:${s.rot.toFixed(6)}`);
      }
      return acc.join('|');
    };
    expect(run()).toBe(run());
  });

  it('ignores nonsense input', () => {
    const s = new Shake();
    s.add(Number.NaN);
    s.add(-5);
    s.add(0);
    expect(s.active).toBe(false);
    s.add(0.5, Number.NaN);
    s.update(1 / 60);
    expect(Number.isFinite(s.x)).toBe(true);
  });

  it('reset() clears it between rounds', () => {
    const s = new Shake();
    s.add(1, 1);
    s.reset();
    expect(s.active).toBe(false);
  });
});

describe('Hitstop', () => {
  it('freezes the fixed-step clock, then releases it', () => {
    const h = new Hitstop();
    expect(h.timeScale).toBe(1);
    h.add(0.06);
    expect(h.timeScale).toBe(0);
    for (let i = 0; i < 5; i++) h.update(1 / 60); // 0.083s > 0.06s
    expect(h.active).toBe(false);
    expect(h.timeScale).toBe(1);
  });

  it('clamps anything longer than a stutter', () => {
    const h = new Hitstop();
    h.add(5);
    expect(h.remaining).toBe(HITSTOP_MAX);
    expect(HITSTOP_MAX).toBeLessThanOrEqual(0.12);
  });

  it('takes the longest pending request rather than summing them', () => {
    const h = new Hitstop();
    h.add(0.05);
    h.add(0.08);
    h.add(0.04);
    expect(h.remaining).toBeCloseTo(0.08, 9);
  });

  it('ignores nonsense input', () => {
    const h = new Hitstop();
    h.add(Number.NaN);
    h.add(-1);
    h.add(0);
    expect(h.active).toBe(false);
  });
});

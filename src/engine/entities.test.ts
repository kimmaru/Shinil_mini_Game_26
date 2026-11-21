import { describe, expect, it } from 'vitest';
import { Entities } from './entities';
import { Spawner, randInt } from './spawn';
import { mulberry32 } from './rng';

describe('Entities', () => {
  it('drops spawns at capacity instead of corrupting memory', () => {
    const e = new Entities(4);
    for (let i = 0; i < 4; i++) expect(e.spawn(i, 0)).toBe(i);
    expect(e.spawn(99, 0)).toBe(-1);
    expect(e.n).toBe(4);
  });

  it('integrates position and decays life', () => {
    const e = new Entities(8);
    const i = e.spawn(0, 0, 100, 0, 10, 1);
    e.step(0.5);
    expect(e.x[i]).toBeCloseTo(50);
    expect(e.life[i]).toBeCloseTo(0.5);
    // Previous position is retained for swept collision against a fast hand.
    expect(e.px[i]).toBeCloseTo(0);
  });

  it('applies gravity only when asked', () => {
    const e = new Entities(8);
    const i = e.spawn(0, 0, 0, 0);
    e.step(1, 0);
    expect(e.vy[i]).toBe(0);
    e.step(1, 100);
    expect(e.vy[i]).toBeCloseTo(100);
  });

  it('compacts on sweep and keeps the live set dense', () => {
    const e = new Entities(8);
    for (let i = 0; i < 5; i++) e.spawn(i, 0, 0, 0, 10, 1);
    e.kill(1);
    e.kill(3);
    const retired: number[] = [];
    e.sweep((i) => retired.push(e.id[i]!));
    expect(e.n).toBe(3);
    expect(retired).toHaveLength(2);
    // Every remaining slot must be live — a hole would be drawn as a ghost.
    for (let i = 0; i < e.n; i++) expect(e.life[i]!).toBeGreaterThan(0);
  });

  it('survives sweeping an entirely dead pool', () => {
    const e = new Entities(4);
    for (let i = 0; i < 4; i++) e.spawn(i, 0, 0, 0, 10, -1);
    e.sweep();
    expect(e.n).toBe(0);
  });

  it('culls by radius, not by centre', () => {
    const e = new Entities(8);
    const i = e.spawn(-30, 50, 0, 0, 40); // centre is outside, edge is inside
    e.cullOutside(0, 0, 100, 100);
    expect(e.life[i]!).toBeGreaterThan(0);
    e.x[i] = -200;
    e.cullOutside(0, 0, 100, 100);
    expect(e.life[i]!).toBeLessThanOrEqual(0);
  });

  it('reports age as 0..1', () => {
    const e = new Entities(4);
    const i = e.spawn(0, 0, 0, 0, 10, 2);
    expect(e.age(i)).toBeCloseTo(0);
    e.step(1);
    expect(e.age(i)).toBeCloseTo(0.5);
  });
});

describe('Spawner', () => {
  it('is deterministic for a given seed', () => {
    const run = (): number[] => {
      const s = new Spawner({ startInterval: 1, endInterval: 0.3 }, mulberry32(7), 40);
      const out: number[] = [];
      for (let i = 0; i < 2400; i++) out.push(s.tick(1 / 60));
      return out;
    };
    // Without this, a seeded replay cannot reproduce a round and none of the
    // 58 smoke tests mean anything.
    expect(run()).toEqual(run());
  });

  it('ramps difficulty from 0 to 1 by rampUntil', () => {
    const s = new Spawner({ startInterval: 1, endInterval: 0.3, rampUntil: 0.5 }, mulberry32(1), 10);
    expect(s.difficulty).toBe(0);
    for (let i = 0; i < 60 * 5; i++) s.tick(1 / 60);
    expect(s.difficulty).toBeCloseTo(1, 1);
  });

  it('spawns more often late in the round than early', () => {
    const count = (fromSec: number, forSec: number): number => {
      const s = new Spawner({ startInterval: 1.2, endInterval: 0.3 }, mulberry32(3), 40);
      for (let i = 0; i < fromSec * 60; i++) s.tick(1 / 60);
      let n = 0;
      for (let i = 0; i < forSec * 60; i++) n += s.tick(1 / 60);
      return n;
    };
    expect(count(30, 8)).toBeGreaterThan(count(0, 8));
  });

  it('honours a forced delay', () => {
    const s = new Spawner({ startInterval: 0.1, endInterval: 0.1 }, mulberry32(1), 40);
    s.delay(5);
    let n = 0;
    for (let i = 0; i < 60 * 2; i++) n += s.tick(1 / 60);
    expect(n).toBe(0);
  });
});

describe('randInt', () => {
  it('covers both endpoints and never exceeds them', () => {
    const rng = mulberry32(42);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = randInt(rng, 3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
      seen.add(v);
    }
    expect(seen.size).toBe(5);
  });
});

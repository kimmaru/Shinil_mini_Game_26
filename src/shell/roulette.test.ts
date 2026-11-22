// The one test in the shell that is not optional.
//
// A roulette that lands on a different game than the one that was chosen
// destroys trust in a single spin, and it is exactly the kind of bug that
// survives manual testing (you have to notice the mismatch while the reel is
// a blur). So: assert it over every reel size, every winner and every start,
// every run — both in reel positions and in the DOM slot the window shows.
import { describe, expect, it } from 'vitest';
import {
  ARRIVE_SPEED,
  REEL_MIN_CARDS,
  REEL_PEEK,
  SILENCE_MS,
  TICK_MAX_HZ,
  reelItemAt,
  reelPlan,
  reelPos,
  reelSlotAt,
  reelSpeed,
  reelSpinMs,
  reelStrip,
  type ReelPlan,
} from './reel';
import { mulberry32 } from '@/engine/rng';

const rnd = mulberry32(20261121);
const SLOTS = 8;

/** Times (ms) at which each card reaches the centre line, by bisection. */
function crossings(p: ReelPlan): number[] {
  const out: number[] = [];
  for (let k = 1; k <= p.cards; k++) {
    let lo = 0;
    let hi = p.travelMs;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (reelPos(p, mid) < k) lo = mid;
      else hi = mid;
    }
    out.push(hi);
  }
  return out;
}

const intervals = (at: number[]): number[] => at.map((t, i) => t - (i ? at[i - 1]! : 0));

describe('reel', () => {
  it('lands on the pre-decided winner, for every reel size, winner and start', () => {
    for (let n = 1; n <= SLOTS; n++) {
      const strip = reelStrip(n);
      for (let winner = 0; winner < n; winner++) {
        for (let start = 0; start < n; start++) {
          const p = reelPlan(n, winner, { start });
          const end = reelPos(p, reelSpinMs(p));
          expect(end).toBe(p.cards);
          expect(reelItemAt(p, end)).toBe(winner);
          // ...and the strip slot on the centre line shows that game.
          const slot = reelSlotAt(p, end);
          expect(Number.isInteger(slot)).toBe(true);
          expect(strip[slot]).toBe(winner);
          // A long-hidden tab comes back far past the end: still the winner.
          expect(reelPos(p, reelSpinMs(p) + 60_000)).toBe(p.cards);
        }
      }
    }
  });

  it('also lands correctly for random laps, durations and out-of-range input', () => {
    for (let k = 0; k < 300; k++) {
      const n = 1 + Math.floor(rnd() * 12);
      const winner = Math.floor(rnd() * n);
      const p = reelPlan(n, winner + n * Math.floor(rnd() * 3), {
        start: Math.floor(rnd() * 40) - 20,
        laps: 1 + Math.floor(rnd() * 6),
        travelMs: 2500 + rnd() * 3000,
      });
      expect(reelItemAt(p, reelPos(p, reelSpinMs(p)))).toBe(winner);
      expect(reelStrip(n)[reelSlotAt(p, p.cards)]).toBe(winner);
    }
  });

  it('shows the same game in the strip as the reel position says, all the way', () => {
    // The DOM strip is one lap plus wrap copies; the reel is many laps. They
    // must agree at every card, not just the last one.
    for (let n = 1; n <= SLOTS; n++) {
      const strip = reelStrip(n);
      const p = reelPlan(n, n - 1, { start: 0 });
      for (let pos = 0; pos <= p.cards; pos++) {
        expect(strip[reelSlotAt(p, pos)]).toBe(reelItemAt(p, pos));
      }
    }
  });

  it('always has a neighbour to peek above and below the window', () => {
    // Window up to 2.2 cards tall, centred on the slot at the centre line.
    const half = 1.1;
    for (let n = 1; n <= SLOTS; n++) {
      const len = reelStrip(n).length;
      expect(len).toBe(n + 2 * REEL_PEEK);
      const p = reelPlan(n, 0, { start: 1 % n });
      for (let t = 0; t <= reelSpinMs(p); t += 5) {
        const c = reelSlotAt(p, reelPos(p, t)) + 0.5;
        expect(c - half).toBeGreaterThanOrEqual(0);
        expect(c + half).toBeLessThanOrEqual(len);
      }
    }
  });

  it('runs at least five laps of the 8 games, and a short list still gets a real spin', () => {
    for (let winner = 0; winner < SLOTS; winner++) {
      expect(reelPlan(SLOTS, winner).cards).toBeGreaterThanOrEqual(5 * SLOTS);
    }
    for (let n = 1; n <= SLOTS; n++) expect(reelPlan(n, 0).cards).toBeGreaterThanOrEqual(REEL_MIN_CARDS);
  });

  it('spins for 4–4.5 s and pops inside the old 3.5–4.5 s + silence window', () => {
    for (let winner = 0; winner < SLOTS; winner++) {
      const p = reelPlan(SLOTS, winner);
      expect(reelSpinMs(p)).toBeGreaterThanOrEqual(4000);
      expect(reelSpinMs(p)).toBeLessThanOrEqual(4500);
    }
    expect(SILENCE_MS).toBe(380);
  });

  it('decelerates monotonically until the winner arrives', () => {
    for (let n = 1; n <= SLOTS; n++) {
      for (let winner = 0; winner < n; winner++) {
        const p = reelPlan(n, winner);
        let prevPos = 0;
        let prevStep = Infinity;
        for (let t = 10; t <= p.travelMs; t += 10) {
          const pos = reelPos(p, t);
          const step = pos - prevPos;
          expect(step).toBeGreaterThan(0);
          expect(step).toBeLessThanOrEqual(prevStep + 1e-9);
          prevPos = pos;
          prevStep = step;
        }
        // Speed is continuous where the settle takes over: no visible jolt.
        expect(reelSpeed(p, p.travelMs - 1e-6)).toBeCloseTo(ARRIVE_SPEED, 3);
        expect(reelSpeed(p, p.travelMs)).toBeCloseTo(ARRIVE_SPEED, 9);
      }
    }
  });

  it('overshoots the winner a little and settles back onto it', () => {
    for (let winner = 0; winner < SLOTS; winner++) {
      const p = reelPlan(SLOTS, winner);
      let peak = 0;
      for (let t = p.travelMs; t <= reelSpinMs(p); t += 2) {
        const over = reelPos(p, t) - p.cards;
        // Never springs back past the winner to show the previous game.
        expect(over).toBeGreaterThanOrEqual(-1e-9);
        peak = Math.max(peak, over);
      }
      expect(peak).toBeGreaterThan(0.06);
      expect(peak).toBeLessThan(0.2);
      expect(reelItemAt(p, p.cards + peak)).toBe(winner);
    }
  });

  it('starts as a blur and ends with the last cards crawling past one by one', () => {
    for (let winner = 0; winner < SLOTS; winner++) {
      const p = reelPlan(SLOTS, winner);
      // Faster than the tick cap: the start is one rattle, not countable ticks.
      expect(reelSpeed(p, 0)).toBeGreaterThan(TICK_MAX_HZ);
      const iv = intervals(crossings(p));
      const tail = iv.slice(-4);
      // 탁…탁……탁: each of the last four visibly longer than the one before,
      for (let i = 1; i < tail.length; i++) expect(tail[i]! / tail[i - 1]!).toBeGreaterThan(1.15);
      // slow enough to count, and the last one not so slow it reads as a hang.
      expect(tail[0]!).toBeGreaterThanOrEqual(150);
      expect(tail.at(-1)!).toBeGreaterThanOrEqual(400);
      expect(tail.at(-1)!).toBeLessThanOrEqual(800);
      // Every crossing is strictly later than the one before.
      for (const d of iv) expect(d).toBeGreaterThan(0);
    }
  });

  it('handles a one-game reel', () => {
    const p = reelPlan(1, 0);
    expect(reelStrip(1).every((i) => i === 0)).toBe(true);
    expect(reelItemAt(p, reelPos(p, reelSpinMs(p)))).toBe(0);
    expect(reelSpeed(p, 0)).toBeGreaterThan(0);
  });
});

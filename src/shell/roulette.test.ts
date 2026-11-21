// The one test in the shell that is not optional.
//
// A roulette that lands on a different game than the one that was chosen
// destroys trust in a single spin, and it is exactly the kind of bug that
// survives manual testing (you have to notice the mismatch while the
// highlight is racing round the board). So: assert it over every board size,
// every winner and every start tile, every run.
import { describe, expect, it } from 'vitest';
import {
  BOARD_SLOTS,
  HOP_LAPS,
  TAIL,
  TRAVEL_MS,
  hopSchedule,
} from './hops';
import { mulberry32 } from '@/engine/rng';

const rnd = mulberry32(20261121);

const intervals = (at: number[]): number[] => at.map((t, i) => t - (i ? at[i - 1]! : 0));

describe('hopSchedule', () => {
  it('lands the last hop on the pre-decided winner, for every board', () => {
    for (let n = 1; n <= BOARD_SLOTS; n++) {
      for (let winner = 0; winner < n; winner++) {
        for (let start = 0; start < n; start++) {
          const plan = hopSchedule(n, winner, { start });
          expect(plan.at(-1)!.tile).toBe(winner);
        }
      }
    }
  });

  it('also lands correctly for random laps, travel times and out-of-range input', () => {
    for (let k = 0; k < 300; k++) {
      const n = 1 + Math.floor(rnd() * 12);
      const winner = Math.floor(rnd() * n);
      const plan = hopSchedule(n, winner + n * Math.floor(rnd() * 3), {
        start: Math.floor(rnd() * 40) - 20,
        laps: 1 + Math.floor(rnd() * 5),
        travelMs: 1000 + rnd() * 6000,
      });
      expect(plan.at(-1)!.tile).toBe(winner);
    }
  });

  it('never skips a tile: each hop moves exactly one step clockwise', () => {
    for (let k = 0; k < 100; k++) {
      const n = 2 + Math.floor(rnd() * 7);
      const start = Math.floor(rnd() * n);
      const plan = hopSchedule(n, Math.floor(rnd() * n), { start });
      let prev = start;
      for (const h of plan) {
        expect(h.tile).toBe((prev + 1) % n);
        prev = h.tile;
      }
    }
  });

  it('runs at least HOP_LAPS full laps', () => {
    for (let winner = 0; winner < BOARD_SLOTS; winner++) {
      expect(hopSchedule(BOARD_SLOTS, winner).length).toBeGreaterThanOrEqual(HOP_LAPS * BOARD_SLOTS);
    }
  });

  it('lands at exactly TRAVEL_MS, inside the 3.5–4.5 s window', () => {
    expect(TRAVEL_MS).toBeGreaterThanOrEqual(3500);
    expect(TRAVEL_MS).toBeLessThanOrEqual(4500);
    for (let winner = 0; winner < BOARD_SLOTS; winner++) {
      const plan = hopSchedule(BOARD_SLOTS, winner);
      expect(plan.at(-1)!.at).toBeCloseTo(TRAVEL_MS, 6);
    }
  });

  it('decelerates: every interval is at least as long as the one before', () => {
    for (let winner = 0; winner < BOARD_SLOTS; winner++) {
      const iv = intervals(hopSchedule(BOARD_SLOTS, winner).map((h) => h.at));
      for (let i = 1; i < iv.length; i++) expect(iv[i]!).toBeGreaterThanOrEqual(iv[i - 1]! - 1e-9);
    }
  });

  it('makes the last three hops noticeably longer', () => {
    for (let winner = 0; winner < BOARD_SLOTS; winner++) {
      const iv = intervals(hopSchedule(BOARD_SLOTS, winner).map((h) => h.at));
      const tail = iv.slice(-TAIL.length);
      let before = iv[iv.length - TAIL.length - 1]!;
      for (const t of tail) {
        expect(t / before).toBeGreaterThanOrEqual(1.3);
        before = t;
      }
    }
  });

  it('keeps the cadence trackable on the real 8-tile board', () => {
    // Faster than ~40 ms per hop and the eye stops seeing a highlight that
    // moves; a final hop much past 800 ms reads as the screen hanging.
    for (let winner = 0; winner < BOARD_SLOTS; winner++) {
      for (let start = 0; start < BOARD_SLOTS; start++) {
        const iv = intervals(hopSchedule(BOARD_SLOTS, winner, { start }).map((h) => h.at));
        expect(Math.min(...iv)).toBeGreaterThanOrEqual(40);
        expect(Math.max(...iv)).toBeLessThanOrEqual(800);
      }
    }
  });

  it('handles an empty board and a one-tile board', () => {
    expect(hopSchedule(0, 0)).toEqual([]);
    const one = hopSchedule(1, 0);
    expect(one.length).toBe(HOP_LAPS);
    expect(one.every((h) => h.tile === 0)).toBe(true);
    expect(one.at(-1)!.at).toBeCloseTo(TRAVEL_MS, 6);
  });
});

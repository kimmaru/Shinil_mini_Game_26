// The roulette's hop schedule — pure, so it is unit-tested without the game
// registry, React or a DOM (see roulette.test.ts). The board that plays it
// back is components/RouletteBoard.tsx.

/** Full laps of the board before the highlight starts to settle. */
export const HOP_LAPS = 3;
/** First hop to last hop. The spec window is 3.5–4.5 s. */
export const TRAVEL_MS = 4000;
/** The held breath between the last hop and the pop. No tick, no motion. */
export const SILENCE_MS = 380;
/** The last regular interval is this many times the first one. */
export const HOP_GROWTH = 4.5;
/** The last three hops, as multiples of the last regular interval. Each one is
 *  visibly longer than the one before it — that is where the suspense is. */
export const TAIL = [1.5, 2.2, 3.0] as const;
/** Tiles on the 3×3 ring (the centre cell is the hub). */
export const BOARD_SLOTS = 8;

export interface Hop {
  /** Ring index the highlight lands on. */
  tile: number;
  /** Ms after the spin starts at which it lands there. */
  at: number;
}

/**
 * The highlight's whole journey, decided before the first frame.
 *
 * Hop k lands on `(start + k) % n`, so the highlight never skips a tile, and
 * the hop count is `laps * n + offset` with the offset chosen so the LAST hop
 * is `winner`. Intervals grow geometrically (fast → slow, an ease-out made of
 * discrete steps), then the final three stretch by `TAIL`. The whole thing is
 * scaled so the last hop lands at exactly `travelMs`.
 */
export function hopSchedule(
  n: number,
  winner: number,
  o: { start?: number; travelMs?: number; laps?: number } = {},
): Hop[] {
  if (n <= 0) return [];
  const travel = o.travelMs ?? TRAVEL_MS;
  const laps = Math.max(1, o.laps ?? HOP_LAPS);
  const w = ((winner % n) + n) % n;
  const s = (((o.start ?? 0) % n) + n) % n;
  const hops = laps * n + ((w - s + n) % n);

  const regular = Math.max(1, hops - TAIL.length);
  const r = regular > 1 ? HOP_GROWTH ** (1 / (regular - 1)) : 1;
  const raw: number[] = [];
  for (let k = 0; k < regular; k++) raw.push(r ** k);
  const last = raw[raw.length - 1]!;
  for (const m of TAIL) if (raw.length < hops) raw.push(last * m);
  // A 1–3 hop board (tiny n, one lap) has fewer hops than regular + tail.
  raw.length = Math.min(raw.length, hops);

  const sum = raw.reduce((a, b) => a + b, 0);
  const k = travel / sum;
  const out: Hop[] = [];
  let at = 0;
  for (let i = 0; i < raw.length; i++) {
    at += raw[i]! * k;
    out.push({ tile: (s + i + 1) % n, at });
  }
  return out;
}

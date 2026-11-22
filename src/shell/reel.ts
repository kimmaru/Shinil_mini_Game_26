// The slot-machine reel's motion and strip layout — pure, so it is unit-tested
// without the game registry, React or a DOM (roulette.test.ts). The component
// that plays it back is components/SlotReel.tsx.
//
// The order is the whole point, as it was for the board this replaced:
//   1. the winner is decided FIRST (`decideRound` in ./rounds.ts)
//   2. the reel's whole journey is computed from that index (`reelPlan`)
//   3. one rAF loop samples `reelPos` against the clock
// The reel cannot land anywhere else: `reelPos` ends at exactly `plan.cards`,
// and the card `plan.cards` steps after `plan.start` IS the winner.
//
// ── The motion, in cards (one card = one game passing the centre line) ─────
//   travel   speed falls from v0 (~30 cards/s: 촤라라락) to ARRIVE_SPEED as
//            ARRIVE + (v0 - ARRIVE)·(1 - t/T)², so the last 3–4 cards crawl
//            past one by one (~170, 200, 260, 370, 550 ms: 탁…탁……탁).
//            v0 is solved so the distance is exactly `cards` at T.
//   settle   the winner arrives still moving at ARRIVE_SPEED, overshoots by
//            ~0.1 card and springs back: x = a·t·(1 - t/S)², which leaves at
//            the arrival speed and comes to rest at exactly 0 at S.

/** Full laps of the games before the reel settles. */
export const REEL_LAPS = 5;
/** A short shortlist still gets a proper 촤라라락. */
export const REEL_MIN_CARDS = 24;
/** Start → the winner first reaching the centre line. */
export const REEL_TRAVEL_MS = 3700;
/** The overshoot-and-settle bounce after that. Travel + settle = the spin. */
export const REEL_SETTLE_MS = 450;
/** The held breath between the reel coming to rest and the pop. */
export const SILENCE_MS = 380;
/** Cards/s at which the winner reaches the centre line: the last "탁". */
export const ARRIVE_SPEED = 1.6;
/** Copies of the strip's ends rendered past each side of one lap, so a
 *  neighbour always peeks above and below the window. */
export const REEL_PEEK = 2;
/** At most this many `ui.tick`s a second. At full speed ~30 cards a second
 *  cross the line; capped, the crossings merge into one rattle and then
 *  separate into single ticks as the reel slows down. */
export const TICK_MAX_HZ = 22;

export interface ReelPlan {
  /** Games on the reel. */
  n: number;
  /** Item at the centre line before the spin. */
  start: number;
  /** Item at the centre line when it stops. */
  winner: number;
  /** Cards that cross the centre line, start → winner. */
  cards: number;
  /** Initial speed, cards per second. */
  v0: number;
  travelMs: number;
  settleMs: number;
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

export function reelPlan(
  n: number,
  winner: number,
  o: { start?: number; laps?: number; travelMs?: number; settleMs?: number } = {},
): ReelPlan {
  const nn = Math.max(1, Math.floor(n));
  const w = mod(Math.floor(winner), nn);
  const s = mod(Math.floor(o.start ?? 0), nn);
  const laps = Math.max(o.laps ?? REEL_LAPS, Math.ceil(REEL_MIN_CARDS / nn));
  const cards = laps * nn + mod(w - s, nn);
  const travelMs = o.travelMs ?? REEL_TRAVEL_MS;
  const T = travelMs / 1000;
  // ∫ ARRIVE + (v0 - ARRIVE)(1 - t/T)² dt over [0, T] = ARRIVE·T + (v0 - ARRIVE)·T/3.
  const v0 = ARRIVE_SPEED + (3 * (cards - ARRIVE_SPEED * T)) / T;
  return { n: nn, start: s, winner: w, cards, v0, travelMs, settleMs: o.settleMs ?? REEL_SETTLE_MS };
}

/** Travel + settle: when the reel is at rest on the winner. */
export const reelSpinMs = (p: ReelPlan): number => p.travelMs + p.settleMs;

/** Cards travelled at `tMs` after the start. Exactly `plan.cards` at and after
 *  the end of the settle; never below it once the winner has arrived. */
export function reelPos(p: ReelPlan, tMs: number): number {
  if (!(tMs > 0)) return 0;
  if (tMs < p.travelMs) {
    const T = p.travelMs / 1000;
    const t = tMs / 1000;
    const r = 1 - t / T;
    // Distance = total minus what is left to travel in the remaining T·r.
    return p.cards - (ARRIVE_SPEED * T * r + ((p.v0 - ARRIVE_SPEED) * T * r * r * r) / 3);
  }
  const t = (tMs - p.travelMs) / 1000;
  const S = p.settleMs / 1000;
  if (t >= S) return p.cards;
  const u = 1 - t / S;
  return p.cards + ARRIVE_SPEED * t * u * u;
}

/** Speed in cards per second (signed: negative while springing back). */
export function reelSpeed(p: ReelPlan, tMs: number): number {
  if (tMs < 0) return 0;
  if (tMs < p.travelMs) {
    const r = 1 - tMs / p.travelMs;
    return ARRIVE_SPEED + (p.v0 - ARRIVE_SPEED) * r * r;
  }
  const S = p.settleMs / 1000;
  const t = (tMs - p.travelMs) / 1000;
  if (t >= S) return 0;
  const u = t / S;
  return ARRIVE_SPEED * (1 - u) * (1 - 3 * u);
}

/** The item whose card is nearest the centre line at `pos`. */
export const reelItemAt = (p: ReelPlan, pos: number): number => mod(p.start + Math.round(pos), p.n);

// ─── Strip layout ───────────────────────────────────────────────────────────
//
// The item sequence is periodic, so the DOM holds ONE lap plus REEL_PEEK
// cards past each end, and the reel position is taken modulo one lap. The
// strip is painted once and only ever moved by `transform` — on the 2015
// MacBook a 45-card strip would keep rasterising new tiles at 7000 px/s.
//
// Cards move DOWN, like a real reel: the next game arrives from above, so
// the strip lists the lap in reverse, top to bottom.

/** Item index per strip slot, top to bottom. */
export function reelStrip(n: number): number[] {
  const nn = Math.max(1, Math.floor(n));
  const out: number[] = [];
  for (let d = 0; d < nn + 2 * REEL_PEEK; d++) out.push(mod(nn - 1 + REEL_PEEK - d, nn));
  return out;
}

/** Which strip slot (fractional, 0 = top) sits on the centre line at `pos`. */
export function reelSlotAt(p: ReelPlan, pos: number): number {
  return p.n - 1 + REEL_PEEK - mod(p.start + pos, p.n);
}

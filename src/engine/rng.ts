// Seeded RNG. `Math.random()` is banned in games: a round that cannot be
// reproduced from a seed cannot be replay-tested, and 58 games is far too many
// to debug by re-playing them by hand.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a string to a seed, so `?seed=hello` works and a game id can seed
 *  itself deterministically. */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Unbiased integer in [0, n), from crypto when available.
 *
 * Rejection sampling, not `% n`: modulo bias would make some games
 * systematically rarer on the roulette, and with 58 games and a small wheel
 * that is noticeable over an afternoon.
 */
export function secureInt(n: number): number {
  if (n <= 1) return 0;
  const g = globalThis.crypto;
  if (!g?.getRandomValues) return Math.floor(Math.random() * n);
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (let tries = 0; tries < 64; tries++) {
    g.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % n;
  }
  return buf[0]! % n;
}

// A shuffle bag: draw without replacement until empty, then refill.
//
// Plain random picking repeats, and children notice a repeat within two
// minutes ("또 이거야?"). This guarantees every game in the pool appears once
// before any appears twice, which reads as "the wheel is fair".
import { secureInt } from './rng';

export class ShuffleBag<T> {
  private bag: T[] = [];
  private items: T[] = [];
  /** The last item drawn, so a refill never immediately repeats it. */
  private last: T | undefined;

  constructor(items: readonly T[] = []) {
    this.setItems(items);
  }

  /** Replace the pool. Keeps any undrawn items that are still in the new pool,
   *  so re-filtering mid-party (a player joins, intensity is capped) does not
   *  reset the no-repeat guarantee. */
  setItems(items: readonly T[]): void {
    this.items = [...items];
    const allowed = new Set(items);
    this.bag = this.bag.filter((x) => allowed.has(x));
    if (this.bag.length === 0) this.refill();
  }

  private refill(): void {
    this.bag = [...this.items];
    // Fisher-Yates.
    for (let i = this.bag.length - 1; i > 0; i--) {
      const j = secureInt(i + 1);
      const tmp = this.bag[i]!;
      this.bag[i] = this.bag[j]!;
      this.bag[j] = tmp;
    }
    // Avoid an immediate repeat across the refill boundary.
    if (this.bag.length > 1 && this.last !== undefined && this.bag.at(-1) === this.last) {
      const tmp = this.bag[0]!;
      this.bag[0] = this.bag.at(-1)!;
      this.bag[this.bag.length - 1] = tmp;
    }
  }

  draw(): T | undefined {
    if (this.items.length === 0) return undefined;
    if (this.bag.length === 0) this.refill();
    const x = this.bag.pop();
    this.last = x;
    return x;
  }

  /** Peek at `n` upcoming items without consuming them. Used to build the
   *  roulette shortlist and to modulepreload the likely next chunks. */
  peek(n: number): T[] {
    if (this.items.length === 0) return [];
    const out: T[] = [];
    let i = this.bag.length - 1;
    while (out.length < n && out.length < this.items.length) {
      if (i < 0) break;
      out.push(this.bag[i]!);
      i--;
    }
    return out;
  }

  get remaining(): number {
    return this.bag.length;
  }
}

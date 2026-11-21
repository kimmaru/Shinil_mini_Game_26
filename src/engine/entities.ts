// ══ FROZEN CONTRACT ══ imported by 58 game modules.
//
// A fixed-capacity pool of simple 2D objects, stored as parallel typed arrays.
//
// Roughly 22 games in the catalogue are "things appear, move, you touch them,
// they die". Writing that loop 22 times produces 22 subtly different bugs, and
// every one of them allocates in update(). This is the one implementation.
//
// Struct-of-arrays rather than an array of objects: no per-frame allocation, no
// GC pauses mid-round, and `alive` compaction is a swap of 10 numbers.
export const ENTITY_CAP = 192;

/** Free-form per-entity tag. Games assign their own meaning (fruit vs bomb). */
export type EntityKind = number;

export class Entities {
  readonly cap: number;
  /** Number of live entities; slots [0, n) are live and densely packed. */
  n = 0;

  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  /** Previous position, for swept collision against a fast-moving hand. */
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly r: Float32Array;
  readonly rot: Float32Array;
  readonly spin: Float32Array;
  /** Seconds remaining; <= 0 retires the entity on the next sweep. */
  readonly life: Float32Array;
  /** Life it was spawned with, so you can compute 0..1 age for fades. */
  readonly life0: Float32Array;
  readonly kind: Int16Array;
  /** Hit points, for objects needing several swats. */
  readonly hp: Int16Array;
  /** Free numeric scratch per entity (phase, lane, target index...). */
  readonly data: Float32Array;
  /** Monotonic id, so a game can remember "I already scored this one". */
  readonly id: Int32Array;

  private nextId = 1;

  constructor(cap = ENTITY_CAP) {
    this.cap = cap;
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.px = new Float32Array(cap);
    this.py = new Float32Array(cap);
    this.r = new Float32Array(cap);
    this.rot = new Float32Array(cap);
    this.spin = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.life0 = new Float32Array(cap);
    this.kind = new Int16Array(cap);
    this.hp = new Int16Array(cap);
    this.data = new Float32Array(cap);
    this.id = new Int32Array(cap);
  }

  /** Returns the new index, or -1 when full. Check it — a silent drop at
   *  capacity is much better than a crash, but you must not write to -1. */
  spawn(
    x: number, y: number,
    vx = 0, vy = 0,
    r = 20, life = 6, kind: EntityKind = 0, hp = 1,
  ): number {
    if (this.n >= this.cap) return -1;
    const i = this.n++;
    this.x[i] = x; this.y[i] = y;
    this.px[i] = x; this.py[i] = y;
    this.vx[i] = vx; this.vy[i] = vy;
    this.r[i] = r;
    this.rot[i] = 0; this.spin[i] = 0;
    this.life[i] = life; this.life0[i] = life;
    this.kind[i] = kind; this.hp[i] = hp;
    this.data[i] = 0;
    this.id[i] = this.nextId++;
    return i;
  }

  /** Integrate positions and decay life. `gravity` in px/sec^2. */
  step(dt: number, gravity = 0): void {
    for (let i = 0; i < this.n; i++) {
      this.px[i] = this.x[i]!;
      this.py[i] = this.y[i]!;
      if (gravity !== 0) this.vy[i] = this.vy[i]! + gravity * dt;
      this.x[i] = this.x[i]! + this.vx[i]! * dt;
      this.y[i] = this.y[i]! + this.vy[i]! * dt;
      this.rot[i] = this.rot[i]! + this.spin[i]! * dt;
      this.life[i] = this.life[i]! - dt;
    }
  }

  /** Age as 0..1 (0 = just spawned). For fade-in/out. */
  age(i: number): number {
    const l0 = this.life0[i]!;
    return l0 <= 0 ? 1 : 1 - this.life[i]! / l0;
  }

  /** Mark for removal on the next sweep(). Safe to call while iterating. */
  kill(i: number): void {
    this.life[i] = -1;
  }

  /**
   * Remove dead entities by swapping the last live one into the hole.
   *
   * Call this ONCE per update, AFTER all your iteration. Order is not
   * preserved — never store a bare index across a sweep; store `id` instead.
   * `onRetire` fires for each removal, before the swap.
   */
  sweep(onRetire?: (i: number) => void): void {
    for (let i = this.n - 1; i >= 0; i--) {
      if (this.life[i]! > 0) continue;
      onRetire?.(i);
      const last = --this.n;
      if (i !== last) {
        this.x[i] = this.x[last]!; this.y[i] = this.y[last]!;
        this.px[i] = this.px[last]!; this.py[i] = this.py[last]!;
        this.vx[i] = this.vx[last]!; this.vy[i] = this.vy[last]!;
        this.r[i] = this.r[last]!;
        this.rot[i] = this.rot[last]!; this.spin[i] = this.spin[last]!;
        this.life[i] = this.life[last]!; this.life0[i] = this.life0[last]!;
        this.kind[i] = this.kind[last]!; this.hp[i] = this.hp[last]!;
        this.data[i] = this.data[last]!; this.id[i] = this.id[last]!;
      }
    }
  }

  /** Retire everything whose centre has left the box by more than its radius. */
  cullOutside(x0: number, y0: number, x1: number, y1: number): void {
    for (let i = 0; i < this.n; i++) {
      const rr = this.r[i]!;
      const ex = this.x[i]!;
      const ey = this.y[i]!;
      if (ex < x0 - rr || ex > x1 + rr || ey < y0 - rr || ey > y1 + rr) this.life[i] = -1;
    }
  }

  clear(): void {
    this.n = 0;
  }
}

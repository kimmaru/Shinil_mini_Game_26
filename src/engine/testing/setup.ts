// Vitest setup: the few browser globals the engine touches that Node lacks.
//
// Deliberately minimal. The engine is designed so that GAME LOGIC needs no DOM
// at all — that is what lets 58 games be verified headlessly. Only the Canvas2D
// renderer's own unit tests reach for browser APIs, and they drive a fake
// context, so a shape-recording stub is enough.

/** `Path2D` exists only in browsers. Sprites compile their SVG path strings
 *  into one, so without this the renderer's tests cannot construct a sprite. */
if (typeof (globalThis as { Path2D?: unknown }).Path2D === 'undefined') {
  class Path2DStub {
    readonly d: string;
    constructor(d?: string | Path2DStub) {
      this.d = typeof d === 'string' ? d : (d?.d ?? '');
    }
    addPath(): void {}
  }
  (globalThis as { Path2D?: unknown }).Path2D = Path2DStub;
}

// stroke — a wrist trail, for drawing, tracing and shape games.
//
// The trail is in view px because that is what a game draws and hit-tests
// against, but the point-spacing filter is in shoulder widths: a child standing
// closer makes bigger pixel movements for the same gesture, and a px-spaced
// trail would be denser at 1m than at 3m and change the shape of the stroke.
import { L, type Side, palm } from '../pose/landmarks';
import type { GestureOpts, PlayerPose } from '../types';
import type { StrokeOpts, StrokeSignal } from './index';
import { DetectorBase, opt, scaleOf, seen1 } from './trigger';

/** How long the trail may stand still before `drawing` goes false. */
export const STROKE_IDLE_MS = 250;

/**
 * Default minimum spacing between trail points, shoulder widths.
 *
 * Has to clear the landmark jitter, or a hand held perfectly still keeps
 * appending noise and `drawing` never goes false. Measured on this corpus at a
 * 134px shoulder width: a single frame moves the palm about 0.04 sw on `idle`
 * and 0.07 sw on `fidget` from jitter alone, with 3-sigma excursions to 0.12
 * and 0.20. 0.18 sits above the realistic case and still gives a 64-point trail
 * roughly 11 shoulder widths of path to work with.
 */
export const STROKE_MIN_STEP = 0.18;

export class StrokeDetector extends DetectorBase<'stroke'> {
  readonly kind = 'stroke' as const;
  protected readonly s: StrokeSignal;

  private side: Side = 'R';
  private minStep = STROKE_MIN_STEP;
  private readonly cap: number;
  private readonly pt = { x: 0, y: 0 };
  private lastGrowMs = -1e9;

  constructor(o: StrokeOpts = {}) {
    super(o, 0);
    // The subject's RIGHT hand by default — which, because the preview is
    // mirrored, is the hand a right-handed child sees on the LEFT of the
    // screen. landmarks.ts decides this once; we just follow it.
    if (o.side !== undefined) this.side = o.side;
    this.cap = Math.max(2, Math.round(opt(o.maxPoints, 64, 2, 1024)));
    this.minStep = opt(o.minStep, STROKE_MIN_STEP, 0.005, 1);
    this.s = {
      points: new Float32Array(this.cap * 2),
      count: 0,
      drawing: false,
      ok: false,
    };
  }

  protected override onConfigure(o: Partial<GestureOpts['stroke']>): void {
    const st = o as Partial<StrokeOpts>;
    if (st.side !== undefined && st.side !== this.side) {
      this.side = st.side;
      this.s.count = 0;
    }
    if (st.minStep !== undefined) this.minStep = opt(st.minStep, this.minStep, 0.005, 1);
    // maxPoints is NOT re-applied: the array is allocated once by contract.
  }

  protected clearEdges(): void {
    // `drawing` is a sustained state.
  }

  protected step(p: PlayerPose): void {
    const wrist = this.side === 'L' ? L.LEFT_WRIST : L.RIGHT_WRIST;
    const ok = seen1(p, wrist);
    this.setOk(ok);
    if (!ok) {
      this.s.drawing = false;
      return;
    }

    palm(p, this.side, this.pt);
    const step = this.minStep * scaleOf(p);
    const n = this.s.count;
    let grow = n === 0;
    if (n > 0) {
      const dx = this.pt.x - this.s.points[(n - 1) * 2]!;
      const dy = this.pt.y - this.s.points[(n - 1) * 2 + 1]!;
      grow = dx * dx + dy * dy >= step * step;
    }
    if (grow) {
      if (n >= this.cap) {
        // Oldest-first and contiguous, so a game can hand `points` straight to
        // a polyline. copyWithin allocates nothing.
        this.s.points.copyWithin(0, 2, this.cap * 2);
        this.s.points[(this.cap - 1) * 2] = this.pt.x;
        this.s.points[(this.cap - 1) * 2 + 1] = this.pt.y;
      } else {
        this.s.points[n * 2] = this.pt.x;
        this.s.points[n * 2 + 1] = this.pt.y;
        this.s.count = n + 1;
      }
      this.lastGrowMs = this.tMs;
    }
    // "A stroke is being laid down" — true while the trail is still growing.
    // A hand parked on the canvas is not drawing, and `minStep` is what decides
    // that, so no extra speed threshold is needed.
    this.s.drawing = this.tMs - this.lastGrowMs <= STROKE_IDLE_MS;
  }

  protected onReset(): void {
    this.s.count = 0;
    this.s.drawing = false;
    this.lastGrowMs = -1e9;
  }

  protected override get dbgUnit(): string {
    return 'trail points';
  }
  protected override get dbgValue(): number {
    return this.s.count;
  }
  protected override get dbgEnter(): number {
    return this.cap;
  }
  protected override get dbgActive(): boolean {
    return this.s.drawing;
  }
}

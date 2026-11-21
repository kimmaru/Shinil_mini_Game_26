import { describe, expect, it } from 'vitest';

import { buildClip } from '../testing/synth';
import { createGestureService } from './service';
import { STROKE_IDLE_MS } from './stroke';
import { driveClip } from './harness.test';

describe('stroke', () => {
  it('captures a trail, oldest first, and never exceeds maxPoints', () => {
    const g = createGestureService(() => undefined);
    const d = g.use('stroke', { maxPoints: 16, minStep: 0.05 });
    let maxCount = 0;
    driveClip('reach-grid', (f) => {
      const s = d.read(f);
      maxCount = Math.max(maxCount, s.count);
      expect(s.count).toBeLessThanOrEqual(16);
      expect(s.points.length).toBe(32);
      for (let i = 0; i < s.count * 2; i++) expect(Number.isFinite(s.points[i]!)).toBe(true);
    });
    expect(maxCount).toBe(16); // the ring filled and kept sliding
  });

  it('is contiguous and ordered after wrapping', () => {
    // A game hands `points` straight to a polyline, so index 0 must be the
    // oldest surviving point after the ring has wrapped many times.
    const g = createGestureService(() => undefined);
    const d = g.use('stroke', { maxPoints: 8, minStep: 0.05 });
    let lastFirst = -1;
    let moved = 0;
    driveClip('reach-grid', (f) => {
      const s = d.read(f);
      if (s.count < 8) return;
      if (s.points[0]! !== lastFirst) moved++;
      lastFirst = s.points[0]!;
    });
    expect(moved).toBeGreaterThan(20); // the window really does slide
  });

  it('drops points closer than minStep, in SHOULDER WIDTHS not pixels', () => {
    // The same gesture at two camera distances must produce a similar number of
    // points. A pixel-spaced trail would be denser close up and change the
    // shape of the stroke.
    const sweep = (S: number): number => {
      const c = buildClip(
        `sweep-${S}`,
        8,
        // hipY low and the elevation modest so the wrist stays INSIDE the frame
        // at both scales: an off-frame wrist is correctly gated, which would
        // make this a test of the clip's framing instead of of minStep.
        (_u, t) => ({ shoulderW: S, hipY: 0.85, armL: 20 + 45 * Math.sin(t * 1.2), elbowL: 4 }),
        { seed: 91, dropout: 0 },
      );
      const g = createGestureService(() => undefined);
      const d = g.use('stroke', { side: 'L', maxPoints: 512, minStep: 0.25 });
      let n = 0;
      driveClip(c, (f) => {
        n = d.read(f).count;
      });
      return n;
    };
    const near = sweep(0.16);
    const far = sweep(0.1);
    expect(near).toBeGreaterThan(10);
    // Not exact: at a smaller body the same landmark jitter is a larger
    // fraction of a shoulder width, so a few extra noise points sneak past the
    // spacing filter. Within 40% is the honest guarantee.
    expect(Math.abs(near - far) / near).toBeLessThan(0.4);
  });

  it('drawing goes false when the hand stops, true when it moves', () => {
    const halfStop = buildClip(
      'half-stop',
      10,
      (_u, t) =>
        t < 5
          ? { armL: 20 + 60 * Math.sin(t * 1.5), elbowL: 4 }
          : { armL: 20, elbowL: 4 },
      { seed: 92, dropout: 0 },
    );
    const g = createGestureService(() => undefined);
    const d = g.use('stroke', { side: 'L' });
    let drawingWhileMoving = 0;
    let drawingWhileStopped = 0;
    let movingReads = 0;
    let stoppedReads = 0;
    driveClip(halfStop, (f) => {
      const s = d.read(f);
      if (f.t < 4.5) {
        movingReads++;
        if (s.drawing) drawingWhileMoving++;
      } else if (f.t > 5 + STROKE_IDLE_MS / 1000 + 0.2) {
        stoppedReads++;
        if (s.drawing) drawingWhileStopped++;
      }
    });
    // Not 100%: the sweep is a sine, so the hand genuinely pauses at each
    // turning point and `drawing` correctly goes quiet there.
    expect(drawingWhileMoving / movingReads).toBeGreaterThan(0.7);
    expect(drawingWhileStopped / stoppedReads).toBeLessThan(0.1);
  });

  it('holds the trail and stops drawing when the wrist is lost', () => {
    const g = createGestureService(() => undefined);
    const d = g.use('stroke', { side: 'L' });
    let countAtLoss = -1;
    let drawingAfterLoss = false;
    let reads = 0;
    driveClip('reach-grid', (f) => {
      reads++;
      // Lose the wrist for the back half of the clip.
      if (reads > 400) f.p1!.vis[15] = 0.1;
      const s = d.read(f);
      if (reads === 400) countAtLoss = s.count;
      if (reads > 420) {
        drawingAfterLoss = drawingAfterLoss || s.drawing;
        expect(s.count).toBe(countAtLoss); // held, not cleared, not extended
        expect(s.ok).toBe(false);
      }
    });
    expect(countAtLoss).toBeGreaterThan(0);
    expect(drawingAfterLoss).toBe(false);
  });

  it('reset() clears the trail for the next round', () => {
    const g = createGestureService(() => undefined);
    const d = g.use('stroke');
    driveClip('reach-grid', (f) => void d.read(f));
    g.resetAll();
    let firstCount = -1;
    driveClip('idle', (f) => {
      if (firstCount < 0) firstCount = d.read(f).count;
      else d.read(f);
    });
    expect(firstCount).toBeLessThanOrEqual(1);
  });

  it('defaults to the subject right hand', () => {
    // landmarks.ts fixes this once: "left"/"right" are the SUBJECT's, and
    // because the preview is mirrored the subject's right hand appears on the
    // viewer's left. A right-handed child draws with 'R'.
    const oneArm = buildClip(
      'one-arm',
      6,
      (_u, t) => ({ armR: 160 - 60 * Math.sin(t * 1.5), elbowR: 4, armL: -78 }),
      { seed: 93, dropout: 0 },
    );
    const g = createGestureService(() => undefined);
    const dflt = g.use('stroke', { minStep: 0.1 });
    const left = g.use('stroke', { side: 'L', minStep: 0.1 });
    let dn = 0;
    let ln = 0;
    driveClip(oneArm, (f) => {
      dn = dflt.read(f).count;
      ln = left.read(f).count;
    });
    expect(dn).toBeGreaterThan(ln);
  });
});

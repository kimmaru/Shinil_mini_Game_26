import { describe, expect, it } from 'vitest';
import { L } from './landmarks';
import { figureBounds, warmupLandmarker, type WarmupTarget } from './warmup';
import { body } from '../testing/synth';

describe('the warmup figure', () => {
  it('is entirely inside the canvas — an off-canvas figure cannot be detected', () => {
    const b = figureBounds();
    expect(b.min).toBeGreaterThan(0.02);
    expect(b.max).toBeLessThan(0.98);
  });

  it('is a plausible human: head above shoulders above hips above ankles', () => {
    const lm = body({ hipX: 0.5, hipY: 0.47, shoulderW: 0.185 }, 1);
    const y = (j: number): number => lm[j * 2 + 1]!;
    expect(y(L.NOSE)).toBeLessThan(y(L.LEFT_SHOULDER));
    expect(y(L.LEFT_SHOULDER)).toBeLessThan(y(L.LEFT_HIP));
    expect(y(L.LEFT_HIP)).toBeLessThan(y(L.LEFT_KNEE));
    expect(y(L.LEFT_KNEE)).toBeLessThan(y(L.LEFT_ANKLE));
  });
});

describe('warmupLandmarker', () => {
  // No OffscreenCanvas in Node, which is itself one of the cases this has to
  // handle honestly: a browser without it cannot be warmed up this way.
  it('reports failure instead of pretending, when it cannot draw', async () => {
    const r = await warmupLandmarker({ detectForVideo: () => ({ landmarks: [[]] }) });
    expect(r.ok).toBe(false);
    expect(r.poseFound).toBe(false);
    expect(r.message).toContain('OffscreenCanvas');
  });

  it('is honest when a pose is NOT found: the compile has not been paid for', async () => {
    const calls: number[] = [];
    const target: WarmupTarget = {
      detectForVideo: (_i, t) => {
        calls.push(t);
        return { landmarks: [] }; // nothing detected
      },
    };
    const r = await withFakeCanvas(() => warmupLandmarker(target, { attempts: 3 }));
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
    expect(r.poseFound).toBe(false);
    expect(r.message).toContain('did not trigger detection');
    expect(r.message).toContain('calibration screen');
    // Timestamps strictly increase — a repeat makes detectForVideo throw.
    expect(calls).toEqual([...calls].sort((a, b) => a - b));
    expect(new Set(calls).size).toBe(calls.length);
  });

  it('reports success only when a pose really came back', async () => {
    const target: WarmupTarget = {
      detectForVideo: () => ({ landmarks: [[{ x: 0.5, y: 0.5 }]] }),
    };
    const r = await withFakeCanvas(() => warmupLandmarker(target, { attempts: 2 }));
    expect(r.ok).toBe(true);
    expect(r.poseFound).toBe(true);
    expect(r.message).toContain('compiled');
  });

  it('falls back to detect() for an IMAGE-mode landmarker', async () => {
    let n = 0;
    const r = await withFakeCanvas(() =>
      warmupLandmarker(
        {
          detect: () => {
            n++;
            return { landmarks: [[{}]] };
          },
        },
        { attempts: 2 },
      ),
    );
    expect(n).toBe(2);
    expect(r.poseFound).toBe(true);
  });

  it('surfaces a throw instead of swallowing it', async () => {
    const r = await withFakeCanvas(() =>
      warmupLandmarker({
        detectForVideo: () => {
          throw new Error('WebGL context lost');
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain('WebGL context lost');
  });

  it('gives up on a deadline rather than hanging the loading screen', async () => {
    let now = 0;
    const r = await withFakeCanvas(() =>
      warmupLandmarker(
        {
          detectForVideo: () => {
            now += 30_000; // a very cold shader cache
            return { landmarks: [] };
          },
        },
        { attempts: 5, timeoutMs: 60_000, now: () => now },
      ),
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain('timed out');
    expect(r.attempts).toBeLessThan(5);
  });

  it('refuses a landmarker with no detect method at all', async () => {
    const r = await withFakeCanvas(() => warmupLandmarker({}));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('neither detect()');
  });
});

/**
 * Minimal OffscreenCanvas + 2D context stand-in.
 *
 * Node has neither, and the point of these tests is the warmup CONTRACT —
 * attempts, honesty, monotonic timestamps, deadlines — not Canvas2D itself.
 */
async function withFakeCanvas<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as Record<string, unknown>;
  const had = 'OffscreenCanvas' in g;
  const ctx = new Proxy(
    {},
    {
      get: (_t, k) =>
        k === 'canvas' ? undefined : typeof k === 'string' ? () => undefined : undefined,
      set: () => true,
    },
  );
  g.OffscreenCanvas = class {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext(): unknown {
      return ctx;
    }
  };
  try {
    return await fn();
  } finally {
    if (!had) delete g.OffscreenCanvas;
  }
}

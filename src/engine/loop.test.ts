import { describe, expect, it, vi } from 'vitest';
import { createLoop, STEP } from './loop';
import type { MiniGame, PoseFrame } from './types';
import type { PoseSource } from './pose/source';
import type { Renderer } from './render/renderer';
import type { FxRuntime } from './fx/service';

/** A clock we drive by hand, so the loop is tested deterministically rather
 *  than against whatever the machine happened to do. */
function fakeRaf() {
  let cbs: ((t: number) => void)[] = [];
  let now = 0;
  const g = globalThis as Record<string, unknown>;
  g['requestAnimationFrame'] = (cb: (t: number) => void) => { cbs.push(cb); return cbs.length; };
  g['cancelAnimationFrame'] = () => { cbs = []; };
  g['performance'] = { now: () => now };
  return {
    advance(ms: number): void {
      now += ms;
      const due = cbs;
      cbs = [];
      for (const cb of due) cb(now);
    },
    get pending() { return cbs.length; },
  };
}

const stubFrame = {} as PoseFrame;

function stubPose(): PoseSource {
  return {
    info: { kind: 'replay', fps: 25, tier: 'test' },
    sample: () => stubFrame,
    start: async () => {},
    stop: () => {},
    calibrate: async () => { throw new Error('n/a'); },
    setCalibration: () => {},
    pause: vi.fn(),
    resume: vi.fn(),
  } as unknown as PoseSource;
}

/** Records the order of engine calls, which is the thing under test. */
function harness() {
  const order: string[] = [];
  const game: MiniGame = {
    init: () => {},
    start: () => {},
    update: vi.fn(() => order.push('update')),
    render: vi.fn(() => order.push('render')),
    end: () => ({
      gameId: 'x', cleared: false, rawScore: 0, maxScore: 1,
      normalized: 0, stars: 0, durationMs: 0, perPlayer: [],
    }),
  };
  const g = {
    save: () => order.push('save'),
    restore: () => order.push('restore'),
  } as unknown as Renderer;
  let timeScale = 1;
  const fx = {
    update: vi.fn((dt: number) => order.push(`fx.update(${dt.toFixed(4)})`)),
    applyCamera: () => order.push('fx.applyCamera'),
    draw: () => order.push('fx.draw'),
    get timeScale() { return timeScale; },
  } as unknown as FxRuntime;
  return { order, game, g, fx, setTimeScale: (v: number) => { timeScale = v; } };
}

describe('loop: fixed timestep', () => {
  it('runs exactly one update per 1/60s of elapsed time', () => {
    const raf = fakeRaf();
    const h = harness();
    const loop = createLoop(h.game, stubPose(), h.g, { fx: h.fx });
    loop.start();
    raf.advance(0);
    for (let i = 0; i < 60; i++) raf.advance(16.667); // 1.0s at a real cadence
    expect(h.game.update).toHaveBeenCalledTimes(60);
    loop.stop();
  });

  it('always passes a fixed dt, never the real frame time', () => {
    // Games are written against dt === 1/60 exactly; a variable dt silently
    // breaks every seeded replay.
    const raf = fakeRaf();
    const h = harness();
    const loop = createLoop(h.game, stubPose(), h.g, { fx: h.fx });
    loop.start();
    raf.advance(0);
    raf.advance(37);
    raf.advance(93);
    for (const call of (h.game.update as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0]).toBe(STEP);
    }
    loop.stop();
  });

  it('drops a backlog instead of spiralling', () => {
    // A long stall must not make the loop simulate the stall, which would
    // make the next frame slower still.
    const raf = fakeRaf();
    const h = harness();
    const loop = createLoop(h.game, stubPose(), h.g, { fx: h.fx });
    loop.start();
    raf.advance(0);
    raf.advance(5000); // a 5-second hitch
    expect((h.game.update as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(5);
    loop.stop();
  });

  it('does not simulate the time a backgrounded tab was away', () => {
    const raf = fakeRaf();
    const h = harness();
    const loop = createLoop(h.game, stubPose(), h.g, { fx: h.fx });
    loop.start();
    raf.advance(0);
    raf.advance(600_000); // ten minutes in another tab
    expect((h.game.update as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(5);
    loop.stop();
  });
});

describe('loop: render cap', () => {
  it('renders at maxFps but still simulates every step', () => {
    // The attract reel is a backdrop: half the draws, same game.
    const raf = fakeRaf();
    const h = harness();
    const loop = createLoop(h.game, stubPose(), h.g, { fx: h.fx, maxFps: 30 });
    loop.start();
    raf.advance(0);
    for (let i = 0; i < 60; i++) raf.advance(16.667); // 1.0s of 60 Hz rAF
    expect(h.game.update).toHaveBeenCalledTimes(60);
    const renders = (h.game.render as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(renders).toBeGreaterThanOrEqual(29);
    expect(renders).toBeLessThanOrEqual(31);
    loop.stop();
  });

  it('holds the cap on a 120 Hz display too', () => {
    const raf = fakeRaf();
    const h = harness();
    const loop = createLoop(h.game, stubPose(), h.g, { fx: h.fx, maxFps: 30 });
    loop.start();
    raf.advance(0);
    for (let i = 0; i < 120; i++) raf.advance(8.334); // 1.0s of 120 Hz rAF
    expect(h.game.update).toHaveBeenCalledTimes(60);
    const renders = (h.game.render as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(renders).toBeGreaterThanOrEqual(29);
    expect(renders).toBeLessThanOrEqual(31);
    loop.stop();
  });

  it('renders every tick without a cap', () => {
    const raf = fakeRaf();
    const h = harness();
    const loop = createLoop(h.game, stubPose(), h.g, { fx: h.fx });
    loop.start();
    raf.advance(0);
    for (let i = 0; i < 60; i++) raf.advance(16.667);
    expect((h.game.render as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(60);
    loop.stop();
  });
});

describe('loop: effects ordering', () => {
  it('brackets every frame with the renderer frame hooks, with g.t advancing', () => {
    // Without beginFrame, g.t is stuck at 0 and the glow budget is spent once
    // per round instead of once per frame.
    const raf = fakeRaf();
    const h = harness();
    const ts: number[] = [];
    const g = Object.assign(h.g, {
      beginFrame: (t: number) => { ts.push(t); h.order.push('beginFrame'); },
      endFrame: () => h.order.push('endFrame'),
    });
    const loop = createLoop(h.game, stubPose(), g, { fx: h.fx });
    loop.start();
    raf.advance(0);
    raf.advance(16);
    raf.advance(16);
    const i = (s: string): number => h.order.indexOf(s);
    expect(i('beginFrame')).toBeLessThan(i('save'));
    expect(i('fx.draw')).toBeLessThan(i('endFrame'));
    expect(ts.at(-1)!).toBeGreaterThan(ts[0]!);
    loop.stop();
  });

  it('draws shake around the game but the fx pass on top of it', () => {
    // Camera shake must move the world; particles, floating text and the
    // flash must NOT shake with it or the screen reads as broken.
    const raf = fakeRaf();
    const h = harness();
    const loop = createLoop(h.game, stubPose(), h.g, { fx: h.fx });
    loop.start();
    raf.advance(0);
    raf.advance(16);
    const i = (s: string): number => h.order.indexOf(s);
    expect(i('save')).toBeLessThan(i('fx.applyCamera'));
    expect(i('fx.applyCamera')).toBeLessThan(i('render'));
    expect(i('render')).toBeLessThan(i('restore'));
    expect(i('restore')).toBeLessThan(i('fx.draw'));
    loop.stop();
  });

  it('advances effects on REAL time while a hitstop freezes the game', () => {
    // The point of a hitstop is that the world stops and the sparks do not.
    const raf = fakeRaf();
    const h = harness();
    const loop = createLoop(h.game, stubPose(), h.g, { fx: h.fx });
    loop.start();
    raf.advance(0);
    h.setTimeScale(0);
    raf.advance(100);
    expect(h.game.update).not.toHaveBeenCalled();
    expect(h.fx.update).toHaveBeenCalled();
    const dts = (h.fx.update as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(dts.some((d: number) => d > 0.05)).toBe(true); // real time, not scaled
    loop.stop();
  });

  it('still renders every frame during a hitstop', () => {
    const raf = fakeRaf();
    const h = harness();
    const loop = createLoop(h.game, stubPose(), h.g, { fx: h.fx });
    loop.start();
    raf.advance(0);
    h.setTimeScale(0);
    raf.advance(16);
    raf.advance(16);
    expect(h.game.render).toHaveBeenCalled();
    loop.stop();
  });
});

describe('loop: pause', () => {
  it('stops stepping and releases the pose source', () => {
    const raf = fakeRaf();
    const h = harness();
    const pose = stubPose();
    const loop = createLoop(h.game, pose, h.g, { fx: h.fx });
    loop.start();
    raf.advance(0);
    raf.advance(16);
    const before = (h.game.update as ReturnType<typeof vi.fn>).mock.calls.length;
    loop.pause();
    raf.advance(1000);
    expect((h.game.update as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
    expect(pose.pause).toHaveBeenCalled();
    loop.resume();
    expect(pose.resume).toHaveBeenCalled();
  });

  it('does not simulate the paused interval on resume', () => {
    const raf = fakeRaf();
    const h = harness();
    const loop = createLoop(h.game, stubPose(), h.g, { fx: h.fx });
    loop.start();
    raf.advance(0);
    loop.pause();
    raf.advance(30_000);
    loop.resume();
    const before = (h.game.update as ReturnType<typeof vi.fn>).mock.calls.length;
    raf.advance(16);
    expect((h.game.update as ReturnType<typeof vi.fn>).mock.calls.length - before)
      .toBeLessThanOrEqual(2);
    loop.stop();
  });

  it('hands a paused pose source back running when the round is torn down', () => {
    // Page hidden mid-round: the host pauses the loop, then the shell aborts
    // the round. The camera source is shared with every later round.
    fakeRaf();
    const h = harness();
    const pose = stubPose();
    const loop = createLoop(h.game, pose, h.g, { fx: h.fx });
    loop.start();
    loop.pause();
    loop.stop();
    expect(pose.resume).toHaveBeenCalledTimes(1);
    loop.stop();
    expect(pose.resume).toHaveBeenCalledTimes(1);
  });
});

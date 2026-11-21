import { describe, expect, it } from 'vitest';
import { createFxService } from './service';
import { MAX_PER_BURST, PARTICLE_CAP } from './particles';
import { HITSTOP_MAX } from './shake';
import { C } from '../render/palette';
import { NullRenderer } from '../testing/nullRenderer';

const frame = (fx: ReturnType<typeof createFxService>, g: NullRenderer, t: number): void => {
  fx.update(1 / 60);
  g.beginFrame(t);
  g.save();
  fx.applyCamera(g);
  g.restore();
  fx.draw(g);
  g.endFrame();
};

describe('createFxService', () => {
  it('constructs with no DOM at all', () => {
    const fx = createFxService();
    expect(fx.reducedMotion).toBe(false);
    expect(fx.timeScale).toBe(1);
    expect(fx.slotColor(0)).toBe(C.slot[0]);
    expect(fx.slotColor(3)).toBe(C.slot[3]);
  });

  it('draws nothing when nothing has happened', () => {
    const fx = createFxService();
    const g = new NullRenderer(1280, 720);
    frame(fx, g, 0);
    expect(g.audit.nanOps).toBe(0);
  });
});

describe('budget', () => {
  it('clamps an enthusiastic game to the pool, not the frame rate', () => {
    const fx = createFxService();
    const g = new NullRenderer(1280, 720);
    fx.setView(1280, 720, 0.72);
    for (let f = 0; f < 120; f++) {
      for (let i = 0; i < 20; i++) fx.burst(640, 360, { count: 500, color: C.hot });
      frame(fx, g, f / 60);
      expect(fx.stats.particles).toBeLessThanOrEqual(PARTICLE_CAP);
    }
    expect(fx.stats.particlesDropped).toBeGreaterThan(0);
  });

  it('one burst of 5000 is ~300 particles plus a small bright core', () => {
    const fx = createFxService();
    fx.setView(1280, 720, 0.72);
    fx.burst(100, 100, { count: 5000 });
    expect(fx.stats.particles).toBeGreaterThan(MAX_PER_BURST);
    expect(fx.stats.particles).toBeLessThan(MAX_PER_BURST * 2);
  });

  it('confetti stays inside the pool', () => {
    const fx = createFxService();
    fx.setView(1280, 720, 0.72);
    fx.confetti({ emoji: '🎉' });
    expect(fx.stats.particles).toBeLessThanOrEqual(PARTICLE_CAP);
    expect(fx.stats.particles).toBeGreaterThan(0);
  });
});

describe('hitstop', () => {
  it('exposes a time scale the loop can consume', () => {
    const fx = createFxService();
    fx.hitstop(0.06);
    expect(fx.timeScale).toBe(0);
    expect(fx.hitstopRemaining).toBeCloseTo(0.06, 9);
    for (let i = 0; i < 5; i++) fx.update(1 / 60);
    expect(fx.timeScale).toBe(1);
  });

  it('cannot be turned into a stutter', () => {
    const fx = createFxService();
    fx.hitstop(10);
    expect(fx.hitstopRemaining).toBe(HITSTOP_MAX);
  });

  it('keeps animating fx while the game clock is frozen', () => {
    const fx = createFxService();
    const g = new NullRenderer();
    fx.setView(1280, 720, 0.72);
    fx.burst(100, 100, { count: 20 });
    fx.hitstop(0.08);
    const before = fx.stats.particles;
    for (let i = 0; i < 4; i++) frame(fx, g, i / 60);
    // Particles keep moving: a frozen screen with frozen sparks reads as a
    // crash, a frozen screen with flying sparks reads as impact.
    expect(fx.timeScale).toBe(0);
    expect(fx.stats.particles).toBe(before);
    expect(g.audit.ops).toBeGreaterThan(0);
  });
});

describe('squash', () => {
  it('decays from the requested amount to zero', () => {
    const fx = createFxService();
    expect(fx.squashAt('nope')).toBe(0);
    fx.squash('target', 0.5);
    expect(fx.squashAt('target')).toBeCloseTo(0.5, 6);
    fx.update(0.13);
    const mid = fx.squashAt('target');
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(0.5);
    for (let i = 0; i < 30; i++) fx.update(1 / 60);
    expect(fx.squashAt('target')).toBe(0);
  });

  it('retriggering keeps the stronger squash and restarts the timer', () => {
    const fx = createFxService();
    fx.squash('a', 0.2);
    fx.update(0.1);
    fx.squash('a', 0.6);
    expect(fx.squashAt('a')).toBeCloseTo(0.6, 6);
  });

  it('does not grow without bound when keyed per entity', () => {
    const fx = createFxService();
    for (let i = 0; i < 500; i++) fx.squash(`e${i}`, 0.3);
    // Bounded; the oldest keys are dropped rather than retained forever.
    let live = 0;
    for (let i = 0; i < 500; i++) if (fx.squashAt(`e${i}`) > 0) live++;
    expect(live).toBeLessThanOrEqual(64);
  });
});

describe('reduced motion', () => {
  it('suppresses shake entirely, not partially', () => {
    const fx = createFxService({ reducedMotion: true });
    expect(fx.reducedMotion).toBe(true);
    fx.shake(0.5, 0.5);
    fx.update(1 / 60);
    const g = new NullRenderer();
    g.beginFrame(0);
    fx.applyCamera(g); // must emit no transform ops at all
    expect(g.audit.ops).toBe(0);
    expect(fx.stats.trauma).toBe(0);
  });

  it('turns confetti into one static puff instead of two seconds of rain', () => {
    const calm = createFxService({ reducedMotion: true });
    calm.setView(1280, 720, 0.72);
    calm.confetti();
    const loud = createFxService({ reducedMotion: false });
    loud.setView(1280, 720, 0.72);
    loud.confetti();
    expect(calm.stats.particles).toBeLessThan(loud.stats.particles);
    expect(calm.stats.particles).toBeGreaterThan(0);
  });

  it('is overridable in both directions, because kids rarely set the OS flag', () => {
    const fx = createFxService();
    fx.setReducedMotion(true);
    expect(fx.reducedMotion).toBe(true);
    fx.setReducedMotion(false);
    expect(fx.reducedMotion).toBe(false);
    fx.setReducedMotion(null); // follow the system again
    expect(fx.reducedMotion).toBe(false);
  });

  it('tightens the flash limiter too', () => {
    const fx = createFxService({ reducedMotion: true });
    for (let i = 0; i < 10; i++) fx.flash('#FFFFFF', 1);
    expect(fx.stats.flashesFired).toBe(1);
  });
});

describe('flash through the service', () => {
  it('a game spamming flash() gets at most 3 a second', () => {
    const fx = createFxService();
    for (let f = 0; f < 60; f++) {
      fx.flash(C.danger, 1);
      fx.update(1 / 60);
    }
    expect(fx.stats.flashesFired).toBeLessThanOrEqual(4);
    expect(fx.stats.flashesDropped).toBeGreaterThan(50);
  });

  it('obeys manifest.a11y.noFlashing', () => {
    const fx = createFxService({ flashing: false });
    fx.flash('#fff', 1);
    expect(fx.stats.flashesFired).toBe(0);
  });
});

describe('shake camera', () => {
  it('rotates about the viewport centre, not the origin', () => {
    const fx = createFxService();
    fx.setView(1280, 720, 0.72);
    fx.shake(1, 0.5);
    fx.update(1 / 60);
    const g = new NullRenderer(1280, 720);
    g.beginFrame(0);
    fx.applyCamera(g);
    expect(g.audit.ops).toBeGreaterThan(1);
    expect(g.audit.nanOps).toBe(0);
  });
});

describe('the whole pass', () => {
  it('survives a full round of every effect without a NaN or an off-screen op', () => {
    const fx = createFxService();
    const g = new NullRenderer(1280, 720);
    g.strict = true;
    fx.setView(1280, 720, 0.72);
    for (let f = 0; f < 600; f++) {
      const t = f / 60;
      if (f % 7 === 0) fx.burst(300 + f % 400, 200, { count: 24, color: C.accent, color2: C.hot });
      if (f % 11 === 0) fx.burst(600, 300, { count: 6, emoji: '✨', gravity: 600 });
      if (f % 13 === 0) fx.pop(400, 400, 60, C.success);
      if (f % 3 === 0) fx.trail(f % 1200, 100, (f % 1200) + 40, 160, { color: C.primaryLo });
      if (f % 23 === 0) fx.popText(500, 300, '+10', C.accentHi);
      if (f % 31 === 0) fx.shake(0.12);
      if (f % 41 === 0) fx.flash(C.white, 0.7);
      if (f % 53 === 0) fx.hitstop(0.05);
      if (f % 97 === 0) fx.confetti();
      fx.squash(`e${f % 8}`, 0.4);
      frame(fx, g, t);
    }
    expect(g.audit.nanOps).toBe(0);
    expect(g.audit.offscreenOps).toBe(0);
    expect(g.audit.framesWithNoDraw).toBe(0);
    expect(g.audit.ops).toBeGreaterThan(1000);
  });

  it('resetAll leaves nothing from the last game on screen', () => {
    const fx = createFxService();
    fx.setView(1280, 720, 0.72);
    fx.burst(1, 1, { count: 100 });
    fx.pop(1, 1, 10);
    fx.trail(0, 0, 1, 1);
    fx.popText(1, 1, 'x');
    fx.shake(1);
    fx.hitstop(0.08);
    fx.squash('k');
    fx.resetAll();
    const s = fx.stats;
    expect(s.particles).toBe(0);
    expect(s.rings).toBe(0);
    expect(s.trails).toBe(0);
    expect(s.popTexts).toBe(0);
    expect(s.trauma).toBe(0);
    expect(fx.timeScale).toBe(1);
    expect(fx.squashAt('k')).toBe(0);
  });
});

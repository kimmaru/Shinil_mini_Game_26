import { describe, expect, it } from 'vitest';
import {
  KIND_DOT,
  KIND_SPRITE,
  MAX_PER_BURST,
  MAX_SPAWN_PER_FRAME,
  PARTICLE_CAP,
  PopTexts,
  Particles,
  Rings,
  Trails,
  colorStr,
  packedStr,
  parseColor,
} from './particles';
import { NullRenderer } from '../testing/nullRenderer';

const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const emit = (p: Particles, n: number, kind = KIND_DOT, glyph = ''): number =>
  p.emit(n, 100, 100, 400, 0, Math.PI * 2, 0.5, 4, 0, 0.9, kind, 0xff0000, 0x00ff00, glyph);

describe('colour parsing', () => {
  it('handles every form palette.ts can emit', () => {
    expect(parseColor('#FFB300')).toBe(0xffb300);
    expect(parseColor('#fff')).toBe(0xffffff);
    expect(parseColor('#101733')).toBe(0x101733);
    expect(parseColor('rgb(255 128 0 / 0.5)')).toBe(0xff8000);
    expect(parseColor('rgba(0, 0, 255, 0.2)')).toBe(0x0000ff);
    // hue() returns space-separated hsl, which is what 58 games will pass.
    expect(parseColor('hsl(0 100% 50%)')).toBe(0xff0000);
    expect(parseColor('hsl(120 100% 50%)')).toBe(0x00ff00);
    expect(parseColor('hsl(210 78% 62% / 0.4)')).toBeGreaterThan(0);
  });

  it('falls back to something visible rather than invisible', () => {
    expect(parseColor('chartreuse')).toBe(0xffffff);
    expect(parseColor('')).toBe(0xffffff);
  });

  it('reuses colour strings instead of allocating per particle per frame', () => {
    const a = colorStr(255, 180, 0, 0.5);
    const b = colorStr(255, 180, 0, 0.5);
    expect(a).toBe(b);
    // Quantised, so a smoothly fading burst still hits the cache.
    expect(colorStr(255, 180, 0, 0.5)).toBe(colorStr(254, 181, 1, 0.505));
    expect(packedStr(0xffb300, 1)).toContain('/');
  });
});

describe('Particles — budget', () => {
  it('asking for 5000 gets ~300, as the contract promises', () => {
    const p = new Particles(rng(1));
    p.beginFrame();
    const n = emit(p, 5000);
    expect(n).toBe(MAX_PER_BURST);
    expect(p.count).toBe(MAX_PER_BURST);
  });

  it('caps total emission per frame so one game cannot refill the pool 60x/s', () => {
    const p = new Particles(rng(2));
    p.beginFrame();
    let total = 0;
    for (let i = 0; i < 40; i++) total += emit(p, 300);
    expect(total).toBeLessThanOrEqual(MAX_SPAWN_PER_FRAME);
    expect(p.count).toBeLessThanOrEqual(PARTICLE_CAP);
  });

  it('never exceeds the pool capacity, however hard it is pushed', () => {
    const p = new Particles(rng(3));
    for (let frame = 0; frame < 30; frame++) {
      p.beginFrame();
      for (let i = 0; i < 10; i++) emit(p, 300);
      p.update(1 / 60);
      expect(p.count).toBeLessThanOrEqual(PARTICLE_CAP);
    }
  });

  it('tapers instead of truncating under pressure, so the last hit still shows', () => {
    const p = new Particles(rng(4), 100);
    p.beginFrame();
    emit(p, 80); // 80% full
    const n = emit(p, 40);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(40);
  });

  it('counts what it refused', () => {
    const p = new Particles(rng(5), 32);
    p.beginFrame();
    emit(p, 5000);
    expect(p.dropped).toBeGreaterThan(0);
  });
});

describe('Particles — lifetime', () => {
  it('leaks nothing: every particle is reclaimed', () => {
    const p = new Particles(rng(6));
    p.beginFrame();
    emit(p, 200);
    expect(p.count).toBe(200);
    for (let i = 0; i < 200; i++) p.update(1 / 60);
    expect(p.count).toBe(0);
  });

  it('survives interleaved spawn and death without corrupting the pool', () => {
    const p = new Particles(rng(7));
    for (let f = 0; f < 600; f++) {
      p.beginFrame();
      if (f % 3 === 0) emit(p, 25);
      p.update(1 / 60);
      expect(p.count).toBeGreaterThanOrEqual(0);
      expect(p.count).toBeLessThanOrEqual(PARTICLE_CAP);
    }
    for (let i = 0; i < 300; i++) p.update(1 / 60);
    expect(p.count).toBe(0);
  });

  it('clear() empties it between rounds', () => {
    const p = new Particles(rng(8));
    p.beginFrame();
    emit(p, 100);
    p.clear();
    expect(p.count).toBe(0);
  });
});

describe('Particles — determinism', () => {
  it('two pools with the same seed draw identically', () => {
    const run = (seed: number): string => {
      const p = new Particles(rng(seed));
      const g = new NullRenderer(1280, 720);
      const acc: number[] = [];
      for (let f = 0; f < 40; f++) {
        p.beginFrame();
        if (f % 7 === 0) emit(p, 30);
        p.update(1 / 60);
        acc.push(p.count);
      }
      p.draw(g);
      acc.push(g.audit.ops);
      return acc.join(',');
    };
    expect(run(99)).toBe(run(99));
    expect(run(99)).not.toBe(run(100));
  });
});

describe('Particles — drawing', () => {
  it('emits no NaN and nothing wildly off-screen', () => {
    const p = new Particles(rng(11));
    const g = new NullRenderer(1280, 720);
    g.strict = true;
    p.beginFrame();
    emit(p, 200);
    emit(p, 20, KIND_SPRITE, 'star');
    for (let f = 0; f < 20; f++) {
      p.update(1 / 60);
      g.beginFrame(f / 60);
      p.draw(g);
      g.endFrame();
    }
    expect(g.audit.nanOps).toBe(0);
    expect(g.audit.ops).toBeGreaterThan(0);
  });

  it('draws one op per sprite particle through the sprite pipeline', () => {
    const p = new Particles(rng(12));
    const g = new NullRenderer();
    p.beginFrame();
    emit(p, 5, KIND_SPRITE, 'star');
    g.beginFrame(0);
    p.draw(g);
    g.endFrame();
    expect(g.audit.ops).toBe(5);
  });
});

describe('Rings / Trails / PopTexts', () => {
  it('rings expand, fade and are reclaimed', () => {
    const r = new Rings(8);
    r.add(10, 10, 40, 0xffffff, 0.3);
    expect(r.count).toBe(1);
    for (let i = 0; i < 30; i++) r.update(1 / 60);
    expect(r.count).toBe(0);
  });

  it('a full ring pool overwrites the oldest, keeping the newest feedback', () => {
    const r = new Rings(4);
    for (let i = 0; i < 4; i++) {
      r.add(i, i, 10, 0xffffff, 1);
      r.update(0.1); // stagger their ages
    }
    r.add(99, 99, 10, 0xffffff, 1);
    expect(r.count).toBe(4);
    const g = new NullRenderer();
    g.beginFrame(0);
    r.draw(g);
    expect(g.audit.nanOps).toBe(0);
  });

  it('trails fade out and are reclaimed', () => {
    const t = new Trails(8);
    for (let i = 0; i < 20; i++) t.add(0, 0, 10, 10, 8, 0xffffff, 0.25);
    expect(t.count).toBeLessThanOrEqual(8);
    for (let i = 0; i < 40; i++) t.update(1 / 60);
    expect(t.count).toBe(0);
  });

  it('popText drifts up, fades and is reclaimed', () => {
    const p = new PopTexts(4);
    p.add(100, 300, '+10', 0xffb300, 0.9, -150);
    const g = new NullRenderer();
    g.beginFrame(0);
    p.draw(g, 40);
    expect(g.audit.ops).toBe(1);
    expect(g.audit.nanOps).toBe(0);
    for (let i = 0; i < 60; i++) p.update(1 / 60);
    expect(p.count).toBe(0);
  });

  it('popText rejects empty text instead of drawing an invisible slot', () => {
    const p = new PopTexts(4);
    p.add(1, 1, '', 0xffffff);
    expect(p.count).toBe(0);
  });
});

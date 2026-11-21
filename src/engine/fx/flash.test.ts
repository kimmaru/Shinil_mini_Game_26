// The WCAG 2.3.1 limiter. This is the highest-stakes test in the fx layer: the
// failure mode is not a cosmetic bug.
import { describe, expect, it } from 'vitest';
import {
  EDGE_DEPTH,
  FLASH_WINDOW_SEC,
  Flash,
  MAX_CENTER_ALPHA,
  MAX_FLASHES_PER_SEC,
  MAX_FLASHES_PER_SEC_REDUCED,
  safeFlashColor,
} from './flash';
import { NullRenderer } from '../testing/nullRenderer';

describe('rate limit', () => {
  it('a 10-call burst produces at most 3 flashes in one second', () => {
    const f = new Flash();
    let accepted = 0;
    for (let i = 0; i < 10; i++) if (f.request('#FFFFFF', 1)) accepted++;
    expect(accepted).toBe(MAX_FLASHES_PER_SEC);
    expect(f.fired).toBe(3);
    expect(f.dropped).toBe(7);
  });

  it('holds the limit across a whole second of frames, not just one frame', () => {
    const f = new Flash();
    // 60 calls spread over exactly one second — the realistic abuse case: a
    // game calling flash() on every hit during a fast combo.
    for (let i = 0; i < 60; i++) {
      f.request('#FFFFFF', 1);
      f.update(1 / 60);
    }
    expect(f.fired).toBeLessThanOrEqual(MAX_FLASHES_PER_SEC + 1);
  });

  it('counts at most 3 onsets in EVERY sliding one-second window', () => {
    const f = new Flash();
    const onsets: number[] = [];
    let t = 0;
    for (let i = 0; i < 1800; i++) {
      // 30 seconds of a game asking for a flash every single frame.
      if (f.request('#FFFFFF', 1)) onsets.push(t);
      f.update(1 / 60);
      t += 1 / 60;
    }
    expect(onsets.length).toBeGreaterThan(3); // it does keep flashing
    for (let i = 0; i < onsets.length; i++) {
      const inWindow = onsets.filter(
        (o) => o >= onsets[i]! && o < onsets[i]! + FLASH_WINDOW_SEC,
      ).length;
      expect(inWindow).toBeLessThanOrEqual(MAX_FLASHES_PER_SEC);
    }
  });

  it('allows a new flash once the window has passed', () => {
    const f = new Flash();
    for (let i = 0; i < 5; i++) f.request('#FFFFFF', 1);
    expect(f.fired).toBe(3);
    f.update(FLASH_WINDOW_SEC + 0.01);
    expect(f.request('#FFFFFF', 1)).toBe(true);
    expect(f.fired).toBe(4);
  });

  it('drops to one per second under reduced motion', () => {
    const f = new Flash();
    f.setReduced(true);
    expect(f.budget).toBe(MAX_FLASHES_PER_SEC_REDUCED);
    let accepted = 0;
    for (let i = 0; i < 10; i++) if (f.request('#FFFFFF', 1)) accepted++;
    expect(accepted).toBe(1);
  });

  it('is fully off for manifest.a11y.noFlashing', () => {
    const f = new Flash();
    f.setEnabled(false);
    for (let i = 0; i < 10; i++) expect(f.request('#FFFFFF', 1)).toBe(false);
    expect(f.fired).toBe(0);
    expect(f.active).toBe(false);
  });
});

describe('colour safety', () => {
  it('cannot produce a saturated red flash', () => {
    const out = safeFlashColor(0xff0000);
    const r = (out >> 16) & 255;
    const g = (out >> 8) & 255;
    const b = out & 255;
    // Desaturated: the red dominance that makes the red-flash threshold strict
    // is gone.
    expect(r - Math.max(g, b)) .toBeLessThan(90);
    expect(g).toBeGreaterThan(120);
    expect(b).toBeGreaterThan(120);
  });

  it('lightens every colour toward white, so a flash reads as light', () => {
    for (const c of [0x000000, 0x4c6fff, 0x16c47f, 0xffb300]) {
      const out = safeFlashColor(c);
      expect((out >> 16) & 255).toBeGreaterThanOrEqual((c >> 16) & 255);
      expect((out >> 8) & 255).toBeGreaterThanOrEqual((c >> 8) & 255);
      expect(out & 255).toBeGreaterThanOrEqual(c & 255);
    }
  });
});

describe('envelope', () => {
  it('snaps on and eases off', () => {
    const f = new Flash();
    f.request('#FFFFFF', 1);
    const a0 = f.alpha;
    f.update(0.08);
    const a1 = f.alpha;
    f.update(0.3);
    expect(a0).toBeGreaterThan(a1);
    expect(f.alpha).toBe(0);
    expect(f.active).toBe(false);
  });

  it('halves the amplitude and lengthens the fade under reduced motion', () => {
    const a = new Flash();
    a.request('#FFFFFF', 1);
    const b = new Flash();
    b.setReduced(true);
    b.request('#FFFFFF', 1);
    expect(b.alpha).toBeLessThan(a.alpha);
    a.update(0.3);
    b.update(0.3);
    expect(a.active).toBe(false);
    expect(b.active).toBe(true); // a swell, not a strobe
  });

  it('clamps a nonsense power rather than trusting it', () => {
    const f = new Flash();
    f.request('#FFFFFF', 99);
    expect(f.alpha).toBeLessThanOrEqual(1);
    const g = new Flash();
    g.request('#FFFFFF', Number.NaN);
    expect(Number.isFinite(g.alpha)).toBe(true);
  });
});

describe('area', () => {
  it('keeps the bright region under 25% of the viewport', () => {
    // WCAG only counts a flash when it covers more than ~25% of the visual
    // field, so the border band's depth is the whole argument for why a
    // full-power flash is safe. Check it for every aspect ratio we ship.
    const sizes: Array<[number, number]> = [
      [1280, 720], [1366, 768], [1000, 1000], [2560, 1440], [800, 1280],
    ];
    for (const [w, h] of sizes) {
      const depth = Math.min(w, h) * EDGE_DEPTH;
      const inner = (w - depth * 2) * (h - depth * 2);
      const covered = 1 - inner / (w * h);
      expect(covered).toBeLessThan(0.25);
    }
  });

  it('the full-viewport component stays below a large luminance change', () => {
    expect(MAX_CENTER_ALPHA).toBeLessThanOrEqual(0.1);
  });

  it('draws in screen space with no NaN and nothing off-canvas', () => {
    const f = new Flash();
    f.request('#FF4D8D', 1);
    const g = new NullRenderer(1280, 720);
    g.strict = true;
    for (let i = 0; i < 20; i++) {
      g.beginFrame(i / 60);
      f.draw(g);
      g.endFrame();
      f.update(1 / 60);
    }
    expect(g.audit.nanOps).toBe(0);
    expect(g.audit.offscreenOps).toBe(0);
    expect(g.audit.ops).toBeGreaterThan(0);
  });

  it('draws nothing when idle', () => {
    const f = new Flash();
    const g = new NullRenderer();
    g.beginFrame(0);
    f.draw(g);
    expect(g.audit.ops).toBe(0);
  });
});

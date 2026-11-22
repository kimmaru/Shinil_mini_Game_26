// The renderer cannot be tested against a real canvas under
// `environment: 'node'`, so it is tested against a fake 2D context that records
// every call and every property assignment. That is enough to pin down the
// invariants that actually break games:
//
//   * devicePixelRatio is applied exactly once, in the base transform
//   * clear() paints the whole viewport even while the camera is shaken
//   * no primitive ever emits a non-finite coordinate
//   * skeleton() draws the dark outline pass BEFORE the coloured pass
//
// All four of those failures look identical from the outside — a blank or
// unreadable screen — which is why they are asserted mechanically.
import { describe, expect, it } from 'vitest';
import { BODY, Canvas2DRenderer, GLOW_BUDGET, mittAt } from './canvas2d';
import { C, KEYLINE, THEME_HUES } from './palette';
import { SKY_DOTS, skyStops } from './sky';
import { L, LANDMARK_COUNT, MIN_VIS } from '../pose/landmarks';
import type { PlayerPose } from '../types';

/** sRGB of a `#rrggbb` or `hsl(h s% l%)` colour. */
function rgbOf(col: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(col);
  if (hex) {
    const v = Number.parseInt(hex[1]!, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  const m = /hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/.exec(col);
  if (!m) throw new Error(`cannot parse ${col}`);
  const s = +m[2]! / 100;
  const l = +m[3]! / 100;
  const k = (n: number): number => (n + +m[1]! / 30) % 12;
  const f = (n: number): number =>
    255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}
const lum = (c: readonly number[]): number => {
  const [r, g, b] = c.map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratioRgb = (a: readonly number[], b: readonly number[]): number => {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const contrast = (a: string, b: string): number => ratioRgb(rgbOf(a), rgbOf(b));

interface Rec {
  op: string;
  args: unknown[];
}

function fakeCanvas(w = 1280, h = 720) {
  const log: Rec[] = [];
  const rec = (op: string) => (...args: unknown[]): void => {
    log.push({ op, args });
  };
  const grad = { addColorStop: rec('addColorStop') };
  const base: Record<string, unknown> = {
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    shadowBlur: 0,
    shadowColor: '',
    font: '10px sans-serif',
    letterSpacing: '0px',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    save: rec('save'),
    restore: rec('restore'),
    setTransform: rec('setTransform'),
    translate: rec('translate'),
    rotate: rec('rotate'),
    scale: rec('scale'),
    beginPath: rec('beginPath'),
    closePath: rec('closePath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    quadraticCurveTo: rec('quadraticCurveTo'),
    arc: rec('arc'),
    rect: rec('rect'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    fillRect: rec('fillRect'),
    clearRect: rec('clearRect'),
    fillText: rec('fillText'),
    strokeText: rec('strokeText'),
    drawImage: rec('drawImage'),
    createLinearGradient: (...a: unknown[]) => {
      log.push({ op: 'createLinearGradient', args: a });
      return grad;
    },
    createRadialGradient: (...a: unknown[]) => {
      log.push({ op: 'createRadialGradient', args: a });
      return grad;
    },
    measureText: (s: string) => {
      const px = Number.parseFloat(String(base['font'])) || 10;
      return {
        width: s.length * px * 0.55,
        actualBoundingBoxAscent: px * 0.9,
        actualBoundingBoxDescent: px * 0.1,
      };
    },
  };
  const ctx = new Proxy(base, {
    set(t, k, v) {
      log.push({ op: `set:${String(k)}`, args: [v] });
      t[k as string] = v;
      return true;
    },
  });
  const canvas = {
    width: 0,
    height: 0,
    clientWidth: w,
    clientHeight: h,
    style: { width: '', height: '' },
    getContext: () => ctx,
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, raw: canvas, log, base };
}

const numericArgs = (log: Rec[]): number[] => {
  const out: number[] = [];
  for (const r of log) {
    if (r.op.startsWith('set:') || r.op === 'addColorStop') continue;
    for (const a of r.args) if (typeof a === 'number') out.push(a);
  }
  return out;
};

function pose(over?: Partial<PlayerPose>): PlayerPose {
  const n = LANDMARK_COUNT;
  const px = new Float32Array(n * 2);
  const vis = new Float32Array(n).fill(1);
  // A crude standing figure in a 1280x720 view.
  const put = (j: number, x: number, y: number): void => {
    px[j * 2] = x;
    px[j * 2 + 1] = y;
  };
  put(L.NOSE, 640, 170);
  put(L.LEFT_EAR, 620, 175);
  put(L.RIGHT_EAR, 660, 175);
  put(L.LEFT_SHOULDER, 580, 260);
  put(L.RIGHT_SHOULDER, 700, 260);
  put(L.LEFT_ELBOW, 540, 350);
  put(L.RIGHT_ELBOW, 740, 350);
  put(L.LEFT_WRIST, 520, 440);
  put(L.RIGHT_WRIST, 760, 440);
  // Fingers just past the wrists, so the palm (where the mitt goes) is real.
  put(L.LEFT_PINKY, 522, 466);
  put(L.LEFT_INDEX, 514, 468);
  put(L.LEFT_THUMB, 528, 458);
  put(L.RIGHT_PINKY, 758, 466);
  put(L.RIGHT_INDEX, 766, 468);
  put(L.RIGHT_THUMB, 752, 458);
  put(L.LEFT_HIP, 600, 430);
  put(L.RIGHT_HIP, 680, 430);
  put(L.LEFT_KNEE, 595, 550);
  put(L.RIGHT_KNEE, 685, 550);
  put(L.LEFT_ANKLE, 592, 660);
  put(L.RIGHT_ANKLE, 688, 660);
  put(L.LEFT_FOOT_INDEX, 585, 690);
  put(L.RIGHT_FOOT_INDEX, 695, 690);
  return {
    id: 1,
    slot: 0,
    present: true,
    conf: 1,
    n: new Float32Array(n * 2),
    v: new Float32Array(n * 2),
    px,
    vis,
    box: { x: 0.3, y: 0.1, w: 0.4, h: 0.85 },
    rollDeg: 0,
    scalePx: 120,
    calib: {
      shoulderW: 120, armSpan: 2, armLen: 0.9, standHipY: 0.6, squatHipY: 0.72,
      reachUpY: 0.2, floorY: 0.95, idleEnergy: 0.05, lowerBodyVisible: true,
      mirrored: true, capturedAt: 0,
    },
    ...over,
  } as PlayerPose;
}

describe('devicePixelRatio', () => {
  it('is applied once, in the base transform, and never leaks into the API', () => {
    const f = fakeCanvas(1280, 720);
    const g = new Canvas2DRenderer(f.canvas, { dpr: 2 });
    expect(g.w).toBe(1280);
    expect(g.h).toBe(720);
    expect(g.s).toBeCloseTo(0.72, 6);
    // The backing store is scaled; the logical API is not.
    expect(f.raw.width).toBe(2560);
    expect(f.raw.height).toBe(1440);
    const t = f.log.filter((r) => r.op === 'setTransform').pop();
    expect(t?.args).toEqual([2, 0, 0, 2, 0, 0]);
  });

  it('leaves canvas.style alone, so CSS keeps owning the layout box', () => {
    // Regression: writing an inline style pins the element, and a canvas sized
    // with CSS then observes its own frozen size forever — the game renders
    // into the top-left 300x150 of a full-screen canvas.
    const f = fakeCanvas(1280, 720);
    const g = new Canvas2DRenderer(f.canvas, { dpr: 2 });
    expect(f.raw.style.width).toBe('');
    g.resize(640, 480);
    expect(f.raw.style.width).toBe('');
    const styled = fakeCanvas(1280, 720);
    new Canvas2DRenderer(styled.canvas, { dpr: 2, manageStyle: true });
    expect(styled.raw.style.width).toBe('1280px');
  });

  it('never adopts the 300x150 HTML default when the canvas is unlaid-out', () => {
    const f = fakeCanvas(0, 0);
    f.raw.width = 300;
    f.raw.height = 150;
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    expect(g.w).toBe(1280);
    expect(g.h).toBe(720);
  });

  it('clamps dpr to the ceiling so a 3x phone does not triple fill cost', () => {
    const f = fakeCanvas(400, 800);
    new Canvas2DRenderer(f.canvas, { dpr: 3, maxDpr: 2 });
    expect(f.raw.width).toBe(800);
  });

  it('s is min(w,h)/1000 on both a laptop and a TV', () => {
    const a = new Canvas2DRenderer(fakeCanvas(1366, 768).canvas, { dpr: 1 });
    const b = new Canvas2DRenderer(fakeCanvas(3840, 2160).canvas, { dpr: 1 });
    expect(a.s).toBeCloseTo(0.768, 6);
    expect(b.s).toBeCloseTo(2.16, 6);
  });
});

describe('clear', () => {
  it('fills the whole viewport while the camera is shaken', () => {
    const f = fakeCanvas(1280, 720);
    const g = new Canvas2DRenderer(f.canvas, { dpr: 2 });
    g.beginFrame(0);
    g.save();
    g.translate(17, -23); // the shake
    g.rotate(0.02);
    f.log.length = 0;
    g.clear(210);
    g.restore();
    // The transform is reset before the fill, so no unpainted seam appears
    // along two edges every frame the screen shakes.
    const st = f.log.filter((r) => r.op === 'setTransform');
    expect(st.length).toBeGreaterThan(0);
    expect(st[0]!.args).toEqual([2, 0, 0, 2, 0, 0]);
    const fills = f.log.filter((r) => r.op === 'fillRect');
    expect(fills.length).toBe(1); // the gradient
    expect(fills[0]!.args).toEqual([0, 0, 1280, 720]);
    // ...plus every decoration dot in ONE fill: two draws per frame in all.
    expect(f.log.filter((r) => r.op === 'fill')).toHaveLength(1);
    expect(f.log.filter((r) => r.op === 'arc')).toHaveLength(SKY_DOTS.length / 3);
  });

  it('keeps ink and HUD text legible on every theme sky, and the dots decorative', () => {
    // The sky got more saturated; this is the line it must not cross. Ink
    // keylines and text are what make objects and labels readable at 2m, and
    // the dots must stay background (ART.md: decoration 1.2-2.0:1, never an
    // object a child could try to touch).
    for (const h of THEME_HUES) {
      const stops = skyStops(h);
      for (const [, col] of stops) {
        expect(contrast(col, KEYLINE), `hue ${h} ${col}`).toBeGreaterThanOrEqual(8);
        expect(contrast(col, C.text), `hue ${h} ${col}`).toBeGreaterThanOrEqual(7);
      }
      const top = rgbOf(stops[0]![1]);
      const dot = top.map((v) => v * 0.7 + 255 * 0.3) as [number, number, number];
      expect(ratioRgb(top, dot), `hue ${h} dots`).toBeLessThan(1.6);
    }
  });

  it('paints an opaque sky by default, and a translucent one over a wiped canvas with skyAlpha', () => {
    const ctxOpts = (o?: { skyAlpha?: number }): { alpha?: boolean } => {
      const f = fakeCanvas();
      let seen: { alpha?: boolean } = {};
      const get = f.raw.getContext;
      f.raw.getContext = ((_k: string, opts: { alpha?: boolean }) => {
        seen = opts;
        return get();
      }) as typeof f.raw.getContext;
      new Canvas2DRenderer(f.canvas, { dpr: 1, ...o });
      return seen;
    };
    expect(ctxOpts().alpha).toBe(false);
    expect(ctxOpts({ skyAlpha: 0.6 }).alpha).toBe(true);

    const opaque = fakeCanvas();
    const g1 = new Canvas2DRenderer(opaque.canvas, { dpr: 1 });
    opaque.log.length = 0;
    g1.clear(210);
    expect(opaque.log.some((r) => r.op === 'clearRect')).toBe(false);
    expect(opaque.log.some((r) => r.op === 'set:globalAlpha' && r.args[0] !== 1)).toBe(false);

    const f = fakeCanvas(1280, 720);
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1, skyAlpha: 0.6 });
    f.log.length = 0;
    g.clear(210);
    const ops = f.log.map((r) => r.op);
    // Wiped first (no accumulation), then the sky at 0.6, then alpha restored
    // so the game's own drawing is opaque.
    expect(f.log.find((r) => r.op === 'clearRect')!.args).toEqual([0, 0, 1280, 720]);
    expect(ops.indexOf('clearRect')).toBeLessThan(ops.indexOf('fillRect'));
    const a = f.log.filter((r) => r.op === 'set:globalAlpha').map((r) => r.args[0]);
    expect(a).toContain(0.6);
    // (the fake ctx does not model save/restore; the real one restores alpha)
    expect(ops.indexOf('save')).toBeLessThan(ops.indexOf('set:globalAlpha'));
    expect(ops.lastIndexOf('restore')).toBeGreaterThan(ops.indexOf('fillRect'));
  });

  it('is dark in both themes and rebuilds the gradient only on change', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    g.clear();
    const stops = f.log.filter((r) => r.op === 'addColorStop').map((r) => r.args[1]);
    expect(stops).toContain(C.bg);
    expect(stops).toContain(C.bgDeep);
    f.log.length = 0;
    g.clear();
    g.clear();
    // Cached: no new gradient objects per frame.
    expect(f.log.filter((r) => r.op === 'createLinearGradient')).toHaveLength(0);
    f.log.length = 0;
    g.clear(40);
    expect(f.log.filter((r) => r.op === 'createLinearGradient')).toHaveLength(1);
  });
});

describe('NaN discipline', () => {
  it('never emits a non-finite coordinate, whatever a game passes in', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    g.beginFrame(0);
    f.log.length = 0;
    const bad = [Number.NaN, Infinity, -Infinity];
    for (const b of bad) {
      g.circle(b, 10, 20, { fill: '#fff' });
      g.circle(10, b, 20, { fill: '#fff' });
      g.circle(10, 10, b, { fill: '#fff' });
      g.rect(b, 0, 10, 10, { fill: '#fff' });
      g.roundRect(0, 0, b, 10, 4, { fill: '#fff' });
      g.line(0, 0, b, 10, 2, { stroke: '#fff' });
      g.arc(10, 10, 10, b, 1, { stroke: '#fff' });
      g.star(b, 1, 10, 5, { fill: '#fff' });
      g.chevron(1, 1, 10, b, { fill: '#fff' });
      g.text('x', b, 1, { size: 30 });
      g.sprite('star', b, 1, 40);
      g.sprite('star', 1, 1, b);
      g.translate(b, 0);
      g.rotate(b);
      g.scale(b, 1);
      g.alpha(b);
      const pts = new Float32Array([0, 0, 10, b, 20, 20]);
      g.poly(pts, 3, { fill: '#fff' });
    }
    for (const n of numericArgs(f.log)) expect(Number.isFinite(n)).toBe(true);
  });

  it('draws nothing for a degenerate pose instead of poisoning the path', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    const p = pose();
    p.px.fill(Number.NaN);
    g.beginFrame(0);
    f.log.length = 0;
    g.skeleton(p);
    g.ghostBody(p, 0.5);
    for (const n of numericArgs(f.log)) expect(Number.isFinite(n)).toBe(true);
    expect(f.log.filter((r) => r.op === 'moveTo')).toHaveLength(0);
  });
});

describe('skeleton', () => {
  it('strokes the dark outline pass before the coloured pass', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    g.beginFrame(0);
    f.log.length = 0;
    g.skeleton(pose({ slot: 2 }));
    const styles = f.log
      .filter((r) => r.op === 'set:strokeStyle')
      .map((r) => r.args[0]);
    const firstInk = styles.indexOf(KEYLINE);
    const firstColor = styles.indexOf(C.slot[2]);
    expect(firstInk).toBeGreaterThanOrEqual(0);
    expect(firstColor).toBeGreaterThan(firstInk);
  });

  it('uses the player slot colour by default and honours an override', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    f.log.length = 0;
    g.skeleton(pose({ slot: 3 }));
    expect(f.log.some((r) => r.op === 'set:strokeStyle' && r.args[0] === C.slot[3])).toBe(true);
    f.log.length = 0;
    g.skeleton(pose({ slot: 3 }), { color: '#123456' });
    expect(f.log.some((r) => r.op === 'set:strokeStyle' && r.args[0] === '#123456')).toBe(true);
  });

  it('skips limbs whose landmarks are not visible enough to trust', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    const full = pose();
    f.log.length = 0;
    g.skeleton(full, { jointR: 0 });
    const withLegs = f.log.filter((r) => r.op === 'moveTo').length;
    const noLegs = pose();
    for (const j of [L.LEFT_KNEE, L.RIGHT_KNEE, L.LEFT_ANKLE, L.RIGHT_ANKLE,
      L.LEFT_FOOT_INDEX, L.RIGHT_FOOT_INDEX]) noLegs.vis[j] = 0.1;
    f.log.length = 0;
    g.skeleton(noLegs, { jointR: 0 });
    expect(f.log.filter((r) => r.op === 'moveTo').length).toBeLessThan(withLegs);
  });

  it('rings an emphasised hand so "this is the hand that matters" reads', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    const p = pose();
    f.log.length = 0;
    g.skeleton(p, { jointR: 6, emphasize: [L.LEFT_WRIST] });
    // Mitts sit on the palm, where the games hit-test, not on the wrist.
    const lp = { x: 0, y: 0 };
    const rp = { x: 0, y: 0 };
    expect(mittAt(p, 'L', lp) && mittAt(p, 'R', rp)).toBe(true);
    const at = (q: { x: number; y: number }): number[] =>
      f.log
        .filter((r) => r.op === 'arc' && r.args[0] === q.x && r.args[1] === q.y)
        .map((r) => r.args[2] as number);
    expect(at(lp)).toContain(6); // the mitt, at jointR
    expect(at(lp)).toContain(6 * BODY.ring); // the ring
    expect(at(rp)).toContain(6);
    expect(at(rp)).not.toContain(6 * BODY.ring); // not emphasised
    // The ring is bright: the accent colour, stroked over an ink keyline.
    const styles = f.log.filter((r) => r.op === 'set:strokeStyle').map((r) => r.args[0]);
    expect(styles.at(-1)).toBe(C.accent);
  });

  it('composites the body ONCE through a layer, so partial alpha is a sticker, not an X-ray', () => {
    // Painted straight onto the canvas at alpha 0.5, the ink under every limb
    // shows through its colour and every overlap darkens.
    const layer = fakeCanvas();
    const f = fakeCanvas();
    (f.raw as Record<string, unknown>)['ownerDocument'] = { createElement: () => layer.raw };
    const g = new Canvas2DRenderer(f.canvas, { dpr: 2 });
    g.beginFrame(0);
    f.log.length = 0;
    layer.log.length = 0;
    g.skeleton(pose(), { alpha: 0.5 });
    // The main canvas gets exactly one draw: the layer, at the body's alpha.
    const draws = f.log.filter((r) => ['drawImage', 'fill', 'stroke', 'fillRect'].includes(r.op));
    expect(draws.map((r) => r.op)).toEqual(['drawImage']);
    expect(f.log.filter((r) => r.op === 'set:globalAlpha').map((r) => r.args[0])).toContain(0.5);
    // The layer matches the backing store and holds the body itself...
    expect(layer.raw.width).toBe(f.raw.width);
    expect(layer.log.filter((r) => r.op === 'stroke').length).toBeGreaterThan(2);
    // ...including the see-through belly, punched out of the LAYER only: on
    // the opaque canvas `destination-out` would cut a black hole.
    expect(layer.log.some((r) => r.op === 'set:globalCompositeOperation' &&
      r.args[0] === 'destination-out')).toBe(true);
    expect(f.log.some((r) => r.op === 'set:globalCompositeOperation' &&
      r.args[0] === 'destination-out')).toBe(false);
    // The composite copies only the body's box, device px to logical px.
    const di = f.log.find((r) => r.op === 'drawImage')!.args as number[];
    expect(di[3]! / 2).toBeCloseTo(di[7]!, 6);
    expect(di[3]!).toBeLessThan(f.raw.width);
  });

  it('never punches the opaque canvas when there is no layer', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    f.log.length = 0;
    g.skeleton(pose(), { alpha: 0.5 });
    g.ghostBody(pose(), 0.1);
    expect(f.log.some((r) => r.op === 'set:globalCompositeOperation' &&
      r.args[0] !== 'source-over')).toBe(false);
    expect(f.log.filter((r) => r.op === 'stroke').length).toBeGreaterThan(0);
  });
});

describe('text', () => {
  it('raises the weight and the size to the readable floor', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    f.log.length = 0;
    g.text('점수', 100, 100, { size: 6, weight: 200 });
    const font = f.log.filter((r) => r.op === 'set:font').pop()?.args[0] as string;
    expect(font.startsWith('500 18px')).toBe(true);
  });

  it('strokes the outline before filling, so the outline sits behind', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    f.log.length = 0;
    g.text('좋아요!', 10, 10, { size: 40, stroke: C.ink, fill: C.white });
    const ops = f.log.map((r) => r.op);
    expect(ops.indexOf('strokeText')).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf('strokeText')).toBeLessThan(ops.indexOf('fillText'));
  });

  it('lays tabular digits on a fixed grid so a counter cannot jitter', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    // Same digit count => same measured width, whatever the digits are.
    const a = g.measure('11111', { size: 48, tabular: true });
    const b = g.measure('98706', { size: 48, tabular: true });
    expect(a).toBeCloseTo(b, 9);
    f.log.length = 0;
    g.text('120', 500, 100, { size: 48, tabular: true, align: 'center' });
    // One fillText per glyph, each at its own cell origin.
    const xs = f.log.filter((r) => r.op === 'fillText').map((r) => r.args[1] as number);
    expect(xs).toHaveLength(3);
    expect(xs[1]! - xs[0]!).toBeGreaterThan(0);
  });

  it('shrinks to fit maxWidth instead of condensing the glyphs', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    f.log.length = 0;
    g.text('아주아주아주 긴 제목입니다', 100, 100, { size: 80, maxWidth: 200 });
    const fonts = f.log.filter((r) => r.op === 'set:font').map((r) => r.args[0] as string);
    const final = Number.parseFloat(fonts[fonts.length - 1]!.split(' ')[1]!);
    expect(final).toBeLessThan(80);
    // fillText is called with no maxWidth argument — condensing Hangul looks cheap.
    const ft = f.log.filter((r) => r.op === 'fillText').pop();
    expect(ft?.args).toHaveLength(3);
  });
});

describe('sprite', () => {
  it('centres the 100x100 author box on the draw point', () => {
    // The whole transform: move to (x,y), scale by size/100, then shift the
    // author box back by half so its centre lands on the draw point. Get the
    // last step wrong and every sprite sits down-and-right of what it marks.
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    f.log.length = 0;
    g.sprite('star', 400, 300, 50);
    const translates = f.log.filter((r) => r.op === 'translate').map((r) => r.args);
    expect(translates[0]).toEqual([400, 300]);
    expect(translates.at(-1)).toEqual([-50, -50]);
    const scale = f.log.find((r) => r.op === 'scale')!;
    expect(scale.args[0]).toBeCloseTo(0.5, 6);
    expect(scale.args[1]).toBeCloseTo(0.5, 6);
  });

  it('fails loudly on an unknown sprite id while developing', () => {
    // A mistyped id would otherwise draw nothing, which looks exactly like a
    // game that forgot to spawn anything — the single most expensive class of
    // bug to find by eye. In a production build this degrades to drawing
    // nothing rather than killing a child's round mid-party.
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    f.log.length = 0;
    expect(() => g.sprite('no-such-sprite', 10, 10, 20)).toThrow(/unknown sprite/);
    expect(f.log.filter((r) => r.op === 'fill')).toHaveLength(0);
  });

  it('rotates about the draw point without leaking the transform', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    f.log.length = 0;
    g.sprite('star', 10, 20, 30, { rot: 0.5 });
    const ops = f.log.map((r) => r.op);
    expect(ops.filter((o) => o === 'save')).toHaveLength(1);
    expect(ops.filter((o) => o === 'restore')).toHaveLength(1);
    expect(f.log.find((r) => r.op === 'rotate')?.args).toEqual([0.5]);
  });
});

describe('glow budget', () => {
  it('honours the first N glows of a frame and drops the rest silently', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 2 });
    g.beginFrame(0);
    f.log.length = 0;
    for (let i = 0; i < GLOW_BUDGET + 20; i++) {
      g.circle(100, 100, 10, { fill: '#fff', glow: 18 });
    }
    const blurs = f.log
      .filter((r) => r.op === 'set:shadowBlur' && r.args[0] !== 0)
      .map((r) => r.args[0] as number);
    expect(blurs).toHaveLength(GLOW_BUDGET);
    // shadowBlur is not scaled by the CTM, so dpr is compensated for by hand.
    expect(blurs[0]).toBe(36);
    expect(g.glowOverflow).toBe(20);
    // The budget reopens next frame.
    g.beginFrame(1 / 60);
    f.log.length = 0;
    g.circle(1, 1, 2, { fill: '#fff', glow: 8 });
    expect(f.log.some((r) => r.op === 'set:shadowBlur' && r.args[0] === 16)).toBe(true);
  });
});

describe('alpha', () => {
  it('multiplies rather than replaces, and unwinds on restore', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    g.beginFrame(0);
    g.alpha(0.5);
    g.save();
    g.alpha(0.5);
    const mid = f.log.filter((r) => r.op === 'set:globalAlpha').pop()?.args[0];
    expect(mid).toBeCloseTo(0.25, 9);
    g.restore();
    const after = f.log.filter((r) => r.op === 'set:globalAlpha').pop()?.args[0];
    expect(after).toBeCloseTo(0.5, 9);
  });
});

describe('ghostBody', () => {
  it('draws a filled silhouette with no face features', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    f.log.length = 0;
    g.ghostBody(pose(), 0.6);
    expect(f.log.filter((r) => r.op === 'fill').length).toBeGreaterThan(0);
    // Exactly one head circle and nothing else centred on the nose: no eyes,
    // no mouth. This is a shadow, not a portrait.
    const atNose = f.log.filter(
      (r) => r.op === 'arc' && r.args[0] === 640 && r.args[1] === 170,
    );
    expect(atNose).toHaveLength(1);
    for (const n of numericArgs(f.log)) expect(Number.isFinite(n)).toBe(true);
  });

  it('is a no-op at zero alpha', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    f.log.length = 0;
    g.ghostBody(pose(), 0);
    expect(f.log).toHaveLength(0);
  });
});

describe('skeleton: confidence and taper', () => {
  /** A player whose left arm the model is unsure about. */
  function player(visOverrides: Record<number, number> = {}): PlayerPose {
    const px = new Float32Array(LANDMARK_COUNT * 2);
    const vis = new Float32Array(LANDMARK_COUNT).fill(0.95);
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      px[i * 2] = 400 + (i % 5) * 20;
      px[i * 2 + 1] = 200 + Math.floor(i / 5) * 30;
    }
    for (const [j, v] of Object.entries(visOverrides)) vis[Number(j)] = v;
    return {
      id: 1, slot: 0, present: true, conf: 0.9,
      n: new Float32Array(LANDMARK_COUNT * 2), v: new Float32Array(LANDMARK_COUNT * 2),
      px, vis, box: { x: 0, y: 0, w: 1, h: 1 }, rollDeg: 0, scalePx: 100,
      calib: {} as PlayerPose['calib'],
    };
  }

  it('fades a low-confidence limb instead of blinking it out', () => {
    // The bug this replaces: a hard threshold made an arm vanish and reappear
    // between frames, which reads as the camera having lost the player.
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    f.log.length = 0;
    // Just above the visibility floor: should draw, but faintly.
    g.skeleton(player({ [L.LEFT_WRIST]: MIN_VIS + 0.06 }));
    const alphas = (log: Rec[]): Set<number> =>
      new Set(log.filter((r) => r.op === 'set:globalAlpha').map((r) => r.args[0] as number));
    const full = fakeCanvas();
    new Canvas2DRenderer(full.canvas, { dpr: 1 }).skeleton(player());
    const sure = alphas(full.log);
    const faint = [...alphas(f.log)].filter((a) => a > 0 && a < 0.5 && !sure.has(a));
    expect(faint.length).toBeGreaterThan(0);
  });

  it('draws nothing for a limb below the visibility floor', () => {
    // Gate, do not guess: a joint the model cannot see must not be drawn at
    // an invented position.
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    const all = new Canvas2DRenderer(fakeCanvas().canvas, { dpr: 1 });
    void all;
    f.log.length = 0;
    g.skeleton(player({
      [L.LEFT_WRIST]: 0.1, [L.LEFT_ELBOW]: 0.1,
      [L.RIGHT_WRIST]: 0.1, [L.RIGHT_ELBOW]: 0.1,
    }));
    const strokes = f.log.filter((r) => r.op === 'stroke').length;
    const full = fakeCanvas();
    const g2 = new Canvas2DRenderer(full.canvas, { dpr: 1 });
    full.log.length = 0;
    g2.skeleton(player());
    const strokesFull = full.log.filter((r) => r.op === 'stroke').length;
    expect(strokes).toBeLessThan(strokesFull);
  });

  it('varies limb thickness rather than drawing a uniform stick figure', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    f.log.length = 0;
    g.skeleton(player());
    const widths = new Set(
      f.log.filter((r) => r.op === 'set:lineWidth').map((r) => Number(r.args[0]).toFixed(2)),
    );
    // Torso, upper arm, forearm and foot are four different weights.
    expect(widths.size).toBeGreaterThanOrEqual(4);
  });

  it('puts dots only on the ends by default', () => {
    const ends = fakeCanvas();
    const gEnds = new Canvas2DRenderer(ends.canvas, { dpr: 1 });
    ends.log.length = 0;
    gEnds.skeleton(player());
    const all = fakeCanvas();
    const gAll = new Canvas2DRenderer(all.canvas, { dpr: 1 });
    all.log.length = 0;
    gAll.skeleton(player(), { jointSet: 'all' });
    const arcs = (l: typeof ends.log): number => l.filter((r) => r.op === 'arc').length;
    expect(arcs(ends.log)).toBeLessThan(arcs(all.log));
  });

  it('draws no joint dots at all when asked', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    const p = pose();
    f.log.length = 0;
    g.skeleton(p, { jointSet: 'none', outline: false });
    const arcAt = (x: number, y: number): boolean =>
      f.log.some((r) => r.op === 'arc' && r.args[0] === x && r.args[1] === y);
    const lp = { x: 0, y: 0 };
    mittAt(p, 'L', lp);
    expect(arcAt(lp.x, lp.y)).toBe(false); // no mitt
    expect(arcAt(592, 660)).toBe(false); // no ankle dot
    // The head is still drawn — a body without one reads as decapitated.
    expect(arcAt(640, 170)).toBe(true);
  });
});

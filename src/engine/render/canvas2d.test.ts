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
import { Canvas2DRenderer, GLOW_BUDGET } from './canvas2d';
import { C } from './palette';
import { L, LANDMARK_COUNT } from '../pose/landmarks';
import type { PlayerPose } from '../types';

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
    expect(fills.length).toBe(2); // background + vignette
    for (const r of fills) expect(r.args).toEqual([0, 0, 1280, 720]);
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
      g.emoji('🦟', b, 1, 40);
      g.emoji('🦟', 1, 1, b);
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
    const firstInk = styles.indexOf(C.ink);
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

  it('draws emphasised joints at ~2x so "this is the hand that matters" reads', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    f.log.length = 0;
    g.skeleton(pose(), { jointR: 6, emphasize: [L.LEFT_WRIST] });
    const at = (x: number, y: number): number[] =>
      f.log
        .filter((r) => r.op === 'arc' && r.args[0] === x && r.args[1] === y)
        .map((r) => r.args[2] as number);
    const wrist = Math.max(...at(520, 440)); // emphasised
    const elbow = Math.max(...at(540, 350)); // ordinary
    expect(at(520, 440)).toContain(12); // 2 * jointR
    expect(wrist).toBeGreaterThan(elbow * 1.4);
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

describe('emoji', () => {
  it('centres the glyph ink box on y rather than using the middle baseline', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    f.log.length = 0;
    g.emoji('🦟', 400, 300, 50);
    const baseline = f.log.filter((r) => r.op === 'set:textBaseline').pop()?.args[0];
    expect(baseline).toBe('alphabetic');
    const ft = f.log.filter((r) => r.op === 'fillText').pop()!;
    // The fake reports ascent 0.9em / descent 0.1em, so the centring offset is
    // (0.9 - 0.1)/2 = 0.4em = 20px below y.
    expect(ft.args[1]).toBe(400);
    expect(ft.args[2]).toBe(320);
  });

  it('rotates about the draw point without leaking the transform', () => {
    const f = fakeCanvas();
    const g = new Canvas2DRenderer(f.canvas, { dpr: 1 });
    f.log.length = 0;
    g.emoji('⭐', 10, 20, 30, 0.5);
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
    // Exactly two head circles (one per soft/solid pass) and nothing else
    // centred on the nose: no eyes, no mouth. This is a shadow, not a portrait.
    const atNose = f.log.filter(
      (r) => r.op === 'arc' && r.args[0] === 640 && r.args[1] === 170,
    );
    expect(atNose).toHaveLength(2);
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

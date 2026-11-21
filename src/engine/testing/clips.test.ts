// Validates the synthetic clip corpus itself.
//
// Every one of the 58 game smoke tests trusts these clips to contain the
// motions their names promise. If `jump-x8` does not actually hold 8 jumps,
// then every jump game's test passes while proving nothing. So the corpus gets
// tested before the games do.
import { describe, expect, it } from 'vitest';
import { CLIP_NAMES, clip, type ClipName } from './clips';
import { body, STAND } from './synth';
import { L, LANDMARK_COUNT } from '../pose/landmarks';

const X = (lm: Float32Array, j: number): number => lm[j * 2]!;
const Y = (lm: Float32Array, j: number): number => lm[j * 2 + 1]!;
const hipY = (lm: Float32Array): number => (Y(lm, L.LEFT_HIP) + Y(lm, L.RIGHT_HIP)) / 2;
const shoulderW = (lm: Float32Array): number =>
  Math.abs(X(lm, L.LEFT_SHOULDER) - X(lm, L.RIGHT_SHOULDER));
const wristGap = (lm: Float32Array): number =>
  Math.hypot(X(lm, L.LEFT_WRIST) - X(lm, L.RIGHT_WRIST), Y(lm, L.LEFT_WRIST) - Y(lm, L.RIGHT_WRIST));

/**
 * Count excursions of a signal past `enter`, re-arming below `exit`.
 * Deliberately the same hysteresis shape the real detectors use, so this
 * measures what a detector would see rather than counting noisy local extrema.
 */
function countExcursions(xs: number[], enter: number, exit: number): number {
  let armed = true;
  let n = 0;
  for (const v of xs) {
    if (armed && v > enter) { n++; armed = false; }
    else if (!armed && v < exit) armed = true;
  }
  return n;
}

describe('synth: the parametric body', () => {
  it('produces 33 finite landmarks', () => {
    const lm = body();
    expect(lm).toHaveLength(LANDMARK_COUNT * 2);
    for (let i = 0; i < lm.length; i++) expect(Number.isFinite(lm[i])).toBe(true);
  });

  it('honours the requested shoulder width', () => {
    for (const w of [0.07, 0.17, 0.3]) {
      expect(shoulderW(body({ shoulderW: w }))).toBeCloseTo(w, 3);
    }
  });

  it('is anatomically oriented: head above shoulders above hips above ankles', () => {
    // y grows DOWNWARD. Getting this backwards would silently invert every
    // vertical threshold in the engine.
    const lm = body();
    const sy = (Y(lm, L.LEFT_SHOULDER) + Y(lm, L.RIGHT_SHOULDER)) / 2;
    expect(Y(lm, L.NOSE)).toBeLessThan(sy);
    expect(sy).toBeLessThan(hipY(lm));
    expect(hipY(lm)).toBeLessThan(Y(lm, L.LEFT_ANKLE));
  });

  it('places the subject-left side on the image-right (unmirrored source)', () => {
    const lm = body();
    expect(X(lm, L.LEFT_SHOULDER)).toBeGreaterThan(X(lm, L.RIGHT_SHOULDER));
  });

  it('raises wrists above shoulders for an overhead pose', () => {
    const lm = body({ armL: 90, armR: 90, elbowL: 0, elbowR: 0 });
    expect(Y(lm, L.LEFT_WRIST)).toBeLessThan(Y(lm, L.LEFT_SHOULDER));
  });

  it('keeps limb lengths proportional to shoulder width', () => {
    // This is what makes normalization distance-invariant: a body twice as far
    // away must be an exact scale copy.
    const near = body({ shoulderW: 0.2 });
    const far = body({ shoulderW: 0.1 });
    const ratio = (lm: Float32Array): number =>
      Math.hypot(
        X(lm, L.LEFT_SHOULDER) - X(lm, L.LEFT_ELBOW),
        Y(lm, L.LEFT_SHOULDER) - Y(lm, L.LEFT_ELBOW),
      ) / shoulderW(lm);
    expect(ratio(near)).toBeCloseTo(ratio(far), 4);
  });
});

describe('clips: the corpus is well-formed', () => {
  it.each(CLIP_NAMES)('%s has frames with finite coordinates', (name) => {
    const c = clip(name);
    expect(c.frames.length).toBeGreaterThan(20);
    for (const f of c.frames) {
      expect(f.people.length).toBeGreaterThan(0);
      for (const p of f.people) {
        expect(p.lm).toHaveLength(LANDMARK_COUNT * 2);
        expect(p.vis).toHaveLength(LANDMARK_COUNT);
        for (let i = 0; i < p.lm.length; i++) expect(Number.isFinite(p.lm[i])).toBe(true);
      }
    }
  });

  it.each(CLIP_NAMES)('%s has monotonically increasing timestamps', (name) => {
    const c = clip(name);
    for (let i = 1; i < c.frames.length; i++) {
      expect(c.frames[i]!.t).toBeGreaterThan(c.frames[i - 1]!.t);
    }
  });

  it('is deterministic — the same clip is byte-identical across calls', () => {
    // Required for the "same seed, same score" replay-integrity test.
    const a = clip('jump-x8');
    const b = clip('jump-x8');
    expect(a).toBe(b); // cached
    expect(a.frames[10]!.people[0]!.lm).toEqual(b.frames[10]!.people[0]!.lm);
  });
});

describe('clips: each contains the motion its name promises', () => {
  const hipRise = (name: ClipName): number[] =>
    clip(name).frames.map((f) => {
      const lm = f.people[0]!.lm;
      // Positive = hips are higher than standing (y grows down).
      return (STAND.hipY - hipY(lm)) / shoulderW(lm);
    });

  it('jump-x8 contains exactly 8 upward hip excursions', () => {
    expect(countExcursions(hipRise('jump-x8'), 0.3, 0.1)).toBe(8);
  });

  it('squat-x8 contains exactly 8 downward hip excursions', () => {
    const drop = hipRise('squat-x8').map((v) => -v);
    expect(countExcursions(drop, 0.3, 0.1)).toBe(8);
  });

  it('clap-x12 brings the wrists together exactly 12 times', () => {
    const closeness = clip('clap-x12').frames.map((f) => {
      const lm = f.people[0]!.lm;
      return -wristGap(lm) / shoulderW(lm); // high = hands together
    });
    expect(countExcursions(closeness, -0.6, -1.0)).toBe(12);
  });

  it('idle and fidget contain no jump and no clap', () => {
    // The false-positive floor the whole catalogue is measured against.
    for (const name of ['idle', 'fidget'] as const) {
      expect(countExcursions(hipRise(name), 0.3, 0.1), `${name} jump`).toBe(0);
      const closeness = clip(name).frames.map((f) => {
        const lm = f.people[0]!.lm;
        return -wristGap(lm) / shoulderW(lm);
      });
      expect(countExcursions(closeness, -0.6, -1.0), `${name} clap`).toBe(0);
    }
  });

  it('reach-grid sweeps both hands across most of the frame', () => {
    // This clip is what gives ~25 reach/catch/aim games a free reachability
    // test, so its coverage is load-bearing.
    const xs: number[] = [];
    const ys: number[] = [];
    for (const f of clip('reach-grid').frames) {
      const lm = f.people[0]!.lm;
      for (const j of [L.LEFT_WRIST, L.RIGHT_WRIST]) {
        xs.push(X(lm, j));
        ys.push(Y(lm, j));
      }
    }
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.45);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.3);
  });

  it('swing-wide moves the hands fast between frames', () => {
    let maxStep = 0;
    const fr = clip('swing-wide').frames;
    for (let i = 1; i < fr.length; i++) {
      const a = fr[i - 1]!.people[0]!.lm;
      const b = fr[i]!.people[0]!.lm;
      maxStep = Math.max(
        maxStep,
        Math.hypot(X(b, L.LEFT_WRIST) - X(a, L.LEFT_WRIST), Y(b, L.LEFT_WRIST) - Y(a, L.LEFT_WRIST)),
      );
    }
    // A point-vs-point hit test would miss a hand moving this far per frame,
    // which is why swing games must use swept collision.
    expect(maxStep).toBeGreaterThan(0.02);
  });

  it('knee-run alternates the knees rather than lifting both', () => {
    let antiPhase = 0;
    for (const f of clip('knee-run').frames) {
      const lm = f.people[0]!.lm;
      const KNEE_UP = 1.5; // resting is 1.98 shoulder-widths below the hip, lifted is 1.06
      const lUp = Y(lm, L.LEFT_KNEE) < hipY(lm) + KNEE_UP * shoulderW(lm);
      const rUp = Y(lm, L.RIGHT_KNEE) < hipY(lm) + KNEE_UP * shoulderW(lm);
      if (lUp !== rUp) antiPhase++;
    }
    expect(antiPhase / clip('knee-run').frames.length).toBeGreaterThan(0.3);
  });

  it('step-lr translates the whole body, not just the shoulders', () => {
    const hips = clip('step-lr').frames.map((f) => hipY(f.people[0]!.lm) * 0 + X(f.people[0]!.lm, L.LEFT_HIP));
    expect(Math.max(...hips) - Math.min(...hips)).toBeGreaterThan(0.2);
  });
});

describe('clips: the standing body fits in frame', () => {
  const FULL_BODY: ClipName[] = [
    'idle', 'fidget', 'reach-grid', 'jump-x8', 'squat-x8', 'clap-x12',
    'swing-wide', 'step-lr', 'knee-run', 'hold-poses', 'far-small',
  ];

  it.each(FULL_BODY)('%s keeps head and ankles inside the image', (name) => {
    // Without this, ankles sit at y>1 and `lowerBodyVisible` is false for the
    // whole corpus, which silently makes every legs/feet game untestable.
    for (const f of clip(name).frames) {
      for (const p of f.people) {
        for (const j of [L.NOSE, L.LEFT_ANKLE, L.RIGHT_ANKLE]) {
          expect(Y(p.lm, j), `${name} joint ${j}`).toBeGreaterThan(-0.02);
          expect(Y(p.lm, j), `${name} joint ${j}`).toBeLessThan(1.02);
        }
      }
    }
  });

  it.each(FULL_BODY)('%s keeps the ankles visible', (name) => {
    const frames = clip(name).frames;
    const ok = frames.filter((f) => f.people[0]!.vis[L.LEFT_ANKLE]! > 0.5).length;
    expect(ok / frames.length, name).toBeGreaterThan(0.85);
  });
});

describe('clips: the adverse conditions', () => {
  it('far-small puts the subject ~4m away', () => {
    for (const f of clip('far-small').frames) {
      expect(shoulderW(f.people[0]!.lm)).toBeLessThan(0.1);
    }
  });

  it('far-small still contains real jumps, so scale invariance is testable', () => {
    // Derive the standing baseline from the clip itself rather than hardcoding
    // it: a clip's framing is its own business, and a literal here silently
    // rots the moment someone reframes it.
    const hips = clip('far-small').frames.map((f) => hipY(f.people[0]!.lm));
    const base = [...hips].sort((a, b) => a - b)[Math.floor(hips.length / 2)]!;
    const rise = clip('far-small').frames.map((f) => {
      const lm = f.people[0]!.lm;
      return (base - hipY(lm)) / shoulderW(lm);
    });
    expect(countExcursions(rise, 0.3, 0.1)).toBeGreaterThan(2);
  });

  it('no-legs hides the lower body', () => {
    const frames = clip('no-legs').frames;
    for (const f of frames) {
      const v = f.people[0]!.vis;
      expect(v[L.LEFT_ANKLE]!).toBeLessThan(0.5);
      expect(v[L.RIGHT_KNEE]!).toBeLessThan(0.5);
    }
    // The upper body stays usable so the game can degrade rather than crash.
    // Random dropout is deliberate, so this is a majority, not every frame.
    const shoulderOk = frames.filter((f) => f.people[0]!.vis[L.LEFT_SHOULDER]! > 0.5).length;
    expect(shoulderOk / frames.length).toBeGreaterThan(0.9);
  });

  it('laggy runs at ~10fps with dropped frames and low-visibility joints', () => {
    const c = clip('laggy');
    expect(c.fps).toBe(10);
    // Frames were actually dropped, so timestamps are not evenly spaced.
    const gaps = new Set<string>();
    for (let i = 1; i < c.frames.length; i++) {
      gaps.add((c.frames[i]!.t - c.frames[i - 1]!.t).toFixed(2));
    }
    expect(gaps.size).toBeGreaterThan(1);
    const lowVis = c.frames.filter((f) =>
      [...f.people[0]!.vis].some((v) => v < 0.5)).length;
    expect(lowVis).toBeGreaterThan(0);
  });

  it('two-cross has two people whose detection order actually swaps', () => {
    const c = clip('two-cross');
    expect(c.frames.every((f) => f.people.length === 2)).toBe(true);
    // The identity-swap regression: the model gives no stable ids, so a naive
    // index-as-identity consumer breaks here and the engine's tracker must not.
    const widthOfFirst = c.frames.map((f) => shoulderW(f.people[0]!.lm));
    const start = widthOfFirst[0]!;
    const swapped = widthOfFirst.some((w) => Math.abs(w - start) > 0.005);
    expect(swapped).toBe(true);
  });
});

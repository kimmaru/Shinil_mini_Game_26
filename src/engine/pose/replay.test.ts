import { describe, expect, it } from 'vitest';
import { CLIP_NAMES, clip } from '../testing/clips';
import { L, LANDMARK_COUNT } from './landmarks';
import { MAX_EXTRAPOLATE_SEC, nullPoseSource } from './frame';
import { ReplayPoseSource, replaySource } from './replay';
import { STEADY } from './oneEuro';

const VIEW = { w: 1280, h: 720 };

describe('ReplayPoseSource', () => {
  it('is Node-safe: no DOM anywhere in the path', () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
    const src = replaySource(clip('idle'));
    void src.start();
    expect(src.sample(1).p1).toBeDefined();
  });

  it('produces finite, bounded values for every clip in the corpus', () => {
    for (const name of CLIP_NAMES) {
      const src = new ReplayPoseSource(clip(name), { maxPlayers: 2, view: VIEW });
      void src.start();
      let seen = 0;
      let worstN = 0;
      let worstV = 0;
      let bad = 0;
      for (let i = 0; i < 20 * 60; i++) {
        const f = src.sample(i / 60);
        expect(f.inferenceAgeMs).toBeLessThanOrEqual(MAX_EXTRAPOLATE_SEC * 1000 + 1e-6);
        for (const p of f.players) {
          if (!p.present) continue;
          seen++;
          if (!(p.conf >= 0 && p.conf <= 1)) bad++;
          if (!(p.scalePx > 0)) bad++;
          for (let k = 0; k < LANDMARK_COUNT * 2; k++) {
            if (!Number.isFinite(p.n[k]!) || !Number.isFinite(p.px[k]!) || !Number.isFinite(p.v[k]!)) {
              bad++;
            }
            worstN = Math.max(worstN, Math.abs(p.n[k]!));
            worstV = Math.max(worstV, Math.abs(p.v[k]!));
          }
        }
      }
      expect(bad, `${name} produced non-finite or impossible values`).toBe(0);
      expect(seen, `${name} never produced a present player`).toBeGreaterThan(100);
      // A body is at most a few shoulder widths across; anything past ~8 means
      // the scale collapsed. 40 units/sec would be a 40-shoulder-width-per-
      // second hand, which no child has.
      expect(worstN, `${name} normalized coords exploded`).toBeLessThan(8);
      expect(worstV, `${name} velocity exploded`).toBeLessThan(40);
    }
  });

  it('loops a 12s clip to fill a 40s round without a seam spike', () => {
    const src = new ReplayPoseSource(clip('idle'), { maxPlayers: 1, view: VIEW, loop: true });
    void src.start();
    let present = 0;
    let worstSeamV = 0;
    const dur = 12;
    for (let i = 0; i < 40 * 60; i++) {
      const t = i / 60;
      const f = src.sample(t);
      if (f.p1?.present) present++;
      // Within 0.2s either side of a loop boundary, nothing may move fast: a
      // teleport back to frame 0 must not look like a jump or a swing.
      const phase = t % dur;
      if (f.p1?.present && (phase < 0.2 || phase > dur - 0.2)) {
        for (let k = 0; k < LANDMARK_COUNT * 2; k++) {
          worstSeamV = Math.max(worstSeamV, Math.abs(f.p1.v[k]!));
        }
      }
    }
    expect(src.loops).toBeGreaterThanOrEqual(3);
    // Measured: present for 2368 of 2400 steps. The missing 0.53s is the
    // 0.45s probation at the very start; the clip's 1% dropped frames cost
    // nothing because `present` has a 0.3s grace.
    expect(present).toBeGreaterThan(40 * 60 * 0.98);
    expect(worstSeamV).toBeLessThan(3);
  });

  it('does not collapse the body at a loop seam', () => {
    // Regression: resetFilters() used to zero the positions, so for one frame
    // after each loop the whole skeleton sat at px (0,0).
    const src = new ReplayPoseSource(clip('step-lr'), { maxPlayers: 1, view: VIEW });
    void src.start();
    let worstOffscreen = 0;
    for (let i = 0; i < 60 * 60; i++) {
      const f = src.sample(i / 60);
      const p = f.p1;
      if (!p?.present) continue;
      const hip = (p.px[L.LEFT_HIP * 2]! + p.px[L.RIGHT_HIP * 2]!) / 2;
      if (hip < 50) worstOffscreen++;
    }
    expect(worstOffscreen).toBe(0);
  });

  it('freezes on the last frame when looping is off', () => {
    const src = new ReplayPoseSource(clip('idle'), { maxPlayers: 1, loop: false, view: VIEW });
    void src.start();
    src.sample(11.9);
    const a = src.sample(13);
    const x1 = a.p1!.px[L.NOSE * 2]!;
    const b = src.sample(14);
    expect(b.p1!.px[L.NOSE * 2]!).toBeCloseTo(x1, 5);
    expect(src.loops).toBe(0);
  });

  it('extrapolates between inferences and reports the age', () => {
    // `laggy` is 10fps, so a 60Hz game asks for 6 frames per inference.
    const src = new ReplayPoseSource(clip('laggy'), { maxPlayers: 1, view: VIEW });
    void src.start();
    let maxAge = 0;
    let moved = 0;
    let prev = 0;
    for (let i = 0; i < 10 * 60; i++) {
      const f = src.sample(i / 60);
      maxAge = Math.max(maxAge, f.inferenceAgeMs);
      if (!f.p1?.present) continue;
      const x = f.p1.px[L.LEFT_WRIST * 2]!;
      if (prev && Math.abs(x - prev) > 0.01) moved++;
      prev = x;
    }
    // The age is capped at 60ms — uncapped extrapolation overshoots badly the
    // moment a frame is dropped, and `laggy` drops 6% of them.
    expect(maxAge).toBeGreaterThan(20);
    expect(maxAge).toBeLessThanOrEqual(MAX_EXTRAPOLATE_SEC * 1000 + 1e-6);
    // 10fps clip over 10s is ~100 inferences; far more than 100 distinct
    // positions means the frames in between really are being extrapolated.
    expect(moved).toBeGreaterThan(200);
  });

  it('pause() stops consuming the clip; resume() re-anchors', () => {
    const src = new ReplayPoseSource(clip('swing-wide'), { maxPlayers: 1, view: VIEW });
    void src.start();
    src.sample(2);
    const before = src.sample(2).p1!.px[L.LEFT_WRIST * 2]!;
    src.pause();
    for (let i = 0; i < 60; i++) src.sample(2 + i / 60);
    expect(src.sample(3).p1!.px[L.LEFT_WRIST * 2]!).toBeCloseTo(before, 5);
    src.resume();
    src.sample(3.1);
    expect(Number.isFinite(src.sample(3.2).p1!.px[L.LEFT_WRIST * 2]!)).toBe(true);
  });

  it('accepts a filter preset without changing the contract', () => {
    const src = new ReplayPoseSource(clip('swing-wide'), {
      maxPlayers: 1,
      view: VIEW,
      filter: STEADY,
    });
    void src.start();
    for (let i = 0; i < 300; i++) src.sample(i / 60);
    expect(src.sample(5).p1!.present).toBe(true);
    expect(src.info.kind).toBe('replay');
    expect(src.info.tier).toContain('swing-wide');
  });

  it('setView rescales px but not n', () => {
    const src = new ReplayPoseSource(clip('idle'), { maxPlayers: 1, view: VIEW });
    void src.start();
    for (let i = 0; i < 120; i++) src.sample(i / 60);
    const p = src.sample(2).p1!;
    const nBefore = p.n[L.LEFT_WRIST * 2]!;
    const pxBefore = p.px[L.LEFT_WRIST * 2]!;
    src.setView(640, 360);
    for (let i = 0; i < 60; i++) src.sample(2 + i / 60);
    const after = src.sample(3).p1!;
    expect(after.n[L.LEFT_WRIST * 2]!).toBeCloseTo(nBefore, 1);
    expect(after.px[L.LEFT_WRIST * 2]!).toBeLessThan(pxBefore * 0.75);
  });

  it('stop() releases every track', () => {
    const src = new ReplayPoseSource(clip('idle'), { maxPlayers: 1, view: VIEW });
    void src.start();
    src.sample(1);
    expect(src.sample(1).p1).toBeDefined();
    src.stop();
    expect(src.trackStates.every((t) => t.state === 'free')).toBe(true);
  });
});

describe('nullPoseSource', () => {
  it('reports nobody, forever, without allocating a player', () => {
    const src = nullPoseSource();
    void src.start();
    const f = src.sample(1);
    expect(f.players.length).toBe(0);
    expect(f.p1).toBeUndefined();
    expect(f.inferenceAgeMs).toBe(0);
    expect(src.info.kind).toBe('null');
    expect(src.sample(2)).toBe(f);
  });
});

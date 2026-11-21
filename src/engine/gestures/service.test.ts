import { describe, expect, it } from 'vitest';

import { L } from '../pose/landmarks';
import { GESTURE_KINDS_FOR_TEST, createGestureService } from './service';
import { POSE_TEMPLATES } from './holds';
import { driveClip } from './harness.test';
import type { GestureKind, PoseFrame } from '../types';

/** Minimal valid options for every kind, so one loop can cover all 17. */
const OPTS: Record<GestureKind, object | undefined> = {
  jump: undefined,
  squat: undefined,
  clap: undefined,
  swing: undefined,
  raise: undefined,
  lean: undefined,
  step: undefined,
  reach: undefined,
  limbAngle: { a: L.LEFT_SHOULDER, b: L.LEFT_ELBOW, c: L.LEFT_WRIST, target: 180 },
  zone: { x: 0.25, y: 0.25, w: 0.5, h: 0.5, holdMs: 300 },
  holdPose: { angles: POSE_TEMPLATES.T },
  rep: { signal: () => 0, enter: 1, exit: 0.4 },
  stillness: undefined,
  balance: undefined,
  stroke: undefined,
  poseMatch: { joints: [L.LEFT_WRIST, L.RIGHT_WRIST], target: new Float32Array([-1, 0, 1, 0]) },
  jointTargets: { targets: [{ x: 0.5, y: 0.5, r: 0.1, joint: L.LEFT_WRIST }] },
};

const KINDS = Object.keys(OPTS) as GestureKind[];

describe('createGestureService', () => {
  it('rents every GestureKind in the frozen contract', () => {
    // If GestureKind grows and the switch in service.ts does not, a game gets a
    // throw at init() rather than a detector that silently never fires.
    const g = createGestureService(() => undefined);
    for (const kind of KINDS) {
      const d = g.use(kind, OPTS[kind] as never);
      expect(d.kind, kind).toBe(kind);
      expect(typeof d.read, kind).toBe('function');
      expect(typeof d.reset, kind).toBe('function');
      expect(typeof d.configure, kind).toBe('function');
    }
    expect(g.size).toBe(KINDS.length);
    expect(KINDS.length).toBe(GESTURE_KINDS_FOR_TEST.length);
  });

  it('every detector survives every clip without throwing or NaN-ing', () => {
    for (const clip of ['idle', 'reach-grid', 'hold-poses', 'far-small', 'no-legs', 'laggy'] as const) {
      const g = createGestureService(() => undefined, { w: 1280, h: 720 });
      const ds = KINDS.map((k) => g.use(k, OPTS[k] as never));
      driveClip(clip, (f) => {
        for (const d of ds) {
          const s = d.read(f) as unknown as Record<string, unknown>;
          for (const key of Object.keys(s)) {
            const v = s[key];
            if (typeof v === 'number') {
              expect(Number.isFinite(v), `${clip}/${d.kind}.${key}`).toBe(true);
            }
          }
        }
      });
    }
  });

  it('throws rather than handing back a detector that can never fire', () => {
    const g = createGestureService(() => undefined);
    // A zone with no rect, a rep with no signal, a pose with no angles and a
    // match with no target are programmer errors, not defaults.
    expect(() => g.use('zone')).toThrow();
    expect(() => g.use('rep')).toThrow();
    expect(() => g.use('holdPose')).toThrow();
    expect(() => g.use('poseMatch')).toThrow();
    expect(() => g.use('jointTargets')).toThrow();
    expect(() => g.use('limbAngle')).toThrow();
    // ...and an unknown kind is a loud failure, not a dead signal.
    expect(() => g.use('wiggle' as GestureKind)).toThrow();
  });

  it('resetAll() re-arms every rented detector — the engine on start/resume', () => {
    // A game never calls reset(). What the engine must be able to do is wipe a
    // whole round's worth of baselines, latches and cooldowns in one call: a
    // 3-second-old hip baseline carried across a pause makes the first frame
    // after "계속하기" look like a jump.
    const g = createGestureService(() => undefined);
    const jump = g.use('jump');
    const squat = g.use('squat');
    const rep = g.use('rep', { signal: (p) => p.n[L.LEFT_KNEE * 2 + 1]!, enter: 1, exit: 0.4 });

    let jumps = 0;
    driveClip('jump-x8', (f) => {
      if (jump.read(f).fired) jumps++;
    });
    expect(jumps).toBe(8);

    g.resetAll();
    // After a reset the detectors are brand new: same counts again, not
    // half-counts from a stale baseline, and no event on the very first frame.
    let again = 0;
    let firstFrameFired = false;
    let first = true;
    driveClip('jump-x8', (f) => {
      const s = jump.read(f);
      if (first) {
        firstFrameFired = s.fired;
        first = false;
      }
      if (s.fired) again++;
    });
    expect(firstFrameFired).toBe(false);
    expect(again).toBe(8);
    expect(squat.read(emptyFrame(0)).released).toBe(false);
    expect(rep.read(emptyFrame(0)).reps).toBe(0);
  });

  it('debug() reports a live value plus both thresholds for every detector', () => {
    // This is what the ?debug=1 overlay draws. Without all three numbers nobody
    // can tune a threshold or diagnose a classroom machine.
    let cur: PoseFrame | undefined;
    const g = createGestureService(() => cur, { w: 1280, h: 720 });
    for (const kind of KINDS) g.use(kind, OPTS[kind] as never);

    let rows = g.debug();
    expect(rows.length).toBe(KINDS.length);

    let sawThresholds = 0;
    driveClip('jump-x8', (f) => {
      cur = f;
      rows = g.debug();
      for (const r of rows) {
        expect(Number.isFinite(r.value), r.kind).toBe(true);
        expect(Number.isFinite(r.enter), r.kind).toBe(true);
        expect(Number.isFinite(r.exit), r.kind).toBe(true);
        expect(typeof r.unit).toBe('string');
        if (r.enter !== 0) sawThresholds++;
      }
    });
    expect(sawThresholds).toBeGreaterThan(0);
    // Ordered by rental, so the overlay's rows do not jump around.
    expect(rows.map((r) => r.kind)).toEqual(KINDS);
  });

  it('debug() cannot steal the game own event', () => {
    // The overlay reads detectors the game is also reading, possibly first.
    // read() is idempotent within a frame, so this must not consume `fired`.
    let cur: PoseFrame | undefined;
    const g = createGestureService(() => cur);
    const jump = g.use('jump');
    let fires = 0;
    driveClip('jump-x8', (f) => {
      cur = f;
      g.debug(); // overlay reads FIRST
      if (jump.read(f).fired) fires++;
    });
    expect(fires).toBe(8);
  });

  it('setView() is what makes 0..1 zone targets mean anything', () => {
    // PoseFrame carries no view size, so the engine owns this. A zone covering
    // the right half of a 1280-wide view must not still cover it at 400 wide.
    const g = createGestureService(() => undefined, { w: 1280, h: 720 });
    const z = g.use('zone', { x: 0.75, y: 0, w: 0.25, h: 1, margin: 0 });
    let insideWide = 0;
    driveClip('reach-grid', (f) => {
      if (z.read(f).inside) insideWide++;
    });
    g.resetAll();
    g.setView(400, 300);
    let insideNarrow = 0;
    driveClip('reach-grid', (f) => {
      if (z.read(f).inside) insideNarrow++;
    });
    expect(insideWide).not.toBe(insideNarrow);
  });

  it('configure() retunes a rented detector without a new rental', () => {
    const g = createGestureService(() => undefined);
    const d = g.use('clap');
    expect(g.size).toBe(1);
    d.configure({ closeAt: 0.02, minSpeed: 40 }); // effectively impossible
    let n = 0;
    driveClip('clap-x12', (f) => {
      if (d.read(f).fired) n++;
    });
    expect(n).toBe(0);
    expect(g.size).toBe(1);
  });

  it('a game that never gets a player gets no events and no crash', () => {
    const g = createGestureService(() => undefined);
    const ds = KINDS.map((k) => g.use(k, OPTS[k] as never));
    for (let i = 0; i < 120; i++) {
      for (const d of ds) {
        const s = d.read(emptyFrame(i / 60)) as unknown as Record<string, unknown>;
        expect(s.ok, d.kind).toBe(false);
        for (const flag of ['fired', 'entered', 'released', 'done', 'justCounted']) {
          if (flag in s) expect(s[flag], `${d.kind}.${flag}`).toBe(false);
        }
      }
    }
  });

  it('allocates nothing in read() — the same objects, forever', () => {
    // Games call read() 60 times a second for a whole afternoon, so every
    // signal and every array inside it must be allocated once in the
    // constructor and mutated thereafter. Identity is the precise test;
    // measuring the heap would be flaky.
    const g = createGestureService(() => undefined, { w: 1280, h: 720 });
    const ds = KINDS.map((k) => g.use(k, OPTS[k] as never));
    const firstSignal = new Map<GestureKind, unknown>();
    const firstArrays = new Map<string, unknown>();
    let reads = 0;

    driveClip('reach-grid', (f) => {
      for (const d of ds) {
        const s = d.read(f) as unknown as Record<string, unknown>;
        if (!firstSignal.has(d.kind)) firstSignal.set(d.kind, s);
        // The signal object itself is reused.
        expect(s, d.kind).toBe(firstSignal.get(d.kind));
        // So is every typed array and Pt inside it.
        for (const key of Object.keys(s)) {
          const v = s[key];
          if (typeof v !== 'object' || v === null) continue;
          const id = `${d.kind}.${key}`;
          if (!firstArrays.has(id)) firstArrays.set(id, v);
          expect(v, id).toBe(firstArrays.get(id));
        }
      }
      reads++;
    });

    expect(reads).toBeGreaterThan(900);
    // Sanity: the identity check is only meaningful if there was something to
    // check — typed arrays and Pts across the 17 signals.
    expect(firstArrays.size).toBeGreaterThan(8);

    // Deliberately NOT a heap-size assertion. Measuring `heapUsed` across a
    // drive reports when V8 happened to collect, not what this layer
    // allocated: the same probe produced -6900KB for `clap` and +1200KB for
    // `stillness` on consecutive runs, and the no-detector baseline alone is
    // 529KB (the harness builds a fresh PoseNormalizer with 66 One Euro
    // filters per drive). The identity assertions above are exact, and the hot
    // paths carry no for-of, array method, Object.keys, template literal or
    // `new` — every typed array in this folder is allocated in a constructor.
  });

  it('watches only its own slot', () => {
    const g = createGestureService(() => undefined);
    const slot0 = g.use('jump', { slot: 0 });
    const slot1 = g.use('jump', { slot: 1 });
    let a = 0;
    let b = 0;
    driveClip('jump-x8', (f) => {
      if (slot0.read(f).fired) a++;
      if (slot1.read(f).fired) b++;
    });
    expect(a).toBe(8);
    expect(b).toBe(0); // there is no player 1 in these clips
  });
});

function emptyFrame(t: number): PoseFrame {
  return { t, inferenceAgeMs: 0, fps: 25, players: [], byId: new Map(), p1: undefined };
}

// ══ FROZEN CONTRACT ══ the named clip corpus every game is smoke-tested on.
//
// All synthetic, all deterministic, all generated at import time (~5ms total).
// No recorded human data exists in this repo, which is both a privacy position
// and the reason a new game can be tested the moment it is written.
import {
  armAt, armsAt, buildClip, clapAt, hipAt, kneeUp, leanBy, mergeClips, osc, squatBy, STAND,
  type BodyParams, type PoseClip,
} from './synth';
import { clamp01, lerp } from '../math';

export type ClipName =
  | 'idle' | 'fidget' | 'reach-grid'
  | 'jump-x8' | 'squat-x8' | 'clap-x12' | 'swing-wide'
  | 'step-lr' | 'knee-run' | 'hold-poses'
  | 'two-cross' | 'far-small' | 'no-legs' | 'laggy';

/** One jump arc: hips rise then fall, ankles leave the floor. */
function jumpArc(phase: number): Partial<BodyParams> {
  const up = Math.sin(clamp01(phase) * Math.PI);
  return {
    hipY: STAND.hipY - 0.13 * up,
    kneeL: 3 + 30 * up, kneeR: 3 + 30 * up,
    armL: lerp(-78, -30, up), armR: lerp(-102, -150, up),
  };
}

const CLIPS: Record<ClipName, () => PoseClip> = {
  /** Standing still with only sensor noise. The false-positive floor: every
   *  game must score near zero here or it is awarding points for nothing. */
  idle: () => buildClip('idle', 12, () => ({}), { seed: 11 }),

  /** Scratching, shifting weight, small arm drift. Children cannot hold still,
   *  so this is the realistic "not playing" baseline, not `idle`. */
  fidget: () =>
    buildClip('fidget', 12, (_u, t) => ({
      hipX: 0.5 + 0.012 * Math.sin(t * 1.3),
      leanDeg: 3 * Math.sin(t * 0.7),
      armL: -78 + 14 * Math.sin(t * 1.9),
      armR: -102 - 11 * Math.sin(t * 1.4 + 1),
      elbowL: 8 + 18 * osc(t, 0.3),
    }), { seed: 12, jitter: 0.005 }),

  /**
   * Both hands raster-sweep the entire frame.
   *
   * The highest-value clip in the corpus: it guarantees a hand passes through
   * every region of the screen, so ~25 reach/catch/aim/zone games get a
   * reachability test — "can the player actually touch my targets?" — for free.
   */
  'reach-grid': () =>
    buildClip('reach-grid', 40, (u) => {
      const rows = 5;
      const row = Math.min(rows - 1, Math.floor(u * rows));
      const within = u * rows - row;
      const sweep = row % 2 === 0 ? within : 1 - within;
      // Arm elevation walks top-to-bottom; sweep drives left-to-right.
      const elev = lerp(100, -60, row / (rows - 1));
      return {
        armL: elev, armR: 180 - elev,
        elbowL: lerp(70, 0, sweep), elbowR: lerp(0, 70, sweep),
        leanDeg: lerp(-12, 12, sweep),
        hipX: lerp(0.42, 0.58, sweep),
      };
    }, { seed: 13 }),

  /** 8 jumps of varied height, with landings in between. */
  'jump-x8': () =>
    buildClip('jump-x8', 16, (_u, t) => {
      const period = 2;
      const ph = (t % period) / period;
      if (ph > 0.45) return {}; // grounded between jumps
      const n = Math.floor(t / period);
      const scale = 0.6 + 0.4 * ((n % 3) / 2);
      const a = jumpArc(ph / 0.45);
      return { ...a, hipY: STAND.hipY - (STAND.hipY - (a.hipY ?? STAND.hipY)) * scale };
    }, { seed: 14 }),

  /** 8 squats of varied depth. */
  'squat-x8': () =>
    buildClip('squat-x8', 18, (_u, t) => {
      const period = 2.2;
      const ph = (t % period) / period;
      const n = Math.floor(t / period);
      const depth = ph < 0.6 ? Math.sin((ph / 0.6) * Math.PI) : 0;
      return squatBy(depth * (0.65 + 0.35 * ((n % 3) / 2)));
    }, { seed: 15 }),

  /** 12 claps at varied height and speed. */
  'clap-x12': () =>
    buildClip('clap-x12', 18, (_u, t) => {
      const period = 1.4;
      const ph = (t % period) / period;
      const n = Math.floor(t / period);
      // Closed briefly at the top of each cycle; open the rest of the time so
      // the detector's re-arm path is exercised every single clap.
      const close = ph < 0.3 ? Math.sin((ph / 0.3) * Math.PI) : 0;
      const base = clapAt(close);
      const lift = (n % 3) * 26; // chest / face / overhead
      return { ...base, armL: (base.armL ?? 0) + lift, armR: (base.armR ?? 0) - lift };
    }, { seed: 16 }),

  /** Big fast arm swings in both directions — for slice and swat games. */
  'swing-wide': () =>
    buildClip('swing-wide', 16, (_u, t) => {
      const a = Math.sin(t * 3.1) * 110;
      return { armL: 20 + a, armR: 160 - a, elbowL: 2, elbowR: 2, leanDeg: a * 0.08 };
    }, { seed: 17, jitter: 0.004 }),

  /** Stepping and leaning left-right, feet in and out. */
  'step-lr': () =>
    buildClip('step-lr', 20, (_u, t) => {
      const s = Math.sin(t * 0.8);
      return {
        hipX: 0.5 + 0.17 * s,
        leanDeg: 15 * s,
        legL: -84 + 9 * s, legR: -96 + 9 * s,
      };
    }, { seed: 18 }),

  /** Running in place: alternating knee lifts. Also covers pedal and stairs. */
  'knee-run': () =>
    buildClip('knee-run', 18, (_u, t) => {
      const a = osc(t, 2.2);
      const b = osc(t, 2.2, 0.5);
      return {
        ...kneeUp('L', a), ...kneeUp('R', b),
        armL: -78 + 40 * b, armR: -102 - 40 * a,
        hipY: STAND.hipY - 0.012 * Math.abs(Math.sin(t * 2.2 * Math.PI)),
      };
    }, { seed: 19 }),

  /** T / Y / one-leg / arms-forward, each held ~3s with clean transitions. */
  'hold-poses': () =>
    buildClip('hold-poses', 24, (u) => {
      const poses: Partial<BodyParams>[] = [
        armsAt(0),                                   // T
        armsAt(45),                                  // Y
        armsAt(90),                                  // overhead
        { ...armsAt(0), footLiftL: 1, legR: -90 },   // one leg
        armAt('L', 60),                              // asymmetric
        { ...armsAt(10), leanDeg: 18 },              // leaning
      ];
      const seg = Math.min(poses.length - 1, Math.floor(u * poses.length));
      const within = u * poses.length - seg;
      const cur = poses[seg]!;
      // 25% transition, 75% hold — a hold detector needs a settled signal.
      if (within > 0.25 || seg === 0) return cur;
      const prev = poses[seg - 1]!;
      const k = within / 0.25;
      const out: Partial<BodyParams> = {};
      for (const key of new Set([...Object.keys(prev), ...Object.keys(cur)])) {
        const kk = key as keyof BodyParams;
        out[kk] = lerp(prev[kk] ?? STAND[kk], cur[kk] ?? STAND[kk], k);
      }
      return out;
    }, { seed: 20 }),

  /** Two people walking through each other. Detection order flips at the
   *  crossing; the engine's tracker must keep slots stable anyway. */
  'two-cross': () =>
    mergeClips(
      'two-cross',
      buildClip('p1', 14, (_u, t) => ({
        hipX: 0.3 + 0.4 * osc(t, 0.14), shoulderW: 0.14, armL: -60, armR: -120,
      }), { seed: 21 }),
      buildClip('p2', 14, (_u, t) => ({
        hipX: 0.7 - 0.4 * osc(t, 0.14), shoulderW: 0.13, armL: -90, armR: -95,
      }), { seed: 22 }),
    ),

  /** Same motions, 4m away: shoulder width ~0.07. Any game with a hard-coded
   *  pixel threshold fails here, which is the whole reason it exists. */
  'far-small': () =>
    buildClip('far-small', 16, (_u, t) => ({
      shoulderW: 0.075,
      hipY: 0.5,
      armL: 20 + 70 * Math.sin(t * 2),
      armR: 160 - 70 * Math.sin(t * 2),
      ...(t % 3 < 0.5 ? jumpArc((t % 3) / 0.5) : {}),
    }), { seed: 23, jitter: 0.004 }),

  /** Standing close to a laptop: legs and feet never visible. Games that need
   *  them must degrade, not crash. */
  'no-legs': () =>
    buildClip('no-legs', 14, (_u, t) => ({
      shoulderW: 0.26, hipY: 0.95,
      armL: 20 + 80 * Math.sin(t * 2.4), armR: 160 - 80 * Math.sin(t * 2.4),
    }), { seed: 24, hideLegs: true }),

  /** 10fps with heavy dropout: the locked-down school Chromebook. */
  laggy: () =>
    buildClip('laggy', 14, (_u, t) => ({
      armL: 20 + 90 * Math.sin(t * 2), armR: 160 - 90 * Math.sin(t * 2),
      ...(t % 2.5 < 0.45 ? jumpArc((t % 2.5) / 0.45) : {}),
    }), { seed: 25, fps: 10, jitter: 0.008, dropout: 0.12, frameDrop: 0.06 }),
};

const built = new Map<ClipName, PoseClip>();

export function clip(name: ClipName): PoseClip {
  let c = built.get(name);
  if (!c) {
    const make = CLIPS[name];
    if (!make) throw new Error(`[clips] unknown clip "${name}"`);
    c = make();
    built.set(name, c);
  }
  return c;
}

export const CLIP_NAMES = Object.keys(CLIPS) as ClipName[];

/** The set every game is smoke-tested against. Deliberately small so the whole
 *  suite stays under a minute and can be an author's pre-handback gate. */
export const SMOKE_CLIPS: readonly ClipName[] = [
  'idle', 'fidget', 'reach-grid', 'jump-x8', 'clap-x12', 'far-small', 'no-legs', 'laggy',
];

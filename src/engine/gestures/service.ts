// createGestureService() — the use() registry, plus the two things the ENGINE
// owns and games must never touch.
//
// 1. RESETS. A game never calls reset(). The engine calls resetAll() on start()
//    and on resume(), because every detector in this folder is a state machine
//    with a baseline, a latch and a cooldown: carrying a 3-second-old baseline
//    across a pause means the first frame after "계속하기" looks like a jump.
//    Making this engine-owned is the whole reason detectors are rented in
//    init() rather than constructed per frame (gestures/index.ts § header).
//
// 2. THE DEBUG REGISTRY. `?debug=1` draws every rented detector's raw value
//    with its enter/exit lines, which is the only way anybody tunes a threshold
//    or diagnoses a classroom Chromebook. That needs an enumerable list of
//    live detectors, which only the service can hold.
import type {
  Detector,
  GestureKind,
  GestureOpts,
  GestureService,
  PoseFrame,
} from '../types';
import {
  ClapDetector,
  JumpDetector,
  LeanDetector,
  LimbAngleDetector,
  RaiseDetector,
  ReachDetector,
  SquatDetector,
  StepDetector,
  SwingDetector,
  type ViewRef,
  ZoneDetector,
} from './detectors';
import { BalanceDetector } from './balance';
import { HoldPoseDetector } from './holds';
import { RepDetector } from './reps';
import { StillnessDetector } from './stillness';
import { StrokeDetector } from './stroke';
import { JointTargetsDetector, PoseMatchDetector } from './similarity';
import { DetectorBase, type GestureDebug } from './trigger';
import type { HoldPoseOpts, JointTargetsOpts, LimbAngleOpts, PoseMatchOpts, RepOpts, ZoneOpts } from './index';

/** The engine-side face of the service. Games only ever see `GestureService`,
 *  which is `use()` and nothing else. */
export interface GestureServiceInternal extends GestureService {
  /** Re-arm every rented detector. Engine-only: call on start() and resume(). */
  resetAll(): void;
  /** Live debug rows for the ?debug=1 overlay, newest rental last. Reads the
   *  current frame so a detector the game stopped reading still shows a live
   *  value; safe to call in any order relative to the game because read() is
   *  idempotent within a frame. */
  debug(): readonly GestureDebug[];
  /** How many detectors are rented — a leak check for the harness: a game that
   *  rents in update() instead of init() shows up here as a climbing number. */
  readonly size: number;
  /** The view rect zone/jointTargets measure their 0..1 fractions against.
   *  Call on resize. */
  setView(w: number, h: number): void;
  dispose(): void;
}

/**
 * @param getFrame the current PoseFrame, for priming the debug rows. May return
 *        undefined before the first inference.
 * @param view the live view rect. `zone` and `jointTargets` take their targets
 *        in 0..1 view fractions but `PoseFrame` carries no view size, so the
 *        engine must pass this and keep it current. Defaults to 1280x720, which
 *        is right only by accident — wire it.
 */
export function createGestureService(
  getFrame: () => PoseFrame | undefined,
  view?: ViewRef,
): GestureServiceInternal {
  const rented: DetectorBase<GestureKind>[] = [];
  const rows: GestureDebug[] = [];
  const viewRef: ViewRef = view ?? { w: 1280, h: 720 };

  function make<K extends GestureKind>(kind: K, opts?: GestureOpts[K]): Detector<K> {
    let d: DetectorBase<GestureKind>;
    switch (kind) {
      case 'jump':
        d = new JumpDetector(opts as GestureOpts['jump']);
        break;
      case 'squat':
        d = new SquatDetector(opts as GestureOpts['squat']);
        break;
      case 'clap':
        d = new ClapDetector(opts as GestureOpts['clap']);
        break;
      case 'swing':
        d = new SwingDetector(opts as GestureOpts['swing']);
        break;
      case 'raise':
        d = new RaiseDetector(opts as GestureOpts['raise']);
        break;
      case 'lean':
        d = new LeanDetector(opts as GestureOpts['lean']);
        break;
      case 'step':
        d = new StepDetector(opts as GestureOpts['step']);
        break;
      case 'reach':
        d = new ReachDetector(opts as GestureOpts['reach']);
        break;
      case 'limbAngle':
        d = new LimbAngleDetector(requireOpts(kind, opts) as LimbAngleOpts);
        break;
      case 'zone':
        d = new ZoneDetector(requireOpts(kind, opts) as ZoneOpts, viewRef);
        break;
      case 'holdPose':
        d = new HoldPoseDetector(requireOpts(kind, opts) as HoldPoseOpts);
        break;
      case 'rep':
        d = new RepDetector(requireOpts(kind, opts) as RepOpts);
        break;
      case 'stillness':
        d = new StillnessDetector(opts as GestureOpts['stillness']);
        break;
      case 'balance':
        d = new BalanceDetector(opts as GestureOpts['balance']);
        break;
      case 'stroke':
        d = new StrokeDetector(opts as GestureOpts['stroke']);
        break;
      case 'poseMatch':
        d = new PoseMatchDetector(requireOpts(kind, opts) as PoseMatchOpts);
        break;
      case 'jointTargets':
        d = new JointTargetsDetector(requireOpts(kind, opts) as JointTargetsOpts, viewRef);
        break;
      default:
        // Unreachable while GestureKind and this switch agree. Throwing beats
        // handing a game a detector that silently never fires.
        throw new Error(`[gestures] unknown gesture kind "${String(kind)}"`);
    }
    rented.push(d);
    return d as unknown as Detector<K>;
  }

  return {
    use<K extends GestureKind>(kind: K, opts?: GestureOpts[K]): Detector<K> {
      return make(kind, opts);
    },

    resetAll(): void {
      for (let i = 0; i < rented.length; i++) rented[i]!.reset();
    },

    debug(): readonly GestureDebug[] {
      const f = getFrame();
      rows.length = 0;
      for (let i = 0; i < rented.length; i++) {
        const d = rented[i]!;
        // Idempotent within a frame, so this cannot consume the game's event.
        if (f !== undefined) d.read(f);
        rows.push(d.debug());
      }
      return rows;
    },

    get size(): number {
      return rented.length;
    },

    setView(w: number, h: number): void {
      if (w > 0) viewRef.w = w;
      if (h > 0) viewRef.h = h;
    },

    dispose(): void {
      rented.length = 0;
      rows.length = 0;
    },
  };
}

/**
 * Every kind this service can construct, in the order `GestureKind` declares
 * them. Exported for the test that fails if `GestureKind` grows and the switch
 * above does not — the failure mode otherwise is a game throwing at init(), or
 * worse, a detector that silently never fires.
 */
export const GESTURE_KINDS_FOR_TEST: readonly GestureKind[] = [
  'jump', 'squat', 'clap', 'swing', 'raise', 'lean', 'step', 'reach',
  'limbAngle', 'zone', 'holdPose', 'rep', 'stillness', 'balance', 'stroke',
  'poseMatch', 'jointTargets',
];

/** These four kinds have no sane default — a zone with no rect, a rep with no
 *  signal, a pose with no angles and a match with no target are all programmer
 *  errors that would otherwise look like a dead game. */
function requireOpts<K extends GestureKind>(kind: K, opts: GestureOpts[K] | undefined): GestureOpts[K] {
  if (opts === undefined) {
    throw new Error(`[gestures] use('${String(kind)}') requires options`);
  }
  return opts;
}

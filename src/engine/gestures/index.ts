// ══ FROZEN CONTRACT ══ imported by 58 game modules.
//
// Detectors are RENTED IN init() and READ IN update(). Zero allocation per frame.
//
//   init():   this.jump = ctx.gestures.use('jump');
//   update(): const j = this.jump.read(frame); if (j.fired) { ... }
//
// Why rent-in-init rather than `ctx.gestures.jump(frame)` per frame: a detector
// is a state machine (baseline, hysteresis, cooldown, re-arm). A per-frame call
// would either leak one machine per frame or need call-site keying. Renting
// makes the lifetime explicit, lets the ENGINE own resets (on start, on resume,
// on player change), and makes "never allocate in update()" reviewable.
//
// A game NEVER calls reset(). The engine does.
import type { GestureKind, PlayerPose, PoseFrame, Pt, Slot } from '../types';
import type { Joint, Side } from '../pose/landmarks';

// ─── Options, per kind ───────────────────────────────────────────────────────

/** Shared by every detector. */
export interface BaseOpts {
  /** Which player to watch. Defaults to slot 0. */
  slot?: Slot;
  /** Minimum ms between two fires. Protects against a single twitch scoring
   *  twice. The engine enforces a 250ms floor on scoring gestures. */
  cooldownMs?: number;
  /** Consecutive frames the condition must hold before firing. 2 removes
   *  single-frame landmark noise at the cost of ~30-60ms. Default 2. */
  confirmFrames?: number;
}

/** Hysteresis pair. `enter` arms the event, `exit` re-arms the detector.
 *  A single threshold produces flicker; this is non-negotiable. */
export interface HysteresisOpts {
  enter?: number;
  exit?: number;
}

export interface JumpOpts extends BaseOpts, HysteresisOpts {
  /** Upward hip velocity, in shoulder-widths/sec, that counts as takeoff.
   *  Default 1.5. The attract screen uses 1.9 — a false start is more
   *  annoying than a missed one.
   *
   *  Velocity ALONE is not a jump: measured peaks of 1.7-2.7 sw/s occur while
   *  standing still, stepping, running in place and standing up out of a
   *  squat. The detector also requires a real hip RISE (~0.17 sw), which none
   *  of those exceed. Lowering that height gate reinstates phantom jumps in
   *  every running game. */
  enter?: number;
  /** Hip must return to within this many shoulder-widths of baseline to
   *  re-arm. Default 0.12 — just above the idle/fidget rise floor. */
  exit?: number;
  /** Require ankles visible. False for laptop users, whose feet are cropped. */
  requireFeetVisible?: boolean;
}

export interface SquatOpts extends BaseOpts, HysteresisOpts {
  /** Hip drop below baseline, in shoulder-widths, to enter. Default 0.32.
   *  A child squatting to 0.45 is filtered to ~0.37-0.43 by the time it
   *  reaches here, so 0.45 would miss a third of real squats; 0.32 is still
   *  2.4x the fidget floor. */
  enter?: number;
  /** Must rise back above this to exit. Default 0.16 (~half of enter). */
  exit?: number;
}

export interface ClapOpts extends BaseOpts {
  /** Wrist separation, in shoulder-widths, that counts as closed. Default 0.42.
   *  Nothing else in the corpus gets closer than 0.78. */
  closeAt?: number;
  /** Must separate past this to re-arm. Default 0.55 — a third of real
   *  consecutive claps only reopen to 0.60-0.63, so a higher gate silently
   *  drops a third of every clapping score. */
  openAt?: number;
  /** Minimum closing speed, shoulder-widths/sec, so slowly folded hands do not
   *  register. Default 1.2; real closures run 2.5-16. */
  minSpeed?: number;
}

export interface SwingOpts extends BaseOpts {
  side?: Side | 'both';
  /** Minimum WRIST speed in shoulder-widths/sec. Default 3.5.
   *  Measured at the wrist, not the palm: `palm()`'s 1.4x finger extrapolation
   *  multiplies the noisiest landmarks, and a resting hand reads 3.2 sw/s at
   *  the palm against 1.6 at the wrist. */
  minSpeed?: number;
}

export interface RaiseOpts extends BaseOpts {
  side?: Side | 'both' | 'either';
  /** How far above the shoulder the wrist must be, in shoulder-widths.
   *  Shoulder-relative (not nose-relative) so short children and tall adults
   *  behave identically. Default 0.25. */
  above?: number;
}

export interface LeanOpts extends BaseOpts, HysteresisOpts {
  /** Shoulder-centre offset from hip-centre, shoulder-widths. Default 0.30. */
  enter?: number;
  exit?: number;
}

export interface StepOpts extends BaseOpts, HysteresisOpts {
  /** Whole-body translation from a slow-moving baseline. Default 0.55. */
  enter?: number;
  exit?: number;
  /** Discrete lanes to quantize into. 3 = left/centre/right. Default 3. */
  lanes?: number;
}

export interface ReachOpts extends BaseOpts {
  side?: Side | 'both';
}

export interface LimbAngleOpts extends BaseOpts {
  /** The three joints; the angle is measured at `b`. */
  a: Joint;
  b: Joint;
  c: Joint;
  /** Optional target for `matched`/`error`. Degrees. */
  target?: number;
  tolDeg?: number;
}

export interface ZoneOpts extends BaseOpts {
  /** Zone rect in 0..1 fractions of the view. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Which joints count as "in". Default: both palms. */
  joints?: readonly Joint[];
  /** Require this many ms inside before `held` goes true. The dwell gauge in
   *  the HUD reads `dwellMs / holdMs`. Default 0. */
  holdMs?: number;
  /** Dead-zone margin, 0..1 of the zone size, to stop boundary flicker.
   *  Default 0.12. */
  margin?: number;
}

export interface HoldPoseOpts extends BaseOpts {
  /** Target joint angles in degrees, keyed by the joint the angle is measured
   *  at. Angle-based, so the match is independent of height, build and
   *  distance from the camera — the fairest comparison available. */
  angles: Partial<Record<Joint, number>>;
  /** Mean absolute angle error, degrees, that counts as "in pose". Default 22. */
  tolDeg?: number;
  /** ms the pose must be held for `done`. Default 800. */
  holdMs?: number;
}

export interface RepOpts extends BaseOpts, HysteresisOpts {
  /** The scalar to count cycles of. Must be in normalized units. */
  signal: (p: PlayerPose) => number;
  /** Counts on the UP edge only — counting both edges double-counts. */
  enter?: number;
  exit?: number;
  /** Joints that must be visible, else the counter holds. */
  needs?: readonly Joint[];
}

export interface StillnessOpts extends BaseOpts {
  /** Multiple of the player's OWN calibrated `idleEnergy` that counts as
   *  moving. This is the single most important fairness decision in the freeze
   *  games: children cannot hold still, and a global constant fails the
   *  fidgety ones while flattering the still ones. Default 2.5 — at 3.0 the
   *  limit lands on the energy of running in place, and a child sprinting
   *  reads as frozen. */
  factor?: number;
  /** Averaging window in ms. Default 200. */
  windowMs?: number;
}

export interface BalanceOpts extends BaseOpts {
  /** Which foot should be lifted, or 'either'. */
  foot?: Side | 'either';
  /** Lift height of the ankle above the other, shoulder-widths. Default 0.35. */
  liftAt?: number;
}

export interface StrokeOpts extends BaseOpts {
  side?: Side;
  /** Max points retained in the trail. Default 64. */
  maxPoints?: number;
  /** Drop points closer than this (shoulder-widths) to the previous one. */
  minStep?: number;
}

export interface PoseMatchOpts extends BaseOpts {
  /** Target pose as normalized [x,y] pairs for the joints in `joints`. */
  target: Float32Array;
  joints: readonly Joint[];
  /** Weight per joint; defaults to visibility. De-weight the face, up-weight
   *  wrists. */
  weights?: Float32Array;
  /** Score as a 1-second rolling best, so a single lucky frame cannot win. */
  rollingMs?: number;
}

export interface JointTargetsOpts extends BaseOpts {
  /** Targets in 0..1 view fractions, each to be covered by a specific joint. */
  targets: readonly { x: number; y: number; r: number; joint: Joint }[];
  /** ms all targets must be covered simultaneously for `done`. Default 1200. */
  holdMs?: number;
}

export interface GestureOpts {
  jump: JumpOpts;
  squat: SquatOpts;
  clap: ClapOpts;
  swing: SwingOpts;
  raise: RaiseOpts;
  lean: LeanOpts;
  step: StepOpts;
  reach: ReachOpts;
  limbAngle: LimbAngleOpts;
  zone: ZoneOpts;
  holdPose: HoldPoseOpts;
  rep: RepOpts;
  stillness: StillnessOpts;
  balance: BalanceOpts;
  stroke: StrokeOpts;
  poseMatch: PoseMatchOpts;
  jointTargets: JointTargetsOpts;
}

// ─── Signals ─────────────────────────────────────────────────────────────────
//
// Every signal object is REUSED across frames. Read what you need and move on;
// do not retain a reference expecting last frame's values.

/** `fired` is true for exactly one frame per gesture. */
export interface JumpSignal {
  fired: boolean;
  /** 0..1 relative to a big jump for this player. */
  power: number;
  airborne: boolean;
  /** Current hip height above baseline, shoulder-widths. */
  height: number;
  ok: boolean;
}

export interface SquatSignal {
  down: boolean;
  /** True for one frame on the way down. */
  entered: boolean;
  /** True for one frame on the way back up; this is where you count a rep. */
  released: boolean;
  depth: number;
  ok: boolean;
}

export interface ClapSignal {
  fired: boolean;
  /** Midpoint of the two palms in view px, at the moment of the clap. */
  at: Pt;
  /** Closing speed, shoulder-widths/sec. Scales the hit effect. */
  power: number;
  ok: boolean;
}

export interface SwingSignal {
  /** True while moving faster than `minSpeed`. */
  active: boolean;
  side: Side;
  /** Palm position this frame and last, view px. Feed both to hitSegCircle. */
  from: Pt;
  to: Pt;
  speed: number;
  /** Direction of travel in degrees; 0 = right, 90 = up. */
  dirDeg: number;
  ok: boolean;
}

export interface RaiseSignal {
  left: boolean;
  right: boolean;
  both: boolean;
  /** True for one frame when the chosen condition becomes true. */
  entered: boolean;
  ok: boolean;
}

export interface LeanSignal {
  /** Continuous -1..1, for steering. */
  value: number;
  /** Hysteresis-stabilized discrete direction. */
  dir: -1 | 0 | 1;
  changed: boolean;
  ok: boolean;
}

export interface StepSignal {
  value: number;
  lane: number;
  changed: boolean;
  ok: boolean;
}

export interface ReachSignal {
  /** Palm positions in view px. */
  leftPalm: Pt;
  rightPalm: Pt;
  /** Palm speeds in view px/sec — use to speed-gate hits. */
  leftSpeed: number;
  rightSpeed: number;
  /** Extension 0..1+ relative to this player's own arm length, so a shorter
   *  child reaching their limit scores the same as a taller one. */
  leftExtend: number;
  rightExtend: number;
  ok: boolean;
}

export interface LimbAngleSignal {
  deg: number;
  matched: boolean;
  /** Absolute error from `target` in degrees. */
  error: number;
  ok: boolean;
}

export interface ZoneSignal {
  inside: boolean;
  entered: boolean;
  exited: boolean;
  dwellMs: number;
  /** 0..1 progress toward holdMs. Render this as a ring; it is the only way a
   *  player knows a selection is in progress. */
  progress: number;
  held: boolean;
  ok: boolean;
}

export interface HoldSignal {
  inPose: boolean;
  /** 0..1 toward holdMs. */
  progress: number;
  /** True for one frame when the hold completes. */
  done: boolean;
  /** Mean absolute angle error, degrees. */
  error: number;
  /** 0..1 per-joint correctness, parallel to the keys of `angles`. Render this:
   *  partial-success feedback is what makes pose games feel fair. */
  perJoint: Float32Array;
  ok: boolean;
}

export interface RepSignal {
  reps: number;
  /** 0..1 within the current cycle. */
  phase: number;
  justCounted: boolean;
  /** Cycles per second, smoothed. Drives run/pedal/swim speed. */
  rate: number;
  ok: boolean;
}

export interface StillnessSignal {
  /** Motion energy: the MEAN per-joint speed over the tracked joints, in
   *  shoulder-widths/sec. A mean, not a sum — a sum is 13x larger and makes
   *  `CalibrationProfile.idleEnergy` meaningless to compare against.
   *  Import `ENERGY_JOINTS`/`motionEnergy` from `pose/calibration` rather than
   *  redefining energy, or the two will drift apart. */
  energy: number;
  still: boolean;
  /** 0..1 where 1 = perfectly still relative to this player's own baseline. */
  quality: number;
  ok: boolean;
}

export interface BalanceSignal {
  onOneFoot: boolean;
  liftedFoot: Side | null;
  /** Lateral sway (std-dev of shoulder centre). Lower is better. */
  sway: number;
  /** 0..1, 1 = rock steady. */
  quality: number;
  heldMs: number;
  ok: boolean;
}

export interface StrokeSignal {
  /** Flat [x,y,...] trail in view px, oldest first. */
  points: Float32Array;
  count: number;
  drawing: boolean;
  ok: boolean;
}

export interface PoseMatchSignal {
  /** 0..1, 1 = identical. Cosine similarity over the normalized joint vector. */
  score: number;
  /** Best score within the rolling window. */
  best: number;
  perJoint: Float32Array;
  ok: boolean;
}

export interface JointTargetsSignal {
  /** Parallel to `targets`: is each one currently covered? */
  covered: Uint8Array;
  coveredCount: number;
  all: boolean;
  progress: number;
  done: boolean;
  ok: boolean;
}

export interface SignalMap {
  jump: JumpSignal;
  squat: SquatSignal;
  clap: ClapSignal;
  swing: SwingSignal;
  raise: RaiseSignal;
  lean: LeanSignal;
  step: StepSignal;
  reach: ReachSignal;
  limbAngle: LimbAngleSignal;
  zone: ZoneSignal;
  holdPose: HoldSignal;
  rep: RepSignal;
  stillness: StillnessSignal;
  balance: BalanceSignal;
  stroke: StrokeSignal;
  poseMatch: PoseMatchSignal;
  jointTargets: JointTargetsSignal;
}

export type SignalOf<K extends GestureKind> = SignalMap[K];

/** `ok` is false when the landmarks this detector needs are not visible.
 *  When ok is false the other fields hold their last good values and no event
 *  fires: we GATE rather than guess. */
export interface Detector<K extends GestureKind> {
  readonly kind: K;
  read(f: PoseFrame): SignalOf<K>;
  /** Engine-only. Games must not call this. */
  reset(): void;
  /** Engine-only: retune between rounds without re-renting. */
  configure(o: Partial<GestureOpts[K]>): void;
}

export interface GestureService {
  /** Rent a detector. Call only from init(). */
  use<K extends GestureKind>(kind: K, opts?: GestureOpts[K]): Detector<K>;
}

// VirtualPoseSource — keyboard / mouse / gamepad, as a body.
//
// This is the whole keyboard-accessibility story for the catalogue, and it is
// implemented ONCE, here, at the pose layer. It synthesizes a complete
// PoseFrame: the same 33 normalized landmarks, with velocities CONSISTENT with
// those positions, pushed through the same normalize -> median -> One Euro ->
// extrapolate path as the camera. So every gesture detector fires exactly as it
// does for a real body: no detector changes, no game changes, and no game
// anywhere branches on input source.
//
// Velocity consistency is the part that is easy to get wrong and expensive to
// get wrong. If you teleport a wrist to the cursor, a swing detector sees
// 40 shoulder-widths/sec and a clap detector sees an impossible closing speed.
// Every control here moves the body along a plausible arc at a plausible speed,
// at a simulated 30Hz "inference" rate, and lets the real filter bank compute
// the derivatives.
//
// Bindings (and the mirror reasoning, which matters):
//   Space       jump — hip impulse plus a ~450ms arc
//   ArrowDown   squat
//   Arrow Left/Right  lean + step (both, so lean and step games both work)
//   Z / X       raise the hand that appears on screen-LEFT / screen-RIGHT.
//               In a mirrored preview the player's own left hand appears on the
//               left of the screen, so Z raises LEFT_WRIST. Z is the left-hand
//               key on the keyboard; that correspondence is the point.
//   C           clap — both hands converge on the cursor over ~150ms
//   mouse/touch drives the dominant hand, by two-link IK, so the palm really
//               lands where the cursor is
//   Gamepad     A jump, B squat, LB/RB hands, X clap, left stick body
import type { CalibrationProfile, PoseFrame } from '../types';
import { STAND, body, type BodyParams } from '../testing/synth';
import { DEG, approach, clamp, lerp } from '../math';
import { L, LANDMARK_COUNT } from './landmarks';
import { CalibrationCapture } from './calibration';
import { MAX_EXTRAPOLATE_SEC } from './frame';
import { PoseIdentity } from './identity';
import type { OneEuroConfig } from './oneEuro';
import { defaultCalibration, type PoseSource, type PoseSourceInfo } from './source';

const D2R = Math.PI / 180;

/** Simulated inference rate. Deliberately NOT 60Hz: a keyboard player must
 *  exercise the same extrapolation path as a camera player, or the virtual
 *  source stops being a test of what ships. */
export const VIRTUAL_HZ = 30;

/**
 * Framing of the synthetic body — and it is NOT synth.ts's STAND.
 *
 * STAND is shoulderW 0.17 at hipY 0.62, which is a ~2m laptop shot: measured
 * on the real skeleton, its ankles sit at image y 1.27 and its nose at 0.02, so
 * the feet are outside the frame and the head leaves it during a jump. A
 * keyboard player must be a WHOLE body or every legs-and-feet game is
 * unplayable without a camera, which is most of the point of this file.
 *
 * shoulderW 0.10 at hipY 0.58 (~3m, full-body framing) puts the nose at 0.23,
 * the ankles at 0.97 and an overhead wrist at 0.05 — everything inside the
 * frame, in every pose this source can produce.
 */
export const VIRTUAL_BODY = { shoulderW: 0.1, hipY: 0.58 } as const;

/** Arm link lengths in shoulder-width units, measured from the frozen skeleton
 *  itself rather than hardcoded, so the IK can never drift away from it.
 *  (Comes out as 0.85 / 0.78.) */
const ARM = (() => {
  const lm = body({ shoulderW: 1, hipX: 0, hipY: 0, armL: 0, elbowL: 0 }, 1);
  const dist = (a: number, b: number): number =>
    Math.hypot(lm[a * 2]! - lm[b * 2]!, lm[a * 2 + 1]! - lm[b * 2 + 1]!);
  return {
    upper: dist(L.LEFT_SHOULDER, L.LEFT_ELBOW),
    fore: dist(L.LEFT_ELBOW, L.LEFT_WRIST),
  };
})();

export interface ArmSolution {
  upper: number;
  elbow: number;
}

/**
 * Two-link IK in the `body()` parameterization.
 *
 * (ux, uy) is the wrist target as an offset from the shoulder, in
 * shoulder-width units, y UP — the same isotropic space `body()` steps in once
 * its aspect correction is undone.
 *
 * All four sign combinations are evaluated and scored by forward kinematics
 * rather than reasoned about: the elbow-bend sign convention in `body()`
 * differs per side (`inward`), and picking it analytically is exactly the kind
 * of sign error that silently puts the hand in the wrong place. Cost prefers
 * hitting the target, then the lower elbow, which is how an arm actually hangs.
 */
export function solveArm(side: 'L' | 'R', ux: number, uy: number, out: ArmSolution): ArmSolution {
  const A = ARM.upper;
  const B = ARM.fore;
  const raw = Math.hypot(ux, uy);
  const d = clamp(raw < 1e-4 ? 1e-4 : raw, Math.abs(A - B) + 0.03, A + B - 0.02);
  const phi = Math.atan2(uy, ux) * DEG;
  const theta = Math.acos(clamp((A * A + B * B - d * d) / (2 * A * B), -1, 1)) * DEG;
  const turn = 180 - theta;
  const delta = Math.acos(clamp((A * A + d * d - B * B) / (2 * A * d), -1, 1)) * DEG;
  const inward = side === 'L' ? -1 : 1;
  const tx = Math.cos(phi * D2R) * d;
  const ty = Math.sin(phi * D2R) * d;

  let best = Infinity;
  out.upper = phi;
  out.elbow = 0;
  for (let su = -1; su <= 1; su += 2) {
    for (let se = -1; se <= 1; se += 2) {
      const upper = phi + su * delta;
      const elbow = se * turn;
      const fore = upper + elbow * inward;
      const ex = Math.cos(upper * D2R) * A;
      const ey = Math.sin(upper * D2R) * A;
      const wx = ex + Math.cos(fore * D2R) * B;
      const wy = ey + Math.sin(fore * D2R) * B;
      const cost = Math.hypot(wx - tx, wy - ty) * 100 + ey;
      if (cost < best) {
        best = cost;
        out.upper = upper;
        out.elbow = elbow;
      }
    }
  }
  return out;
}

export interface VirtualOpts {
  view?: { w: number; h: number };
  calib?: CalibrationProfile;
  filter?: OneEuroConfig;
  /** Which hand the pointer drives. 'R' is the subject's right, which in a
   *  mirrored view is the hand on the right of the screen. */
  dominant?: 'L' | 'R';
  /** Listen for real DOM input. False for tests, which drive press()/release()
   *  directly and therefore stay Node-safe. */
  attach?: boolean;
  gamepad?: boolean;
}

/** Codes this source understands, as `KeyboardEvent.code` values. */
export type VirtualKey =
  | 'Space'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'KeyZ'
  | 'KeyX'
  | 'KeyC';

const JUMP_SEC = 0.45;
const CLAP_SEC = 0.36;
/** Maximum speed the pointer-driven hand target travels, shoulder-widths/sec.
 *
 *  A mouse can cross the screen in one frame; an arm cannot. Without this cap
 *  the One Euro filter faithfully reports the 160 units/sec that implies, a
 *  swing detector believes it, and `hitSegCircle` sweeps the whole screen and
 *  hits every target on the line. A fast human arm peaks near 8-9. */
const HAND_SPEED = 10;
/** Maximum sideways walking speed, shoulder-widths/sec. ~1.4 m/s, a brisk
 *  sidestep. An `approach()` toward the cursor starts at 24 units/sec, which
 *  is not only superhuman, it exceeds the identity tracker's own match gate —
 *  the virtual body would lose its own player slot every time the mouse moved
 *  across the screen. */
const WALK_SPEED = 4;
/** How far from the shoulder centre both hands can still meet, in shoulder
 *  widths. An arm is 1.63; a shoulder is 0.5 off centre. */
const CLAP_REACH = 1.45;

export class VirtualPoseSource implements PoseSource {
  readonly info: PoseSourceInfo = { kind: 'virtual', fps: VIRTUAL_HZ, tier: 'virtual' };

  private identity: PoseIdentity;
  private calib: CalibrationProfile;
  private viewW: number;
  private viewH: number;
  private dominant: 'L' | 'R';
  private useGamepad: boolean;

  // input state
  private held = new Set<string>();
  private jumpQueued = false;
  private clapQueued = false;
  private pointerX = 0;
  private pointerY = 0;
  private pointerOn = false;

  // body state, all continuous so velocities stay plausible
  private squat = 0;
  private lean = 0;
  private walkX = 0;
  /** Rate-limited hand target, in image coords. */
  private handX = -1;
  private handY = -1;
  private raiseL = 0;
  private raiseR = 0;
  private jumpT = -1;
  private clapT = -1;

  private nextFeedT = 0;
  private lastFed = -1;
  private paused = false;
  private attached: EventTarget | null = null;
  private solL: ArmSolution = { upper: 0, elbow: 0 };
  private solR: ArmSolution = { upper: 0, elbow: 0 };
  private visBuf = new Float32Array(LANDMARK_COUNT).fill(0.98);
  private det = { lm: new Float32Array(LANDMARK_COUNT * 2), vis: this.visBuf };
  private dets = [this.det];
  private params: Partial<BodyParams> = {};

  constructor(opts: VirtualOpts = {}) {
    this.viewW = opts.view?.w ?? 1280;
    this.viewH = opts.view?.h ?? 720;
    this.calib = opts.calib ?? defaultCalibration(this.viewW, this.viewH);
    this.dominant = opts.dominant ?? 'R';
    this.useGamepad = opts.gamepad ?? true;
    this.identity = new PoseIdentity({
      maxPlayers: 1,
      calib: this.calib,
      filter: opts.filter,
      // A synthesized body is upright and present from frame one; probation
      // exists to reject pets and chairs, and there are none in here.
      probationSec: 0,
    });
    this.pointerX = this.viewW / 2;
    this.pointerY = this.viewH / 2;
    if (opts.attach !== false) this.attach();
  }

  get view(): { w: number; h: number } {
    return { w: this.viewW, h: this.viewH };
  }

  setView(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
  }

  // ── input, programmatic (tests) and DOM ──────────────────────────────────

  press(code: string): void {
    if (code === 'Space' && !this.held.has(code)) this.jumpQueued = true;
    if (code === 'KeyC' && !this.held.has(code)) this.clapQueued = true;
    this.held.add(code);
  }

  release(code: string): void {
    this.held.delete(code);
  }

  /** Pointer position in view px (the mirrored space games draw in). */
  setPointer(x: number, y: number): void {
    this.pointerX = x;
    this.pointerY = y;
    this.pointerOn = true;
  }

  clearPointer(): void {
    this.pointerOn = false;
  }

  attach(target?: EventTarget): void {
    if (this.attached) return;
    const t = target ?? (typeof window !== 'undefined' ? window : null);
    if (!t) return;
    this.attached = t;
    t.addEventListener('keydown', this.onKeyDown as EventListener);
    t.addEventListener('keyup', this.onKeyUp as EventListener);
    t.addEventListener('pointermove', this.onPointer as EventListener);
    t.addEventListener('pointerdown', this.onPointer as EventListener);
  }

  detach(): void {
    const t = this.attached;
    if (!t) return;
    t.removeEventListener('keydown', this.onKeyDown as EventListener);
    t.removeEventListener('keyup', this.onKeyUp as EventListener);
    t.removeEventListener('pointermove', this.onPointer as EventListener);
    t.removeEventListener('pointerdown', this.onPointer as EventListener);
    this.attached = null;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    this.press(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.release(e.code);
  };

  private onPointer = (e: PointerEvent): void => {
    this.setPointer(e.clientX, e.clientY);
  };

  // ── PoseSource ───────────────────────────────────────────────────────────

  start(): Promise<void> {
    this.feed(0);
    this.nextFeedT = 1 / VIRTUAL_HZ;
    return Promise.resolve();
  }

  stop(): void {
    this.detach();
    this.identity.reset();
    this.nextFeedT = 0;
    this.lastFed = -1;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.held.clear();
  }

  sample(tSec: number): PoseFrame {
    if (!this.paused) {
      // A backgrounded tab resumes with a huge gap: skip the dead time rather
      // than simulate four thousand frames of nothing.
      if (tSec - this.nextFeedT > 0.5) this.nextFeedT = tSec - 1 / VIRTUAL_HZ;
      while (this.nextFeedT <= tSec) {
        this.feed(this.nextFeedT);
        this.nextFeedT += 1 / VIRTUAL_HZ;
      }
    }
    const age =
      this.paused || this.lastFed < 0
        ? 0
        : Math.min(MAX_EXTRAPOLATE_SEC, Math.max(0, tSec - this.lastFed));
    return this.identity.project(tSec, age, VIRTUAL_HZ, this.viewW, this.viewH);
  }

  setCalibration(c: CalibrationProfile): void {
    this.calib = c;
    this.identity.setCalibration(c);
  }

  /**
   * Scripted calibration: stand, arms out, arms overhead, squat — 4 seconds,
   * driven by the simulated body rather than by a real one.
   *
   * This is better than falling back to `defaultCalibration()`: the virtual
   * body has correct proportions, so a keyboard player gets a profile whose
   * armSpan, armLen, reachUpY and squatHipY are all real measurements of the
   * body the games will actually see.
   */
  calibrate(ms: number): Promise<CalibrationProfile> {
    const cap = new CalibrationCapture({ ms, mirrored: this.calib.mirrored });
    const step = 1 / VIRTUAL_HZ;
    let t = Math.max(this.lastFed, 0);
    const t0 = t;
    const dur = ms / 1000;
    while (!cap.done && t - t0 < dur + 1) {
      t += step;
      const u = (t - t0) / dur;
      this.feed(t, scriptedPose(u));
      const p = this.identity.project(t, 0, VIRTUAL_HZ, this.viewW, this.viewH);
      if (p.p1?.present) cap.feed(p.p1, t, this.viewH);
    }
    this.nextFeedT = t + step;
    if (!cap.usable) {
      return Promise.reject(new Error('[virtual] scripted calibration produced no usable frames'));
    }
    const profile = cap.finish(t * 1000);
    this.setCalibration(profile);
    return Promise.resolve(profile);
  }

  // ── body synthesis ───────────────────────────────────────────────────────

  private feed(t: number, override?: Partial<BodyParams>): void {
    const dt = this.lastFed < 0 ? 1 / VIRTUAL_HZ : Math.max(1e-3, Math.min(0.25, t - this.lastFed));
    // Reused object, refilled from STAND every feed: no per-frame allocation
    // here, though body() itself allocates its own output (it is frozen).
    const p = this.params;
    Object.assign(p, STAND, VIRTUAL_BODY);
    if (override) {
      Object.assign(p, override);
    } else {
      this.readGamepad();
      this.step(dt, p);
    }

    const aspect = this.viewW / this.viewH;
    const S = p.shoulderW ?? STAND.shoulderW;

    if (!override) this.applyHands(p, S, aspect);

    const lm = body(p, aspect);
    this.det.lm.set(lm);
    // Anything outside the frame genuinely is not visible — the same rule the
    // clip builder applies. Without this a game would place a target on a foot
    // that is off the bottom of the screen and wait forever.
    const vis = this.det.vis;
    for (let j = 0; j < LANDMARK_COUNT; j++) {
      const x = lm[j * 2]!;
      const y = lm[j * 2 + 1]!;
      vis[j] = x >= 0 && x <= 1 && y >= 0 && y <= 1 ? 0.98 : 0.15;
    }
    this.identity.update(this.dets, t, this.viewW, this.viewH);
    this.lastFed = t;
  }

  /** Advance the continuous body state and write the non-arm params. */
  private step(dt: number, p: Partial<BodyParams>): void {
    const h = this.held;
    // Jump: one-shot arc, re-armed on landing — the same shape as a real jump,
    // so a jump detector's takeoff velocity and re-arm both behave.
    if (this.jumpQueued && this.jumpT < 0) this.jumpT = 0;
    this.jumpQueued = false;
    if (this.jumpT >= 0) {
      this.jumpT += dt;
      if (this.jumpT > JUMP_SEC) this.jumpT = -1;
    }
    if (this.clapQueued && this.clapT < 0) this.clapT = 0;
    this.clapQueued = false;
    if (this.clapT >= 0) {
      this.clapT += dt;
      if (this.clapT > CLAP_SEC) this.clapT = -1;
    }

    this.squat = approach(this.squat, h.has('ArrowDown') ? 1 : 0, 9, dt);
    const leanTarget = (h.has('ArrowRight') ? 1 : 0) - (h.has('ArrowLeft') ? 1 : 0);
    this.lean = approach(this.lean, leanTarget, 7, dt);
    this.raiseL = approach(this.raiseL, h.has('KeyZ') ? 1 : 0, 8, dt);
    this.raiseR = approach(this.raiseR, h.has('KeyX') ? 1 : 0, 8, dt);

    // The body walks sideways toward the cursor, because an arm is only 1.6
    // shoulder-widths long: without this the hands can only reach a third of
    // the screen, and a mouse player cannot clap a bug in the corner. It is
    // also what a real child does — they step toward it.
    const walkTarget = this.pointerOn ? clamp(this.pointerImageX() - 0.5, -0.26, 0.26) : 0;
    const walkStep = WALK_SPEED * (p.shoulderW ?? VIRTUAL_BODY.shoulderW) * dt;
    const walkGap = walkTarget - this.walkX;
    this.walkX += Math.abs(walkGap) <= walkStep ? walkGap : Math.sign(walkGap) * walkStep;

    // Lean AND step from the same key: shoulder offset carries the lean
    // signal, hip translation carries the step signal, and both exceed their
    // detector's enter threshold at full deflection.
    p.leanDeg = 16 * this.lean;
    p.hipX = clamp(0.5 + this.walkX + 0.12 * this.lean, 0.14, 0.86);

    // Move the hand target toward the cursor at a speed an arm can manage.
    const S = p.shoulderW ?? VIRTUAL_BODY.shoulderW;
    const aspect = this.viewW / this.viewH;
    const tIx = this.pointerImageX();
    const tIy = this.pointerY / this.viewH;
    if (this.handX < 0 || !this.pointerOn) {
      this.handX = tIx;
      this.handY = tIy;
    } else {
      const dx = (tIx - this.handX) / S;
      const dy = (tIy - this.handY) / (S * aspect);
      const d = Math.hypot(dx, dy);
      const maxD = HAND_SPEED * dt;
      if (d > maxD && d > 1e-6) {
        const k = maxD / d;
        this.handX += (tIx - this.handX) * k;
        this.handY += (tIy - this.handY) * k;
      } else {
        this.handX = tIx;
        this.handY = tIy;
      }
    }

    let hipY = VIRTUAL_BODY.hipY + 0.11 * this.squat;
    let knee = 3 + 62 * this.squat;
    if (this.jumpT >= 0) {
      const up = Math.sin(clamp(this.jumpT / JUMP_SEC, 0, 1) * Math.PI);
      hipY -= 0.13 * up;
      knee = Math.max(knee, 3 + 30 * up);
    }
    p.hipY = hipY;
    p.kneeL = knee;
    p.kneeR = knee;
  }

  /** Pointer x in image coords (un-mirrored), 0..1. */
  private pointerImageX(): number {
    const x = this.pointerX / this.viewW;
    return this.calib.mirrored !== false ? 1 - x : x;
  }

  /** Arms: clap > raise > pointer > jump swing > hanging. */
  private applyHands(p: Partial<BodyParams>, S: number, aspect: number): void {
    const up = this.jumpT >= 0 ? Math.sin(clamp(this.jumpT / JUMP_SEC, 0, 1) * Math.PI) : 0;
    p.armL = lerp(STAND.armL, -30, up);
    p.armR = lerp(STAND.armR, -150, up);
    p.elbowL = STAND.elbowL;
    p.elbowR = STAND.elbowR;

    // The skeleton has to exist before we can ask where its shoulders are;
    // shoulder position depends only on hip/lean/width, never on the arms.
    const base = body(p, aspect);
    const shoulder = (side: 'L' | 'R'): { x: number; y: number } => {
      const j = side === 'L' ? L.LEFT_SHOULDER : L.RIGHT_SHOULDER;
      return { x: base[j * 2]!, y: base[j * 2 + 1]! };
    };

    // Hand target in image coords: the rate-limited follow of the cursor,
    // which lives in MIRRORED view px because that is the space the player
    // sees and the games draw in.
    const tIx = this.handX < 0 ? this.pointerImageX() : this.handX;
    const tIy = this.handY < 0 ? this.pointerY / this.viewH : this.handY;

    const toUnits = (sx: number, sy: number, ix: number, iy: number, out: [number, number]): void => {
      out[0] = (ix - sx) / S;
      out[1] = -(iy - sy) / (S * aspect);
    };
    const u: [number, number] = [0, 0];

    if (this.clapT >= 0) {
      // Both hands converge on the cursor and separate again. Converging to
      // the CURSOR (not to the chest) is what makes a keyboard player able to
      // clap a mosquito where the mosquito actually is.
      // Trapezoid, not a triangle: the palms have to STAY together for a
      // couple of inference frames or the filter never sees them close. A real
      // clap holds contact for a moment too.
      const ph = clamp(this.clapT / CLAP_SEC, 0, 1);
      const close = ph < 0.35 ? ph / 0.35 : ph < 0.6 ? 1 : 1 - (ph - 0.6) / 0.4;
      const sep = lerp(0.95, 0.07, close * close) / 2;
      const sL = shoulder('L');
      const sR = shoulder('R');
      // Pull the clap point in until BOTH hands can actually meet there. An
      // arm reaches 1.63 shoulder-widths; a clap point the far hand cannot
      // reach leaves a one-shoulder-width gap between the palms and the clap
      // never registers. This is a real constraint on a real body too, which
      // is exactly why games must size targets off ReachSignal.leftExtend
      // rather than off the screen.
      const cx = (sL.x + sR.x) / 2;
      const cy = (sL.y + sR.y) / 2;
      let k = 1;
      for (let i = 0; i < 6; i++) {
        const qx = cx + (tIx - cx) * k;
        const qy = cy + (tIy - cy) * k;
        const far = Math.max(
          Math.hypot((qx - sL.x) / S, (qy - sL.y) / (S * aspect)),
          Math.hypot((qx - sR.x) / S, (qy - sR.y) / (S * aspect)),
        );
        if (far <= CLAP_REACH) break;
        k *= CLAP_REACH / far;
      }
      const clapX = cx + (tIx - cx) * k;
      const clapY = cy + (tIy - cy) * k;
      toUnits(sL.x, sL.y, clapX + sep * S, clapY, u);
      solveArm('L', u[0], u[1], this.solL);
      toUnits(sR.x, sR.y, clapX - sep * S, clapY, u);
      solveArm('R', u[0], u[1], this.solR);
      p.armL = this.solL.upper;
      p.elbowL = this.solL.elbow;
      p.armR = this.solR.upper;
      p.elbowR = this.solR.elbow;
      return;
    }

    if (this.pointerOn) {
      const side = this.dominant;
      const sh = shoulder(side);
      toUnits(sh.x, sh.y, tIx, tIy, u);
      const sol = side === 'L' ? this.solL : this.solR;
      solveArm(side, u[0], u[1], sol);
      if (side === 'L') {
        p.armL = sol.upper;
        p.elbowL = sol.elbow;
      } else {
        p.armR = sol.upper;
        p.elbowR = sol.elbow;
      }
    }

    // Raising overrides the pointer for that hand: an explicit key beats an
    // ambient cursor position.
    if (this.raiseL > 0.01) {
      p.armL = lerp(p.armL ?? STAND.armL, 88, this.raiseL);
      p.elbowL = lerp(p.elbowL ?? STAND.elbowL, 4, this.raiseL);
    }
    if (this.raiseR > 0.01) {
      p.armR = lerp(p.armR ?? STAND.armR, 92, this.raiseR);
      p.elbowR = lerp(p.elbowR ?? STAND.elbowR, 4, this.raiseR);
    }
  }

  private readGamepad(): void {
    if (!this.useGamepad) return;
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    const pads = navigator.getGamepads();
    for (const pad of pads) {
      if (!pad) continue;
      const b = (i: number): boolean => !!pad.buttons[i]?.pressed;
      this.setFromPad('Space', b(0));
      this.setFromPad('ArrowDown', b(1));
      this.setFromPad('KeyC', b(2));
      this.setFromPad('KeyZ', b(4));
      this.setFromPad('KeyX', b(5));
      const ax = pad.axes[0] ?? 0;
      this.setFromPad('ArrowLeft', ax < -0.4);
      this.setFromPad('ArrowRight', ax > 0.4);
      break; // one pad drives the one virtual body
    }
  }

  private setFromPad(code: VirtualKey, down: boolean): void {
    if (down) this.press(code);
    else this.release(code);
  }
}

/** The 4-second calibration script: stand, arms out, arms overhead, squat.
 *  Exported so a test can assert the profile it produces. */
export function scriptedPose(u: number): Partial<BodyParams> {
  const seg = clamp(u, 0, 0.999) * 4;
  // (the caller has already applied VIRTUAL_BODY; anything returned here wins)
  const k = seg % 1;
  const ease = k < 0.3 ? k / 0.3 : 1;
  if (seg < 1) return {};
  if (seg < 2) {
    // arms out to the sides
    return { armL: lerp(STAND.armL, 2, ease), armR: lerp(STAND.armR, 178, ease), elbowL: 4, elbowR: 4 };
  }
  if (seg < 3) {
    return { armL: lerp(2, 88, ease), armR: lerp(178, 92, ease), elbowL: 4, elbowR: 4 };
  }
  const depth = ease;
  return {
    armL: lerp(88, STAND.armL, ease),
    armR: lerp(92, STAND.armR, ease),
    hipY: VIRTUAL_BODY.hipY + 0.11 * depth,
    kneeL: 3 + 62 * depth,
    kneeR: 3 + 62 * depth,
  };
}

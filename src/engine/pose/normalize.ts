// Raw landmarks -> PlayerPose. The single most important function in the engine.
//
// Everything a game is allowed to threshold on comes out of here, so this file
// decides whether a 120cm seven-year-old standing 1.2m from a laptop and a
// 170cm adult standing 3m back play the same game. They must.
//
// THE THREE SPACES, and why there are three:
//
//   raw   image-normalized 0..1, y DOWN, NOT mirrored. What the model emits.
//   px    view pixels, MIRRORED. For drawing and for hit tests against
//         on-screen objects. Mirroring is non-negotiable UX: unmirrored,
//         "raise your right hand" sends every 7-year-old the wrong way.
//   n     origin = hip midpoint, 1 unit = shoulder width, +y DOWN. Every
//         gameplay threshold. Derived from the MIRRORED px space so that game
//         logic and drawing can never disagree about which way is left.
//
// We never mirror the frame fed to the model: it costs a copy, buys nothing
// (the model is trained on both orientations) and would double-flip the
// left/right semantics that landmarks.ts fixes once and for all.
//
// `n` is hip-centred, so `ny(p, L.LEFT_HIP)` is ~0 by construction and whole-
// body motion is INVISIBLE in `n`. That is deliberate — it is what makes a
// wrist position independent of where the player stands. Whole-body motion
// lives in `v` (absolute, shoulder-widths/sec), in `px`, and in `box`. A jump
// detector reads `v` and `px`, never `n`.
//
// With the hips out of frame (a child close to a laptop) the origin is the hip
// centre ESTIMATED from the shoulders instead — see HIP_ENTER_VIS. `n` is then
// shoulder-anchored, which arm games cannot tell apart; games that need real
// hip motion are kept out of the pool by `lowerBodyVisible`.
import type { CalibrationProfile, PlayerPose } from '../types';
import { DEG, clamp } from '../math';
import { L, LANDMARK_COUNT, MIN_VIS } from './landmarks';
import { DEFAULT_FILTER, type OneEuroConfig, PoseFilterBank } from './oneEuro';

const N = LANDMARK_COUNT;
const N2 = N * 2;

/** Shoulder width as a fraction of hip-centre-to-shoulder-centre length.
 *
 *  RESEARCH-POSE §5.1 / RESEARCH-ARCH §3.2 both write `torso * 0.9`. Measured
 *  against this project's own skeleton (testing/synth.ts: torso = 1.35
 *  shoulder widths) the true ratio is 0.74, and anthropometry for a standing
 *  child gives ~0.79 (biacromial 0.23H over hip-to-acromion 0.29H). 0.9 would
 *  make every threshold jump 20% the moment a shoulder is occluded, so this is
 *  a deliberate deviation from the brief. It only matters on the fallback path.
 */
/**
 * shoulder width / torso length, used only as a scale FALLBACK when a shoulder
 * drops below MIN_VIS. Measured at 0.741 on this project's skeleton and ~0.74
 * in child anthropometry. The research brief's 0.9 would step the scale ~20%
 * the instant a shoulder occludes, which moves every threshold in every game.
 */
export const TORSO_TO_SHOULDER = 0.741;

/** Weight of the NEW sample when smoothing scale and centre.
 *  Positions get One Euro; scale gets this, which is far heavier. A jittery
 *  scale makes every threshold in every game jitter, and shoulder width is
 *  genuinely near-constant for a child standing in front of a camera. */
export const SCALE_SMOOTH = 0.3;

/** Scale clamp, as a fraction of view height. Stops one mis-detection from
 *  exploding the whole geometry (Jumping Jack clamps 4%-50%, same idea). */
export const SCALE_MIN_FRAC = 0.04;
export const SCALE_MAX_FRAC = 0.5;

/** Hold a vanished landmark's last good visibility for this long before
 *  admitting it is gone (RESEARCH-POSE §5.4: hide a part after 0.3s). Without
 *  this, one dropped frame gates every detector that needs the joint. */
export const STALE_VIS_SEC = 0.3;

const TORSO_ANCHORS = [L.LEFT_SHOULDER, L.RIGHT_SHOULDER, L.LEFT_HIP, L.RIGHT_HIP] as const;

/**
 * The origin of `n` when the hips are out of frame.
 *
 * A child 1.2m from a laptop is in frame from the head to about the waist, and
 * a MacBook lid tilted back pushes the hips off the bottom edge entirely. The
 * hips are then either held at a stale position (the gate in feed()) or
 * flickering around MIN_VIS at the edge, and an origin that follows them
 * teleports every `n` in every game. So the origin is a blend of the measured
 * hip centre and one estimated from the shoulders — shoulder centre plus this
 * body's own shoulder-to-hip vector, learned while its hips were visible
 * (default: straight down by 1 / TORSO_TO_SHOULDER).
 *
 * Hysteresis on the (stale-graced) hip visibility picks the side: trust the
 * hips once both reach HIP_ENTER_VIS, stop below MIN_VIS. Hips at the frame
 * edge wobble around 0.5, and a single threshold there would flip the origin
 * every few frames. The switch itself is a ramp at HIP_BLEND_RATE, never a
 * step: with a learned torso vector the two origins differ by a few hundredths
 * of a shoulder width, and the ramp spreads even an unlearned 0.3 over 0.4s.
 * Velocities (`v`) come from the joints themselves and never see any of this.
 */
export const HIP_ENTER_VIS = 0.7;
/** Origin weight moved between measured and estimated hips, per second. */
export const HIP_BLEND_RATE = 2.5;
/** Time constant for learning this body's shoulder-to-hip vector, seconds. */
export const TORSO_LEARN_SEC = 1;

/**
 * Per-body normalization state. One of these per player slot, reused forever.
 *
 * `feed()` runs at inference rate (~25Hz) and does the expensive work.
 * `project()` runs at 60Hz and only extrapolates — see PoseSource.sample().
 */
export class PoseNormalizer {
  /** Filtered absolute position in shoulder-width units, MIRRORED space.
   *  This — not `n` — is the authoritative state, because it is the only one
   *  in which whole-body motion and limb motion are both visible. */
  readonly w = new Float32Array(N2);
  /** Filtered velocity, shoulder-widths/sec, from the One Euro derivative. */
  readonly v = new Float32Array(N2);
  /** Visibility with the stale-grace window applied. */
  readonly vis = new Float32Array(N);

  /** Shoulder width in view px: the unit of `n`, heavily smoothed. */
  scalePx = 0;
  /** Mean visibility of the torso anchors. */
  conf = 0;
  /** Shoulder-line tilt, degrees, -90..90. Deliberately NOT corrected for. */
  rollDeg = 0;
  /** Timestamp of the last fed inference, seconds. */
  lastT = -1;
  /** True once at least one body has been fed. */
  primed = false;
  /** Weight of the MEASURED hip centre in the origin of `n`, 0..1. The rest
   *  is the shoulder-based estimate. See HIP_ENTER_VIS. */
  hipWeight = 1;
  /** This body's shoulder-centre -> hip-centre vector, shoulder widths. */
  torsoX = 0;
  torsoY = 1 / TORSO_TO_SHOULDER;

  private hipTrusted = true;
  private bank: PoseFilterBank;
  /** Whether each landmark's RAW visibility passed this frame. */
  private rawOk = new Uint8Array(N);
  private lastGoodVis = new Float32Array(N);
  private lastGoodT = new Float32Array(N);
  private mirrored = true;

  constructor(cfg: OneEuroConfig = DEFAULT_FILTER) {
    this.bank = new PoseFilterBank(N2, cfg);
    this.lastGoodT.fill(-1e9);
  }

  setFilter(cfg: OneEuroConfig): void {
    this.bank.configure(cfg);
  }

  /**
   * Consume one inference for one body.
   *
   * @param raw  33*2 image-normalized, y down, NOT mirrored.
   * @param visRaw 33 visibilities 0..1.
   * @param viewW/viewH the view the video is being displayed into, in logical
   *        px. Landmarks are mapped onto this rect, so the caller must pass the
   *        rect the video actually covers or every distance is skewed.
   * @param t seconds, monotonically increasing.
   */
  feed(
    raw: Float32Array,
    visRaw: Float32Array,
    viewW: number,
    viewH: number,
    calib: CalibrationProfile,
    t: number,
  ): void {
    const mir = calib.mirrored !== false;
    if (mir !== this.mirrored) {
      // Flipping the mirror mid-session teleports every landmark. Start clean
      // rather than hand a 60-shoulder-width velocity spike to a detector.
      this.mirrored = mir;
      this.resetFilters();
    }

    // ── 1. Visibility, with a grace window ─────────────────────────────────
    // Gate, don't guess: a 0.1-visibility ankle fed to a jump detector breaks
    // the round. But a ONE FRAME dropout is noise, not an absent leg.
    //
    // Two different decisions come out of this, and conflating them is a bug
    // that costs you a teleporting wrist: the REPORTED visibility gets the
    // grace window (so a one-frame dropout does not gate every detector),
    // while the POSITION is gated on the RAW visibility (so the garbage
    // landmark behind that dropout is never trusted — it is held instead).
    const vis = this.vis;
    const ok = this.rawOk;
    for (let j = 0; j < N; j++) {
      const rv = visRaw[j]!;
      if (rv >= MIN_VIS) {
        ok[j] = 1;
        this.lastGoodVis[j] = rv;
        this.lastGoodT[j] = t;
        vis[j] = rv;
      } else {
        ok[j] = 0;
        vis[j] = t - this.lastGoodT[j]! <= STALE_VIS_SEC ? this.lastGoodVis[j]! : rv;
      }
    }

    // ── 2. Scale: shoulder width in view px, with the fallback ladder ───────
    const slx = raw[L.LEFT_SHOULDER * 2]! * viewW;
    const sly = raw[L.LEFT_SHOULDER * 2 + 1]! * viewH;
    const srx = raw[L.RIGHT_SHOULDER * 2]! * viewW;
    const sry = raw[L.RIGHT_SHOULDER * 2 + 1]! * viewH;
    const hlx = raw[L.LEFT_HIP * 2]! * viewW;
    const hly = raw[L.LEFT_HIP * 2 + 1]! * viewH;
    const hrx = raw[L.RIGHT_HIP * 2]! * viewW;
    const hry = raw[L.RIGHT_HIP * 2 + 1]! * viewH;

    let s = 0;
    if (ok[L.LEFT_SHOULDER] && ok[L.RIGHT_SHOULDER]) {
      s = Math.hypot(slx - srx, sly - sry);
    }
    if (s < 1e-3 && ok[L.LEFT_HIP] && ok[L.RIGHT_HIP]) {
      // Torso length, which survives one bad shoulder.
      const tl = Math.hypot((slx + srx) / 2 - (hlx + hrx) / 2, (sly + sry) / 2 - (hly + hry) / 2);
      if (tl > 1e-3) s = tl * TORSO_TO_SHOULDER;
    }
    if (s < 1e-3) s = this.primed ? this.scalePx : calib.shoulderW;
    s = clamp(s, viewH * SCALE_MIN_FRAC, viewH * SCALE_MAX_FRAC);
    this.scalePx = this.primed ? this.scalePx + SCALE_SMOOTH * (s - this.scalePx) : s;

    // ── 3. Positions: mirror, scale to shoulder widths, median -> One Euro ──
    const inv = 1 / this.scalePx;
    const bank = this.bank;
    const w = this.w;
    const v = this.v;
    for (let j = 0; j < N; j++) {
      const i = j * 2;
      const rx = raw[i]!;
      const x = (mir ? 1 - rx : rx) * viewW * inv;
      const y = raw[i + 1]! * viewH * inv;
      if (ok[j] || !bank.primed(i)) {
        w[i] = bank.push(i, x, t);
        w[i + 1] = bank.push(i + 1, y, t);
      } else {
        // Not visible: hold the last good position. Velocity decays to zero
        // instead of freezing, so a parked hand cannot farm a speed gate.
        w[i] = bank.hold(i, t);
        w[i + 1] = bank.hold(i + 1, t);
      }
      v[i] = bank.velocity(i);
      v[i + 1] = bank.velocity(i + 1);
    }

    // ── 4. Origin: measured hips, or hips estimated from the shoulders ──────
    const hipVis = Math.min(vis[L.LEFT_HIP]!, vis[L.RIGHT_HIP]!);
    if (!this.primed) this.hipTrusted = hipVis >= HIP_ENTER_VIS;
    else if (this.hipTrusted) this.hipTrusted = hipVis >= MIN_VIS;
    else this.hipTrusted = hipVis >= HIP_ENTER_VIS;
    // Without both shoulders there is nothing to estimate from, so whatever
    // the hips are (held or not) is the best origin there is.
    const shOk = vis[L.LEFT_SHOULDER]! >= MIN_VIS && vis[L.RIGHT_SHOULDER]! >= MIN_VIS;
    const target = this.hipTrusted || !shOk ? 1 : 0;
    const dtSec = this.lastT < 0 ? -1 : t - this.lastT;
    if (!this.primed || dtSec < 0) this.hipWeight = target;
    else {
      const step = HIP_BLEND_RATE * Math.min(dtSec, 0.25);
      this.hipWeight = clamp(this.hipWeight + clamp(target - this.hipWeight, -step, step), 0, 1);
    }
    // Learn this body's torso vector while BOTH ends are really measured this
    // frame (not held), so the estimate lands where the hips actually were.
    if (
      this.hipWeight === 1 && this.hipTrusted && dtSec > 0 &&
      ok[L.LEFT_HIP] && ok[L.RIGHT_HIP] && ok[L.LEFT_SHOULDER] && ok[L.RIGHT_SHOULDER]
    ) {
      const tx = (w[L.LEFT_HIP * 2]! + w[L.RIGHT_HIP * 2]! - w[L.LEFT_SHOULDER * 2]! - w[L.RIGHT_SHOULDER * 2]!) / 2;
      const ty = (w[L.LEFT_HIP * 2 + 1]! + w[L.RIGHT_HIP * 2 + 1]! - w[L.LEFT_SHOULDER * 2 + 1]! - w[L.RIGHT_SHOULDER * 2 + 1]!) / 2;
      // Only a plausible upright torso teaches anything: a bow or a mis-detected
      // hip must not become the origin of the next minute of play.
      if (ty > 0.8 && ty < 2.2 && Math.abs(tx) < 0.6 * ty) {
        const k = 1 - Math.exp(-dtSec / TORSO_LEARN_SEC);
        this.torsoX += k * (tx - this.torsoX);
        this.torsoY += k * (ty - this.torsoY);
      }
    }

    // ── 5. Derived scalars ─────────────────────────────────────────────────
    let c = 0;
    for (const j of TORSO_ANCHORS) c += vis[j]!;
    this.conf = c / TORSO_ANCHORS.length;

    // Shoulder-line tilt, measured left-to-right across the SCREEN so the sign
    // does not depend on the mirror flag. 0 = level.
    const lx = w[L.LEFT_SHOULDER * 2]!;
    const ly = w[L.LEFT_SHOULDER * 2 + 1]!;
    const rx2 = w[L.RIGHT_SHOULDER * 2]!;
    const ry2 = w[L.RIGHT_SHOULDER * 2 + 1]!;
    const dx = rx2 - lx;
    const dy = ry2 - ly;
    this.rollDeg = dx >= 0 ? Math.atan2(-dy, dx) * DEG : Math.atan2(dy, -dx) * DEG;

    this.lastT = t;
    this.primed = true;
  }

  /**
   * Write px / n / v / vis / box / rollDeg / conf / scalePx into `pose`,
   * extrapolated `ageSec` past the last inference.
   *
   * Allocation-free: every target is a Float32Array or a field of `pose`.
   * Inference runs at ~25Hz and games step at 60Hz, so this is where 12fps
   * detection still ends up feeling smooth.
   */
  project(pose: PlayerPose, ageSec: number, viewW: number, viewH: number): void {
    const s = this.scalePx;
    const w = this.w;
    const v = this.v;
    const a = ageSec > 0 ? ageSec : 0;
    const px = pose.px;
    const n = pose.n;
    const vis = this.vis;

    // Hip centre of the EXTRAPOLATED body, so n stays exactly hip-centred.
    let hx =
      (w[L.LEFT_HIP * 2]! + v[L.LEFT_HIP * 2]! * a + w[L.RIGHT_HIP * 2]! + v[L.RIGHT_HIP * 2]! * a) /
      2;
    let hy =
      (w[L.LEFT_HIP * 2 + 1]! +
        v[L.LEFT_HIP * 2 + 1]! * a +
        w[L.RIGHT_HIP * 2 + 1]! +
        v[L.RIGHT_HIP * 2 + 1]! * a) /
      2;
    // Hips out of frame: blend toward the shoulder-based estimate. Skipped at
    // weight 1 so a fully visible body keeps the exact hip centre.
    const k = this.hipWeight;
    if (k < 1) {
      const ex =
        (w[L.LEFT_SHOULDER * 2]! + v[L.LEFT_SHOULDER * 2]! * a +
          w[L.RIGHT_SHOULDER * 2]! + v[L.RIGHT_SHOULDER * 2]! * a) / 2 + this.torsoX;
      const ey =
        (w[L.LEFT_SHOULDER * 2 + 1]! + v[L.LEFT_SHOULDER * 2 + 1]! * a +
          w[L.RIGHT_SHOULDER * 2 + 1]! + v[L.RIGHT_SHOULDER * 2 + 1]! * a) / 2 + this.torsoY;
      hx = k * hx + (1 - k) * ex;
      hy = k * hy + (1 - k) * ey;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let j = 0; j < N; j++) {
      const i = j * 2;
      const wx = w[i]! + v[i]! * a;
      const wy = w[i + 1]! + v[i + 1]! * a;
      const X = wx * s;
      const Y = wy * s;
      px[i] = X;
      px[i + 1] = Y;
      n[i] = wx - hx;
      n[i + 1] = wy - hy;
      if (vis[j]! >= MIN_VIS) {
        if (X < minX) minX = X;
        if (X > maxX) maxX = X;
        if (Y < minY) minY = Y;
        if (Y > maxY) maxY = Y;
      }
    }
    pose.v.set(v);
    pose.vis.set(vis);
    pose.scalePx = s;
    pose.rollDeg = this.rollDeg;
    pose.conf = this.conf;
    if (minX < maxX) {
      const b = pose.box;
      b.x = minX / viewW;
      b.y = minY / viewH;
      b.w = (maxX - minX) / viewW;
      b.h = (maxY - minY) / viewH;
    }
  }

  /** Forget filter history but keep the measured scale AND the last known
   *  pose — for a replay loop seam or a re-acquired camera, where the body
   *  teleports but is the same body.
   *
   *  Velocity goes to zero (nothing real happened between the two positions,
   *  so publishing a velocity across the seam would fire every
   *  velocity-triggered detector in the catalogue). Positions are kept: a
   *  caller that projects before the next inference arrives must get the last
   *  pose, not a body collapsed at the origin. */
  resetFilters(): void {
    this.bank.reset();
    for (let i = 0; i < N2; i++) this.v[i] = 0;
    this.lastT = -1;
  }

  reset(): void {
    this.resetFilters();
    this.w.fill(0);
    this.rawOk.fill(0);
    this.vis.fill(0);
    this.lastGoodVis.fill(0);
    this.lastGoodT.fill(-1e9);
    this.scalePx = 0;
    this.conf = 0;
    this.rollDeg = 0;
    this.primed = false;
    this.hipWeight = 1;
    this.hipTrusted = true;
    this.torsoX = 0;
    this.torsoY = 1 / TORSO_TO_SHOULDER;
  }
}

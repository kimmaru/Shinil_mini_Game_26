// Camera shake and hitstop.
//
// Shake is trauma-based (Squirrel Eiserloh, GDC 2016): callers add trauma, the
// displacement is trauma squared so small hits stay subtle and big ones punch,
// and it decays on its own. The noise is deterministic — two sines of an
// accumulated clock, not Math.random — so a replay test shakes identically and
// nothing here touches the game's rng stream.
//
// Both effects are clamped hard, for different reasons:
//   shake    is a nausea trigger, and these children are already moving. The
//            translation ceiling is ~28px at a 1000px viewport, and the whole
//            thing is suppressed (not reduced — suppressed) under reduced
//            motion, which the FxService does by never calling add().
//   hitstop  past ~0.08s stops reading as impact and starts reading as a
//            dropped frame, and a child reads a dropped frame as "it's broken".

/** Translation ceiling in px at s = 1 (a 1000px-min viewport). */
export const SHAKE_MAX_PX = 34;
/** Rotation ceiling in degrees. More than this and text becomes unreadable. */
export const SHAKE_MAX_ROT_DEG = 2.2;
/**
 * Response curve exponent applied to `power`.
 *
 * The textbook trauma model squares the amplitude, and that is wrong for the
 * numbers this engine documents: `shake(0.12)` is described as "a solid hit",
 * and 0.12² x 28px x 0.72 is 0.3 PIXELS — invisible. Measured against a real
 * 1280x720 canvas, 0.75 puts the documented anchors where their descriptions
 * say they are: 0.12 peaks around 5px, 0.5 ("a disaster") around 15px, 1.0 at
 * the 24px ceiling.
 */
export const SHAKE_CURVE = 0.75;
/** Longest hitstop anyone gets, whatever they asked for. */
export const HITSTOP_MAX = 0.1;

export class Shake {
  /** Requested intensity, 0..1. Accumulates, saturating. */
  private amp = 0;
  /** 1 -> 0 over the requested duration. Separate from `amp` on purpose: with
   *  one combined scalar, a quiet shake would also be a SHORT one, and
   *  `shake(0.12, 0.3)` would last two frames instead of 0.3s. */
  private env = 0;
  private decay = 1 / 0.3;
  /** Accumulated seconds — the noise phase. Never a wall clock. */
  private clock = 0;
  private scale = 1;

  /** `power` 0..1 (0.12 = a solid hit, 0.5 = a disaster). */
  add(power: number, durationSec = 0.3): void {
    if (!Number.isFinite(power) || power <= 0) return;
    const p = Math.min(1, power);
    const fresh = this.env <= 0;
    // A second hit during a shake adds a fraction, so twenty hits in one frame
    // escalate but cannot launch the camera.
    this.amp = fresh ? p : Math.min(1, Math.max(this.amp, p) + p * 0.35);
    const d = Number.isFinite(durationSec) ? Math.max(0.05, Math.min(1.5, durationSec)) : 0.3;
    // A fresh shake takes the requested duration. Adding to one already in
    // progress can only SLOW the decay, never speed it up: a lingering disaster
    // shake must not be cut short by a small quick hit landing behind it.
    this.decay = fresh ? 1 / d : Math.min(this.decay, 1 / d);
    this.env = 1;
  }

  /** `viewScale` is Renderer.s — the shake has to be bigger on a TV. */
  setScale(viewScale: number): void {
    this.scale = Number.isFinite(viewScale) && viewScale > 0 ? viewScale : 1;
  }

  update(dt: number): void {
    if (!(dt > 0)) return;
    this.clock += dt;
    if (this.env <= 0) return;
    this.env = Math.max(0, this.env - dt * this.decay);
    if (this.env === 0) {
      this.amp = 0;
      this.decay = 1 / 0.3;
    }
  }

  reset(): void {
    this.amp = 0;
    this.env = 0;
    this.decay = 1 / 0.3;
  }

  get active(): boolean {
    return this.env > 0 && this.amp > 0;
  }

  /** Current effective intensity, 0..1. For the debug overlay and the tests. */
  get amount(): number {
    return this.amp * this.env;
  }

  /** Peak displacement in px right now, before the noise term. */
  private magnitude(): number {
    return SHAKE_MAX_PX * this.scale * Math.pow(this.amp, SHAKE_CURVE) * this.env;
  }

  private noise(seed: number): number {
    const t = this.clock;
    return Math.sin(t * 37.1 + seed) * Math.sin(t * 13.7 + seed * 2.3);
  }

  get x(): number {
    if (!this.active) return 0;
    return this.noise(0) * this.magnitude();
  }

  get y(): number {
    if (!this.active) return 0;
    return this.noise(9.2) * this.magnitude();
  }

  /** Radians. */
  get rot(): number {
    if (!this.active) return 0;
    const k = Math.pow(this.amp, SHAKE_CURVE) * this.env;
    return this.noise(17.7) * ((SHAKE_MAX_ROT_DEG * Math.PI) / 180) * k;
  }
}

export class Hitstop {
  private left = 0;
  /** Total frozen seconds this round — a cheap "is a game abusing this" signal
   *  for the debug overlay. */
  total = 0;

  /** Takes the LONGEST pending request rather than summing: three simultaneous
   *  hits should feel like one impact, not a 0.18s freeze. */
  add(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const s = Math.min(HITSTOP_MAX, seconds);
    if (s > this.left) this.left = s;
  }

  /** Advance with REAL dt. Hitstop freezes the game clock, not itself. */
  update(dtReal: number): void {
    if (this.left <= 0 || !(dtReal > 0)) return;
    this.total += Math.min(this.left, dtReal);
    this.left = Math.max(0, this.left - dtReal);
  }

  reset(): void {
    this.left = 0;
  }

  get active(): boolean {
    return this.left > 0;
  }

  get remaining(): number {
    return this.left;
  }

  /** What the fixed-step loop multiplies dt by: 0 while frozen, 1 otherwise.
   *  Rhythm games must never use hitstop — it desynchronises the audio clock,
   *  which keeps running. */
  get timeScale(): number {
    return this.left > 0 ? 0 : 1;
  }
}

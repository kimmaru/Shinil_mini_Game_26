// ─── snowball-fight — SHAPE B (continuous overlap + physics), two directions ─
//
// Every other overlap game in this batch asks the player to MEET a flying
// object. This one asks them to get out of its way and send one back, so the
// same physics loop runs twice with the player's body as the target in one
// direction and the snowmen's in the other.
//
// The two decisions worth copying:
//
// 1. A THROW HAS NO DEPTH. The gesture everyone describes — "pull the hand
//    behind the shoulder and snap it forward" — is a Z-axis motion, and a
//    frontal webcam has no Z. What is actually measurable is the elbow: a
//    throw is a flexed elbow (cocked) that straightens FAST while the wrist
//    moves quickly. All three must hold inside a 0.6s window, and then the
//    hand is locked out for 500ms. Without that lockout a child scratching
//    their arm fires three snowballs. 
//
// 2. THE FIRST FIFTEEN SECONDS MISS ON PURPOSE. The snowmen open with throws
//    aimed a shoulder-width to the side of the player, so the telegraph
//    teaches the dodge before it costs anything. A game that opens on five
//    unavoidable hits is a game a 7-year-old watches rather than plays.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { headTopPx, L, shoulderPx, visible } from '@/engine/pose/landmarks';
import { angleDeg6, clamp, clamp01, hitSegCircle, lerp, pulse } from '@/engine/math';
import { Entities } from '@/engine/entities';
import { chance, randRange, Spawner } from '@/engine/spawn';
import { C, fade, hue } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

/** Ball kinds. */
const SMALL = 0;
/** Wide and head-high: sidestepping is not enough, this one must be ducked. */
const BIG = 1;
const MINE = 2;

const PTS = 15;
const LABEL = '+15';
/** A snowball that was really aimed at the player and flew past: the dodge
 *  is the other half of the game, and it is the only thing that rewards it. */
const DODGE_PTS = 8;
const DODGE_LABEL = '+8';

// ─── The throw gesture, in numbers a frontal camera can actually see ─────────
/** Elbow interior angle (deg) below which the arm counts as cocked. */
const COCK_DEG = 105;
/** ...and above which it counts as released. */
const RELEASE_DEG = 120;
/** Minimum straightening rate at release, deg/sec. A slow stretch is not a
 *  throw; measured elbow rates on the clip corpus run 250-5000 during real
 *  extensions and under 480 during a fidget. */
const RELEASE_RATE = 150;
/** Minimum wrist speed at release, shoulder-widths/sec. Idle peaks at 1.2. */
const RELEASE_SPEED = 1.7;
/** How long a cocked arm stays armed. */
const COCK_WINDOW = 0.6;
/** The cocked pose must be HELD this long, hand at or above the shoulder,
 *  before it arms. A fast straight-arm windmill reads as "bent" for a frame
 *  or two (filter lag between elbow and wrist) and used to fire on every lap;
 *  a real wind-up is a held pose. */
const COCK_HOLD = 0.2;
/** Per-hand lockout. The brief's 0.5s, and the reason an arm scratch cannot
 *  empty a magazine. */
const HAND_COOLDOWN = 0.5;
/** Short global lockout so one two-armed motion is one snowball. */
const ANY_COOLDOWN = 0.3;
/** Aim assist: a snowman within this many radians of the throw direction gets
 *  the ball. Wide on purpose — the gesture is the skill, not the aiming, and
 *  a wrist cannot aim precisely in a mirror at 2m. */
const AIM_CONE = 1.45;

const SNOWMEN = 4;
/** Lane fractions, in activation order. Nothing sits dead centre: a snowman
 *  straight ahead of the player can be hit by a throw in any direction, which
 *  removes the "which way do I throw" decision entirely. The outer lanes stay
 *  right of the HUD's score + combo column (x < 0.25w). */
const LANE_X = [0.3, 0.7, 0.42, 0.58] as const;
/** Snowman centre height, fraction of the view: its hat clears the HUD band. */
const MAN_Y = 0.29;

interface Snowman {
  live: boolean;
  x: number;
  y: number;
  /** 0 waiting, 1 aiming, 2 knocked over. */
  state: number;
  timer: number;
  aimT: number;
  aimT0: number;
  aimX: number;
  aimY: number;
  big: boolean;
  /** This throw is aimed at the player rather than past them. */
  threat: boolean;
  /** 0..1 knocked-over animation. */
  hitPop: number;
}

class SnowballFight implements MiniGame {
  private ctx!: GameContext;
  private reach!: Detector<'reach'>;
  private spawner!: Spawner;

  private readonly balls = new Entities(48);
  private readonly men: Snowman[] = [];

  private readonly torso: Pt = { x: 0, y: 0 };
  private readonly hip: Pt = { x: 0, y: 0 };
  private readonly shoulder: Pt = { x: 0, y: 0 };
  private player: PlayerPose | null = null;
  private bodyOk = false;

  // Per-hand throw state. Index 0 = left, 1 = right.
  private readonly elbow = new Float32Array(2);
  private readonly elbowPrev = new Float32Array(2);
  private readonly cockT = new Float32Array(2);
  private readonly cockHold = new Float32Array(2);
  private readonly coolT = new Float32Array(2);
  private anyCool = 0;

  private bodyR = 0;
  private headR = 0;
  private ballR = 0;
  private manR = 0;
  private gravity = 0;
  private dodgeSfx = 0;

  private score = 0;
  private hits = 0;
  private thrown = 0;
  private taken = 0;
  private dodges = 0;
  private combo = 0;
  private bestCombo = 0;
  private time = 0;
  private duckTold = false;
  private hitTold = false;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.reach = ctx.gestures.use('reach', { side: 'both' });
    // The spawner is only a difficulty ramp here: each snowman owns its own
    // throw clock, because four snowmen on one clock fire in unison and the
    // round becomes unsurvivable in a way no child can read.
    this.spawner = new Spawner(
      { startInterval: 99, endInterval: 99 },
      ctx.rng,
      manifest.durationMs / 1000,
    );

    const { w, h } = ctx.view;
    for (let i = 0; i < SNOWMEN; i++) {
      this.men.push({
        live: i === 0,
        x: 0,
        y: 0,
        state: 0,
        // Staggered openings, so the first four shots arrive one at a time.
        timer: 1.6 + i * 1.1,
        aimT: 0, aimT0: 1, aimX: w / 2, aimY: h / 2,
        big: false, threat: false, hitPop: 0,
      });
    }
    this.layout(w, h);
    this.bodyR = Math.min(w, h) * 0.1;
    this.headR = Math.min(w, h) * 0.055;

    this.torso.x = w / 2;
    this.torso.y = h * 0.52;
    this.hip.x = w / 2;
    this.hip.y = h * 0.62;
    this.shoulder.x = w / 2;
    this.shoulder.y = h * 0.42;

    ctx.hud.setGoal(t('goal'));
  }

  /** Everything sized or placed from the view. Re-run on resize: the view is
   *  live, and a snowman left at the old size's lane is off in the margin. */
  private layout(w: number, h: number): void {
    const g = Math.min(w, h);
    this.ballR = g * 0.034;
    // 0.075 -> a snowman body is ~8.5% of the view width, the target floor.
    this.manR = g * 0.075;
    this.gravity = g * 1.05;
    for (let i = 0; i < SNOWMEN; i++) {
      const m = this.men[i]!;
      m.x = w * LANE_X[i]!;
      m.y = h * MAN_Y;
    }
  }

  onResize(w: number, h: number): void {
    this.layout(w, h);
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.audio.music({ bpm: 112 });
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    this.spawner.tick(dt);
    const d = this.spawner.difficulty;

    if (this.anyCool > 0) this.anyCool -= dt;
    if (this.dodgeSfx > 0) this.dodgeSfx -= dt;

    const p = f.p1;
    this.player = p ?? null;
    if (p) this.trackBody(p);
    this.throwRead(f, p, dt);

    this.runSnowmen(dt, d);
    this.balls.step(dt, this.gravity);
    this.resolveBalls();
    this.balls.cullOutside(-this.ballR * 4, -this.ctx.view.h * 0.6,
      this.ctx.view.w + this.ballR * 4, this.ctx.view.h * 1.2);
    this.balls.sweep();
  }

  private trackBody(p: PlayerPose): void {
    // Chest centre: the midpoint of the shoulder and hip centres. Using the
    // nose instead would let a child duck their head and keep standing in the
    // line of fire, which is not a dodge.
    shoulderPx(p, this.shoulder);
    // The hip centre is the origin of `n` (px = n * scalePx + origin): the
    // measured hips when they are in frame, the engine's shoulder-based
    // estimate when a waist-up child has them below the edge. So only the
    // shoulders need to be seen.
    const ncx = (p.n[L.LEFT_SHOULDER * 2]! + p.n[L.RIGHT_SHOULDER * 2]!) / 2;
    const ncy = (p.n[L.LEFT_SHOULDER * 2 + 1]! + p.n[L.RIGHT_SHOULDER * 2 + 1]!) / 2;
    this.hip.x = this.shoulder.x - ncx * p.scalePx;
    this.hip.y = this.shoulder.y - ncy * p.scalePx;
    this.torso.x = (this.shoulder.x + this.hip.x) / 2;
    this.torso.y = (this.shoulder.y + this.hip.y) / 2;
    this.bodyOk = visible(p, L.LEFT_SHOULDER, L.RIGHT_SHOULDER);
    // Hit zones scale with the player, not the screen, so a child at the back
    // of the room is neither harder nor easier to hit.
    this.bodyR = p.scalePx * 0.62;
    this.headR = p.scalePx * 0.34;
  }

  /** The throw: cocked elbow -> fast extension -> lockout. */
  private throwRead(f: PoseFrame, p: PlayerPose | undefined, dt: number): void {
    const r = this.reach.read(f);
    for (let i = 0; i < 2; i++) {
      if (this.coolT[i]! > 0) this.coolT[i] = this.coolT[i]! - dt;
      if (this.cockT[i]! > 0) this.cockT[i] = this.cockT[i]! - dt;
    }
    if (!p || !r.ok) {
      this.cockHold[0] = 0;
      this.cockHold[1] = 0;
      return;
    }

    for (let i = 0; i < 2; i++) {
      const sh = i === 0 ? L.LEFT_SHOULDER : L.RIGHT_SHOULDER;
      const el = i === 0 ? L.LEFT_ELBOW : L.RIGHT_ELBOW;
      const wr = i === 0 ? L.LEFT_WRIST : L.RIGHT_WRIST;
      if (!visible(p, sh, el, wr)) {
        this.cockHold[i] = 0;
        continue;
      }

      const ang = angleDeg6(
        p.n[sh * 2]!, p.n[sh * 2 + 1]!,
        p.n[el * 2]!, p.n[el * 2 + 1]!,
        p.n[wr * 2]!, p.n[wr * 2 + 1]!,
      );
      this.elbowPrev[i] = this.elbow[i]!;
      this.elbow[i] = ang;
      const rate = (ang - this.elbowPrev[i]!) / dt;

      // Cocked: elbow folded with the hand up by the shoulder. The hand-above-
      // elbow test is what separates "winding up to throw" from "arm hanging
      // down, bent at the waist"; hand at or above the shoulder, held for
      // COCK_HOLD, is what separates it from a windmill passing through.
      const wy = p.n[wr * 2 + 1]!;
      if (ang < COCK_DEG && wy < p.n[el * 2 + 1]! && wy <= p.n[sh * 2 + 1]!) {
        this.cockHold[i] = this.cockHold[i]! + dt;
        if (this.cockHold[i]! >= COCK_HOLD) this.cockT[i] = COCK_WINDOW;
      } else {
        this.cockHold[i] = 0;
      }

      const spd = Math.hypot(p.v[wr * 2]!, p.v[wr * 2 + 1]!);
      const armed = this.cockT[i]! > 0 && this.coolT[i]! <= 0 && this.anyCool <= 0;
      if (!armed || ang < RELEASE_DEG || rate < RELEASE_RATE || spd < RELEASE_SPEED) continue;

      this.cockT[i] = 0;
      this.coolT[i] = HAND_COOLDOWN;
      this.anyCool = ANY_COOLDOWN;
      const palm = i === 0 ? r.leftPalm : r.rightPalm;
      this.launchMine(palm.x, palm.y, p.v[wr * 2]!, p.v[wr * 2 + 1]!);
    }
  }

  /** Send a snowball at the snowman nearest the direction the hand went. */
  private launchMine(x: number, y: number, vx: number, vy: number): void {
    const len = Math.hypot(vx, vy) || 1;
    const dx = vx / len;
    const dy = vy / len;
    this.thrown++;
    this.ctx.audio.play('whoosh', { gain: 0.5 });

    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < SNOWMEN; i++) {
      const m = this.men[i]!;
      if (!m.live || m.state === 2) continue;
      const tx = m.x - x;
      const ty = m.y - y;
      const tl = Math.hypot(tx, ty) || 1;
      // Angle between the throw and the snowman, as a cos test.
      if ((tx / tl) * dx + (ty / tl) * dy < Math.cos(AIM_CONE)) continue;
      if (tl < bestD) {
        bestD = tl;
        best = i;
      }
    }

    const flight = 0.45;
    if (best < 0) {
      // Nothing in that direction: the ball sails off and the combo goes with
      // it. Quiet — the empty sky is the feedback.
      const i = this.balls.spawn(x, y, dx * this.ballR * 26, dy * this.ballR * 26,
        this.ballR * 0.9, 2.4, MINE);
      if (i >= 0) this.balls.data[i] = -1;
      if (this.combo > 0) {
        this.combo = 0;
        this.ctx.hud.setCombo(0);
      }
      this.ctx.fx.miss(x, y);
      return;
    }
    const m = this.men[best]!;
    const i = this.balls.spawn(
      x, y,
      (m.x - x) / flight,
      (m.y - y) / flight - 0.5 * this.gravity * flight,
      this.ballR * 0.9, flight + 0.4, MINE,
    );
    if (i >= 0) {
      this.balls.data[i] = best;
      this.balls.spin[i] = 9;
    }
  }

  private runSnowmen(dt: number, d: number): void {
    const count = 1 + (d > 0.25 ? 1 : 0) + (d > 0.55 ? 1 : 0) + (d > 0.8 ? 1 : 0);
    for (let i = 0; i < SNOWMEN; i++) {
      const m = this.men[i]!;
      if (!m.live && i < count) {
        m.live = true;
        m.state = 0;
        m.timer = 0.8 + this.ctx.rng() * 0.8;
      }
      if (!m.live) continue;
      if (m.hitPop > 0) m.hitPop = Math.max(0, m.hitPop - dt * 2.2);

      if (m.state === 2) {
        m.timer -= dt;
        if (m.timer <= 0) {
          m.state = 0;
          m.timer = lerp(2.4, 1.2, d) * randRange(this.ctx.rng, 0.85, 1.15);
        }
        continue;
      }
      if (m.state === 0) {
        m.timer -= dt;
        if (m.timer > 0) continue;
        this.beginAim(m, d);
        continue;
      }
      // Aiming: the telegraph is drawn in render(); this is just its clock.
      m.aimT -= dt;
      if (m.aimT <= 0) this.release(m, d);
    }
  }

  private beginAim(m: Snowman, d: number): void {
    const { w, h } = this.ctx.view;
    // Telegraph 1.0s -> 0.4s. Below ~0.35s a whole-body dodge is physically
    // impossible for this age group, so 0.4 is the floor.
    m.aimT0 = lerp(1.0, 0.4, d);
    m.aimT = m.aimT0;
    m.state = 1;
    m.big = d > 0.45 && chance(this.ctx.rng, 0.26);

    const scale = this.player ? this.player.scalePx : this.bodyR / 0.62;
    if (m.big) {
      // Head height: ducking takes the head out of the line, and the ball is
      // too wide to sidestep.
      m.aimY = (this.player ? headTopPx(this.player) : this.torso.y - this.bodyR) + scale * 0.2;
      m.aimX = this.torso.x;
    } else if (chance(this.ctx.rng, lerp(0.25, 0.85, d))) {
      // Straight at the chest: this is the one that must be dodged.
      m.aimX = this.torso.x;
      m.aimY = this.torso.y;
    } else {
      // A deliberate near miss. Early on these are most of the shots: the
      // player learns to read the telegraph before it costs anything.
      const side = chance(this.ctx.rng, 0.5) ? -1 : 1;
      m.aimX = this.torso.x + side * scale * randRange(this.ctx.rng, 1.2, 1.9);
      m.aimY = this.torso.y;
    }
    m.threat = m.big || m.aimX === this.torso.x;
    m.aimX = clamp(m.aimX, w * 0.06, w * 0.94);
    // The telegraph ring is information a child must see: keep it below the
    // HUD band, and below the score + combo column on the left quarter.
    m.aimY = clamp(m.aimY, m.aimX < w * 0.25 ? h * 0.26 : h * 0.18, h * 0.92);

    // The engine's telegraph is one expanding ring, i.e. the "something is
    // coming" beat. The countdown itself is drawn in render().
    this.ctx.fx.telegraph(m.aimX, m.aimY, (m.big ? 1.7 : 1) * this.ballR * 2.4, {
      color: m.big ? C.warn : C.info,
      secs: m.aimT0,
    });
    this.ctx.audio.play('charge', { gain: 0.3 });
    if (m.big && !this.duckTold) {
      this.duckTold = true;
      this.ctx.hud.toast(t('duck'), { color: C.warn, big: true });
    }
  }

  private release(m: Snowman, d: number): void {
    m.state = 0;
    m.timer = lerp(2.6, 1.3, d) * randRange(this.ctx.rng, 0.85, 1.15);
    const flight = lerp(0.85, 0.58, d);
    const r = this.ballR * (m.big ? 1.75 : 1);
    const i = this.balls.spawn(
      m.x, m.y + this.manR * 0.2,
      (m.aimX - m.x) / flight,
      (m.aimY - m.y) / flight - 0.5 * this.gravity * flight,
      r, flight + 1.6, m.big ? BIG : SMALL,
    );
    if (i >= 0) {
      this.balls.spin[i] = m.aimX > m.x ? 7 : -7;
      this.balls.data[i] = m.threat ? 1 : 0;
    }
    this.ctx.audio.play('swing', { gain: 0.35 });
  }

  private resolveBalls(): void {
    const h = this.ctx.view.h;
    for (let i = this.balls.n - 1; i >= 0; i--) {
      const kind = this.balls.kind[i]!;
      const x = this.balls.x[i]!;
      const y = this.balls.y[i]!;
      const px = this.balls.px[i]!;
      const py = this.balls.py[i]!;
      const r = this.balls.r[i]!;

      if (kind === MINE) {
        const target = this.balls.data[i]!;
        if (target >= 0) {
          const m = this.men[target | 0]!;
          // Swept, because a thrown ball covers ~80px between frames and a
          // point test misses exactly when the throw was good. A snowman that
          // is already down cannot be knocked over twice: the ball flies on.
          if (m.state !== 2 && hitSegCircle(px, py, x, y, m.x, m.y, this.manR + r)) {
            this.balls.kill(i);
            this.knock(m, x, y);
          }
        }
        continue;
      }

      // A snowball at the player. Big ones are judged against the head and
      // shoulders only, so a duck takes the body out of the line; small ones
      // against the chest, so a sidestep does.
      if (this.bodyOk && this.player) {
        const cx = kind === BIG ? this.shoulder.x : this.torso.x;
        const cy = kind === BIG ? this.shoulder.y : this.torso.y;
        const rr = (kind === BIG ? this.bodyR * 0.8 : this.bodyR) + r;
        if (hitSegCircle(px, py, x, y, cx, cy, rr)) {
          this.balls.kill(i);
          this.takeHit(x, y);
          continue;
        }
        // A near miss is worth a sound: it tells the player the dodge was
        // real rather than lucky.
        if (this.dodgeSfx <= 0 && y > cy - rr && y < cy + rr * 2) {
          const gap = Math.hypot(x - cx, y - cy);
          if (gap < rr * 2.1) {
            this.dodgeSfx = 0.7;
            this.ctx.audio.play('whoosh', { gain: 0.3 });
            this.ctx.fx.pop(x, y, r * 2.2, fade(C.info, 0.5));
          }
        }
      }

      if (y > h * 0.95) {
        const threat = this.balls.data[i] === 1;
        this.balls.kill(i);
        // Only a body that was there can have dodged: an empty frame must
        // never earn points (or a 오늘 최고 기록).
        if (threat && this.bodyOk && this.player) this.dodged(x, h * 0.9);
        this.ctx.fx.burst(x, h * 0.95, {
          count: 6, color: fade(C.white, 0.7), speed: 150, life: 0.3, size: 3,
        });
      }
    }
  }

  private knock(m: Snowman, x: number, y: number): void {
    m.state = 2;
    m.timer = 0.9;
    m.hitPop = 1;
    this.hits++;
    this.combo++;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    const pts = PTS + Math.min(5, Math.floor(this.combo / 4));
    this.score += pts;
    this.ctx.fx.impact(x, y, 'hit', {
      color: hue(manifest.theme!.hue), sprite: 'burst', label: LABEL,
    });
    this.ctx.audio.playLadder('hit.soft', this.combo);
    if (this.combo > 0 && this.combo % 4 === 0) {
      this.ctx.hud.toast(t('hit'), { color: C.accent });
    }
    this.ctx.hud.setScore(this.score);
    this.ctx.hud.setCombo(this.combo);
    this.ctx.emit({ kind: 'scored', points: pts });
  }

  private dodged(x: number, y: number): void {
    this.score += DODGE_PTS;
    this.dodges++;
    this.ctx.fx.impact(x, y, 'tap', { color: C.info, sprite: 'sparkle', label: DODGE_LABEL });
    this.ctx.audio.play('pop.high', { gain: 0.5 });
    if (this.dodges % 3 === 1) this.ctx.hud.toast(t('dodge'), { color: C.info });
    this.ctx.hud.setScore(this.score);
    this.ctx.emit({ kind: 'scored', points: DODGE_PTS });
  }

  private takeHit(x: number, y: number): void {
    this.taken++;
    this.combo = 0;
    this.ctx.hud.setCombo(0);
    // A real cost, told gently: a white splat and a soft thud, no red, no
    // flash. Repeated failure cues lose this age group inside a minute.
    this.ctx.fx.burst(x, y, {
      count: 14, color: fade(C.white, 0.9), color2: fade(C.info, 0.8),
      speed: 240, gravity: 320, life: 0.45,
    });
    this.ctx.fx.pop(x, y, this.bodyR * 1.2, fade(C.info, 0.6));
    this.ctx.audio.play('thud', { gain: 0.5 });
    // Said once per round: a toast on every hit is a failure banner that
    // never leaves the screen for a child still learning the dodge.
    if (!this.hitTold) {
      this.hitTold = true;
      this.ctx.hud.toast(t('oops'), { color: C.info });
    }
    this.ctx.emit({ kind: 'miss' });
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    // Snow bank, so "the ground" and "the distance" are not ambiguous.
    const ground = g.h * 0.95;
    g.rect(0, ground, g.w, g.h - ground, { fill: fade(C.white, 0.55) });
    g.line(0, ground, g.w, ground, 3 * g.s, { stroke: fade(C.ink, 0.18) });

    // Snowmen. Eyes but no mouth: ART.md gives faces to creatures you chase,
    // and nothing at all to hazards. These are opponents, so eyes only.
    for (let i = 0; i < SNOWMEN; i++) {
      const m = this.men[i]!;
      if (!m.live) continue;
      const knocked = m.state === 2;
      const pop = 1 + pulse(m.hitPop) * 0.18;
      g.save();
      g.translate(m.x, m.y);
      if (knocked) g.rotate(0.5);
      g.scale(pop, 1 / pop);
      g.circle(0, this.manR * 0.55, this.manR, {
        fill: fade(C.white, 0.95), stroke: C.ink, sw: 4 * g.s,
      });
      g.circle(0, -this.manR * 0.62, this.manR * 0.66, {
        fill: fade(C.white, 0.95), stroke: C.ink, sw: 4 * g.s,
      });
      g.line(-this.manR * 0.5, -this.manR * 0.2, this.manR * 0.5, -this.manR * 0.2, this.manR * 0.2, {
        stroke: C.accent,
      });
      g.circle(-this.manR * 0.22, -this.manR * 0.72, this.manR * 0.1, { fill: C.ink });
      g.circle(this.manR * 0.22, -this.manR * 0.72, this.manR * 0.1, { fill: C.ink });
      g.restore();

      // The telegraph: a line to where the ball will land and a ring that
      // closes on it. This is INFORMATION, so it is drawn plainly and never
      // suppressed.
      if (m.state === 1) {
        const k = 1 - clamp01(m.aimT / Math.max(m.aimT0, 1e-3));
        const col = m.big ? C.warn : C.info;
        g.line(m.x, m.y, m.aimX, m.aimY, 3 * g.s, { stroke: fade(col, 0.35) });
        const rr = (m.big ? 1.7 : 1) * this.ballR * lerp(4.2, 1.6, k);
        g.circle(m.aimX, m.aimY, rr, { stroke: col, sw: 5 * g.s });
        g.circle(m.aimX, m.aimY, this.ballR * 0.35, { fill: fade(col, 0.5) });
        if (m.big) {
          g.chevron(m.aimX, m.aimY + rr * 1.5, this.ballR * 0.8, -Math.PI / 2, {
            fill: fade(C.warn, 0.8),
          });
        }
      }
    }

    // Balls. The player's are the game's own colour and spin upward; the
    // snowmen's are white with an ink keyline, which is the only way a white
    // object reads at all on a cream canvas.
    for (let i = 0; i < this.balls.n; i++) {
      const x = this.balls.x[i]!;
      const y = this.balls.y[i]!;
      const r = this.balls.r[i]!;
      const kind = this.balls.kind[i]!;
      if (kind === MINE) {
        g.sprite('circle', x, y, r * 2.2, { hue: manifest.theme!.hue, rot: this.balls.rot[i]! });
        continue;
      }
      g.circle(x, y, r, {
        fill: fade(C.white, 0.95),
        stroke: kind === BIG ? C.ink : fade(C.ink, 0.8),
        sw: (kind === BIG ? 5 : 4) * g.s,
      });
      g.circle(x - r * 0.3, y - r * 0.3, r * 0.22, { fill: fade(C.info, 0.35) });
    }

    if (this.player) {
      g.ghostBody(this.player, 0.1);
      g.skeleton(this.player, { alpha: 0.5 });
      // The hit zone, drawn faintly: a player who cannot see what gets hit
      // cannot learn to move it.
      g.circle(this.torso.x, this.torso.y, this.bodyR, {
        stroke: fade(C.ink, 0.16), sw: 2 * g.s,
      });
    }

    if (!this.bodyOk) {
      g.text(t('hint'), g.w / 2, g.h * 0.44, {
        size: 36 * g.s, weight: 700, align: 'center', fill: C.text,
        stroke: C.bg, sw: 6 * g.s,
      });
    }
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.bestCombo >= 4) highlights.push(`연속 ${this.bestCombo}번 맞혔어요!`);
    if (this.taken === 0 && this.hits > 0) highlights.push('한 번도 안 맞았어요!');
    return {
      gameId: manifest.id,
      cleared: this.hits > 0,
      rawScore: this.score,
      maxScore: manifest.scoring.maxScore,
      normalized: 0,
      stars: 0,
      durationMs: manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score: this.score,
        hits: this.hits, misses: this.taken, bestCombo: this.bestCombo,
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }

  dispose(): void {
    this.ctx.audio.stopMusic();
    this.balls.clear();
  }
}

export default (): MiniGame => new SnowballFight();

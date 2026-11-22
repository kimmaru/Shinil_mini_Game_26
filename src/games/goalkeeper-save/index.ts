// ─── goalkeeper-save — SHAPE B (continuous overlap), judged on LIMB SEGMENTS ─
//
// Every other overlap game in the catalogue tests a POINT (a palm, the top of
// the head) against a circle. A goalkeeper does not save with a point: the
// save is made by the whole forearm. So the test here is four swept
// segment-vs-circle checks per ball (upper arm and forearm-to-palm, both
// sides), which is what makes a lunge feel like a lunge instead of a game of
// finding the pixel.
//
// Three decisions that shaped everything else:
//
// 1. ONLY THE ARMS SAVE. A child standing still in front of a camera has
//    their chest in the middle of the goal, so a torso that saves is a game
//    that scores a child for standing there — the exact phantom score the
//    smoke test exists to catch. Legs are out of frame at 1.2 m, and when
//    they are visible (further back) a jumping flail with legs saved 41 of
//    45 shots, so they do not save either: the howTo says hands, and it is.
//
// 2. A LIMB ONLY SAVES WHILE IT IS MOVING (1.5 shoulder-widths/sec, measured
//    against an idle peak of 1.2 and a fidget peak of 2.0). Same reason, and
//    the same gate candy-rain-catch puts on its hands.
//
// 3. THE GOAL IS SIZED FROM THE PLAYER'S OWN ARM. The nine zones sit at
//    1.15 arm-lengths apart in three rows measured from the SHOULDERS (high,
//    chest, low), so a small child and a tall one are asked for the same
//    stretch rather than the same number of pixels — and so the game works
//    waist-up, 1.2 m from a laptop, where hips and legs are out of frame.
//    The ball and glove are capped by the same arm length: in view px alone a
//    child far from the camera covers the whole goal with one flail.
import type {
  EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { jx, jy, L, palm, shoulderPx, visible } from '@/engine/pose/landmarks';
import { clamp, clamp01, easeInQuad, hitSegCircle, lerp, pulse, TAU } from '@/engine/math';
import { chance, randInt, randRange, Spawner } from '@/engine/spawn';
import { C, fade, hue } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

const PTS = 20;
/** Max combo bonus on top of PTS. */
const BONUS_MAX = 5;
/** Pre-built: the floating label always shows the points actually awarded. */
const LABELS = ['+20', '+21', '+22', '+23', '+24', '+25'] as const;

/** Colour strings built once: update() and render() build none. */
const THEME = hue(manifest.theme!.hue);
const BALL_TRAIL = fade(THEME, 0.3);
const NET_FILL = fade(C.white, 0.35);
const NET_LINE = fade(C.ink, 0.1);
const GOAL_LINE = fade(C.ink, 0.5);
const ZONE_RING = fade(C.ink, 0.22);
const ZONE_MARK = fade(C.ink, 0.3);
const SHOOTER = fade(C.ink, 0.5);
const SAVE_TRAIL = fade(C.white, 0.7);
const EMPHASIZE = [L.LEFT_WRIST, L.RIGHT_WRIST] as const;
/** Top of the zone rows: below the DOM HUD band, deep enough for the score
 *  column on the left. */
const SAFE_TOP = 0.26;

/** A limb saves only while it is actually being moved, in shoulder-widths/sec. */
const LIMB_GATE = 1.35;
/** How early in the flight a limb can intercept. Before this the ball is still
 *  "far away" and a save would look like it happened at nothing. */
const REACH_FROM = 0.5;
/** A save inside the last 10% of the flight is a scramble, and gets the big
 *  grade plus a sliver of hitstop. */
const CLOSE_FROM = 0.9;
/** Seconds the ball sits on the goal line before it counts as a goal.
 *
 *  wave-jump judges a wave over the whole stretch it crosses the player's
 *  feet rather than at one instant, for the same reason: a single-frame
 *  verdict fails the saves a child was genuinely making. This is the window
 *  where a late hand still gets there, and it is why a scramble is possible. */
const LINGER = 0.14;

/** The ball is orange on a green pitch: it must not share the theme hue. */
const BALL_HUE = 28;

const SHOTS = 4;
const SEGS = 4;

interface Shot {
  /** 0 free, 1 telegraphing, 2 in flight. */
  state: number;
  zone: number;
  aimT: number;
  aimT0: number;
  age: number;
  flight: number;
  /** Seconds left on the goal line before it counts. */
  linger: number;
  /** Signed lateral bow in px — the banana kick. */
  curve: number;
  faked: boolean;
  willFake: boolean;
  lx: number;
  ly: number;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  r: number;
  prog: number;
}

class GoalkeeperSave implements MiniGame {
  private ctx!: GameContext;
  private spawner!: Spawner;

  private readonly shots: Shot[] = [];
  private readonly zoneX = new Float32Array(9);
  private readonly zoneY = new Float32Array(9);
  /** Which row a zone is in: 0 high, 1 chest, 2 low. All three are hand rows. */
  private readonly zoneRow = new Uint8Array(9);
  private rigged = false;

  // The eight limb segments, as joint pairs. The distal end of a forearm is
  // the PALM, not the wrist: a child saves with their hand and the wrist
  // trails a hand-length behind it.
  private readonly segA = new Int8Array(SEGS);
  private readonly segB = new Int8Array(SEGS);
  private readonly segPalm = new Uint8Array(SEGS);
  private readonly segLeft = new Uint8Array(SEGS);
  private readonly palmPt: Pt = { x: 0, y: 0 };
  private readonly shoulder: Pt = { x: 0, y: 0 };

  private player: PlayerPose | null = null;
  /** Both shoulders in frame: the goal is laid out from them. */
  private shouldersOk = true;
  private armPx = 0;

  private goalL = 0;
  private goalR = 0;
  private goalT = 0;
  private goalB = 0;
  private ballR = 0;
  private glove = 0;
  private netShake = 0;
  private savePop = 0;

  private score = 0;
  private saves = 0;
  private goals = 0;
  private combo = 0;
  private bestCombo = 0;
  private time = 0;
  private lowTold = false;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.spawner = new Spawner(
      // ~45 shots (the pool of 4 caps the late bursts). Two at once only in
      // the last stretch, where the player already knows which hand goes where.
      { startInterval: 2.4, endInterval: 1.2, jitter: 0.2, burstLate: 2 },
      ctx.rng,
      manifest.durationMs / 1000,
    );

    const { w, h } = ctx.view;
    const g = Math.min(w, h);

    for (let i = 0; i < SHOTS; i++) {
      this.shots.push({
        state: 0, zone: 4, aimT: 0, aimT0: 1, age: 0, flight: 1, linger: 0,
        curve: 0, faked: false, willFake: false,
        lx: w / 2, ly: h * 0.2, x: w / 2, y: h * 0.2, prevX: w / 2, prevY: h * 0.2,
        r: 0, prog: 0,
      });
    }

    const A = [L.LEFT_SHOULDER, L.LEFT_ELBOW, L.RIGHT_SHOULDER, L.RIGHT_ELBOW];
    const B = [L.LEFT_ELBOW, L.LEFT_WRIST, L.RIGHT_ELBOW, L.RIGHT_WRIST];
    for (let i = 0; i < SEGS; i++) {
      this.segA[i] = A[i]!;
      this.segB[i] = B[i]!;
      this.segPalm[i] = i === 1 || i === 3 ? 1 : 0;
      this.segLeft[i] = i === 0 || i === 1 ? 1 : 0;
    }

    // A default goal, so frame one is never drawn around a body we have not
    // seen yet.
    this.layout(w / 2, h * 0.45, g * 0.3);
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.audio.music({ bpm: 118 });
  }

  /**
   * Place the nine zones and the frame from this player's own proportions,
   * in the LIVE view (the host keeps ctx.view current across resizes).
   *
   * Rows hang off the shoulder line, never the hips: 1.2 m from a laptop the
   * hips are below the frame and their landmarks are guesses. The low row is
   * a hand reaching down and out, which a waist-up child can do.
   */
  private layout(cx: number, shoulderY: number, armPx: number): void {
    const { w, h } = this.ctx.view;
    const g = Math.min(w, h);
    this.armPx = armPx;
    // Capped by the arm, so the goal shrinks with the body and a child far
    // from the camera is asked for the same stretch, not handed every save.
    this.ballR = Math.min(g * 0.055, armPx * 0.11);
    // A glove, not a fingertip: the save is tested against the limb segment
    // inflated by this, which is roughly a child's hand across.
    this.glove = Math.min(g * 0.045, armPx * 0.09);

    const mx = w * 0.05;
    const hi = shoulderY - armPx * 0.45;
    // Slide the whole goal down (spacing kept) until the top row clears the
    // DOM HUD band; a far-away child's shoulders sit high in the frame.
    const drop = Math.max(0, h * SAFE_TOP - hi);
    const yMax = h * 0.92;
    for (let i = 0; i < 9; i++) {
      const col = i % 3;
      const row = (i / 3) | 0;
      const ry = row === 0 ? hi : row === 1 ? shoulderY + armPx * 0.2 : shoulderY + armPx * 0.55;
      this.zoneX[i] = clamp(cx + (col - 1) * armPx * 1.15, mx, w - mx);
      this.zoneY[i] = Math.min(ry + drop, yMax);
      this.zoneRow[i] = row;
    }
    this.goalL = clamp(cx - armPx * 1.75, w * 0.02, w * 0.4);
    this.goalR = clamp(cx + armPx * 1.75, w * 0.6, w * 0.98);
    this.goalT = clamp(this.zoneY[0]! - armPx * 0.5, h * 0.18, h * 0.5);
    this.goalB = clamp(this.zoneY[6]! + armPx * 0.3, h * 0.5, h * 0.99);
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    if (this.netShake > 0) this.netShake = Math.max(0, this.netShake - dt * 2);
    if (this.savePop > 0) this.savePop = Math.max(0, this.savePop - dt * 3);

    const p = f.p1;
    this.player = p ?? null;
    if (p) {
      shoulderPx(p, this.shoulder);
      this.shouldersOk = visible(p, L.LEFT_SHOULDER, L.RIGHT_SHOULDER);
      // Rigged off the shoulders, not `conf`: conf averages in the hips, which
      // are out of frame for a waist-up child.
      if (!this.rigged && this.shouldersOk) {
        // Floored so a child far from the camera still gets zones a ball wide apart.
        const armPx = Math.max((p.calib.armLen > 0.5 ? p.calib.armLen : 1.6) * p.scalePx,
          Math.min(this.ctx.view.w, this.ctx.view.h) * 0.2);
        // The goal is pinned to the middle of the VIEW, not to the player: a
        // goal that follows the keeper cannot be beaten, and a child who
        // drifts sideways has to come back, which is the game.
        this.layout(this.ctx.view.w / 2, this.shoulder.y, armPx);
        this.rigged = true;
      }
    }

    for (let i = 0, k = this.spawner.tick(dt); i < k; i++) this.aim();
    this.advance(dt, p);
  }

  private aim(): void {
    const s = this.freeShot();
    if (!s) return;
    const d = this.spawner.difficulty;
    const { w, h } = this.ctx.view;

    s.zone = this.pickZone();
    // Telegraph 0.8s -> 0.35s. The floor is the whole-body reaction time of a
    // 7-year-old; below it the game stops being a test of anything.
    s.aimT0 = lerp(0.8, 0.35, d);
    s.aimT = s.aimT0;
    s.state = 1;
    s.age = 0;
    s.prog = 0;
    s.linger = LINGER;
    s.faked = false;
    s.willFake = d > 0.5 && chance(this.ctx.rng, 0.2);
    s.flight = lerp(0.72, 0.5, d);
    s.curve = d > 0.4 && chance(this.ctx.rng, 0.3)
      ? randRange(this.ctx.rng, 0.4, 0.75) * (chance(this.ctx.rng, 0.5) ? -1 : 1) * w * 0.12
      : 0;
    s.lx = w * 0.5 + randRange(this.ctx.rng, -0.14, 0.14) * w;
    // Inside the HUD safe area (x is 0.36..0.64w, so 0.18h is clear).
    s.ly = h * 0.2;
    s.x = s.lx;
    s.y = s.ly;
    s.prevX = s.lx;
    s.prevY = s.ly;
    s.r = this.ballR * 0.35;

    this.ctx.fx.telegraph(this.zoneX[s.zone]!, this.zoneY[s.zone]!, this.ballR * 2.4, {
      color: C.warn, secs: s.aimT0,
    });
    this.ctx.audio.play('charge', { gain: 0.26 });
    if (this.zoneRow[s.zone] === 2 && !this.lowTold) {
      this.lowTold = true;
      this.ctx.hud.toast(t('low'), { color: C.info });
    }
  }

  /**
   * Which of the nine. The low row is deliberately rarer than a third: a
   * hand reaching down and out is the slowest, most awkward save there is,
   * and a uniform nine meant a third of every round was a scramble before the
   * player had learned anything.
   */
  private pickZone(): number {
    const row = chance(this.ctx.rng, 0.22) ? 2 : chance(this.ctx.rng, 0.5) ? 0 : 1;
    return row * 3 + randInt(this.ctx.rng, 0, 2);
  }

  private freeShot(): Shot | null {
    for (let i = 0; i < this.shots.length; i++) {
      const s = this.shots[i]!;
      if (s.state === 0) return s;
    }
    return null;
  }

  private advance(dt: number, p: PlayerPose | undefined): void {
    for (let i = 0; i < this.shots.length; i++) {
      const s = this.shots[i]!;
      if (s.state === 0) continue;

      if (s.state === 1) {
        s.aimT -= dt;
        // The fake: the marker slides to a neighbour, with a sound, while
        // there is still time to move. A fake nobody can see is just a lie.
        if (s.willFake && !s.faked && s.aimT < s.aimT0 * 0.45) {
          s.faked = true;
          const row = this.zoneRow[s.zone]!;
          const col = s.zone % 3;
          s.zone = row * 3 + (col === 1 ? (chance(this.ctx.rng, 0.5) ? 0 : 2) : 1);
          this.ctx.audio.play('wobble', { gain: 0.4 });
          this.ctx.fx.telegraph(this.zoneX[s.zone]!, this.zoneY[s.zone]!, this.ballR * 2.2, {
            color: C.warn, secs: s.aimT,
          });
        }
        if (s.aimT <= 0) {
          s.state = 2;
          s.age = 0;
          this.ctx.audio.play('release', { gain: 0.45 });
        }
        continue;
      }

      s.age += dt;
      s.prog = clamp01(s.age / s.flight);
      this.place(s);
      if (s.prog >= 1) {
        s.linger -= dt;
        if (s.linger <= 0) {
          this.concede(s);
          continue;
        }
      }
      if (s.prog >= REACH_FROM && p) this.trySave(s, p);
    }
  }

  /** Straight line from the shooter to the zone, bowed by the banana kick,
   *  with the radius growing so "coming at you" reads without perspective. */
  private place(s: Shot): void {
    s.prevX = s.x;
    s.prevY = s.y;
    const zx = this.zoneX[s.zone]!;
    const zy = this.zoneY[s.zone]!;
    // Eased, because a ball that covers the last third of its flight at the
    // same speed as the first reads as floating.
    const k = lerp(s.prog, easeInQuad(s.prog), 0.55);
    const bx = lerp(s.lx, zx, k);
    const by = lerp(s.ly, zy, k);
    const bow = s.curve * Math.sin(s.prog * Math.PI);
    const dx = zx - s.lx;
    const dy = zy - s.ly;
    const len = Math.hypot(dx, dy) || 1;
    s.x = bx - (dy / len) * bow;
    s.y = by + (dx / len) * bow;
    s.r = this.ballR * lerp(0.35, 1, s.prog);
  }

  private trySave(s: Shot, p: PlayerPose): void {
    const rr = s.r + this.glove;
    for (let i = 0; i < SEGS; i++) {
      const a = this.segA[i]! as 0;
      const b = this.segB[i]! as 0;
      if (!visible(p, a, b)) continue;
      // Moving limbs only. A hand hanging at a child's side is in the goal
      // for the whole round and must never save anything.
      const sa = Math.hypot(p.v[a * 2]!, p.v[a * 2 + 1]!);
      const sb = Math.hypot(p.v[b * 2]!, p.v[b * 2 + 1]!);
      if (Math.max(sa, sb) < LIMB_GATE) continue;

      const ax = jx(p, a);
      const ay = jy(p, a);
      let bx: number;
      let by: number;
      if (this.segPalm[i] === 1) {
        palm(p, this.segLeft[i] === 1 ? 'L' : 'R', this.palmPt);
        bx = this.palmPt.x;
        by = this.palmPt.y;
      } else {
        bx = jx(p, b);
        by = jy(p, b);
      }
      // Swept both ways: the limb as a segment, and the ball's own travel
      // this frame, which is 60-100px near the end of a flight.
      if (!hitSegCircle(ax, ay, bx, by, s.x, s.y, rr)
        && !hitSegCircle(ax, ay, bx, by, s.prevX, s.prevY, rr)) continue;
      this.save(s, (ax + bx) / 2, (ay + by) / 2);
      return;
    }
  }

  private save(s: Shot, hx: number, hy: number): void {
    const close = s.prog >= CLOSE_FROM;
    s.state = 0;
    s.prog = 0;
    this.saves++;
    this.combo++;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    const bonus = Math.min(BONUS_MAX, Math.floor(this.combo / 4));
    const pts = PTS + bonus;
    this.score += pts;
    this.savePop = 1;

    this.ctx.fx.impact(s.x, s.y, close ? 'big' : 'hit', {
      color: THEME, sprite: 'burst', label: LABELS[bonus]!,
    });
    if (close) {
      // A fingertip save is the best thing that happens in this game, so it
      // gets the one piece of slow motion the round allows.
      this.ctx.fx.hitstop(0.06);
      this.ctx.hud.toast(t('superb'), { color: C.accent, big: true });
      this.ctx.audio.play('hit.hard', { gain: 0.7 });
    } else {
      this.ctx.audio.playLadder('hit.soft', this.combo);
    }
    this.ctx.fx.trail(hx, hy, s.x, s.y, { color: SAVE_TRAIL, life: 0.2 });
    this.ctx.hud.setScore(this.score);
    this.ctx.hud.setCombo(this.combo);
    this.ctx.emit({ kind: 'scored', points: pts });
  }

  /** A goal. Deliberately almost silent: the net wobbles, the counter moves,
   *  and the next shot is already being lined up. */
  private concede(s: Shot): void {
    s.state = 0;
    this.goals++;
    this.combo = 0;
    this.netShake = 1;
    this.ctx.hud.setCombo(0);
    this.ctx.fx.miss(s.x, s.y);
    this.ctx.audio.play('thud', { gain: 0.32 });
    this.ctx.emit({ kind: 'miss' });
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    const wob = this.netShake > 0 ? Math.sin(this.time * 34) * this.netShake * 7 * g.s : 0;

    // Pitch and goal. The frame is the only fixed furniture on screen, so it
    // carries the ink: posts and crossbar at full weight, net at a whisper.
    const gw = this.goalR - this.goalL;
    const gh = this.goalB - this.goalT;
    g.rect(this.goalL, this.goalT, gw, gh, { fill: NET_FILL });
    for (let i = 1; i < 6; i++) {
      const x = this.goalL + (gw * i) / 6;
      g.line(x + wob * 0.3, this.goalT, x, this.goalB, 2 * g.s, { stroke: NET_LINE });
    }
    for (let i = 1; i < 4; i++) {
      const y = this.goalT + (gh * i) / 4;
      g.line(this.goalL, y, this.goalR, y + wob * 0.3, 2 * g.s, { stroke: NET_LINE });
    }
    g.line(this.goalL, this.goalT, this.goalR, this.goalT, 9 * g.s, { stroke: C.ink });
    g.line(this.goalL, this.goalT, this.goalL, this.goalB, 9 * g.s, { stroke: C.ink });
    g.line(this.goalR, this.goalT, this.goalR, this.goalB, 9 * g.s, { stroke: C.ink });
    g.line(this.goalL, this.goalB, this.goalR, this.goalB, 4 * g.s, { stroke: GOAL_LINE });

    // The nine zones; the low row carries a down arrow: reach down for it.
    for (let i = 0; i < 9; i++) {
      const x = this.zoneX[i]!;
      const y = this.zoneY[i]!;
      const row = this.zoneRow[i]!;
      g.circle(x, y, this.ballR * 1.25, { stroke: ZONE_RING, sw: 3 * g.s });
      if (row === 2) {
        g.chevron(x, y + this.ballR * 0.5, this.ballR * 0.3, Math.PI / 2, { fill: ZONE_MARK });
      }
    }

    // Telegraphs, then balls, so a ball always draws over its own marker.
    for (let i = 0; i < this.shots.length; i++) {
      const s = this.shots[i]!;
      if (s.state !== 1) continue;
      const k = 1 - clamp01(s.aimT / Math.max(s.aimT0, 1e-3));
      const x = this.zoneX[s.zone]!;
      const y = this.zoneY[s.zone]!;
      g.circle(x, y, this.ballR * lerp(3.4, 1.3, k), { stroke: C.warn, sw: 6 * g.s });
      g.arc(x, y, this.ballR * 1.6, -Math.PI / 2, -Math.PI / 2 + k * TAU, {
        stroke: C.accent, sw: 5 * g.s,
      });
      g.circle(s.lx, s.ly, this.ballR * 0.3, { fill: SHOOTER });
    }

    for (let i = 0; i < this.shots.length; i++) {
      const s = this.shots[i]!;
      if (s.state !== 2) continue;
      g.line(s.prevX, s.prevY, s.x, s.y, s.r * 0.7, { stroke: BALL_TRAIL });
      g.sprite('circle', s.x, s.y, s.r * 2.2, {
        hue: BALL_HUE,
        rot: this.time * 6,
        glow: s.prog > CLOSE_FROM ? 12 : 0,
      });
      g.circle(s.x, s.y, s.r * 1.1, { stroke: C.ink, sw: 4 * g.s });
    }

    if (this.player) {
      g.ghostBody(this.player, 0.1);
      // Emphasise the hands: they are what saves, and a player who cannot
      // tell what the game is watching plays with their chest.
      g.skeleton(this.player, {
        alpha: 0.6,
        jointSet: 'ends',
        emphasize: EMPHASIZE,
        outline: true,
      });
    }

    if (this.savePop > 0) {
      g.save();
      g.alpha(this.savePop * 0.5);
      g.circle(this.shoulder.x, this.shoulder.y, this.ballR * (2 + pulse(this.savePop) * 3), {
        stroke: C.accent, sw: 5 * g.s,
      });
      g.restore();
    }

    // Only when the goal cannot be read off this body: shoulders out of frame.
    if (this.player && !this.shouldersOk) {
      g.text(t('hint'), g.w / 2, g.h * 0.22, {
        size: 36 * g.s, weight: 700, align: 'center', fill: C.text,
        stroke: C.bg, sw: 6 * g.s,
      });
    }
  }

  onResize(): void {
    // Re-pin the goal to the new view on the next good frame.
    this.rigged = false;
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.bestCombo >= 4) highlights.push(`연속 ${this.bestCombo}번 막았어요!`);
    if (this.goals === 0 && this.saves > 0) highlights.push('무실점!');
    return {
      gameId: manifest.id,
      cleared: this.saves > 0,
      rawScore: this.score,
      maxScore: manifest.scoring.maxScore,
      normalized: 0,
      stars: 0,
      durationMs: manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score: this.score,
        hits: this.saves, misses: this.goals, bestCombo: this.bestCombo,
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }

  dispose(): void {
    this.ctx.audio.stopMusic();
  }
}

export default (): MiniGame => new GoalkeeperSave();

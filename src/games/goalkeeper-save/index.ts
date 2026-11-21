// ─── goalkeeper-save — SHAPE B (continuous overlap), judged on LIMB SEGMENTS ─
//
// Every other overlap game in the catalogue tests a POINT (a palm, the top of
// the head) against a circle. A goalkeeper does not save with a point: the
// save is made by the whole forearm, the shin, the outstretched leg. So the
// test here is eight swept segment-vs-circle checks per ball, which is what
// makes a lunge feel like a lunge instead of a game of finding the pixel.
//
// Three decisions that shaped everything else:
//
// 1. THE TORSO DOES NOT SAVE. A child standing still in front of a camera has
//    their chest in the middle of the goal, so a torso that saves is a game
//    that scores a child for standing there — the exact phantom score the
//    smoke test exists to catch. Arms and legs save; the chest is where you
//    get beaten.
//
// 2. A LIMB ONLY SAVES WHILE IT IS MOVING (1.5 shoulder-widths/sec, measured
//    against an idle peak of 1.2 and a fidget peak of 2.0). Same reason, and
//    the same gate candy-rain-catch puts on its hands.
//
// 3. THE GOAL IS SIZED FROM THE PLAYER'S OWN ARM. The nine zones sit at
//    1.15 arm-lengths apart and the lowest row is at ankle height, so a small
//    child and a tall one are asked for the same stretch rather than the same
//    number of pixels.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { hipPx, jx, jy, L, palm, shoulderPx, visible } from '@/engine/pose/landmarks';
import { clamp, clamp01, easeInQuad, hitSegCircle, lerp, pulse, TAU } from '@/engine/math';
import { chance, randInt, randRange, Spawner } from '@/engine/spawn';
import { C, fade, hue } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

/** Goals conceded before the round is called. */
const MAX_GOALS = 5;
const PTS = 20;
const LABEL = '+20';

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

const SHOTS = 4;
const SEGS = 8;

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
  private reach!: Detector<'reach'>;
  private spawner!: Spawner;

  private readonly shots: Shot[] = [];
  private readonly zoneX = new Float32Array(9);
  private readonly zoneY = new Float32Array(9);
  /** Which row a zone is in: 0 hands, 1 either, 2 feet. */
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
  private readonly hip: Pt = { x: 0, y: 0 };

  private player: PlayerPose | null = null;
  private lowerOk = true;

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
    this.reach = ctx.gestures.use('reach', { side: 'both' });
    this.spawner = new Spawner(
      // ~26 shots. Two at once only in the last stretch, where the player
      // already knows which limb goes where.
      { startInterval: 2.4, endInterval: 1.2, jitter: 0.2, burstLate: 2 },
      ctx.rng,
      manifest.durationMs / 1000,
    );

    const { w, h } = ctx.view;
    const g = Math.min(w, h);
    this.ballR = g * 0.055;
    // A glove, not a fingertip: the save is tested against the limb segment
    // inflated by this, which is roughly a child's hand across.
    this.glove = g * 0.045;

    for (let i = 0; i < SHOTS; i++) {
      this.shots.push({
        state: 0, zone: 4, aimT: 0, aimT0: 1, age: 0, flight: 1, linger: 0,
        curve: 0, faked: false, willFake: false,
        lx: w / 2, ly: h * 0.1, x: w / 2, y: h * 0.1, prevX: w / 2, prevY: h * 0.1,
        r: this.ballR, prog: 0,
      });
    }

    const A = [L.LEFT_SHOULDER, L.LEFT_ELBOW, L.RIGHT_SHOULDER, L.RIGHT_ELBOW,
      L.LEFT_HIP, L.LEFT_KNEE, L.RIGHT_HIP, L.RIGHT_KNEE];
    const B = [L.LEFT_ELBOW, L.LEFT_WRIST, L.RIGHT_ELBOW, L.RIGHT_WRIST,
      L.LEFT_KNEE, L.LEFT_ANKLE, L.RIGHT_KNEE, L.RIGHT_ANKLE];
    for (let i = 0; i < SEGS; i++) {
      this.segA[i] = A[i]!;
      this.segB[i] = B[i]!;
      this.segPalm[i] = i === 1 || i === 3 ? 1 : 0;
      this.segLeft[i] = i === 0 || i === 1 || i === 4 || i === 5 ? 1 : 0;
    }

    // A default goal, so frame one is never drawn around a body we have not
    // seen yet.
    this.layout(w / 2, h * 0.34, h * 0.52, g * 0.3);
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.hud.setLives(MAX_GOALS, MAX_GOALS);
    this.ctx.audio.music({ bpm: 118 });
  }

  /** Place the nine zones and the frame from this player's own proportions. */
  private layout(cx: number, shoulderY: number, hipY: number, armPx: number): void {
    const { w, h } = this.ctx.view;
    const mx = w * 0.05;
    const my = h * 0.06;
    const rows = [
      shoulderY - armPx * 0.45,
      (shoulderY + hipY) / 2 + armPx * 0.3,
      hipY + armPx * 1.1,
    ];
    for (let i = 0; i < 9; i++) {
      const col = i % 3;
      const row = (i / 3) | 0;
      this.zoneX[i] = clamp(cx + (col - 1) * armPx * 1.15, mx, w - mx);
      this.zoneY[i] = clamp(rows[row]!, my, h - my);
      this.zoneRow[i] = row;
    }
    this.goalL = clamp(cx - armPx * 1.75, w * 0.02, w * 0.4);
    this.goalR = clamp(cx + armPx * 1.75, w * 0.6, w * 0.98);
    this.goalT = clamp(this.zoneY[0]! - armPx * 0.5, my * 0.4, h * 0.5);
    this.goalB = clamp(this.zoneY[6]! + armPx * 0.3, h * 0.5, h * 0.99);
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    if (this.netShake > 0) this.netShake = Math.max(0, this.netShake - dt * 2);
    if (this.savePop > 0) this.savePop = Math.max(0, this.savePop - dt * 3);

    const p = f.p1;
    this.player = p ?? null;
    this.reach.read(f);
    if (p) {
      shoulderPx(p, this.shoulder);
      hipPx(p, this.hip);
      this.lowerOk = visible(p, L.LEFT_HIP, L.RIGHT_HIP)
        && (visible(p, L.LEFT_KNEE) || visible(p, L.RIGHT_KNEE));
      if (!this.rigged && p.conf > 0.4) {
        const armPx = (p.calib.armLen > 0.5 ? p.calib.armLen : 1.6) * p.scalePx;
        // The goal is pinned to the middle of the VIEW, not to the player: a
        // goal that follows the keeper cannot be beaten, and a child who
        // drifts sideways has to come back, which is the game.
        this.layout(this.ctx.view.w / 2, this.shoulder.y, this.hip.y, armPx);
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
    s.ly = h * 0.08;
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
   * Which of the nine. The bottom row is deliberately rarer than a third:
   * a low ball needs a foot there, which is the slowest thing a child can
   * move, and a uniform nine meant a third of every round was unsaveable
   * before the player had learned anything.
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
    const pts = PTS + Math.floor(this.combo / 4);
    this.score += pts;
    this.savePop = 1;

    this.ctx.fx.impact(s.x, s.y, close ? 'big' : 'hit', {
      color: hue(manifest.theme!.hue), sprite: 'burst', label: LABEL,
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
    this.ctx.fx.trail(hx, hy, s.x, s.y, { color: fade(C.white, 0.7), life: 0.2 });
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
    this.ctx.hud.setLives(Math.max(0, MAX_GOALS - this.goals), MAX_GOALS);
    this.ctx.hud.setCombo(0);
    this.ctx.fx.miss(s.x, s.y);
    this.ctx.audio.play('thud', { gain: 0.32 });
    this.ctx.emit({ kind: 'miss' });
    if (this.goals >= MAX_GOALS) this.ctx.emit({ kind: 'clearEarly' });
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    const theme = hue(manifest.theme!.hue);
    const wob = this.netShake > 0 ? Math.sin(this.time * 34) * this.netShake * 7 * g.s : 0;

    // Pitch and goal. The frame is the only fixed furniture on screen, so it
    // carries the ink: posts and crossbar at full weight, net at a whisper.
    const gw = this.goalR - this.goalL;
    const gh = this.goalB - this.goalT;
    g.rect(this.goalL, this.goalT, gw, gh, { fill: fade(C.white, 0.35) });
    for (let i = 1; i < 6; i++) {
      const x = this.goalL + (gw * i) / 6;
      g.line(x + wob * 0.3, this.goalT, x, this.goalB, 2 * g.s, { stroke: fade(C.ink, 0.1) });
    }
    for (let i = 1; i < 4; i++) {
      const y = this.goalT + (gh * i) / 4;
      g.line(this.goalL, y, this.goalR, y + wob * 0.3, 2 * g.s, { stroke: fade(C.ink, 0.1) });
    }
    g.line(this.goalL, this.goalT, this.goalR, this.goalT, 9 * g.s, { stroke: C.ink });
    g.line(this.goalL, this.goalT, this.goalL, this.goalB, 9 * g.s, { stroke: C.ink });
    g.line(this.goalR, this.goalT, this.goalR, this.goalB, 9 * g.s, { stroke: C.ink });
    g.line(this.goalL, this.goalB, this.goalR, this.goalB, 4 * g.s, { stroke: fade(C.ink, 0.5) });

    // The nine zones, each marked with which end of the body it wants: a
    // chevron up for the hand rows, down for the foot row.
    for (let i = 0; i < 9; i++) {
      const x = this.zoneX[i]!;
      const y = this.zoneY[i]!;
      const row = this.zoneRow[i]!;
      g.circle(x, y, this.ballR * 1.25, { stroke: fade(C.ink, 0.14), sw: 2 * g.s });
      g.chevron(
        x, y + (row === 2 ? this.ballR * 0.5 : -this.ballR * 0.5), this.ballR * 0.26,
        row === 2 ? -Math.PI / 2 : Math.PI / 2,
        { fill: fade(C.ink, 0.16) },
      );
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
      g.circle(s.lx, s.ly, this.ballR * 0.3, { fill: fade(C.ink, 0.5) });
    }

    for (let i = 0; i < this.shots.length; i++) {
      const s = this.shots[i]!;
      if (s.state !== 2) continue;
      g.line(s.prevX, s.prevY, s.x, s.y, s.r * 0.7, { stroke: fade(theme, 0.3) });
      g.sprite('circle', s.x, s.y, s.r * 2.2, {
        hue: manifest.theme!.hue,
        rot: this.time * 6,
        glow: s.prog > CLOSE_FROM ? 12 : 0,
      });
    }

    if (this.player) {
      g.ghostBody(this.player, 0.1);
      // Emphasise the four limb ends: these are the parts that save, and a
      // player who cannot tell what the game is watching plays with their
      // chest.
      g.skeleton(this.player, {
        alpha: 0.6,
        jointSet: 'ends',
        emphasize: [L.LEFT_WRIST, L.RIGHT_WRIST, L.LEFT_ANKLE, L.RIGHT_ANKLE],
        outline: true,
      });
    }

    if (this.savePop > 0) {
      g.circle(this.shoulder.x, this.shoulder.y, this.ballR * (2 + pulse(this.savePop) * 3), {
        stroke: fade(C.accent, this.savePop * 0.5), sw: 5 * g.s,
      });
    }

    if (!this.lowerOk) {
      g.text(t('hint'), g.w / 2, g.h * 0.12, {
        size: 30 * g.s, weight: 700, align: 'center', fill: C.text,
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
      cleared: this.goals < MAX_GOALS,
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

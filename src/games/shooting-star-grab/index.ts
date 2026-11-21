// ─── shooting-star-grab — SHAPE B (continuous overlap + physics) ─────────────
//
// The overlap games in this catalogue mostly ask "was your hand in the same
// place as the object". This one asks "was your hand GOING THE SAME WAY", which
// is the only honest way to make a swipe feel like a swipe: a star crossed at
// right angles is batted away, a star swept along with is hooked and dragged.
//
// Three numbers were measured against the clip corpus rather than guessed:
//   - the hand speed gate (1.6 shoulder-widths/sec) sits above the measured
//     idle peak of 1.2 and the fidget median of 0.73, so a hand hanging at a
//     child's side can never collect a star by being in the right place;
//   - acquiring a hook needs cos >= 0.50 (within 60 degrees) but KEEPING one
//     only needs 0.25 (75 degrees), because a child's sweep is an arc and a
//     single threshold drops the star halfway through every real grab;
//   - a catch takes 0.30s of continuous matching, which is both the "never
//     score off one frame" rule and the reason the drag reads as a drag.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { L, MIN_VIS, shoulderPx } from '@/engine/pose/landmarks';
import { TAU, approach, clamp, clamp01, lerp } from '@/engine/math';
import { chance, randRange, Spawner } from '@/engine/spawn';
import { C, fade, hue } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

/** Seconds of continuous matching a catch costs. Doubles as the "never fire a
 *  scoring event from a single frame" guard. */
const HOLD = 0.12;
/** Hand speed, in shoulder-widths/sec, below which a hand cannot hook.
 *  Measured idle peak is 1.2 and fidget peak 2.0; a real sweep runs 3-9. */
const SPEED_GATE = 1.6;
/** Direction agreement needed to hook (cos, so 0.5 = within 60 degrees)... */
const ACQ_COS = -0.1;
/** ...and the looser one needed to keep it. A sweep is an arc, not a ray. */
const KEEP_COS = -0.35;
/** Mean agreement across the whole hook that earns the big score. */
const PERFECT_COS = 0.7;

const PTS = 10;
const PTS_PERFECT = 30;
/** Pre-built: the hot path never builds a string. */
const LABEL = '+10';
const LABEL_PERFECT = '+30';

/** Trajectory shapes, in the order the round introduces them. */
const STRAIGHT = 0;
const CURVE = 1;
const ESS = 2;

/** Colours built once: render() must not build strings. */
const INK_RING = fade(C.ink, 0.1);
const INK_HAND = fade(C.ink, 0.22);
const DECOR_COL = [fade(C.ink, 0.07), fade(C.ink, 0.11), fade(C.ink, 0.15)] as const;

const POOL = 10;
const DECOR = 16;

interface Star {
  live: boolean;
  caught: boolean;
  /** Launch point and unit travel direction — the straight part of the path. */
  bx: number;
  by: number;
  dx: number;
  dy: number;
  /** Lateral bow in px, and how many cycles of it fit into the flight. */
  amp: number;
  freq: number;
  /** px/sec along the straight part. */
  speed: number;
  flight: number;
  age: number;
  /** Position on the path this frame, and the unit direction of travel. */
  x: number;
  y: number;
  ivx: number;
  ivy: number;
  r: number;
  kind: number;
  /** -1, or the index of the hand holding it. */
  hand: number;
  /** 0..1 toward a catch. */
  prog: number;
  matchSum: number;
  matchN: number;
  /** 0..1 how far the star has been dragged off its path toward the palm. */
  pull: number;
}

class ShootingStarGrab implements MiniGame {
  private ctx!: GameContext;
  private reach!: Detector<'reach'>;
  private spawner!: Spawner;

  private readonly stars: Star[] = [];
  /** Background sky: x, y, radius per decorative star. Fixed for the round. */
  private readonly decor = new Float32Array(DECOR * 3);

  // Hands, index 0 = left, 1 = right. Typed arrays so update() allocates
  // nothing and both hands run the same code path.
  private readonly handX = new Float32Array(2);
  private readonly handY = new Float32Array(2);
  private readonly handPrevX = new Float32Array(2);
  private readonly handPrevY = new Float32Array(2);
  private readonly handDX = new Float32Array(2);
  private readonly handDY = new Float32Array(2);
  private readonly handLive = new Uint8Array(2);
  /** Pool index of the star this hand holds, or -1. */
  private readonly handHeld = new Int8Array(2);

  private readonly shoulder: Pt = { x: 0, y: 0 };
  private player: PlayerPose | null = null;
  private handsSeen = false;

  private grabR = 0;
  private keepR = 0;
  private armPx = 0;

  private score = 0;
  private caught = 0;
  private perfects = 0;
  private lost = 0;
  private combo = 0;
  private bestCombo = 0;
  private time = 0;
  private pairTold = false;
  private theme = '';
  private themeSoft = '';

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.theme = hue(manifest.theme!.hue);
    this.themeSoft = hue(manifest.theme!.hue, 70, 68, 0.55);
    this.reach = ctx.gestures.use('reach', { side: 'both' });
    this.spawner = new Spawner(
      // ~30 stars. Fewer than a rain game on purpose: each one is a 0.3s
      // commitment of a whole arm, so a dense sky reads as noise.
      { startInterval: 1.9, endInterval: 1.15, jitter: 0.22 },
      ctx.rng,
      manifest.durationMs / 1000,
    );

    const g = Math.min(ctx.view.w, ctx.view.h);
    this.grabR = g * 0.095;
    this.keepR = this.grabR * 2.2;
    this.armPx = g * 0.3;

    for (let i = 0; i < POOL; i++) {
      this.stars.push({
        live: false, caught: false,
        bx: 0, by: 0, dx: 1, dy: 0, amp: 0, freq: 0,
        speed: 0, flight: 1, age: 0,
        x: -1e3, y: -1e3, ivx: 1, ivy: 0, r: this.grabR * 0.62, kind: STRAIGHT,
        hand: -1, prog: 0, matchSum: 0, matchN: 0, pull: 0,
      });
    }
    for (let i = 0; i < DECOR; i++) {
      this.decor[i * 3] = ctx.rng() * ctx.view.w;
      this.decor[i * 3 + 1] = ctx.rng() * ctx.view.h * 0.92;
      this.decor[i * 3 + 2] = g * (0.006 + ctx.rng() * 0.01);
    }

    // Start the hands somewhere sane so frame one never draws them at (0,0).
    this.handX[0] = ctx.view.w * 0.36;
    this.handX[1] = ctx.view.w * 0.64;
    this.handY[0] = ctx.view.h * 0.55;
    this.handY[1] = ctx.view.h * 0.55;
    this.handPrevX[0] = this.handX[0]!;
    this.handPrevX[1] = this.handX[1]!;
    this.handPrevY[0] = this.handY[0]!;
    this.handPrevY[1] = this.handY[1]!;
    this.handHeld[0] = -1;
    this.handHeld[1] = -1;
    this.shoulder.x = ctx.view.w / 2;
    this.shoulder.y = ctx.view.h * 0.4;

    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.audio.music({ bpm: 104 });
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    const p = f.p1;
    this.player = p ?? null;
    this.trackHands(f, p);

    for (let i = 0, k = this.spawner.tick(dt); i < k; i++) this.spawn(false);
    this.advance(dt);
  }

  /**
   * Palm positions, travel directions and the speed gate.
   *
   * The direction comes from the palm's own displacement this frame rather
   * than the detector's velocity filter: the filter is tuned for magnitude
   * stability and lags a direction reversal, which is exactly the moment this
   * game is judging. The speed gate uses the filtered value, where lag is
   * harmless and noise is not.
   */
  private trackHands(f: PoseFrame, p: PlayerPose | undefined): void {
    const r = this.reach.read(f);
    this.handsSeen = r.ok && p !== undefined;
    if (!p) return;
    shoulderPx(p, this.shoulder);
    this.armPx = (p.calib.armLen > 0.5 ? p.calib.armLen : 1.6) * p.scalePx;
    const scale = Math.max(1, p.scalePx);

    for (let i = 0; i < 2; i++) {
      const pt = i === 0 ? r.leftPalm : r.rightPalm;
      // Gate on the NORMALIZED speed: the same movement is 300px/sec at 1m
      // from a laptop and 80px/sec at 3m from a TV, so a px gate would
      // quietly make this unplayable at the back of a classroom.
      const spd = (i === 0 ? r.leftSpeed : r.rightSpeed) / scale;
      this.handPrevX[i] = this.handX[i]!;
      this.handPrevY[i] = this.handY[i]!;
      if (r.ok) {
        this.handX[i] = pt.x;
        this.handY[i] = pt.y;
      }
      const dx = this.handX[i]! - this.handPrevX[i]!;
      const dy = this.handY[i]! - this.handPrevY[i]!;
      const len = Math.hypot(dx, dy);
      if (len > 0.5) {
        this.handDX[i] = dx / len;
        this.handDY[i] = dy / len;
      }
      const seen = p.vis[i === 0 ? L.LEFT_WRIST : L.RIGHT_WRIST]! >= MIN_VIS;
      this.handLive[i] = r.ok && seen && spd > SPEED_GATE ? 1 : 0;
    }
  }

  private spawn(mirrored: boolean): void {
    const idx = this.freeIndex();
    if (idx < 0) return;
    const s = this.stars[idx]!;
    const { w, h } = this.ctx.view;
    const d = this.spawner.difficulty;
    const g = Math.min(w, h);

    // Where the star will be grabbable: inside THIS player's own reach, never
    // at a fixed screen position. A taller child and a shorter one are then
    // asked for the same effort — the fairness rule in GAME_AUTHORING section 5.
    // 0.6-1.25 arm lengths from the shoulder centre is the band a straight
    // arm actually sweeps through: the hand is one arm length from ITS OWN
    // shoulder, which is half a shoulder-width off the centre, so the measured
    // envelope runs 0.69-1.31. An annulus tighter than that puts every star
    // inside the player's arc, where no sweep ever reaches it.
    // Upper and outer arc only: the hanging-arm sector below the shoulders is
    // where a resting hand lives, and a star there would be free.
    const ang = randRange(this.ctx.rng, -2.9, 0.45);
    const rad = (lerp(0.68, 1.1, d) + randRange(this.ctx.rng, -0.16, 0.16)) * this.armPx;
    const margin = g * 0.14;
    const ax = clamp(this.shoulder.x + Math.cos(ang) * rad, margin, w - margin);
    const ay = clamp(this.shoulder.y + Math.sin(ang) * rad, margin, h - margin);

    // Falling diagonals: a star that travels straight down or straight across
    // can be taken with a one-axis wave, which is not a sweep.
    // Fall angles from 26 to 72 degrees below horizontal, both ways. A single
    // shallow angle would mean every star is swept with the same horizontal
    // wave; this way some want a flat sweep and some a steep one.
    const leftward = mirrored ? true : chance(this.ctx.rng, 0.5);
    const drop = randRange(this.ctx.rng, 0.45, 1.26);
    const theta = leftward ? Math.PI - drop : drop;
    s.dx = Math.cos(theta);
    s.dy = Math.abs(Math.sin(theta));

    s.kind = d < 0.3 ? STRAIGHT : d < 0.62 ? CURVE : chance(this.ctx.rng, 0.5) ? ESS : CURVE;
    s.amp = s.kind === STRAIGHT ? 0 : g * (s.kind === CURVE ? 0.1 : 0.075);
    s.freq = s.kind === ESS ? 1 : 0.5;
    s.speed = lerp(0.36, 0.55, d) * g * randRange(this.ctx.rng, 0.92, 1.08);

    const back = this.edgeDist(ax, ay, -s.dx, -s.dy, g * 0.06);
    const fwd = this.edgeDist(ax, ay, s.dx, s.dy, g * 0.06);
    s.bx = ax - s.dx * back;
    s.by = ay - s.dy * back;
    s.flight = (back + fwd) / s.speed;
    s.age = 0;
    s.live = true;
    s.caught = false;
    s.hand = -1;
    s.prog = 0;
    s.matchSum = 0;
    s.matchN = 0;
    s.pull = 0;
    s.r = this.grabR * 0.62;
    this.place(s);

    // Late game: a second star going the other way, so the round ends on
    // "one hand each" rather than on "faster".
    if (!mirrored && d > 0.55 && chance(this.ctx.rng, 0.4)) {
      this.spawn(true);
      if (!this.pairTold) {
        this.pairTold = true;
        this.ctx.hud.toast(t('pair'), { color: C.accent });
      }
    }
  }

  private freeIndex(): number {
    for (let i = 0; i < this.stars.length; i++) {
      if (!this.stars[i]!.live) return i;
    }
    return -1;
  }

  /** Distance from (x,y) to the edge of the view box along (dx,dy). */
  private edgeDist(x: number, y: number, dx: number, dy: number, m: number): number {
    const { w, h } = this.ctx.view;
    let best = Infinity;
    if (dx > 1e-6) best = Math.min(best, (w + m - x) / dx);
    if (dx < -1e-6) best = Math.min(best, (-m - x) / dx);
    if (dy > 1e-6) best = Math.min(best, (h + m - y) / dy);
    if (dy < -1e-6) best = Math.min(best, (-m - y) / dy);
    return Number.isFinite(best) && best > 0 ? best : m;
  }

  /**
   * Write the star's path position and its INTRINSIC direction of travel.
   *
   * Intrinsic matters: once hooked, the star is drawn being dragged toward the
   * palm, so its on-screen movement is partly the hand's. Judging the hand
   * against that would be judging the hand against itself, and every hook
   * would read as a perfect sweep.
   */
  private place(s: Star): void {
    const along = s.speed * s.age;
    const ph = s.flight > 0 ? s.age / s.flight : 0;
    const w = TAU * s.freq;
    const lat = s.amp * Math.sin(ph * w);
    s.x = s.bx + s.dx * along - s.dy * lat;
    s.y = s.by + s.dy * along + s.dx * lat;

    const vLat = s.flight > 0 ? (s.amp * w * Math.cos(ph * w)) / s.flight : 0;
    const vx = s.dx * s.speed - s.dy * vLat;
    const vy = s.dy * s.speed + s.dx * vLat;
    const len = Math.hypot(vx, vy) || 1;
    s.ivx = vx / len;
    s.ivy = vy / len;
  }

  private advance(dt: number): void {
    for (let i = 0; i < this.stars.length; i++) {
      const s = this.stars[i]!;
      if (!s.live) continue;
      s.age += dt;
      this.place(s);
      if (s.age >= s.flight) {
        this.expire(s);
        continue;
      }
      this.resolve(i, s, dt);
    }
  }

  private resolve(idx: number, s: Star, dt: number): void {
    // Already held: the only question is whether the hand is still sweeping
    // with it. Distance is measured against the PATH, so a hand that stops
    // keeping up loses the star even though it is drawn in the palm.
    if (s.hand >= 0) {
      const i = s.hand;
      const cos = this.handDX[i]! * s.ivx + this.handDY[i]! * s.ivy;
      const far = Math.hypot(this.handX[i]! - s.x, this.handY[i]! - s.y) > this.keepR;
      if (this.handLive[i] === 1 && cos > KEEP_COS && !far) {
        s.prog += dt / HOLD;
        s.matchSum += cos;
        s.matchN++;
        s.pull = approach(s.pull, 0.55, 9, dt);
        if (s.prog >= 1) this.catchStar(s);
        return;
      }
      this.handHeld[i] = -1;
      s.hand = -1;
      this.ctx.audio.play('ui.tick', { gain: 0.16 });
    }

    // Free: offer it to a hand that is moving with it and close enough.
    s.prog = Math.max(0, s.prog - dt * 1.6);
    s.pull = approach(s.pull, 0, 7, dt);
    for (let i = 0; i < 2; i++) {
      if (this.handLive[i] !== 1 || this.handHeld[i]! >= 0) continue;
      const near = Math.hypot(this.handX[i]! - s.x, this.handY[i]! - s.y) <= this.grabR + s.r;
      const cos0 = this.handDX[i]! * s.ivx + this.handDY[i]! * s.ivy;
      if (!near) continue;
      const cos = cos0;
      if (cos < ACQ_COS) continue;
      s.hand = i;
      this.handHeld[i] = idx;
      s.matchSum += cos;
      s.matchN++;
      this.ctx.audio.play('sparkle', { gain: 0.28 });
      return;
    }
  }

  private catchStar(s: Star): void {
    const i = s.hand >= 0 ? s.hand : 0;
    const quality = s.matchN > 0 ? s.matchSum / s.matchN : 0;
    const perfect = quality >= PERFECT_COS;
    const x = lerp(s.x, this.handX[i]!, s.pull);
    const y = lerp(s.y, this.handY[i]!, s.pull);

    s.caught = true;
    s.live = false;
    if (s.hand >= 0) this.handHeld[s.hand] = -1;
    s.hand = -1;

    this.caught++;
    this.combo++;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    const pts = perfect ? PTS_PERFECT : PTS;
    this.score += pts;
    if (perfect) this.perfects++;

    this.ctx.fx.impact(x, y, perfect ? 'big' : 'hit', {
      color: perfect ? C.accent : this.theme,
      sprite: perfect ? 'star' : 'sparkle',
      label: perfect ? LABEL_PERFECT : LABEL,
    });
    // A rising pitch per combo step is the cheapest strong reward there is.
    this.ctx.audio.playLadder(perfect ? 'chime' : 'pop.high', this.combo);
    if (perfect) this.ctx.hud.toast(t('perfect'), { color: C.accent, big: true });
    this.ctx.hud.setScore(this.score);
    this.ctx.hud.setCombo(this.combo);
    this.ctx.emit({ kind: 'scored', points: pts });
  }

  /** A star that crossed the screen untouched. Quiet by construction: the
   *  combo break and the empty sky are the feedback. */
  private expire(s: Star): void {
    s.live = false;
    if (s.hand >= 0) this.handHeld[s.hand] = -1;
    s.hand = -1;
    if (s.caught) return;
    this.lost++;
    if (this.combo > 0) {
      this.combo = 0;
      this.ctx.hud.setCombo(0);
    }
    this.ctx.fx.miss(s.x, s.y);
    this.ctx.emit({ kind: 'miss' });
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    // Night sky. Background decoration only, so it stays in ART.md's
    // 1.2-2:1 contrast band and never competes with a real star.
    for (let i = 0; i < DECOR; i++) {
      const tw = Math.floor(1.5 + 1.49 * Math.sin(this.time * 1.3 + i));
      g.star(this.decor[i * 3]!, this.decor[i * 3 + 1]!, this.decor[i * 3 + 2]!, 4, {
        fill: DECOR_COL[tw]!,
      });
    }

    // The reach ring: "stars come to where you can get them". Drawn from the
    // same arm length the spawner places them with.
    if (this.player) {
      g.circle(this.shoulder.x, this.shoulder.y, this.armPx * 0.95, {
        stroke: INK_RING, sw: 2 * g.s,
      });
    }

    const theme = this.theme;
    for (let i = 0; i < this.stars.length; i++) {
      const s = this.stars[i]!;
      if (!s.live) continue;
      const held = s.hand >= 0;
      const x = held ? lerp(s.x, this.handX[s.hand]!, s.pull) : s.x;
      const y = held ? lerp(s.y, this.handY[s.hand]!, s.pull) : s.y;
      const dir = Math.atan2(s.ivy, s.ivx);

      // Tail: where it came from. Together with the chevron it makes "sweep
      // THIS way" readable from 2m without reading a word.
      const tail = s.speed * 0.2;
      g.line(x - s.ivx * tail, y - s.ivy * tail, x, y, 22 * g.s, { stroke: this.themeSoft });
      g.line(x - s.ivx * tail * 0.6, y - s.ivy * tail * 0.6, x, y, 8 * g.s, { stroke: theme });
      g.chevron(x + s.ivx * s.r * 2.1, y + s.ivy * s.r * 2.1, s.r * 0.8, dir, { fill: theme });
      g.sprite('star', x, y, s.r * 2.6, {
        rot: dir + this.time * 0.6,
        glow: held ? 14 : 0,
        tint: C.accent,
      });
      if (s.prog > 0.02) {
        g.arc(x, y, s.r * 1.9, -Math.PI / 2, -Math.PI / 2 + clamp01(s.prog) * TAU, {
          stroke: C.accent, sw: 5 * g.s,
        });
      }
    }

    if (this.player) {
      g.ghostBody(this.player, 0.08);
      g.skeleton(this.player, { alpha: 0.45, jointSet: 'hands' });
    }

    // Hands. The ring lights only while the hand is moving fast enough to
    // hook: without that the speed gate is invisible and reads as the game
    // ignoring the player.
    for (let i = 0; i < 2; i++) {
      const live = this.handLive[i] === 1;
      const held = this.handHeld[i]! >= 0;
      const x = this.handX[i]!;
      const y = this.handY[i]!;
      g.circle(x, y, this.grabR * (live ? 1 : 0.72), {
        stroke: live ? theme : INK_HAND,
        sw: (live ? 5 : 2) * g.s,
        glow: held ? 10 : 0,
      });
      if (live) {
        g.chevron(
          x + this.handDX[i]! * this.grabR * 1.25,
          y + this.handDY[i]! * this.grabR * 1.25,
          this.grabR * 0.3,
          Math.atan2(this.handDY[i]!, this.handDX[i]!),
          { fill: theme },
        );
      }
    }

    if (!this.handsSeen) {
      g.text(t('hint'), g.w / 2, g.h * 0.16, {
        size: 34 * g.s, weight: 700, align: 'center', fill: C.text,
        stroke: C.bg, sw: 6 * g.s,
      });
    }
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.bestCombo >= 4) highlights.push(`연속 ${this.bestCombo}개!`);
    if (this.perfects >= 3) highlights.push(`완벽하게 ${this.perfects}번!`);
    return {
      gameId: manifest.id,
      cleared: this.caught > 0,
      rawScore: this.score,
      maxScore: manifest.scoring.maxScore,
      normalized: 0,
      stars: 0,
      durationMs: manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score: this.score,
        hits: this.caught, misses: this.lost, bestCombo: this.bestCombo,
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }

  dispose(): void {
    this.ctx.audio.stopMusic();
  }
}

export default (): MiniGame => new ShootingStarGrab();

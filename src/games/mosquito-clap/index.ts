// ─── REFERENCE GAME — SHAPE A (discrete trigger) ─────────────────────────────
//
// Roughly 22 games in the catalogue are this shape: a gesture fires, and you
// test it against objects on screen. Read this whole file before writing one.
//
// It exercises every engine surface exactly once — a rented Trigger detector,
// screen-space joint positions, pooled entities, a seeded spawn ramp, combo
// scoring, HUD, the five juice calls, and engine-computed stars — while being
// physically trivial: no gravity, no scrolling, no beat, no pose library.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { L, palm } from '@/engine/pose/landmarks';
import { clamp01, dist, easeOutBack, pulse, TAU } from '@/engine/math';
import { Entities } from '@/engine/entities';
import { chance, randRange, Spawner } from '@/engine/spawn';
import { C, fade, hue } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

/** Entity kinds. Plain numbers, because entities are typed arrays. */
const MOSQUITO = 0;
const BEE = 1;

/** Highlighted on the skeleton: "these are the parts that matter". */
const HANDS = [L.LEFT_WRIST, L.RIGHT_WRIST] as const;

const LABELS = ['+0', '+1', '+2', '+3', '+4', '+5', '+6', '+7', '+8'] as const;
const POINTS = 2;
/** Every 4th catch in a row is worth an extra point. */
const COMBO_STEP = 4;
/** Palm ring colour, built once rather than once per frame. */
const HAND_RING = hue(manifest.theme?.hue ?? 142, 80, 70);

class MosquitoClap implements MiniGame {
  private ctx!: GameContext;
  private clap!: Detector<'clap'>;
  private spawner!: Spawner;

  // Everything below is allocated HERE, in the field initialisers and init().
  // update() and render() allocate nothing at all.
  private readonly bugs = new Entities(40);
  private readonly handL: Pt = { x: 0, y: 0 };
  private readonly handR: Pt = { x: 0, y: 0 };
  private readonly clapAt: Pt = { x: 0, y: 0 };
  /** Last seen player, so render() can draw the body. render() must never call
   *  a detector's read(): it can run between fixed updates. */
  private player: PlayerPose | null = null;

  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private hits = 0;
  private misses = 0;
  /** Seconds left on the clap flourish, for the render pass. */
  private flash = 0;
  private flashGood = false;
  private time = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // A rented detector carries hysteresis, a closing-speed gate, confirm
    // frames and a refractory period. Hand-rolled threshold code is where
    // double-scoring lives.
    this.clap = ctx.gestures.use('clap', { cooldownMs: 280 });
    this.spawner = new Spawner(
      { startInterval: 1.5, endInterval: 0.65, jitter: 0.35, burstLate: 2 },
      ctx.rng,
      manifest.durationMs / 1000,
    );
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.audio.music({ bpm: 108 });
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt);

    for (let i = 0, k = this.spawner.tick(dt); i < k; i++) this.spawn();
    this.fly(dt);

    const p = f.p1;
    this.player = p ?? null;
    if (p) {
      palm(p, 'L', this.handL);
      palm(p, 'R', this.handR);
      const c = this.clap.read(f);
      if (c.fired) {
        this.clapAt.x = c.at.x;
        this.clapAt.y = c.at.y;
        this.resolve(c.power);
      }
    }

    this.bugs.sweep();
  }

  /** Wandering flight. Each bug carries its own phase in `data`, so no state
   *  lives outside the pool and nothing is allocated per frame. */
  private fly(dt: number): void {
    const { w, h } = this.ctx.view;
    const speed = 1 + this.spawner.difficulty * 0.8;
    for (let i = 0; i < this.bugs.n; i++) {
      const phase = this.bugs.data[i]!;
      const wobble = Math.sin(this.time * 3.1 + phase) * 48;
      this.bugs.vx[i] = this.bugs.vx[i]! + Math.cos(this.time * 1.7 + phase) * 26 * dt;
      this.bugs.vy[i] = this.bugs.vy[i]! + (wobble - this.bugs.vy[i]!) * 1.4 * dt;
      // Steer back inside rather than bouncing: a bug that leaves the frame is
      // a bug the player cannot reach, and this game has no misses to spare.
      const m = w * 0.08;
      // The top edge is the DOM HUD's: its band (~0.17h), and the score +
      // combo column on the left quarter. A bug behind the HUD is invisible.
      const top = (this.bugs.x[i]! < w * 0.25 ? h * 0.26 : h * 0.18) + this.bugs.r[i]!;
      if (this.bugs.x[i]! < m) this.bugs.vx[i] = Math.abs(this.bugs.vx[i]!) + 10;
      if (this.bugs.x[i]! > w - m) this.bugs.vx[i] = -Math.abs(this.bugs.vx[i]!) - 10;
      if (this.bugs.y[i]! < top) this.bugs.vy[i] = Math.abs(this.bugs.vy[i]!) + 10;
      if (this.bugs.y[i]! > h * 0.85) this.bugs.vy[i] = -Math.abs(this.bugs.vy[i]!) - 10;
      // Clamp so a long round cannot accelerate a bug past catchable.
      const vmax = 150 * speed;
      if (this.bugs.vx[i]! > vmax) this.bugs.vx[i] = vmax;
      if (this.bugs.vx[i]! < -vmax) this.bugs.vx[i] = -vmax;
      this.bugs.rot[i] = Math.sin(this.time * 12 + phase) * 0.25;
    }
    this.bugs.step(dt);
  }

  private spawn(): void {
    const { w, h } = this.ctx.view;
    const d = this.spawner.difficulty;
    // Bees arrive only once the player has the rhythm, and stay rare: this is
    // a 7-year-old's first game of the party.
    const bee = d > 0.35 && chance(this.ctx.rng, 0.18);
    const r = Math.min(w, h) * (bee ? 0.07 : 0.066);
    const i = this.bugs.spawn(
      randRange(this.ctx.rng, w * 0.15, w * 0.85),
      randRange(this.ctx.rng, h * 0.26 + r, h * 0.75),
      randRange(this.ctx.rng, -60, 60),
      randRange(this.ctx.rng, -30, 30),
      r,
      bee ? 7 : 9,
      bee ? BEE : MOSQUITO,
    );
    if (i >= 0) this.bugs.data[i] = this.ctx.rng() * TAU;
  }

  private resolve(power: number): void {
    const g = Math.min(this.ctx.view.w, this.ctx.view.h);
    // The clap's reach is generous on purpose: a child aims with both hands
    // meeting somewhere in front of them, not at a pixel.
    const reach = g * 0.14;
    this.flash = 0.35;

    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.bugs.n; i++) {
      const d = dist(this.clapAt.x, this.clapAt.y, this.bugs.x[i]!, this.bugs.y[i]!);
      if (d < bestD && d <= reach + this.bugs.r[i]!) { bestD = d; best = i; }
    }

    if (best < 0) {
      // A whiff is SILENT. No red X, no buzzer: repeated failure indicators
      // make this age group quit inside a minute.
      this.flashGood = false;
      this.combo = 0;
      this.ctx.hud.setCombo(0);
      return;
    }

    const x = this.bugs.x[best]!;
    const y = this.bugs.y[best]!;
    const isBee = this.bugs.kind[best] === BEE;
    this.bugs.kill(best);
    this.flashGood = !isBee;

    if (isBee) {
      this.misses++;
      this.combo = 0;
      this.ctx.hud.setCombo(0);
      this.ctx.hud.toast(t('bee'), { color: C.info });
      this.ctx.audio.play('miss', { gain: 0.25 });
      // Quiet by construction: the engine refuses to shake or flash here.
      this.ctx.fx.miss(x, y);
      this.ctx.emit({ kind: 'miss' });
      return;
    }

    this.hits++;
    this.combo++;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    const points = POINTS + Math.floor(this.combo / COMBO_STEP);
    this.score += points;

    // One call, one grade. Particles, ring, shake, hitstop, squash and the
    // floating score all land together at the catalogue's standard weight —
    // and the engine, not this game, decides whether hitstop is safe here.
    this.ctx.fx.impact(x, y, this.combo >= 8 ? 'big' : 'hit', {
      color: C.success,
      sprite: 'sparkle',
      label: LABELS[Math.min(points, LABELS.length - 1)]!,
    });
    // Rising pitch per combo step: the cheapest strong reward signal there is.
    this.ctx.audio.playLadder('pop', this.combo);
    if (this.combo > 0 && this.combo % COMBO_STEP === 0) {
      this.ctx.audio.play('combo.up');
      this.ctx.hud.toast(this.combo >= 8 ? t('wow') : t('nice'), { color: C.accent });
    }
    this.ctx.hud.setScore(this.score);
    this.ctx.hud.setCombo(this.combo);
    this.ctx.emit({ kind: 'scored', points });
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    // Always draw the body. Even with latency, visible response to movement
    // reads as "it can see me"; a game that draws nothing reads as broken.
    if (this.player) g.ghostBody(this.player, 0.1);
    if (this.player) g.skeleton(this.player, { alpha: 0.45, emphasize: HANDS });

    for (let i = 0; i < this.bugs.n; i++) {
      const x = this.bugs.x[i]!;
      const y = this.bugs.y[i]!;
      const r = this.bugs.r[i]!;
      const age = this.bugs.age(i);
      // Pop in, fade out. Nothing in this project ever simply appears.
      const grow = age < 0.1 ? easeOutBack(age / 0.1) : 1;
      const leaving = age > 0.88 ? 1 - (age - 0.88) / 0.12 : 1;
      g.save();
      g.alpha(clamp01(leaving));
      const bee = this.bugs.kind[i] === BEE;
      // A ring behind the bug, so it reads against a busy skeleton overlay.
      g.circle(x, y, r * 1.25 * grow, {
        stroke: bee ? C.warn : fade(C.white, 0.35),
        sw: bee ? 4 * g.s : 2 * g.s,
      });
      g.sprite(bee ? 'bee' : 'mosquito', x, y, r * 2.2 * grow, { rot: this.bugs.rot[i]! });
      g.restore();
    }

    // The hands, drawn on the PALMS: a child aims with their hand, and the
    // wrist trails a hand-length behind it.
    this.drawHand(g, this.handL);
    this.drawHand(g, this.handR);

    // The clap flourish: a ring where the hands met, so the player can see
    // exactly where the game thought they clapped.
    if (this.flash > 0) {
      const k = this.flash / 0.35;
      g.circle(this.clapAt.x, this.clapAt.y, Math.min(g.w, g.h) * 0.14 * (1.1 - k * 0.5), {
        stroke: this.flashGood ? C.success : fade(C.white, 0.5),
        sw: (this.flashGood ? 6 : 3) * g.s,
      });
      if (this.flashGood) {
        g.star(this.clapAt.x, this.clapAt.y, 26 * g.s * pulse(1 - k), 5, { fill: C.accent });
      }
    }
  }

  private drawHand(g: Renderer, p: Pt): void {
    g.circle(p.x, p.y, 22 * g.s, { stroke: HAND_RING, sw: 3 * g.s, glow: 10 });
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.bestCombo >= COMBO_STEP) highlights.push(`콤보 ${this.bestCombo}연속!`);
    if (this.hits >= 12) highlights.push(`모기 ${this.hits}마리 잡았어요`);
    return {
      gameId: manifest.id,
      cleared: this.hits > 0,
      rawScore: this.score,
      maxScore: manifest.scoring.maxScore,
      // The ENGINE computes these from starCuts, so the rating means the same
      // thing across all 58 games. Leave them at 0.
      normalized: 0,
      stars: 0,
      durationMs: manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score: this.score,
        hits: this.hits, misses: this.misses, bestCombo: this.bestCombo,
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }

  dispose(): void {
    this.ctx.audio.stopMusic();
    this.bugs.clear();
  }
}

export default (): MiniGame => new MosquitoClap();

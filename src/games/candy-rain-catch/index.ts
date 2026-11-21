// ─── REFERENCE GAME — SHAPE B (continuous overlap) ───────────────────────────
//
// ~12 games in the catalogue are this shape: objects move under their own
// physics, body parts overlap them, and MISSING has a consequence. Read this
// whole file before writing one.
//
// What it demonstrates that Shape A does not: gravity and per-frame overlap
// (no discrete gesture anywhere), several catchers at once, a miss path that
// stays kind, and difficulty that ramps by forcing the player to use the head
// basket AND both hands rather than by simply going faster.
import type {
  EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { headTopPx, jx, L, palm, palmSpeedPx } from '@/engine/pose/landmarks';
import { clamp01, easeOutBack, hitCircles, lerp } from '@/engine/math';
import { Entities } from '@/engine/entities';
import { chance, randRange, Spawner } from '@/engine/spawn';
import { C, fade, hue } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

const CANDY = 0;
const GOLD = 1;
const ROCK = 2;

const LIVES = 5;
/**
 * Falling columns. EVEN on purpose: an odd lane count puts a column dead
 * centre, so a child who never moves still collects a fifth of the sweets in
 * their head basket. With four lanes nothing falls down the middle and the
 * score has to be earned by moving.
 */
const LANES = 4;

const VALUE = [3, 10, 0] as const;

class CandyRainCatch implements MiniGame {
  private ctx!: GameContext;
  private spawner!: Spawner;

  private readonly drops = new Entities(56);
  private readonly basket: Pt = { x: 0, y: 0 };
  private readonly handL: Pt = { x: 0, y: 0 };
  private readonly handR: Pt = { x: 0, y: 0 };
  private player: PlayerPose | null = null;
  /** Hands only catch while they are actually being moved. A hand hanging at
   *  the player's side would otherwise sweep up a third of the sweets while
   *  the child stands perfectly still. */
  private handLive = { l: false, r: false };

  private score = 0;
  private caught = 0;
  private dropped = 0;
  private lives = LIVES;
  private combo = 0;
  private bestCombo = 0;
  private time = 0;
  /** Squash on the basket when it catches something, 0..1. */
  private basketPop = 0;
  private basketR = 0;
  private handR_ = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    const g = Math.min(ctx.view.w, ctx.view.h);
    this.basketR = g * 0.068;
    this.handR_ = g * 0.055;
    this.spawner = new Spawner(
      // ~55 sweets in a round, not 85: a child who misses two thirds of
      // everything reads the round as failing even while their score climbs.
      { startInterval: 1.4, endInterval: 0.6, jitter: 0.25, burstMid: 1, burstLate: 2 },
      ctx.rng,
      manifest.durationMs / 1000,
    );
    // Start the basket centred so the first frame is never drawn at (0,0).
    this.basket.x = ctx.view.w / 2;
    this.basket.y = ctx.view.h * 0.3;
    this.handL.x = ctx.view.w * 0.35;
    this.handR.x = ctx.view.w * 0.65;
    this.handL.y = this.handR.y = ctx.view.h * 0.55;
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.hud.setLives(this.lives, LIVES);
    this.ctx.audio.music({ bpm: 120 });
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    if (this.basketPop > 0) this.basketPop = Math.max(0, this.basketPop - dt * 3.5);

    for (let i = 0, k = this.spawner.tick(dt); i < k; i++) this.spawnDrop();

    // Gravity scales with the view so the fall FEELS the same on a laptop and
    // a TV; a fixed px/s² is twice as fast on half the screen.
    const g = Math.min(this.ctx.view.w, this.ctx.view.h);
    this.drops.step(dt, g * 0.55);

    const p = f.p1;
    this.player = p ?? null;
    if (p) this.trackCatchers(p);

    this.resolveCatches();
    this.resolveFloor();
    this.drops.sweep();
  }

  /** The head basket rides on top of the head; the hands are secondary
   *  catchers. Three catchers is what makes the late game need the whole body
   *  rather than just a fast sidestep. */
  private trackCatchers(p: PlayerPose): void {
    this.basket.x = jx(p, L.NOSE);
    this.basket.y = headTopPx(p) - this.basketR * 0.5;
    palm(p, 'L', this.handL);
    palm(p, 'R', this.handR);
    const gate = Math.min(this.ctx.view.w, this.ctx.view.h) * 0.25; // px/sec
    this.handLive.l = palmSpeedPx(p, 'L') > gate;
    this.handLive.r = palmSpeedPx(p, 'R') > gate;
  }

  private spawnDrop(): void {
    const { w, h } = this.ctx.view;
    const d = this.spawner.difficulty;
    // Rocks arrive only once the player has the rhythm, and stay a minority.
    const kind = d > 0.3 && chance(this.ctx.rng, 0.16)
      ? ROCK
      : chance(this.ctx.rng, 0.12) ? GOLD : CANDY;
    // Quantised lanes, widening as the round goes on, so early sweets land
    // near the middle and late ones demand real movement.
    const spread = lerp(0.72, 1.0, d);
    const lane = Math.floor(this.ctx.rng() * LANES) / (LANES - 1);
    const x = w * (0.5 + (lane - 0.5) * spread);
    const r = Math.min(w, h) * (kind === ROCK ? 0.045 : 0.038);
    const i = this.drops.spawn(
      x, -r * 2,
      randRange(this.ctx.rng, -20, 20), randRange(this.ctx.rng, 0, 40),
      r, 12, kind,
    );
    if (i >= 0) this.drops.data[i] = this.ctx.rng() * 6.28;
  }

  private resolveCatches(): void {
    for (let i = this.drops.n - 1; i >= 0; i--) {
      const x = this.drops.x[i]!;
      const y = this.drops.y[i]!;
      const r = this.drops.r[i]!;
      const inBasket = hitCircles(x, y, r, this.basket.x, this.basket.y, this.basketR);
      const inHand =
        (this.handLive.l && hitCircles(x, y, r, this.handL.x, this.handL.y, this.handR_)) ||
        (this.handLive.r && hitCircles(x, y, r, this.handR.x, this.handR.y, this.handR_));
      if (!inBasket && !inHand) continue;

      const kind = this.drops.kind[i]!;
      this.drops.kill(i);

      if (kind === ROCK) {
        // A caught rock costs a life, but the feedback is a soft "앗" rather
        // than a punishment: this age group quits on repeated failure cues.
        this.lives--;
        this.combo = 0;
        this.ctx.hud.setLives(this.lives, LIVES);
        this.ctx.hud.setCombo(0);
        this.ctx.hud.toast(t('oops'), { color: C.warn });
        this.ctx.audio.play('thud', { gain: 0.6 });
        this.ctx.fx.burst(x, y, { count: 10, color: C.warn, emoji: '💥', speed: 260 });
        this.ctx.fx.shake(0.12);
        this.ctx.emit({ kind: 'miss' });
        if (this.lives <= 0) this.ctx.emit({ kind: 'clearEarly' });
        continue;
      }

      this.caught++;
      this.combo++;
      if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      const gold = kind === GOLD;
      this.score += VALUE[kind]! + Math.floor(this.combo / 5);
      this.basketPop = inBasket ? 1 : this.basketPop;

      this.ctx.fx.burst(x, y, {
        count: gold ? 22 : 12,
        color: gold ? C.accent : hue(manifest.theme!.hue),
        emoji: gold ? '⭐' : '✨',
        speed: 320,
        gravity: 400,
      });
      this.ctx.fx.popText(x, y, `+${VALUE[kind]!}`, gold ? C.accent : C.white);
      if (gold) {
        this.ctx.hud.toast(t('golden'), { color: C.accent, big: true });
        this.ctx.audio.play('bonus');
        this.ctx.fx.shake(0.1);
      } else {
        this.ctx.audio.playLadder('pop.high', this.combo);
      }
      this.ctx.hud.setScore(this.score);
      this.ctx.hud.setCombo(this.combo);
      this.ctx.emit({ kind: 'scored', points: VALUE[kind]! });
    }
  }

  /** A sweet that reaches the floor is gone. Rocks landing are a relief, not a
   *  failure, so they cost nothing. */
  private resolveFloor(): void {
    const floor = this.ctx.view.h * 0.94;
    for (let i = this.drops.n - 1; i >= 0; i--) {
      if (this.drops.y[i]! < floor) continue;
      const kind = this.drops.kind[i]!;
      const x = this.drops.x[i]!;
      this.drops.kill(i);
      if (kind === ROCK) continue;
      this.dropped++;
      this.combo = 0;
      this.ctx.hud.setCombo(0);
      // Silent: a small puff where it fell, nothing more.
      this.ctx.fx.burst(x, floor, { count: 5, color: fade(C.white, 0.5), speed: 120, life: 0.35 });
    }
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    // The floor line, so "where sweets are lost" is never ambiguous.
    const floor = g.h * 0.94;
    g.line(0, floor, g.w, floor, 3 * g.s, { stroke: fade(C.white, 0.18) });

    if (this.player) g.ghostBody(this.player, 0.08);
    if (this.player) g.skeleton(this.player, { alpha: 0.4 });

    for (let i = 0; i < this.drops.n; i++) {
      const x = this.drops.x[i]!;
      const y = this.drops.y[i]!;
      const r = this.drops.r[i]!;
      const kind = this.drops.kind[i]!;
      const spin = this.drops.data[i]! + this.time * 2;
      if (kind === GOLD) {
        // A halo, so the valuable one is readable at a glance from 2m.
        g.circle(x, y, r * 1.7, { stroke: fade(C.accent, 0.5), sw: 3 * g.s, glow: 12 });
      }
      g.emoji(kind === ROCK ? '🪨' : kind === GOLD ? '🍯' : '🍬', x, y, r * 2.2, Math.sin(spin) * 0.3);
    }

    // The basket, with a squash when it catches.
    const pop = easeOutBack(clamp01(this.basketPop));
    const br = this.basketR * (1 + pop * 0.18);
    g.save();
    g.translate(this.basket.x, this.basket.y);
    g.scale(1 + pop * 0.12, 1 - pop * 0.1);
    g.emoji('🧺', 0, 0, br * 2.1);
    g.restore();

    // Hands glow only while they are moving fast enough to catch. Without
    // this the speed gate is invisible and reads as the game ignoring you.
    const hr = this.handR_;
    const hands: [Pt, boolean][] = [[this.handL, this.handLive.l], [this.handR, this.handLive.r]];
    for (const [p, live] of hands) {
      g.circle(p.x, p.y, hr * (live ? 1 : 0.7), {
        stroke: live ? hue(manifest.theme?.hue ?? 320, 90, 72) : fade(C.white, 0.22),
        sw: (live ? 4 : 2) * g.s,
        glow: live ? 12 : 0,
      });
    }
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.bestCombo >= 5) highlights.push(`연속 ${this.bestCombo}개!`);
    if (this.dropped === 0 && this.caught > 0) highlights.push('하나도 안 흘렸어요!');
    return {
      gameId: manifest.id,
      cleared: this.lives > 0,
      rawScore: this.score,
      maxScore: manifest.scoring.maxScore,
      normalized: 0,
      stars: 0,
      durationMs: manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score: this.score,
        hits: this.caught, misses: this.dropped, bestCombo: this.bestCombo,
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }

  dispose(): void {
    this.ctx.audio.stopMusic();
    this.drops.clear();
  }
}

export default (): MiniGame => new CandyRainCatch();

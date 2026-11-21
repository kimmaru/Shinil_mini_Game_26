// SPIDER-TOUCH — Shape A (discrete trigger), accuracy variant: no speed gate,
// the hand just has to arrive inside the dot's radius.
//
// FAIRNESS: every dot's distance from the player is a fraction of THIS
// player's own single-arm reach (`calib.armSpan / 2`, ~= armLen + half a
// shoulder width — the distance a straight arm covers from the chest), not a
// screen position. A shorter child at 0.95x is stretching exactly as much as
// a taller one. See docs/GAME_AUTHORING.md §5.
import type {
  EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { L, palm, shoulderPx } from '@/engine/pose/landmarks';
import { clamp01, easeOutBack, hitCircle, lerp, TAU } from '@/engine/math';
import { Entities } from '@/engine/entities';
import { chance, randRange, Spawner } from '@/engine/spawn';
import { C, fade, hue } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

/** Highlighted on the skeleton: "these are the parts that matter". */
const HANDS = [L.LEFT_WRIST, L.RIGHT_WRIST] as const;

/** Dot tiers. Plain numbers: entities are typed arrays. */
const NEAR = 0;
const FAR = 1;
const MAX = 2;
const POINTS = [5, 15, 25] as const;

/** Seconds a dot waits before it quietly vanishes unanswered. Generous on
 *  purpose — this is an accuracy game, not a reflex one; nobody is rushed. */
const TARGET_LIFE = 3.6;

/**
 * A resting arm already hangs almost straight down, so a dot spawned in that
 * exact direction could be "caught" by a hand that never moved. Excluding a
 * wedge around straight-down (-90°, in the 0=right/90=up convention) means
 * every dot — even the very first, closest one — needs a real reach away from
 * rest, in direction as well as distance.
 */
const EXCLUDE_LO = -125;
const EXCLUDE_HI = -55;

class SpiderTouch implements MiniGame {
  private ctx!: GameContext;
  private spawner!: Spawner;

  // Everything below is allocated HERE or in init(). update()/render() never allocate.
  private readonly targets = new Entities(6);
  private readonly footprints = new Entities(40);
  private readonly handL: Pt = { x: 0, y: 0 };
  private readonly handR: Pt = { x: 0, y: 0 };
  private readonly center: Pt = { x: 0, y: 0 };
  /** Last seen player, so render() can draw the body without calling a
   *  detector's read() (it can run between fixed updates). */
  private player: PlayerPose | null = null;

  private score = 0;
  private combo = 0;
  private best = 0;
  private hits = 0;
  private misses = 0;
  private time = 0;
  /** min(w,h)/1000, computed once — the same scale `g.s` uses, available
   *  outside render() for sizing things spawned in update(). */
  private s = 1;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.s = Math.min(ctx.view.w, ctx.view.h) / 1000;
    this.spawner = new Spawner(
      // Two dots at once, and single-hand-only dots, only once the player has
      // the idea — see spawnOne().
      { startInterval: 1.6, endInterval: 0.85, jitter: 0.3, burstMid: 1, burstLate: 2 },
      ctx.rng,
      manifest.durationMs / 1000,
    );
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.audio.music({ bpm: 100 });
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    const p = f.p1;
    this.player = p ?? null;

    this.targets.step(dt);
    // Pass 1: dots that timed out unanswered. Quiet — combo breaks, nothing
    // else — then swept immediately so a fresh hit below is never confused
    // with a timeout (both end up with life <= 0 by the time sweep() runs).
    for (let i = this.targets.n - 1; i >= 0; i--) {
      if (this.targets.life[i]! <= 0) {
        this.misses++;
        this.combo = 0;
        this.ctx.hud.setCombo(0);
      }
    }
    this.targets.sweep();

    for (let i = 0, k = this.spawner.tick(dt); i < k; i++) this.spawnOne();

    if (p) {
      palm(p, 'L', this.handL);
      palm(p, 'R', this.handR);
      this.resolveHits();
      this.targets.sweep();
    }
  }

  private spawnOne(): void {
    const p = this.player;
    if (!p) return;
    shoulderPx(p, this.center);

    // One arm's reach from the chest: armSpan is wrist-to-wrist with both
    // arms out (~2*armLen + a shoulder width), so half of it is ~= armLen +
    // half a shoulder width — exactly the distance a single straight arm
    // covers from the body's own centre.
    const armSpan = p.calib.armSpan > 1 ? p.calib.armSpan : 4.3;
    const reachUnit = armSpan * 0.5;
    const d = this.spawner.difficulty;
    const ratio = clamp01(lerp(0.5, 0.95, d) + randRange(this.ctx.rng, -0.04, 0.04));
    const distPx = reachUnit * ratio * p.scalePx;

    let angleDeg = 0;
    for (let tries = 0; tries < 8; tries++) {
      angleDeg = randRange(this.ctx.rng, -180, 180);
      if (angleDeg <= EXCLUDE_LO || angleDeg >= EXCLUDE_HI) break;
    }
    const rad = (angleDeg * Math.PI) / 180;
    const x = this.center.x + Math.cos(rad) * distPx;
    const y = this.center.y - Math.sin(rad) * distPx;

    const r = Math.min(this.ctx.view.w, this.ctx.view.h) * 0.07;
    const tier = ratio < 0.65 ? NEAR : ratio < 0.85 ? FAR : MAX;
    // "지정 손" only once the ramp is nearly maxed, and only sometimes — this
    // is the hardest variant and must stay rare.
    const locked = d > 0.72 && chance(this.ctx.rng, 0.3) ? (chance(this.ctx.rng, 0.5) ? 1 : 2) : 0;

    const i = this.targets.spawn(x, y, 0, 0, r, TARGET_LIFE, tier);
    if (i >= 0) this.targets.data[i] = locked;
  }

  private resolveHits(): void {
    for (let i = this.targets.n - 1; i >= 0; i--) {
      const lock = this.targets.data[i]!;
      const allowL = lock !== 2;
      const allowR = lock !== 1;
      const tx = this.targets.x[i]!;
      const ty = this.targets.y[i]!;
      const tr = this.targets.r[i]!;
      const hit =
        (allowL && hitCircle(this.handL.x, this.handL.y, tx, ty, tr)) ||
        (allowR && hitCircle(this.handR.x, this.handR.y, tx, ty, tr));
      if (hit) this.resolve(i, tx, ty);
    }
  }

  private resolve(i: number, x: number, y: number): void {
    const tier = this.targets.kind[i]!;
    this.targets.kill(i);

    this.hits++;
    this.combo++;
    if (this.combo > this.best) this.best = this.combo;
    const pts = POINTS[tier]!;
    this.score += pts;

    // A faint, permanent footprint: the player's own coverage map growing on
    // the wall. Purely decorative — never re-tested, never re-scored.
    if (this.footprints.n < this.footprints.cap) {
      this.footprints.spawn(x, y, 0, 0, 7 * this.s, 1e4, tier);
    }

    this.ctx.fx.impact(x, y, tier === MAX ? 'big' : 'hit', {
      color: C.accent,
      sprite: tier === MAX ? 'star' : 'sparkle',
      label: `+${pts}`,
    });
    this.ctx.audio.playLadder(tier === MAX ? 'pop.high' : 'pop', this.combo);
    if (this.combo > 0 && this.combo % 6 === 0) {
      this.ctx.audio.play('combo.up');
      this.ctx.hud.toast(this.combo >= 12 ? t('wow') : t('nice'), { color: C.accent });
    }
    this.ctx.hud.setScore(this.score);
    this.ctx.hud.setCombo(this.combo);
    this.ctx.emit({ kind: 'scored', points: pts });
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    if (this.player) g.ghostBody(this.player, 0.08);
    if (this.player) g.skeleton(this.player, { alpha: 0.4, emphasize: HANDS });

    for (let i = 0; i < this.footprints.n; i++) {
      g.circle(this.footprints.x[i]!, this.footprints.y[i]!, this.footprints.r[i]!, {
        fill: fade(C.white, 0.5),
        stroke: fade(hue(manifest.theme?.hue ?? 266), 0.5),
        sw: 2 * g.s,
      });
    }

    for (let i = 0; i < this.targets.n; i++) {
      const x = this.targets.x[i]!;
      const y = this.targets.y[i]!;
      const r = this.targets.r[i]!;
      const tier = this.targets.kind[i]!;
      const locked = this.targets.data[i]!;
      const age = this.targets.age(i);
      const grow = age < 0.12 ? easeOutBack(age / 0.12) : 1;
      const bodyR = r * 0.62 * grow;

      // The spider itself: body + 6 legs + eyes only, no mouth — a thing you
      // chase gets eyes, never a face (ART.md §2.5).
      g.circle(x, y, bodyR, {
        fill: hue((manifest.theme?.hue ?? 266) + 8, 62, 26),
        stroke: C.ink,
        sw: 2 * g.s,
      });
      for (let leg = 0; leg < 6; leg++) {
        const a = (leg / 6) * TAU + this.time * 0.6;
        g.line(
          x, y,
          x + Math.cos(a) * bodyR * 1.6, y + Math.sin(a) * bodyR * 1.6,
          2 * g.s, { stroke: C.ink },
        );
      }
      g.circle(x - bodyR * 0.3, y - bodyR * 0.25, bodyR * 0.16, { fill: C.white });
      g.circle(x + bodyR * 0.3, y - bodyR * 0.25, bodyR * 0.16, { fill: C.white });

      if (tier >= FAR) {
        g.circle(x, y, r * (tier === MAX ? 1.35 : 1.1) * grow, {
          stroke: tier === MAX ? C.accent : fade(C.white, 0.5),
          sw: (tier === MAX ? 4 : 2) * g.s,
          glow: tier === MAX ? 14 : 0,
        });
      }
      if (tier === MAX) {
        g.sprite('star', x, y - bodyR * 1.6, 16 * g.s, { hue: manifest.theme?.hue, rot: this.time });
      }

      if (locked !== 0) {
        g.text(locked === 1 ? t('left') : t('right'), x, y - r * 1.7, {
          size: 22 * g.s, weight: 800, align: 'center', fill: C.ink, stroke: C.white, sw: 4,
        });
      }
    }

    // Hands on the PALMS, not the wrists: a child aims with their hand.
    const hr = 20 * g.s;
    for (const pt of [this.handL, this.handR]) {
      g.circle(pt.x, pt.y, hr, { stroke: hue(manifest.theme?.hue ?? 266, 80, 70), sw: 3 * g.s, glow: 8 });
    }
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.best >= 6) highlights.push(`콤보 ${this.best}연속!`);
    if (this.hits >= 20) highlights.push(`거미 자국 ${this.hits}개`);
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
        hits: this.hits, misses: this.misses, bestCombo: this.best,
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }

  dispose(): void {
    this.ctx.audio.stopMusic();
    this.targets.clear();
    this.footprints.clear();
  }
}

export default (): MiniGame => new SpiderTouch();

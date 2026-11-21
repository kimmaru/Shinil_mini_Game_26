// SPIDER-TOUCH — Shape A (discrete trigger), accuracy variant: no speed gate,
// the hand just has to arrive inside the spider's ring and stay there for two
// frames.
//
// FAIRNESS: every spider's distance from the player is a fraction of THIS
// player's own single-arm reach (`calib.armSpan / 2`, ~= armLen + half a
// shoulder width — the distance a straight arm covers from the chest), not a
// screen position. A shorter child at 0.95x is stretching exactly as much as
// a taller one. See docs/GAME_AUTHORING.md §5. A spider that would land off
// the edge of the view is pulled in along the same ray from the chest, so it
// stays somewhere that arm can point at.
import type {
  EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { L, MIN_VIS, palm, shoulderPx } from '@/engine/pose/landmarks';
import { clamp01, dist, easeOutBack, lerp } from '@/engine/math';
import { Entities } from '@/engine/entities';
import { chance, randRange, Spawner } from '@/engine/spawn';
import { C, KEYLINE, fade, hue } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

/** Highlighted on the skeleton: "these are the parts that matter". */
const HANDS = [L.LEFT_WRIST, L.RIGHT_WRIST] as const;

/** Spider tiers. Plain numbers: entities are typed arrays. */
const NEAR = 0;
const FAR = 1;
const MAX = 2;
const POINTS = [5, 15, 25] as const;
const LABEL: string[] = [];
for (let i = 0; i <= 30; i++) LABEL.push('+' + i);

/** Seconds a spider waits before it quietly scuttles away. Generous on
 *  purpose — this is an accuracy game, not a reflex one; nobody is rushed. */
const TARGET_LIFE = 3.8;
/** A hand must stay inside the ring this many frames, and each hand needs a
 *  quarter second between two spiders, so one noisy frame is never a hit. */
const CONFIRM = 2;
const HAND_CD = 0.26;

/**
 * A resting arm already hangs almost straight down, so a spider spawned in that
 * exact direction could be "caught" by a hand that never moved. Excluding a
 * wedge around straight-down (-90°, in the 0=right/90=up convention) means
 * every spider — even the very first, closest one — needs a real reach away
 * from rest, in direction as well as distance.
 */
const EXCLUDE_LO = -145;
const EXCLUDE_HI = -35;

class SpiderTouch implements MiniGame {
  private ctx!: GameContext;
  private spawner!: Spawner;

  // Everything below is allocated HERE or in init(). update()/render() never allocate.
  private readonly targets = new Entities(6);
  private readonly footprints = new Entities(24);
  private readonly handL: Pt = { x: 0, y: 0 };
  private readonly handR: Pt = { x: 0, y: 0 };
  private readonly center: Pt = { x: 0, y: 0 };
  private handOkL = false;
  private handOkR = false;
  private cdL = 0;
  private cdR = 0;
  /** Last seen player, so render() can draw the body without calling a
   *  detector's read() (it can run between fixed updates). */
  private player: PlayerPose | null = null;

  private score = 0;
  private combo = 0;
  private best = 0;
  private hits = 0;
  private misses = 0;
  private time = 0;
  private spawnR = 0;
  /** min(w,h)/1000, computed once — the same scale `g.s` uses, available
   *  outside render() for sizing things spawned in update(). */
  private s = 1;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.s = Math.min(ctx.view.w, ctx.view.h) / 1000;
    // 8% of the short side: a ~115 px wide ring on a 1280x720 view.
    this.spawnR = Math.min(ctx.view.w, ctx.view.h) * 0.08;
    this.spawner = new Spawner(
      // Two spiders at once, and single-hand-only ones, only once the player
      // has the idea — see spawnOne().
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
    if (this.cdL > 0) this.cdL -= dt;
    if (this.cdR > 0) this.cdR -= dt;
    const p = f.p1;
    this.player = p ?? null;

    this.targets.step(dt);
    // Spiders that timed out unanswered. Quiet — the combo breaks, nothing
    // else — then swept immediately so a fresh hit below is never confused
    // with a timeout (both end up with life <= 0 by the time sweep() runs).
    for (let i = this.targets.n - 1; i >= 0; i--) {
      if (this.targets.life[i]! <= 0) {
        this.misses++;
        if (this.combo > 0) {
          this.combo = 0;
          this.ctx.hud.setCombo(0);
        }
      }
    }
    this.targets.sweep();

    if (p) {
      this.handOkL = p.vis[L.LEFT_WRIST]! >= MIN_VIS;
      this.handOkR = p.vis[L.RIGHT_WRIST]! >= MIN_VIS;
      if (this.handOkL) palm(p, 'L', this.handL);
      if (this.handOkR) palm(p, 'R', this.handR);
      for (let i = 0, k = this.spawner.tick(dt); i < k; i++) this.spawnOne(p);
      this.resolveHits();
      this.targets.sweep();
    } else {
      this.handOkL = false;
      this.handOkR = false;
    }
  }

  private spawnOne(p: PlayerPose): void {
    if (this.targets.n >= 3) return;
    shoulderPx(p, this.center);

    // One arm's reach from the chest: armSpan is wrist-to-wrist with both
    // arms out (~2*armLen + a shoulder width), so half of it is ~= armLen +
    // half a shoulder width — exactly the distance a single straight arm
    // covers from the body's own centre.
    const armSpan = p.calib.armSpan > 1 ? p.calib.armSpan : 4.3;
    const reachUnit = armSpan * 0.5;
    const d = this.spawner.difficulty;
    const ratio = clamp01(lerp(0.55, 0.95, d) + randRange(this.ctx.rng, -0.04, 0.04));
    const { w, h } = this.ctx.view;
    const r = this.spawnR;
    const m = r * 1.3;

    let x = 0;
    let y = 0;
    let placed = false;
    for (let tries = 0; tries < 10 && !placed; tries++) {
      const angleDeg = randRange(this.ctx.rng, -180, 180);
      if (angleDeg > EXCLUDE_LO && angleDeg < EXCLUDE_HI) continue;
      const rad = (angleDeg * Math.PI) / 180;
      let distPx = reachUnit * ratio * p.scalePx;
      // Off the edge of the view: pull in along the same ray.
      for (let k = 0; k < 8; k++) {
        x = this.center.x + Math.cos(rad) * distPx;
        y = this.center.y - Math.sin(rad) * distPx;
        if (x >= m && x <= w - m && y >= m && y <= h - m) break;
        distPx *= 0.88;
      }
      if (x < m || x > w - m || y < m || y > h - m) continue;
      // Never appear under a hand that is already there, or on another spider.
      if (this.handOkL && dist(x, y, this.handL.x, this.handL.y) < r * 2.2) continue;
      if (this.handOkR && dist(x, y, this.handR.x, this.handR.y) < r * 2.2) continue;
      placed = true;
      for (let i = 0; i < this.targets.n; i++) {
        if (dist(x, y, this.targets.x[i]!, this.targets.y[i]!) < r * 2.6) placed = false;
      }
    }
    if (!placed) return;

    const tier = ratio < 0.68 ? NEAR : ratio < 0.85 ? FAR : MAX;
    // "지정 손" only once the ramp is nearly maxed, and only sometimes — this
    // is the hardest variant and must stay rare.
    const locked = d > 0.72 && chance(this.ctx.rng, 0.3) ? (chance(this.ctx.rng, 0.5) ? 1 : 2) : 0;

    const i = this.targets.spawn(x, y, 0, 0, r, TARGET_LIFE, tier, 0);
    if (i >= 0) this.targets.data[i] = locked;
  }

  private resolveHits(): void {
    for (let i = this.targets.n - 1; i >= 0; i--) {
      if (this.targets.life[i]! <= 0) continue;
      const lock = this.targets.data[i]!;
      const tx = this.targets.x[i]!;
      const ty = this.targets.y[i]!;
      const tr = this.targets.r[i]!;
      const useL = lock !== 2 && this.handOkL && this.cdL <= 0 && dist(this.handL.x, this.handL.y, tx, ty) <= tr;
      const useR = lock !== 1 && this.handOkR && this.cdR <= 0 && dist(this.handR.x, this.handR.y, tx, ty) <= tr;
      if (!useL && !useR) { this.targets.hp[i] = 0; continue; }
      const n = this.targets.hp[i]! + 1;
      this.targets.hp[i] = n;
      if (n < CONFIRM) continue;
      if (useL) this.cdL = HAND_CD;
      if (useR) this.cdR = HAND_CD;
      this.resolve(i, tx, ty);
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
      this.footprints.spawn(x, y, 0, 0, 9 * this.s, 1e4, tier);
    }

    this.ctx.fx.impact(x, y, tier === MAX ? 'big' : 'hit', {
      color: C.accent,
      sprite: tier === MAX ? 'star' : 'sparkle',
      label: LABEL[pts]!,
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
    const th = manifest.theme?.hue ?? 266;

    if (this.player) g.ghostBody(this.player, 0.1);
    if (this.player) g.skeleton(this.player, { alpha: 0.5, emphasize: HANDS });

    for (let i = 0; i < this.footprints.n; i++) {
      g.circle(this.footprints.x[i]!, this.footprints.y[i]!, this.footprints.r[i]!, {
        fill: fade(C.white, 0.6),
        stroke: hue(th, 60, 60, 0.6),
        sw: 3 * g.s,
      });
    }

    for (let i = 0; i < this.targets.n; i++) {
      const bx = this.targets.x[i]!;
      const by = this.targets.y[i]!;
      const r = this.targets.r[i]!;
      const tier = this.targets.kind[i]!;
      const locked = this.targets.data[i]!;
      const age = this.targets.age(i);
      const grow = age < 0.14 ? easeOutBack(age / 0.14) : 1;
      const bodyR = r * 0.55 * grow;
      const x = bx;
      const y = by + Math.sin(this.time * 3 + i) * 5 * g.s;

      // The touch ring: the exact area that counts, in the tier's colour.
      g.circle(bx, by, r * grow, {
        fill: fade(C.white, 0.4),
        stroke: tier === MAX ? C.accent : tier === FAR ? C.hot : C.white,
        sw: (tier === MAX ? 7 : 5) * g.s,
        glow: tier === MAX ? 12 : 0,
      });
      // The silk thread it hangs from.
      g.line(x, 0, x, y - bodyR, 3 * g.s, { stroke: fade(C.ink, 0.3) });

      // Eight chunky legs, wiggling.
      for (let side = 0; side < 2; side++) {
        const sg = side === 0 ? 1 : -1;
        for (let k = 0; k < 4; k++) {
          const a = -0.95 + k * 0.62 + Math.sin(this.time * 7 + k * 1.3 + side) * 0.12;
          const lx = Math.cos(a) * sg;
          const ly = Math.sin(a);
          g.line(
            x + lx * bodyR * 0.7, y + ly * bodyR * 0.7,
            x + lx * bodyR * 1.75, y + ly * bodyR * 1.75,
            5 * g.s, { stroke: KEYLINE },
          );
        }
      }
      // Body, eyes only — a creature you chase never gets a mouth.
      g.circle(x, y, bodyR, { fill: hue(th + 8, 50, 30), stroke: KEYLINE, sw: 4 * g.s });
      g.circle(x - bodyR * 0.35, y - bodyR * 0.2, bodyR * 0.26, { fill: C.white });
      g.circle(x + bodyR * 0.35, y - bodyR * 0.2, bodyR * 0.26, { fill: C.white });
      g.circle(x - bodyR * 0.32, y - bodyR * 0.16, bodyR * 0.12, { fill: C.ink });
      g.circle(x + bodyR * 0.32, y - bodyR * 0.16, bodyR * 0.12, { fill: C.ink });
      if (tier === MAX) g.sprite('star', x, y - bodyR * 2, 30 * g.s, { rot: this.time });

      if (locked !== 0) {
        g.text(locked === 1 ? t('left') : t('right'), bx, by - r * 1.55, {
          size: 48 * g.s, weight: 800, align: 'center', fill: C.ink, stroke: C.white, sw: 7 * g.s,
        });
      }
    }

    // Hands on the PALMS, not the wrists: a child aims with their hand.
    const hr = 30 * g.s;
    if (this.player && this.handOkL) this.drawHand(g, this.handL, hr);
    if (this.player && this.handOkR) this.drawHand(g, this.handR, hr);
  }

  private drawHand(g: Renderer, pt: Pt, r: number): void {
    g.circle(pt.x, pt.y, r, { fill: fade(C.accent, 0.55), stroke: KEYLINE, sw: 4 * g.s });
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

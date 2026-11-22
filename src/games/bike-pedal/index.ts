// ─── bike-pedal — scalar rep counter driving a bicycle ────────────────────────
//
// Signal: wrist height above the SAME-SIDE ELBOW, in shoulder-widths. A hand
// drawing a circle in front of the chest swings above and below its elbow once
// per lap, so one lap = one rising edge of this scalar. Elbow-relative means no
// absolute height is assumed: a child circling at the chest, the belly or the
// shoulder is judged by the same loop. One rented `rep` per hand; a stride is
// counted only when it ALTERNATES with the previous one, so a single hand
// bobbing does not pedal. (True rotation direction is not checked — NEEDS.md.)
//
// Distance is a cadence integral shaped by the hill under the bike: uphill is
// slower, downhill faster. A star hangs every STAR_GAP strides of distance.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Renderer,
} from '@/engine/types';
import { L, ny } from '@/engine/pose/landmarks';
import { approach, pulse, TAU } from '@/engine/math';
import { C, fade } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

const PERIOD = 16;
const STAR_GAP = 5;
const STAR_POINTS = 10;
const HILL_SLOW = 0.38;
const STREAK_GAP = 1.2;
const POINT_LABEL = '+10';
const HANDS = [L.LEFT_WRIST, L.RIGHT_WRIST] as const;
const TERRAIN_PTS = 17;
const CLOUDS = 4;
const RING = fade(C.primaryHi, 0.5);
const WHEEL_FILL = fade(C.white, 0.5);
const SPOKE = fade(C.ink, 0.45);

const sigL = (p: PlayerPose): number => ny(p, L.LEFT_ELBOW) - ny(p, L.LEFT_WRIST);
const sigR = (p: PlayerPose): number => ny(p, L.RIGHT_ELBOW) - ny(p, L.RIGHT_WRIST);
const NEED_L = [L.LEFT_WRIST, L.LEFT_ELBOW] as const;
const NEED_R = [L.RIGHT_WRIST, L.RIGHT_ELBOW] as const;

class BikePedal implements MiniGame {
  private ctx!: GameContext;
  private repL!: Detector<'rep'>;
  private repR!: Detector<'rep'>;
  private player: PlayerPose | null = null;

  private readonly terrain = new Float32Array((TERRAIN_PTS + 2) * 2);
  private readonly cloudX = new Float32Array(CLOUDS);
  private readonly cloudY = new Float32Array(CLOUDS);

  private time = 0;
  private dist = 0;
  private strideRate = 0;
  private speed = 0;
  private lastStrideT = -10;
  private lastSide: 0 | 1 | 2 = 0;
  private strides = 0;
  private bestRate = 0;
  private stars = 0;
  private starStreak = 0;
  private bestStreak = 0;
  private slopeNorm = 0;
  private crank = 0;
  private wheel = 0;
  private bob = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // enter/exit in shoulder-widths of wrist-above-elbow. A relaxed hanging
    // arm reads about -0.9; a hand circled up past its elbow reads +0.2..0.5.
    this.repL = ctx.gestures.use('rep', { signal: sigL, enter: 0.12, exit: -0.12, needs: NEED_L, cooldownMs: 250 });
    this.repR = ctx.gestures.use('rep', { signal: sigR, enter: 0.12, exit: -0.12, needs: NEED_R, cooldownMs: 250 });
    for (let i = 0; i < CLOUDS; i++) {
      this.cloudX[i] = (i + ctx.rng() * 0.6) / CLOUDS;
      this.cloudY[i] = 0.08 + ctx.rng() * 0.2;
    }
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    if (this.bob > 0) this.bob = Math.max(0, this.bob - dt * 4);
    const p = f.p1;
    this.player = p ?? null;

    if (p) {
      const sl = this.repL.read(f);
      const sr = this.repR.read(f);
      if (sl.ok && sl.justCounted) this.confirmStride(1);
      if (sr.ok && sr.justCounted) this.confirmStride(2);
    }

    // Stopping is quiet: the cadence decays and the bike coasts to a halt.
    if (this.time - this.lastStrideT > 0.8) {
      this.strideRate = approach(this.strideRate, 0, 2.5, dt);
      if (this.time - this.lastStrideT > STREAK_GAP) this.starStreak = 0;
    }

    this.slopeNorm = Math.cos((TAU * this.dist) / PERIOD);
    const hill = 1 - HILL_SLOW * this.slopeNorm;
    this.speed = approach(this.speed, this.strideRate * hill, 4, dt);
    this.dist += this.speed * dt;
    this.crank += this.speed * Math.PI * dt;
    this.wheel += this.speed * dt * 1.4;

    // Stars sit on the road every STAR_GAP; the bike scoops them up.
    while (this.dist >= (this.stars + 1) * STAR_GAP) {
      this.stars++;
      this.starStreak++;
      if (this.starStreak > this.bestStreak) this.bestStreak = this.starStreak;
      this.bob = 1;
      const { w, h } = this.ctx.view;
      this.ctx.fx.impact(w * 0.3, this.groundY(h, 0) - h * 0.2, 'hit', {
        color: C.accent, sprite: 'star', label: POINT_LABEL,
      });
      this.ctx.audio.playLadder('pop', Math.min(this.starStreak, 12));
      this.ctx.hud.setScore(this.stars * STAR_POINTS);
      this.ctx.emit({ kind: 'scored', points: STAR_POINTS });
    }
  }

  private confirmStride(side: 1 | 2): void {
    if (this.lastSide === side) return;
    const now = this.time;
    if (this.lastStrideT >= 0 && now - this.lastStrideT < 5) {
      const gap = now - this.lastStrideT;
      if (gap > 1e-3) {
        const inst = 1 / gap;
        this.strideRate = this.strideRate > 0 ? this.strideRate + (inst - this.strideRate) * 0.4 : inst;
        if (this.strideRate > this.bestRate) this.bestRate = this.strideRate;
      }
    }
    this.lastStrideT = now;
    this.lastSide = side;
    this.strides++;
    this.ctx.audio.play('step', { gain: 0.25, rate: 1.4 });
  }

  /** Road surface y at `dx` strides ahead of the bike (negative = behind). */
  private groundY(h: number, dx: number): number {
    return h * 0.78 - Math.sin((TAU * (this.dist + dx)) / PERIOD) * h * 0.09;
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);
    const s = g.s;
    const unitPx = g.w * 0.09;
    const bikeX = g.w * 0.28;

    // Sun and clouds, on the engine sky (no full-screen fill of our own, so the
    // camera backdrop shows through when it is on).
    g.circle(g.w * 0.84, g.h * 0.16, 58 * s, { fill: C.accentHi, stroke: C.ink, sw: 4 * s });
    for (let i = 0; i < CLOUDS; i++) {
      const x = (((this.cloudX[i]! - this.dist * 0.004) % 1) + 1) % 1;
      const cx = (x * 1.3 - 0.15) * g.w;
      const cy = this.cloudY[i]! * g.h;
      const k = 32 * s;
      g.circle(cx, cy, k, { fill: C.white });
      g.circle(cx + k * 1.1, cy + k * 0.15, k * 0.8, { fill: C.white });
      g.circle(cx - k, cy + k * 0.2, k * 0.7, { fill: C.white });
    }

    // Rolling road: the same sine the bike's slope and speed come from.
    const tp = this.terrain;
    for (let i = 0; i < TERRAIN_PTS; i++) {
      const x = (i / (TERRAIN_PTS - 1)) * g.w;
      tp[i * 2] = x;
      tp[i * 2 + 1] = this.groundY(g.h, (x - bikeX) / unitPx);
    }
    tp[TERRAIN_PTS * 2] = g.w;
    tp[TERRAIN_PTS * 2 + 1] = g.h;
    tp[TERRAIN_PTS * 2 + 2] = 0;
    tp[TERRAIN_PTS * 2 + 3] = g.h;
    g.poly(tp, TERRAIN_PTS + 2, { fill: C.success, stroke: C.ink, sw: 4 * s }, true);

    // Stars on the road ahead.
    const first = this.stars;
    for (let k = first; k < first + 8; k++) {
      const dx = (k + 1) * STAR_GAP - this.dist;
      const x = bikeX + dx * unitPx;
      if (x > g.w + 60 * s) break;
      const y = this.groundY(g.h, dx) - 120 * s - Math.sin(this.time * 4 + k) * 6 * s;
      g.sprite('star', x, y, 120 * s, { hue: 45 });
    }

    this.drawBike(g, bikeX, this.groundY(g.h, 0), s);

    if (this.player) {
      g.ghostBody(this.player, 0.1);
      g.skeleton(this.player, { alpha: 0.75, color: C.white, outline: true, emphasize: HANDS });
    }

    if (this.time - this.lastStrideT > 1.6) {
      const k = 0.92 + 0.08 * pulse((this.time * 1.5) % 1);
      g.text(t('prompt'), g.w / 2, g.h * 0.12, {
        size: 56 * s * k, weight: 800, display: true, align: 'center', baseline: 'middle',
        fill: C.primaryHi, stroke: C.white, sw: 8 * s,
      });
      g.text(t('promptSub'), g.w / 2, g.h * 0.2, {
        size: 38 * s, weight: 700, align: 'center', baseline: 'middle',
        fill: C.text, stroke: C.white, sw: 6 * s,
      });
      // Two orbit rings with a dot each, half a lap apart: "take turns".
      const ph = this.time * 3;
      const ry = g.h * 0.36;
      const rr = 62 * s;
      for (let i = 0; i < 2; i++) {
        const cx = g.w * (i === 0 ? 0.68 : 0.86);
        g.circle(cx, ry, rr, { stroke: RING, sw: 6 * s });
        const a = ph + i * Math.PI;
        g.circle(cx + Math.cos(a) * rr, ry + Math.sin(a) * rr, 16 * s, { fill: C.hot, stroke: C.ink, sw: 3 * s });
      }
    }
  }

  private drawBike(g: Renderer, bx: number, by: number, s: number): void {
    const R = 70 * s;
    const tilt = -Math.atan(Math.cos((TAU * this.dist) / PERIOD) * (g.h * 0.09 * TAU) / (PERIOD * g.w * 0.09));
    const bounce = Math.sin(this.bob * Math.PI) * 10 * s;
    g.save();
    g.translate(bx, by - bounce);
    g.rotate(tilt);
    const rx = -115 * s;
    const fx = 115 * s;
    const hy = -R;
    const bbx = -5 * s;
    const bby = -R * 0.95;
    const seatX = -50 * s;
    const seatY = -R * 2.15;
    const headX = 95 * s;
    const headY = -R * 2.2;
    const ink = C.ink;

    for (let w = 0; w < 2; w++) {
      const cx = w === 0 ? rx : fx;
      g.circle(cx, hy, R, { fill: WHEEL_FILL, stroke: ink, sw: 9 * s });
      for (let i = 0; i < 4; i++) {
        const a = this.wheel + (i / 4) * Math.PI;
        g.line(cx - Math.cos(a) * R, hy - Math.sin(a) * R, cx + Math.cos(a) * R, hy + Math.sin(a) * R, 2.5 * s, { stroke: SPOKE });
      }
    }
    const fr = C.primary;
    g.line(rx, hy, bbx, bby, 8 * s, { stroke: fr });
    g.line(bbx, bby, seatX, seatY, 8 * s, { stroke: fr });
    g.line(seatX, seatY, headX, headY, 8 * s, { stroke: fr });
    g.line(bbx, bby, headX, headY, 8 * s, { stroke: fr });
    g.line(headX, headY, fx, hy, 8 * s, { stroke: fr });
    g.line(seatX - 18 * s, seatY, seatX + 18 * s, seatY, 10 * s, { stroke: ink });
    g.line(headX, headY, headX - 22 * s, headY - 14 * s, 8 * s, { stroke: ink });

    // Rider: legs follow the crank, arms hold the bars.
    const cr = 38 * s;
    const p1x = bbx + Math.cos(this.crank) * cr;
    const p1y = bby + Math.sin(this.crank) * cr;
    const p2x = bbx - Math.cos(this.crank) * cr;
    const p2y = bby - Math.sin(this.crank) * cr;
    const hipX = seatX;
    const hipY = seatY - 8 * s;
    g.line(hipX, hipY, p2x, p2y, 14 * s, { stroke: C.hot });
    g.line(hipX, hipY, p1x, p1y, 14 * s, { stroke: C.hot });
    g.circle(p1x, p1y, 11 * s, { fill: C.accent, stroke: ink, sw: 3 * s });
    g.circle(p2x, p2y, 11 * s, { fill: C.accent, stroke: ink, sw: 3 * s });
    const shX = hipX + 38 * s;
    const shY = hipY - 92 * s;
    g.line(hipX, hipY, shX, shY, 22 * s, { stroke: C.secondary });
    g.line(shX, shY, headX - 8 * s, headY - 10 * s, 11 * s, { stroke: C.hot });
    g.circle(shX + 12 * s, shY - 38 * s, 30 * s, { fill: C.accentHi, stroke: ink, sw: 4 * s });
    g.circle(shX + 22 * s, shY - 42 * s, 4 * s, { fill: ink });
    g.restore();
  }

  end(_reason: EndReason): GameResult {
    const score = this.stars * STAR_POINTS;
    const highlights: string[] = [];
    if (this.stars >= 12) highlights.push(`별을 ${this.stars}개 모았어요!`);
    if (this.bestRate >= 3) highlights.push('페달을 아주 빨리 돌렸어요!');
    return {
      gameId: manifest.id,
      cleared: this.strides > 0,
      rawScore: score,
      maxScore: manifest.scoring.maxScore,
      normalized: 0,
      stars: 0,
      durationMs: manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score,
        hits: this.stars, misses: 0, bestCombo: this.bestStreak,
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }
}

export default (): MiniGame => new BikePedal();

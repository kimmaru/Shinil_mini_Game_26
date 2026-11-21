// ─── run-in-place-sprint — scalar rep counter driving a race ──────────────────
//
// Signal: `kneeLift(p, side)` from the engine's rep module (knee above the
// standing knee line, falling back to elbow-above-shoulder when the legs are
// out of frame — the laptop case). One rented `rep` detector per side; this
// file only sequences their `justCounted` edges, so a stride counts only when
// it ALTERNATES with the previous one. One wobbling leg never scores twice.
//
// Every stride moves the runner and scores a point (two in the last spurt).
// Standing still earns nothing; stopping is quiet — the cadence just decays.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Renderer,
} from '@/engine/types';
import { L } from '@/engine/pose/landmarks';
import { kneeLift } from '@/engine/gestures/reps';
import { approach, clamp01, easeOutBack, pulse } from '@/engine/math';
import { C, fade } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

const DURATION = manifest.durationMs / 1000;
/** Strides to run one lap of the track. */
const LAP_STRIDES = 24;
/** Last N seconds score double. */
const SPURT_SEC = 8;
/** A pause longer than this ends the streak (quietly). */
const STREAK_GAP = 0.9;
const CLOUDS = 4;
const POSTS = 5;
const GRASS = fade(C.success, 0.55);
const SHADOW = fade(C.ink, 0.15);
const SPEED = fade(C.primary, 0.28);
const ACCENT_DIM = fade(C.accent, 0.3);

const EMPHASIZE = [L.LEFT_KNEE, L.RIGHT_KNEE, L.LEFT_WRIST, L.RIGHT_WRIST] as const;
const sigL = (p: PlayerPose): number => kneeLift(p, 'L');
const sigR = (p: PlayerPose): number => kneeLift(p, 'R');

class RunInPlaceSprint implements MiniGame {
  private ctx!: GameContext;
  private repL!: Detector<'rep'>;
  private repR!: Detector<'rep'>;
  private player: PlayerPose | null = null;

  private readonly cloudX = new Float32Array(CLOUDS);
  private readonly cloudY = new Float32Array(CLOUDS);
  private readonly cloudS = new Float32Array(CLOUDS);
  private readonly flagPts = new Float32Array(6);

  private time = 0;
  private score = 0;
  private strides = 0;
  private laps = 0;
  private lapStrides = 0;
  private streak = 0;
  private bestStreak = 0;
  /** Confirmed-alternation cadence, strides/sec. */
  private strideRate = 0;
  private bestRate = 0;
  private speed = 0;
  private lastStrideT = -10;
  /** 0 = none yet, 1 = left counted last, 2 = right counted last. */
  private lastSide: 0 | 1 | 2 = 0;
  private spurtAnnounced = false;
  private scroll = 0;
  private runnerFrac = 0;
  private lapFlash = 0;
  private stepPulse = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // Default enter/exit (0.22/0.10) are measured against this exact signal.
    // 250 ms per leg = at most 4 cycles/s per side, 8 strides/s in all.
    this.repL = ctx.gestures.use('rep', { signal: sigL, cooldownMs: 250 });
    this.repR = ctx.gestures.use('rep', { signal: sigR, cooldownMs: 250 });
    for (let i = 0; i < CLOUDS; i++) {
      this.cloudX[i] = (i + ctx.rng() * 0.6) / CLOUDS;
      this.cloudY[i] = 0.1 + ctx.rng() * 0.22;
      this.cloudS[i] = 0.8 + ctx.rng() * 0.6;
    }
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.hud.setBar('distance', 0, { labelKo: t('distance'), color: C.accent });
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    if (this.lapFlash > 0) this.lapFlash = Math.max(0, this.lapFlash - dt);
    if (this.stepPulse > 0) this.stepPulse = Math.max(0, this.stepPulse - dt * 5);
    const p = f.p1;
    this.player = p ?? null;

    if (p) {
      const sl = this.repL.read(f);
      const sr = this.repR.read(f);
      if (sl.ok && sl.justCounted) this.confirmStride(1);
      if (sr.ok && sr.justCounted) this.confirmStride(2);
    }

    // Stopping is quiet: the cadence decays instead of freezing.
    if (this.time - this.lastStrideT > 0.8) {
      this.strideRate = approach(this.strideRate, 0, 2.5, dt);
      if (this.time - this.lastStrideT > STREAK_GAP) this.streak = 0;
    }
    this.speed = approach(this.speed, this.strideRate, 6, dt);
    this.scroll += this.speed * dt * 0.1;
    this.runnerFrac = approach(this.runnerFrac, this.lapStrides / LAP_STRIDES, 10, dt);

    if (!this.spurtAnnounced && this.time >= DURATION - SPURT_SEC) {
      this.spurtAnnounced = true;
      this.ctx.hud.toast(t('spurt'), { color: C.accent, big: true });
      this.ctx.audio.play('drum.snare', { gain: 0.6 });
    }
  }

  private confirmStride(side: 1 | 2): void {
    if (this.lastSide === side) return; // same leg twice: quietly ignored
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
    this.streak++;
    if (this.streak > this.bestStreak) this.bestStreak = this.streak;
    this.lapStrides++;
    this.stepPulse = 1;
    this.score += this.time >= DURATION - SPURT_SEC ? 2 : 1;
    this.ctx.hud.setScore(this.score);

    const { w, h } = this.ctx.view;
    const rx = this.trackX0(w) + (this.trackX1(w) - this.trackX0(w)) * this.runnerFrac;
    this.ctx.fx.impact(rx, h * 0.88, 'tap', { color: C.accent });
    this.ctx.audio.playLadder('step', Math.min(this.streak, 12), { gain: 0.5 });

    if (this.lapStrides >= LAP_STRIDES) {
      this.lapStrides = 0;
      this.laps++;
      this.runnerFrac = 0;
      this.lapFlash = 1;
      this.ctx.fx.impact(this.trackX1(w), h * 0.8, 'big', { color: C.accent, sprite: 'star' });
      this.ctx.audio.play('fanfare', { gain: 0.55 });
      this.ctx.hud.toast(t('lap'), { color: C.success, big: true });
    }
    this.ctx.hud.setBar('distance', this.lapStrides / LAP_STRIDES, { labelKo: t('distance'), color: C.accent });
  }

  private trackX0(w: number): number { return w * 0.1; }
  private trackX1(w: number): number { return w * 0.88; }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);
    const s = g.s;
    const groundY = g.h * 0.8;
    const spurt = this.time >= DURATION - SPURT_SEC;

    // Clouds drift slowly; they carry the sense of speed.
    for (let i = 0; i < CLOUDS; i++) {
      const x = (((this.cloudX[i]! - this.scroll * 0.25) % 1) + 1) % 1;
      const cx = (x * 1.3 - 0.15) * g.w;
      const cy = this.cloudY[i]! * g.h;
      const k = this.cloudS[i]! * 34 * s;
      g.circle(cx, cy, k, { fill: C.white });
      g.circle(cx + k * 1.1, cy + k * 0.15, k * 0.8, { fill: C.white });
      g.circle(cx - k * 1.0, cy + k * 0.2, k * 0.7, { fill: C.white });
    }

    // Ground, with a stripe band.
    g.rect(0, groundY, g.w, g.h - groundY, { fill: C.bgDeep });
    g.rect(0, groundY, g.w, 8 * s, { fill: GRASS });

    // Fence posts scroll past at the pace of the stride cadence.
    for (let i = 0; i < POSTS; i++) {
      const x = (((i / POSTS - this.scroll) % 1) + 1) % 1;
      const px = x * (g.w + 80 * s) - 40 * s;
      g.roundRect(px - 10 * s, groundY - 70 * s, 20 * s, 74 * s, 6 * s, { fill: C.accentHi, stroke: C.ink, sw: 3 * s });
      g.circle(px, groundY - 74 * s, 10 * s, { fill: C.hot, stroke: C.ink, sw: 3 * s });
    }

    // Track: a fat bar the runner follows toward the flag.
    const x0 = this.trackX0(g.w);
    const x1 = this.trackX1(g.w);
    const ty = g.h * 0.9;
    const th = 26 * s;
    g.roundRect(x0 - th / 2, ty - th / 2, x1 - x0 + th, th, th / 2, { fill: C.white, stroke: C.ink, sw: 4 * s });
    const fillW = (x1 - x0) * clamp01(this.runnerFrac);
    if (fillW > 1) g.roundRect(x0 - th / 2, ty - th / 2, fillW + th / 2, th, th / 2, { fill: spurt ? C.hot : C.accent });

    // Finish flag: pole + pennant, bouncing on a lap.
    const bounce = this.lapFlash > 0 ? easeOutBack(1 - this.lapFlash) : 1;
    const fh = 150 * s * (0.8 + 0.2 * bounce);
    g.line(x1, ty, x1, ty - fh, 6 * s, { stroke: C.ink });
    const fp = this.flagPts;
    fp[0] = x1; fp[1] = ty - fh;
    fp[2] = x1 + 80 * s; fp[3] = ty - fh + 28 * s;
    fp[4] = x1; fp[5] = ty - fh + 56 * s;
    g.poly(fp, 3, { fill: C.success, stroke: C.ink, sw: 4 * s });
    g.sprite('star', x1, ty - fh - 18 * s, 36 * s, { hue: 45 });

    // The runner token hops with every stride.
    const rx = x0 + (x1 - x0) * this.runnerFrac;
    const hop = Math.sin(this.stepPulse * Math.PI) * 18 * s;
    const rr = 42 * s;
    const ry = ty - th / 2 - rr * 0.85 - hop;
    g.circle(rx, ty - th / 2 + 2 * s, rr * 0.8, { fill: SHADOW });
    g.circle(rx, ry, rr, { fill: spurt ? C.hot : C.primary, stroke: C.ink, sw: 4 * s, glow: spurt ? 10 : 0 });
    g.circle(rx - rr * 0.32, ry - rr * 0.1, rr * 0.13, { fill: C.white });
    g.circle(rx + rr * 0.32, ry - rr * 0.1, rr * 0.13, { fill: C.white });

    // Speed lines whose length follows the cadence.
    if (this.speed > 0.5) {
      const len = (30 + this.speed * 22) * s;
      for (let i = 0; i < 5; i++) {
        const x = (((i / 5 - this.scroll * 3) % 1) + 1) % 1;
        const y = g.h * (0.3 + (i % 3) * 0.13);
        g.line(x * g.w, y, x * g.w - len, y, 4 * s, { stroke: SPEED });
      }
    }

    if (this.player) {
      g.ghostBody(this.player, 0.1);
      g.skeleton(this.player, {
        alpha: 0.7,
        color: spurt ? C.hot : undefined,
        outline: true,
        emphasize: EMPHASIZE,
      });
    }

    // How-to, until they are really running.
    if (this.time - this.lastStrideT > 1.6) {
      const k = 0.92 + 0.08 * pulse((this.time * 1.5) % 1);
      g.text(t('prompt'), g.w / 2, g.h * 0.17, {
        size: 58 * s * k, weight: 800, display: true, align: 'center', baseline: 'middle',
        fill: C.primaryHi, stroke: C.white, sw: 8 * s,
      });
      g.text(t('promptSub'), g.w / 2, g.h * 0.25, {
        size: 38 * s, weight: 700, align: 'center', baseline: 'middle',
        fill: C.text, stroke: C.white, sw: 6 * s,
      });
      const lift = pulse((this.time * 1.4) % 1);
      const swap = (this.time * 1.4) % 2 < 1;
      g.chevron(g.w * 0.3, g.h * 0.55 - lift * 18 * s, 34 * s, -Math.PI / 2, { fill: swap ? C.accent : ACCENT_DIM, stroke: C.ink, sw: 3 * s });
      g.chevron(g.w * 0.7, g.h * 0.55 - lift * 18 * s, 34 * s, -Math.PI / 2, { fill: swap ? ACCENT_DIM : C.accent, stroke: C.ink, sw: 3 * s });
    } else if (spurt) {
      g.text(t('spurt'), g.w / 2, g.h * 0.17, {
        size: 44 * s, weight: 800, display: true, align: 'center', baseline: 'middle',
        fill: C.hot, stroke: C.white, sw: 7 * s,
      });
    }
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.laps >= 1) highlights.push('결승선을 통과했어요!');
    if (this.bestStreak >= 40) highlights.push('멈추지 않고 달렸어요!');
    return {
      gameId: manifest.id,
      cleared: this.laps > 0,
      rawScore: this.score,
      maxScore: manifest.scoring.maxScore,
      normalized: 0,
      stars: 0,
      durationMs: manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score: this.score,
        hits: this.strides, misses: 0, bestCombo: this.bestStreak,
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }
}

export default (): MiniGame => new RunInPlaceSprint();

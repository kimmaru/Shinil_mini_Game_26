// ─── SHAPE C variant — scalar rep counter driving locomotion ─────────────────
//
// Signal: `kneeLift(p, side)`, imported straight from the engine's rep
// detector module rather than reinvented. It already does exactly what this
// game needs — knee height above the hip, shoulder-widths, falling back to
// elbow-above-shoulder when the knees are out of frame (the common laptop
// case) — and its own doc comment names "run-in-place" as a customer.
//
// Alternation ("both sides must move, not one") is NOT a hand-rolled
// threshold: two `rep` detectors (one per side) each keep their own
// hysteresis, and this file only sequences their `justCounted` edges — the
// same pattern mosquito-clap uses to layer a hit-test on top of a rented
// `clap` detector.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Renderer,
} from '@/engine/types';
import { L } from '@/engine/pose/landmarks';
import { kneeLift } from '@/engine/gestures/reps';
import { approach, clamp, clamp01, lerp } from '@/engine/math';
import { C, fade } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

/** Seconds of real scoring before the fixed cool-down. 30s total round. */
const ACTIVE_SEC = 28;
/** Last-spurt window starts here. */
const LAST_SPURT_AT = 18;
const SPURT_MULT = 1.2;
/** Distance units to cross the line. Capped — a strong run cannot inflate
 *  the score past this once it is reached. */
const FINISH_DISTANCE = 50;
/** Required cadence ramps up across the round — the "uphill". */
const REQ_CADENCE_START = 1.0;
const REQ_CADENCE_END = 2.2;
const PACE_MIN = 0.4;
const PACE_MAX = 1.4;

const EMPHASIZE = [L.LEFT_KNEE, L.RIGHT_KNEE, L.LEFT_WRIST, L.RIGHT_WRIST] as const;

class RunInPlaceSprint implements MiniGame {
  private ctx!: GameContext;
  private repL!: Detector<'rep'>;
  private repR!: Detector<'rep'>;
  private player: PlayerPose | null = null;

  private time = 0;
  private distance = 0;
  /** Confirmed-alternation cadence, cycles/sec. A leg wobbling alone never
   *  moves this: it only updates on a genuine L-then-R (or R-then-L) pair. */
  private strideRate = 0;
  private bestRate = 0;
  private lastStrideT = -1;
  /** 0 = none yet, 1 = left confirmed last, 2 = right confirmed last. */
  private lastSide: 0 | 1 | 2 = 0;
  private strides = 0;
  private finished = false;
  private spurtAnnounced = false;
  private restAnnounced = false;
  private scrollX = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // No enter/exit override: the detector's own defaults (0.22/0.10) are
    // measured against exactly this signal on the knee-run clip (see
    // reps.ts) — reusing them beats guessing new numbers.
    this.repL = ctx.gestures.use('rep', { signal: (p) => kneeLift(p, 'L') });
    this.repR = ctx.gestures.use('rep', { signal: (p) => kneeLift(p, 'R') });
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.hud.setBar('distance', 0, { labelKo: '거리' });
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    const p = f.p1;
    this.player = p ?? null;
    const active = this.time < ACTIVE_SEC;

    if (p) {
      const sl = this.repL.read(f);
      const sr = this.repR.read(f);
      if (active) {
        if (sl.ok && sl.justCounted) this.confirmStride(1);
        if (sr.ok && sr.justCounted) this.confirmStride(2);
      }
    }

    // A leg that stops moving decays the cadence rather than freezing it —
    // otherwise one last stride before standing still would read as a
    // sustained sprint forever.
    if (this.lastStrideT >= 0 && this.time - this.lastStrideT > 0.8) {
      this.strideRate = approach(this.strideRate, 0, 2.5, dt);
    }

    if (active) {
      const prog = clamp01(this.time / ACTIVE_SEC);
      const reqCadence = lerp(REQ_CADENCE_START, REQ_CADENCE_END, prog);
      const pace = clamp(this.strideRate / reqCadence, PACE_MIN, PACE_MAX);
      const spurt = this.time >= LAST_SPURT_AT ? SPURT_MULT : 1;
      // Distance IS the cadence integral — this is the entire scoring rule.
      this.distance = Math.min(FINISH_DISTANCE, this.distance + this.strideRate * pace * spurt * dt);
      this.scrollX += this.strideRate * dt * 0.08;
      this.ctx.hud.setBar('distance', this.distance / FINISH_DISTANCE, { labelKo: '거리' });
      this.ctx.hud.setScore(Math.round(this.distance));

      if (!this.finished && this.distance >= FINISH_DISTANCE) {
        this.finished = true;
        this.ctx.hud.toast(t('finish'), { color: C.success, big: true });
        this.ctx.audio.play('fanfare', { gain: 0.6 });
        this.ctx.fx.confetti({ color: C.accent });
      }
      if (!this.spurtAnnounced && this.time >= LAST_SPURT_AT) {
        this.spurtAnnounced = true;
        this.ctx.hud.toast(t('spurt'), { color: C.accent, big: true });
        this.ctx.audio.play('drum.snare', { gain: 0.5 });
      }
    } else if (!this.restAnnounced) {
      // The fixed 2-second cool-down: no more scoring, just a calm beat.
      this.restAnnounced = true;
      this.ctx.hud.toast(t('rest'), { color: C.info });
      this.ctx.hud.announce(t('rest'));
    }
  }

  private confirmStride(side: 1 | 2): void {
    if (this.lastSide === side) return; // same leg twice: quietly ignored
    this.strides++;
    if (this.lastStrideT >= 0) {
      const gap = this.time - this.lastStrideT;
      if (gap > 1e-3 && gap < 5) {
        this.strideRate = this.strideRate > 0
          ? this.strideRate + (1 / gap - this.strideRate) * 0.5
          : 1 / gap;
        if (this.strideRate > this.bestRate) this.bestRate = this.strideRate;
      }
    }
    this.lastStrideT = this.time;
    this.lastSide = side;
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);
    const active = this.time < ACTIVE_SEC;

    const groundY = g.h * 0.84;
    g.rect(0, groundY, g.w, g.h - groundY, { fill: fade(C.bgDeep, 0.7) });
    g.line(0, groundY, g.w, groundY, 3 * g.s, { stroke: fade(C.ink, 0.2) });

    // Speed lines: length and spacing read as velocity, proportional to the
    // confirmed-alternation cadence — a single wobbling leg never speeds them.
    const bands = 3;
    const perBand = 4;
    for (let b = 0; b < bands; b++) {
      const y = groundY * (0.4 + b * 0.18);
      for (let i = 0; i < perBand; i++) {
        const frac = ((i / perBand) + this.scrollX * (1 + b * 0.4) + b * 0.13) % 1;
        const x = frac * g.w;
        const len = (18 + this.strideRate * 10) * g.s;
        g.line(x, y, x - len, y, 2 * g.s, { stroke: fade(C.ink, 0.1) });
      }
    }

    // The finish flag starts small and far, and grows near as distance closes
    // — the same perspective trick wave-jump uses for its waves.
    const prog = clamp01(this.distance / FINISH_DISTANCE);
    const flagY = lerp(g.h * 0.2, g.h * 0.72, prog * prog);
    const flagSize = lerp(26, 104, prog) * g.s;
    g.sprite('ui-flag-finish', g.w * 0.84, flagY, flagSize);

    if (this.player) g.ghostBody(this.player, 0.1);
    // The player's own skeleton IS the runner — no separate character sprite.
    if (this.player) {
      g.skeleton(this.player, {
        alpha: active ? 0.6 : 0.4,
        color: this.time >= LAST_SPURT_AT && active ? C.accent : undefined,
        emphasize: EMPHASIZE,
      });
    }

    if (!active) {
      g.text(t('rest'), g.w / 2, g.h * 0.46, {
        size: 36 * g.s, weight: 700, align: 'center', fill: C.info,
        stroke: C.ink, sw: 5 * g.s,
      });
    }
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.finished) highlights.push('결승선을 통과했어요!');
    else if (this.strides >= 24) highlights.push('정말 열심히 달렸어요!');
    return {
      gameId: manifest.id,
      cleared: this.finished,
      rawScore: Math.round(this.distance),
      maxScore: manifest.scoring.maxScore,
      normalized: 0,
      stars: 0,
      durationMs: manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score: Math.round(this.distance),
        hits: this.strides, misses: 0, bestCombo: Math.round(this.bestRate),
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }

  dispose(): void {
    // Nothing pooled, no music started.
  }
}

export default (): MiniGame => new RunInPlaceSprint();

// ─── SHAPE A variant — scalar rep counter (two-hand pedal) ────────────────────
//
// Signal: `kneeLift(p, side)`, the same scalar run-in-place-sprint uses. The
// brief wants a circular/rotation signal, but `rep` only ever takes a plain
// scalar and no clip in the corpus exercises a real hand rotation — see
// NEEDS.md. `kneeLift`'s own fallback (knee, else elbow-above-shoulder)
// happens to cover both postures the brief describes (seated hand-pedal via
// the elbow branch, standing knee-alternate via the primary branch) without
// any extra code, which is why it is reused rather than a bespoke formula.
//
// "Proper pedalling" is rewarded, not required: the two hands' rep PHASES are
// compared, and close to antiphase (0.5 apart) is scored as better form —
// the honest, available proxy for "hands 180 degrees apart in a circle".
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { L, palm } from '@/engine/pose/landmarks';
import { kneeLift } from '@/engine/gestures/reps';
import { approach, clamp, clamp01, smoothstep, TAU } from '@/engine/math';
import { C, fade } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

const HILL_PERIOD_SEC = 20;
const REQ_BASE = 1.4;
const REQ_HILL_AMP = 0.6;
const PACE_MIN = 0.45;
const PACE_MAX = 1.5;
const FORM_BONUS_MAX = 0.3;
const REVERSE_AT = 0.72;
const REVERSE_DUR_SEC = 8;
const REVERSE_BONUS = 1.15;
/** Scales the raw cadence integral down to a comfortable score range. */
const K_DIST = 0.3;

const HANDS = [L.LEFT_WRIST, L.RIGHT_WRIST] as const;

class BikePedal implements MiniGame {
  private ctx!: GameContext;
  private repL!: Detector<'rep'>;
  private repR!: Detector<'rep'>;
  private player: PlayerPose | null = null;

  private readonly handL: Pt = { x: 0, y: 0 };
  private readonly handR: Pt = { x: 0, y: 0 };

  private time = 0;
  private distance = 0;
  private strideRate = 0;
  private bestRate = 0;
  private lastStrideT = -1;
  private lastSide: 0 | 1 | 2 = 0;
  private strides = 0;
  private formQuality = 0;
  private formGood = false;
  private reverseActive = false;
  private reverseAnnounced = false;
  private wheelAngle = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // Same signal family as run-in-place-sprint, same reason: the engine's
    // own default enter/exit on `rep` is already measured against this
    // scalar, so there is nothing to retune.
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

    let formNow = this.formQuality;
    if (p) {
      palm(p, 'L', this.handL);
      palm(p, 'R', this.handR);
      const sl = this.repL.read(f);
      const sr = this.repR.read(f);
      if (sl.ok && sl.justCounted) this.confirmStride(1);
      if (sr.ok && sr.justCounted) this.confirmStride(2);

      if (sl.ok && sr.ok) {
        // Circular distance between the two phases, 0..0.5. 0.5 = perfect
        // antiphase — the honest proxy for "hands opposite in the circle".
        const diff = Math.abs(sl.phase - sr.phase);
        const circ = diff > 0.5 ? 1 - diff : diff;
        formNow = clamp01(circ / 0.5);
      }
    }
    this.formQuality = formNow;
    if (!this.formGood && formNow > 0.85) {
      this.formGood = true;
      this.ctx.hud.toast(t('goodForm'), { color: C.accent });
      this.ctx.audio.play('chime', { gain: 0.5 });
    } else if (formNow < 0.4) {
      this.formGood = false;
    }

    if (this.lastStrideT >= 0 && this.time - this.lastStrideT > 0.8) {
      this.strideRate = approach(this.strideRate, 0, 2.5, dt);
    }

    const durationSec = manifest.durationMs / 1000;
    const prog = clamp01(this.time / durationSec);
    this.reverseActive = prog >= REVERSE_AT && this.time < durationSec
      && this.time - REVERSE_AT * durationSec < REVERSE_DUR_SEC;
    if (this.reverseActive && !this.reverseAnnounced) {
      this.reverseAnnounced = true;
      this.ctx.hud.toast(t('reverse'), { color: C.info, big: true });
      this.ctx.audio.play('whoosh', { gain: 0.5 });
    }

    const hill = Math.sin((this.time / HILL_PERIOD_SEC) * TAU);
    const reqCadence = REQ_BASE + hill * REQ_HILL_AMP;
    const pace = clamp(this.strideRate / reqCadence, PACE_MIN, PACE_MAX);
    const formBonus = 1 + FORM_BONUS_MAX * smoothstep(this.formQuality);
    const reverseBonus = this.reverseActive ? REVERSE_BONUS : 1;

    this.distance += this.strideRate * pace * formBonus * reverseBonus * K_DIST * dt;
    this.wheelAngle += this.strideRate * dt * (this.reverseActive ? -1 : 1);

    this.ctx.hud.setBar('distance', clamp01(this.distance / manifest.scoring.maxScore), { labelKo: '거리' });
    this.ctx.hud.setScore(Math.round(this.distance));
  }

  private confirmStride(side: 1 | 2): void {
    if (this.lastSide === side) return;
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

    const groundY = g.h * 0.82;
    g.rect(0, groundY, g.w, g.h - groundY, { fill: fade(C.bgDeep, 0.6) });
    // A tilting road hints at the current hill without any text.
    const hill = Math.sin((this.time / HILL_PERIOD_SEC) * TAU);
    const tilt = hill * g.h * 0.03;
    g.line(0, groundY + tilt, g.w, groundY - tilt, 3 * g.s, { stroke: fade(C.ink, 0.2) });

    const bigR = Math.min(g.w, g.h) * 0.1;
    const smallR = bigR * 0.6;
    const pedalX = g.w * 0.32;
    const wheelX = g.w * 0.68;
    const hubY = groundY - bigR * 1.1;

    // Chain: two tangent lines between the pedal gear and the wheel hub.
    g.line(pedalX, hubY - bigR, wheelX, hubY - smallR, 4 * g.s, { stroke: fade(C.ink, 0.35) });
    g.line(pedalX, hubY + bigR, wheelX, hubY + smallR, 4 * g.s, { stroke: fade(C.ink, 0.35) });

    // The wheel: a rim with spokes, spinning faster than the pedal gear —
    // the gearing feedback the brief asks for. Rotation reverses visually
    // during the "반대로!" window.
    g.circle(wheelX, hubY, smallR * 1.5, { stroke: fade(C.ink, 0.3), sw: 4 * g.s });
    const spokeAngle = this.wheelAngle * 2.4;
    for (let i = 0; i < 6; i++) {
      const a = spokeAngle + (i / 6) * TAU;
      g.line(
        wheelX, hubY,
        wheelX + Math.cos(a) * smallR * 1.5, hubY + Math.sin(a) * smallR * 1.5,
        3 * g.s, { stroke: fade(C.ink, 0.3) },
      );
    }
    g.sprite('ui-gear', wheelX, hubY, smallR * 2, { rot: this.wheelAngle * 2.4 });
    g.sprite('ui-gear', pedalX, hubY, bigR * 2, { rot: this.wheelAngle });

    // Hands as the pedals themselves, tinted by how close to antiphase they
    // currently are — the visual readout for "good form".
    const formColor = this.formQuality > 0.7 ? C.success : C.textFaint;
    for (const hp of [this.handL, this.handR]) {
      g.circle(hp.x, hp.y, 18 * g.s, { stroke: formColor, sw: 3 * g.s, glow: this.formQuality > 0.7 ? 8 : 0 });
    }

    if (this.player) g.ghostBody(this.player, 0.1);
    if (this.player) g.skeleton(this.player, { alpha: 0.45, emphasize: HANDS });

    if (this.reverseActive) {
      g.text(t('reverse'), g.w / 2, g.h * 0.14, {
        size: 32 * g.s, weight: 700, align: 'center', fill: C.info,
        stroke: C.ink, sw: 5 * g.s,
      });
    }
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.formGood) highlights.push('페달링 자세가 좋았어요!');
    if (this.distance >= manifest.scoring.maxScore * 0.75) highlights.push('멀리까지 달렸어요!');
    return {
      gameId: manifest.id,
      cleared: this.strides > 0,
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

export default (): MiniGame => new BikePedal();

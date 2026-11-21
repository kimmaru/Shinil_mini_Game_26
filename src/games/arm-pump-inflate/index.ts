// ─── SHAPE A variant — scalar rep counter (arm pump) ──────────────────────────
//
// Signal: average wrist height above the shoulders, in shoulder-widths. A
// single `rep` detector with a 0.6 shoulder-width enter/exit GAP is the whole
// "amplitude floor" from the brief — hysteresis already enforces "you must
// swing this far", so a child who vibrates their hands in place never
// crosses both thresholds and never counts a pump.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Renderer,
} from '@/engine/types';
import { L, ny } from '@/engine/pose/landmarks';
import { clamp01, pulse } from '@/engine/math';
import { squash } from '@/engine/motion/tokens';
import { C, fade } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

const SLOTS = 2;
/** Visual/scoring target. Bursting past this banks only 70%. */
const BURST_NOMINAL = 100;
const BURST_JITTER = 10;
const BANK_FRACTION = 0.7;
/** Shoulder-widths per confirmed pump. */
const INFLATE_PER_REP = 7;
/** Shoulder-widths/sec of leak, baseline vs. resting (not pumping). */
const LEAK_BASE = 1.4;
const LEAK_REST_MULT = 2.3;
const REST_IDLE_SEC = 0.7;
/** Fraction of the round elapsed before the second balloon appears. */
const SECOND_BALLOON_AT = 0.6;

const HANDS = [L.LEFT_WRIST, L.RIGHT_WRIST] as const;

/** Average wrist height above the shoulder line, shoulder-widths, +up.
 *  `n` is hip-centred with +y DOWN, so "above" is shoulderY minus wristY. */
function pumpSignal(p: PlayerPose): number {
  const shoulderY = (ny(p, L.LEFT_SHOULDER) + ny(p, L.RIGHT_SHOULDER)) / 2;
  const wristY = (ny(p, L.LEFT_WRIST) + ny(p, L.RIGHT_WRIST)) / 2;
  return shoulderY - wristY;
}

class ArmPumpInflate implements MiniGame {
  private ctx!: GameContext;
  private pump!: Detector<'rep'>;
  private player: PlayerPose | null = null;

  private readonly size = new Float32Array(SLOTS);
  private readonly burstAt = new Float32Array(SLOTS);
  private readonly popFlash = new Float32Array(SLOTS);
  private activeSlots = 1;

  private bankedScore = 0;
  private bestSize = 0;
  private pops = 0;
  private hits = 0;
  private time = 0;
  private lastRepT = -10;
  /** Last read rep phase (0..1), captured in update() so render() never has
   *  to call a detector's read() itself — it can run between fixed updates. */
  private phase = 0;
  /** Scratch for slot positions. Pre-allocated; never replaced. */
  private readonly slotAt = { x: 0, y: 0 };

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // The 0.6 SW gap between enter and exit IS the amplitude floor: a pump
    // that never swings this far cannot cross both thresholds, so it cannot
    // count — no hand-rolled amplitude check needed.
    this.pump = ctx.gestures.use('rep', {
      signal: pumpSignal,
      enter: -0.6,
      exit: -1.2,
      needs: [L.LEFT_WRIST, L.RIGHT_WRIST, L.LEFT_SHOULDER, L.RIGHT_SHOULDER],
    });
    this.burstAt[0] = BURST_NOMINAL;
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    for (let i = 0; i < SLOTS; i++) {
      if (this.popFlash[i]! > 0) this.popFlash[i] = Math.max(0, this.popFlash[i]! - dt * 1.6);
    }

    const p = f.p1;
    this.player = p ?? null;
    const prog = clamp01(this.time / (manifest.durationMs / 1000));

    if (p) {
      const s = this.pump.read(f);
      if (s.ok) this.phase = s.phase;
      if (s.ok && s.justCounted) {
        this.hits++;
        this.lastRepT = this.time;
        for (let i = 0; i < this.activeSlots; i++) {
          this.size[i] = Math.min(BURST_NOMINAL * 1.4, this.size[i]! + INFLATE_PER_REP);
        }
        this.ctx.audio.play('boing', { gain: 0.45, rate: 1 + Math.min(this.hits, 10) * 0.015 });
        this.ctx.emit({ kind: 'scored', points: INFLATE_PER_REP });
      }
    }

    // Reveal the second balloon once: more air to manage, same pump.
    if (this.activeSlots < SLOTS && prog > SECOND_BALLOON_AT) {
      this.activeSlots = SLOTS;
      this.burstAt[1] = BURST_NOMINAL + (this.ctx.rng() * 2 - 1) * BURST_JITTER;
      this.ctx.hud.toast(t('secondBalloon'), { color: C.accent });
    }

    // Leaking: always a little, much more if you stop pumping. This is the
    // whole reason "pump steadily" beats "one huge pump then rest".
    const idleFor = this.time - this.lastRepT;
    const leakMult = idleFor > REST_IDLE_SEC ? LEAK_REST_MULT : 1;
    const leak = LEAK_BASE * (1 + prog * 0.6) * leakMult * dt;
    let total = this.bankedScore;
    for (let i = 0; i < this.activeSlots; i++) {
      this.size[i] = Math.max(0, this.size[i]! - leak);
      if (this.size[i]! > this.bestSize) this.bestSize = this.size[i]!;

      if (this.size[i]! >= this.burstAt[i]!) {
        const prev = this.size[i]!;
        const banked = Math.round(prev * BANK_FRACTION);
        this.bankedScore += banked;
        this.pops++;
        this.popFlash[i] = 1;
        this.size[i] = 0;
        this.burstAt[i] = BURST_NOMINAL + (this.ctx.rng() * 2 - 1) * BURST_JITTER;
        this.ctx.hud.toast(t('pop'), { color: C.warn });
        this.ctx.audio.play('break', { gain: 0.55 });
        this.ctx.emit({ kind: 'scored', points: banked });
      }
      total += this.size[i]!;
    }
    this.ctx.hud.setScore(Math.round(total));
  }

  private slotPos(i: number, out: { x: number; y: number }): void {
    const { w, h } = this.ctx.view;
    out.x = this.activeSlots === 1 ? w * 0.5 : w * (0.32 + i * 0.36);
    out.y = h * 0.52;
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    // Ground platform: a simple seat line, so the standing-vs-seated reads.
    g.rect(0, g.h * 0.86, g.w, g.h * 0.14, { fill: fade(C.bgDeep, 0.6) });

    const baseR = Math.min(g.w, g.h) * 0.17;
    const pos = this.slotAt;
    for (let i = 0; i < this.activeSlots; i++) {
      this.slotPos(i, pos);
      const frac = clamp01(this.size[i]! / BURST_NOMINAL);
      const grow = 0.5 + 0.7 * frac;
      // Elastic squash synced to the pump rhythm — the entire feel budget for
      // this game goes here, per the brief. `phase` was captured in update(),
      // never re-read from the detector here.
      const { sx, sy } = squash(pulse(this.phase) * 0.22);
      const flash = this.popFlash[i]!;
      if (flash > 0) {
        g.circle(pos.x, pos.y, baseR * (1.3 + (1 - flash) * 0.9), {
          stroke: fade(C.accent, flash * 0.6), sw: 5 * g.s,
        });
      }
      g.line(pos.x, pos.y + baseR * grow, pos.x, g.h * 0.86, 2 * g.s, { stroke: fade(C.ink, 0.25) });
      g.sprite('balloon', pos.x, pos.y, baseR * 2 * grow, {
        hue: frac > 0.8 ? 26 : manifest.theme?.hue,
        scaleX: sx, scaleY: sy,
      });
      if (frac > 0.78) {
        g.circle(pos.x, pos.y, baseR * grow * 1.08, { stroke: C.warn, sw: 3 * g.s });
      }
    }

    if (this.player) g.ghostBody(this.player, 0.1);
    if (this.player) g.skeleton(this.player, { alpha: 0.45, emphasize: HANDS });
  }

  end(_reason: EndReason): GameResult {
    let total = this.bankedScore;
    for (let i = 0; i < this.activeSlots; i++) total += this.size[i]!;
    const highlights: string[] = [];
    if (this.pops >= 1) highlights.push(`풍선 ${this.pops}개 터뜨렸어요!`);
    if (this.bestSize >= BURST_NOMINAL * 0.9) highlights.push('빵빵하게 불었어요!');
    return {
      gameId: manifest.id,
      cleared: this.hits > 0,
      rawScore: Math.round(total),
      maxScore: manifest.scoring.maxScore,
      normalized: 0,
      stars: 0,
      durationMs: manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score: Math.round(total),
        hits: this.hits, misses: 0, bestCombo: Math.round(this.bestSize),
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }

  dispose(): void {
    // No pooled entities, no music started — nothing to tear down.
  }
}

export default (): MiniGame => new ArmPumpInflate();

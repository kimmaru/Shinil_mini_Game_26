// ─── arm-pump-inflate — scalar rep counter (arm pump) ─────────────────────────
//
// Signal: average wrist height above the shoulder line, in shoulder-widths
// (0 = wrists at shoulder height, about -1.5 = arms hanging). One rented `rep`
// counts a pump on each rising crossing of `enter`, and only after the hands
// fell below `exit` first. That 0.5 shoulder-width gap IS the amplitude floor:
// vibrating the hands in place never crosses both lines, so it never counts.
// The rep detector's own cooldown (250 ms) caps the pace at 4 pumps/s.
//
// Every pump inflates the balloon (loud: ladder pitch + sparkle); a full
// balloon pops with a bang and a bonus. Resting only lets a little air out —
// there is no failure state.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Renderer,
} from '@/engine/types';
import { L, ny } from '@/engine/pose/landmarks';
import { approach, clamp01, easeOutBack, lerp, pulse } from '@/engine/math';
import { C, fade, hue as hsl } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

const PUMP_POINTS = 10;
const POP_POINTS = 50;
const GROUND_LINE = fade(C.hot, 0.35);
const HOSE = fade(C.ink, 0.55);
const ACCENT_DIM = fade(C.accent, 0.3);
const LABEL_PUMP = '+10';
const LABEL_POP = '+50';
/** Pumps needed to fill the first balloon; later ones need a little more. */
const NEED_FIRST = 8;
const NEED_MAX = 10;
const LEAK_AFTER = 0.9;
/** Pumps of air lost per second while resting. */
const LEAK_RATE = 0.4;
const HUES = [322, 42, 140, 266, 8] as const;
const SKY = hsl(205, 80, 85);
const HANDS = [L.LEFT_WRIST, L.RIGHT_WRIST] as const;
const NEEDS = [L.LEFT_WRIST, L.RIGHT_WRIST, L.LEFT_SHOULDER, L.RIGHT_SHOULDER] as const;

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

  private time = 0;
  private score = 0;
  private pumps = 0;
  private pops = 0;
  private bestStreak = 0;
  private streak = 0;
  private air = 0;
  private need = NEED_FIRST;
  private lastPumpT = -10;
  /** 0..1 handle position, following the player's own hands. */
  private handle = 0;
  private squash = 0;
  private popFlash = 0;
  private born = 1;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.pump = ctx.gestures.use('rep', {
      signal: pumpSignal,
      enter: -0.4,
      exit: -0.9,
      needs: NEEDS,
      cooldownMs: 250,
    });
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.hud.setBar('fill', 0, { labelKo: t('fill'), color: C.hot });
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    if (this.squash > 0) this.squash = Math.max(0, this.squash - dt * 5);
    if (this.popFlash > 0) this.popFlash = Math.max(0, this.popFlash - dt * 1.8);
    if (this.born < 1) this.born = Math.min(1, this.born + dt * 2.5);

    const p = f.p1;
    this.player = p ?? null;
    if (p) {
      this.handle = approach(this.handle, clamp01((pumpSignal(p) + 1.3) / 1.0), 22, dt);
      const s = this.pump.read(f);
      if (s.ok && s.justCounted) this.onPump();
    }

    // Resting lets a little air out. Quiet: nothing flashes, nothing buzzes.
    if (this.time - this.lastPumpT > LEAK_AFTER) {
      if (this.air > 0) {
        this.air = Math.max(0, this.air - LEAK_RATE * dt);
        this.ctx.hud.setBar('fill', this.air / this.need, { labelKo: t('fill'), color: C.hot });
      }
      this.streak = 0;
    }
  }

  private onPump(): void {
    this.pumps++;
    this.streak++;
    if (this.streak > this.bestStreak) this.bestStreak = this.streak;
    this.lastPumpT = this.time;
    this.air += 1;
    this.squash = 1;
    this.score += PUMP_POINTS;

    const { w, h } = this.ctx.view;
    const bx = w * 0.74;
    const by = h * 0.4;
    this.ctx.fx.impact(bx, by, 'tap', { color: C.hot, sprite: 'sparkle', label: LABEL_PUMP });
    this.ctx.audio.playLadder('boing', Math.min(this.streak, 12), { gain: 0.45 });
    this.ctx.emit({ kind: 'scored', points: PUMP_POINTS });

    if (this.air >= this.need) {
      this.pops++;
      this.score += POP_POINTS;
      this.air = 0;
      this.need = Math.min(NEED_MAX, this.need + 1 - (this.pops % 2));
      this.popFlash = 1;
      this.born = 0;
      this.ctx.fx.impact(bx, by, 'big', { color: C.accent, sprite: 'sparkle', label: LABEL_POP });
      this.ctx.audio.play('hit.crit', { gain: 0.7 });
      this.ctx.audio.play('sparkle', { gain: 0.6 });
      this.ctx.hud.toast(this.pops % 2 === 0 ? t('nice') : t('pop'), { color: C.hot, big: true });
      this.ctx.emit({ kind: 'scored', points: POP_POINTS });
    }
    this.ctx.hud.setScore(this.score);
    this.ctx.hud.setBar('fill', this.air / this.need, { labelKo: t('fill'), color: C.hot });
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);
    g.rect(0, 0, g.w, g.h, { fill: SKY });
    const s = g.s;
    const groundY = g.h * 0.86;
    g.rect(0, groundY, g.w, g.h - groundY, { fill: C.bgDeep });
    g.rect(0, groundY, g.w, 8 * s, { fill: GROUND_LINE });

    const bx = g.w * 0.74;
    const fill = clamp01(this.air / this.need);
    const rMax = Math.min(g.w, g.h) * 0.2;
    const rBase = lerp(0.46, 1, fill) * rMax;
    const grow = this.born < 1 ? easeOutBack(this.born) : 1;
    const r = rBase * grow;
    const sx = 1 + 0.12 * this.squash;
    const sy = 1 - 0.1 * this.squash;
    const cy = g.h * 0.4;
    const hue = HUES[this.pops % HUES.length]!;

    // Pump: base, barrel, and a handle that follows the player's own hands.
    const px = bx;
    const baseW = 150 * s;
    const barrelTop = g.h * 0.7;
    const handleY = lerp(g.h * 0.64, barrelTop - 14 * s, 1 - this.handle);
    g.line(px + 34 * s, barrelTop + 14 * s, bx, cy + r * 1.05, 9 * s, { stroke: HOSE });
    g.roundRect(px - baseW / 2, groundY - 24 * s, baseW, 24 * s, 8 * s, { fill: C.primary, stroke: C.ink, sw: 4 * s });
    g.roundRect(px - 34 * s, barrelTop, 68 * s, groundY - barrelTop - 8 * s, 10 * s, { fill: C.primaryLo, stroke: C.ink, sw: 4 * s });
    g.line(px, handleY, px, barrelTop + 4 * s, 12 * s, { stroke: C.ink });
    g.roundRect(px - 56 * s, handleY - 14 * s, 112 * s, 24 * s, 12 * s, { fill: C.accent, stroke: C.ink, sw: 4 * s });

    if (this.popFlash > 0) {
      g.circle(bx, cy, rMax * (1.1 + (1 - this.popFlash) * 0.9), {
        stroke: fade(C.accent, this.popFlash * 0.7), sw: 8 * s,
      });
    }
    g.sprite('balloon', bx, cy, r * 2.2, {
      hue, scaleX: sx, scaleY: sy, rot: Math.sin(this.time * 2.2) * 0.04,
      glow: fill > 0.85 ? 14 : 0,
    });

    if (this.player) {
      g.ghostBody(this.player, 0.1);
      g.skeleton(this.player, { alpha: 0.75, outline: true, emphasize: HANDS });
    }

    if (this.time - this.lastPumpT > 2) {
      const k = 0.92 + 0.08 * pulse((this.time * 1.5) % 1);
      g.text(t('prompt'), g.w * 0.4, g.h * 0.12, {
        size: 56 * s * k, weight: 800, display: true, align: 'center', baseline: 'middle',
        fill: C.hot, stroke: C.white, sw: 8 * s,
      });
      g.text(t('promptSub'), g.w * 0.4, g.h * 0.2, {
        size: 38 * s, weight: 700, align: 'center', baseline: 'middle',
        fill: C.text, stroke: C.white, sw: 6 * s,
      });
      const up = (this.time * 1.6) % 2 < 1;
      g.chevron(g.w * 0.16, g.h * 0.46, 36 * s, -Math.PI / 2, { fill: up ? C.accent : ACCENT_DIM, stroke: C.ink, sw: 3 * s });
      g.chevron(g.w * 0.16, g.h * 0.6, 36 * s, Math.PI / 2, { fill: up ? ACCENT_DIM : C.accent, stroke: C.ink, sw: 3 * s });
    }
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.pops >= 1) highlights.push(`풍선 ${this.pops}개를 터뜨렸어요!`);
    if (this.bestStreak >= 20) highlights.push('쉬지 않고 펌프질했어요!');
    return {
      gameId: manifest.id,
      cleared: this.pumps > 0,
      rawScore: this.score,
      maxScore: manifest.scoring.maxScore,
      normalized: 0,
      stars: 0,
      durationMs: manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score: this.score,
        hits: this.pumps, misses: 0, bestCombo: this.bestStreak,
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }
}

export default (): MiniGame => new ArmPumpInflate();

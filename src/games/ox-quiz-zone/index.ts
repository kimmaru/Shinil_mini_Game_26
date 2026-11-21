// ─── ox-quiz-zone — OX 퀴즈 (Shape A, discrete cue x whole-body zone trigger) ──
//
// The player's hip-centre x decides O (screen-left) or X (screen-right).
// This is a screen-space "which half of the room" question, not a size or
// distance threshold — the same technique the `zone` detector itself uses
// internally (a rect in 0..1 view fractions) — so there is no fairness issue
// the way a raw-pixel THRESHOLD would have: a short child and a tall one
// standing on the same side of the room both land in the same zone.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Renderer,
} from '@/engine/types';
import { L, hipPx } from '@/engine/pose/landmarks';
import { clamp01, easeOutBack } from '@/engine/math';
import { chance, randInt } from '@/engine/spawn';
import { C, fade } from '@/engine/render/palette';
import { manifest } from './manifest';
import { QUIZ_BANK, t } from './locale';

const ROUND_N = 9;
const COMPARE_CHANCE = 0.22;
const COMPARE_MIN = 2;
const COMPARE_MAX = 6;

const THINK_SEC = 4.0;
/** Last second of thinking time: the zone borders blink fast. */
const BLINK_SEC = 1.0;
const REVEAL_SEC = 1.3;
const GAP_SEC = 0.4;

const PHASE_THINK = 0;
const PHASE_REVEAL = 1;
const PHASE_GAP = 2;

const SIDE_O = 0;
const SIDE_X = 1;
const SIDE_NONE = -1;

const POINTS = 20;

class OxQuizZone implements MiniGame {
  private ctx!: GameContext;
  private zoneO!: Detector<'zone'>;
  private zoneX!: Detector<'zone'>;

  private player: PlayerPose | null = null;
  private readonly hip = { x: 0, y: 0 };

  // This round's 9 questions, decided once from the seeded rng so a replay
  // reproduces the same quiz. Fixed-size typed arrays: no per-frame growth.
  private readonly slotCompare = new Uint8Array(ROUND_N);
  private readonly slotFact = new Int32Array(ROUND_N);
  private readonly slotCmpLeft = new Int32Array(ROUND_N);
  private readonly slotCmpRight = new Int32Array(ROUND_N);

  private time = 0;
  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private hits = 0;
  private misses = 0;

  private qIndex = 0;
  private phase = PHASE_THINK;
  private phaseT = THINK_SEC;
  private phaseTotal = THINK_SEC;
  private correctSide = SIDE_O;
  private chosenSide = SIDE_NONE;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // Whole-body translation, not hands: watch the hips, both halves of the
    // view, with the zone detector's own margin hysteresis so standing
    // exactly on the centre line never flickers between sides.
    this.zoneO = ctx.gestures.use('zone', { x: 0, y: 0, w: 0.5, h: 1, joints: [L.LEFT_HIP, L.RIGHT_HIP] });
    this.zoneX = ctx.gestures.use('zone', { x: 0.5, y: 0, w: 0.5, h: 1, joints: [L.LEFT_HIP, L.RIGHT_HIP] });

    const pool: number[] = [];
    for (let i = 0; i < QUIZ_BANK.length; i++) pool.push(i);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(ctx.rng() * (i + 1));
      const tmp = pool[i]!;
      pool[i] = pool[j]!;
      pool[j] = tmp;
    }
    let fi = 0;
    for (let i = 0; i < ROUND_N; i++) {
      // Mixed in so a child who cannot read yet can still play some rounds:
      // "which side has more shapes" needs no text at all.
      if (chance(ctx.rng, COMPARE_CHANCE)) {
        this.slotCompare[i] = 1;
        const left = randInt(ctx.rng, COMPARE_MIN, COMPARE_MAX);
        let right = randInt(ctx.rng, COMPARE_MIN, COMPARE_MAX);
        if (right === left) right = left >= COMPARE_MAX ? left - 1 : left + 1;
        this.slotCmpLeft[i] = left;
        this.slotCmpRight[i] = right;
      } else {
        this.slotCompare[i] = 0;
        this.slotFact[i] = pool[fi % pool.length]!;
        fi++;
      }
    }
    this.startQuestion(0);
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    const p = f.p1;
    this.player = p ?? null;
    if (p) hipPx(p, this.hip);

    const zo = this.zoneO.read(f);
    const zx = this.zoneX.read(f);

    if (this.phase === PHASE_THINK) {
      this.phaseT -= dt;
      if (this.phaseT <= 0) this.commit(zo.inside, zx.inside);
    } else if (this.phase === PHASE_REVEAL) {
      this.phaseT -= dt;
      if (this.phaseT <= 0) {
        this.phase = PHASE_GAP;
        this.phaseT = GAP_SEC;
        this.phaseTotal = GAP_SEC;
      }
    } else {
      this.phaseT -= dt;
      if (this.phaseT <= 0) this.startQuestion((this.qIndex + 1) % ROUND_N);
    }
  }

  /** Judged at the deadline MOMENT: wherever the body happens to be when the
   *  window closes, not any position passed through earlier. */
  private commit(oIn: boolean, xIn: boolean): void {
    this.chosenSide = oIn && !xIn ? SIDE_O : xIn && !oIn ? SIDE_X : SIDE_NONE;
    const correct = this.chosenSide === this.correctSide;

    if (correct) {
      this.hits++;
      this.combo++;
      if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      this.score += POINTS;
      this.ctx.fx.impact(this.hip.x, this.hip.y, this.combo >= 3 ? 'big' : 'hit', {
        color: C.success, sprite: 'sparkle', label: `+${POINTS}`,
      });
      this.ctx.audio.playLadder('pop', this.combo);
      this.ctx.hud.setScore(this.score);
      this.ctx.hud.setCombo(this.combo);
      this.ctx.emit({ kind: 'scored', points: POINTS });
    } else {
      this.misses++;
      this.combo = 0;
      // Quiet by construction: no shake, no flash, no red on the player.
      this.ctx.fx.miss(this.hip.x, this.hip.y);
      this.ctx.hud.setCombo(0);
      this.ctx.emit({ kind: 'miss' });
    }

    // The reveal itself is neutral information — it happens the same way
    // whether the player got it right or not.
    const vw = this.ctx.view.w;
    const vh = this.ctx.view.h;
    const zoneCx = this.correctSide === SIDE_O ? vw * 0.25 : vw * 0.75;
    this.ctx.fx.pop(zoneCx, vh * 0.5, Math.min(vw, vh) * 0.3, this.correctSide === SIDE_O ? C.success : C.hot);
    this.ctx.hud.toast(this.correctSide === SIDE_O ? t('correctO') : t('correctX'), { color: C.text });

    this.phase = PHASE_REVEAL;
    this.phaseT = REVEAL_SEC;
    this.phaseTotal = REVEAL_SEC;
  }

  private startQuestion(i: number): void {
    this.qIndex = i;
    if (this.slotCompare[i]) {
      this.correctSide = this.slotCmpLeft[i]! > this.slotCmpRight[i]! ? SIDE_O : SIDE_X;
    } else {
      const item = QUIZ_BANK[this.slotFact[i]!]!;
      this.correctSide = item.answer === 'O' ? SIDE_O : SIDE_X;
    }
    this.chosenSide = SIDE_NONE;
    this.phase = PHASE_THINK;
    this.phaseT = THINK_SEC;
    this.phaseTotal = THINK_SEC;
    this.ctx.hud.announce(this.questionText(), { speak: true });
  }

  private questionText(): string {
    return this.slotCompare[this.qIndex] ? t('compareHint') : QUIZ_BANK[this.slotFact[this.qIndex]!]!.textKo;
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);
    this.drawZones(g);
    if (this.player) g.ghostBody(this.player, 0.12);
    if (this.player) g.skeleton(this.player, { alpha: 0.6 });
    this.drawBanner(g);
  }

  private drawZones(g: Renderer): void {
    const halfW = g.w / 2;
    g.rect(0, 0, halfW, g.h, { fill: fade(C.success, 0.09) });
    g.rect(halfW, 0, halfW, g.h, { fill: fade(C.hot, 0.09) });
    g.line(halfW, 0, halfW, g.h, 2 * g.s, { stroke: fade(C.ink, 0.15) });

    const ringR = Math.min(g.w, g.h) * 0.24;
    const oy = g.h * 0.46;
    g.circle(halfW * 0.5, oy, ringR, { stroke: C.success, sw: 10 * g.s });
    const xr = ringR * 0.86;
    const xcx = halfW * 1.5;
    g.line(xcx - xr, oy - xr, xcx + xr, oy + xr, 10 * g.s, { stroke: C.hot });
    g.line(xcx + xr, oy - xr, xcx - xr, oy + xr, 10 * g.s, { stroke: C.hot });

    // Last second: both borders blink fast — the universal "deciding now".
    if (this.phase === PHASE_THINK && this.phaseT < BLINK_SEC) {
      const blink = 0.4 + 0.5 * Math.abs(Math.sin(this.time * 16));
      g.save();
      g.alpha(blink);
      g.rect(2 * g.s, 2 * g.s, halfW - 4 * g.s, g.h - 4 * g.s, { stroke: C.warn, sw: 8 * g.s });
      g.rect(halfW + 2 * g.s, 2 * g.s, halfW - 4 * g.s, g.h - 4 * g.s, { stroke: C.warn, sw: 8 * g.s });
      g.restore();
    }

    // Reveal: the correct zone brightens as if it just lit up.
    if (this.phase === PHASE_REVEAL) {
      const k = easeOutBack(1 - this.phaseT / this.phaseTotal);
      const cx = this.correctSide === SIDE_O ? halfW * 0.5 : halfW * 1.5;
      const col = this.correctSide === SIDE_O ? C.success : C.hot;
      g.save();
      g.alpha(clamp01(0.5 * k));
      g.circle(cx, oy, ringR * (0.8 + 0.4 * k), { fill: col });
      g.restore();
    }

    if (this.slotCompare[this.qIndex]) {
      this.drawCompareShapes(g, this.slotCmpLeft[this.qIndex]!, halfW * 0.5, g.h * 0.8);
      this.drawCompareShapes(g, this.slotCmpRight[this.qIndex]!, halfW * 1.5, g.h * 0.8);
    }
  }

  private drawCompareShapes(g: Renderer, count: number, cx: number, cy: number): void {
    const cols = 3;
    const r = 15 * g.s;
    const gap = r * 2.5;
    for (let i = 0; i < count; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = cx + (col - 1) * gap;
      const y = cy + row * gap * 0.9;
      g.circle(x, y, r, { fill: C.accent, stroke: C.ink, sw: 2 * g.s });
    }
  }

  private drawBanner(g: Renderer): void {
    if (this.phase === PHASE_GAP) return;
    const bw = Math.min(g.w * 0.86, 680 * g.s);
    const bh = 96 * g.s;
    const bx = g.w / 2 - bw / 2;
    const by = g.h * 0.04;
    g.roundRect(bx, by, bw, bh, 18 * g.s, { fill: fade(C.bg, 0.94), stroke: C.textFaint, sw: 3 * g.s });
    g.text(this.questionText(), g.w / 2, by + bh / 2, {
      size: 30 * g.s, weight: 800, display: true, align: 'center', baseline: 'middle',
      fill: C.text, maxWidth: bw * 0.92,
    });

    if (this.phase === PHASE_THINK) {
      const ratio = clamp01(this.phaseT / this.phaseTotal);
      const barW = bw * 0.9;
      const barX = g.w / 2 - barW / 2;
      const barY = by + bh + 10 * g.s;
      const barCol = ratio > 0.4 ? C.success : ratio > 0.2 ? C.warn : C.danger;
      g.roundRect(barX, barY, barW, 10 * g.s, 5 * g.s, { fill: fade(C.ink, 0.1) });
      g.roundRect(barX, barY, barW * ratio, 10 * g.s, 5 * g.s, { fill: barCol });
    }
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.bestCombo >= 4) highlights.push(`${this.bestCombo}문제 연속 정답!`);
    if (this.hits >= 7) highlights.push(`정답 ${this.hits}개!`);
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
        hits: this.hits, misses: this.misses, bestCombo: this.bestCombo,
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }

  dispose(): void {}
}

export default (): MiniGame => new OxQuizZone();

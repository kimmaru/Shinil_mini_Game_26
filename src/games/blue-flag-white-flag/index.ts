// ─── blue-flag-white-flag — 청기백기 (Shape A, discrete cue x pose trigger) ──
//
// MIRRORING, checked against src/engine/pose/landmarks.ts rather than assumed:
// Side 'L'/'R' (and RaiseSignal.left/right) are already THE PLAYER'S OWN left
// and right — the engine mirrors `px` once, centrally, specifically so that
// "왼손" never needs a flip in game code. 왼손(subject's left) = 백기,
// 오른손(subject's right) = 청기, read straight off `raise.left`/`raise.right`.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Renderer,
} from '@/engine/types';
import { palm } from '@/engine/pose/landmarks';
import { clamp01, lerp } from '@/engine/math';
import { C, fade } from '@/engine/render/palette';
import { manifest } from './manifest';
import { INSTRUCTIONS, type Clause, type FlagState, type Instruction, t } from './locale';

const WINDOW_START = 4.4;
const WINDOW_END = 2.3;
const RAMP_UNTIL = 0.8;
/** 함정 지시 gets this much extra time to read, per the brief. */
const TRAP_BONUS = 0.4;
/** Seconds before the second clause of a multi-clause instruction appears. */
const CLAUSE_DELAY = 0.55;
const DOUBLE_AFTER = 0.45;
const DOUBLE_CHANCE = 0.3;
/** Fraction of the round after which an un-mentioned flag must not move at
 *  all — "안 바뀌면 유지": unnecessary movement becomes wrong too. */
const STRICT_KEEP_AT = 0.55;

const POINTS = 15;

const BLUE_COLOR = C.primary;
const WHITE_COLOR = C.ink;

class BlueFlagWhiteFlag implements MiniGame {
  private ctx!: GameContext;
  private raise!: Detector<'raise'>;

  private player: PlayerPose | null = null;
  private readonly handL = { x: 0, y: 0 };
  private readonly handR = { x: 0, y: 0 };

  private time = 0;
  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private hits = 0;
  private misses = 0;

  private prevIdx = -1;
  private instr: Instruction = INSTRUCTIONS[0]!;
  private window = 0;
  private windowTotal = 1;
  private clauseRevealT = 0;
  private queueDepth = 0;
  private trapBadgeAlpha = 0;

  private strictKeep = false;
  private announcedStrict = false;
  private prevBlueUp = false;
  private prevWhiteUp = false;
  private snapshotBlueUp = false;
  private snapshotWhiteUp = false;
  private touchedBlueKeep = false;
  private touchedWhiteKeep = false;
  private justStarted = true;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.raise = ctx.gestures.use('raise', { side: 'either', above: 0.25 });
    this.startNextInstruction();
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    if (this.clauseRevealT > 0) this.clauseRevealT -= dt;
    if (this.trapBadgeAlpha > 0) this.trapBadgeAlpha = Math.max(0, this.trapBadgeAlpha - dt * 2);

    const p = f.p1;
    this.player = p ?? null;
    if (p) {
      palm(p, 'L', this.handL);
      palm(p, 'R', this.handR);
    }

    const r = this.raise.read(f);
    // Gate, don't guess: hold the last known state while landmarks are lost
    // rather than let a dropout read as "lowered".
    const blueUp = r.ok ? r.right : this.prevBlueUp;
    const whiteUp = r.ok ? r.left : this.prevWhiteUp;

    if (this.justStarted) {
      this.justStarted = false;
    } else if (this.strictKeep) {
      if (this.instr.blue === 'keep' && blueUp !== this.prevBlueUp) this.touchedBlueKeep = true;
      if (this.instr.white === 'keep' && whiteUp !== this.prevWhiteUp) this.touchedWhiteKeep = true;
    }
    this.prevBlueUp = blueUp;
    this.prevWhiteUp = whiteUp;

    if (this.window > 0) {
      this.window -= dt;
      if (this.window <= 0) this.judge(blueUp, whiteUp);
    }
  }

  private judge(blueUp: boolean, whiteUp: boolean): void {
    const blueOk = this.flagOk(this.instr.blue, blueUp, this.snapshotBlueUp, this.touchedBlueKeep);
    const whiteOk = this.flagOk(this.instr.white, whiteUp, this.snapshotWhiteUp, this.touchedWhiteKeep);
    this.resolve(blueOk && whiteOk);
  }

  private flagOk(target: FlagState, up: boolean, snapshot: boolean, touched: boolean): boolean {
    if (target === 'up') return up;
    if (target === 'down') return !up;
    // 'keep': don't-care early, "untouched and unchanged" once strictKeep.
    return this.strictKeep ? up === snapshot && !touched : true;
  }

  private resolve(correct: boolean): void {
    const cx = (this.handL.x + this.handR.x) / 2;
    const cy = (this.handL.y + this.handR.y) / 2;
    if (correct) {
      this.hits++;
      this.combo++;
      if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      this.score += POINTS;
      this.ctx.fx.impact(cx, cy, this.combo >= 6 ? 'big' : 'hit', {
        color: C.success, sprite: 'sparkle', label: `+${POINTS}`,
      });
      this.ctx.audio.playLadder('pop', this.combo);
      if (this.combo > 0 && this.combo % 4 === 0) {
        this.ctx.hud.toast(this.combo >= 8 ? t('wow') : t('nice'), { color: C.accent });
      }
      this.ctx.hud.setScore(this.score);
      this.ctx.hud.setCombo(this.combo);
      this.ctx.emit({ kind: 'scored', points: POINTS });
    } else {
      this.misses++;
      this.combo = 0;
      // Quiet by construction: no shake, no flash, no red.
      this.ctx.fx.miss(cx, cy);
      this.ctx.hud.setCombo(0);
      this.ctx.emit({ kind: 'miss' });
    }
    this.startNextInstruction();
  }

  private startNextInstruction(): void {
    const totalSec = manifest.durationMs / 1000;
    const elapsedFrac = clamp01(this.time / totalSec);

    if (!this.strictKeep && elapsedFrac >= STRICT_KEEP_AT) {
      this.strictKeep = true;
      if (!this.announcedStrict) {
        this.announcedStrict = true;
        this.ctx.hud.announce(t('keepWarn'), { assertive: true });
        this.ctx.hud.toast(t('keepWarn'), { color: C.warn });
      }
    }

    const rampFrac = clamp01(elapsedFrac / RAMP_UNTIL);
    const chained = this.queueDepth > 0;

    let idx = Math.floor(this.ctx.rng() * INSTRUCTIONS.length);
    if (idx === this.prevIdx) idx = (idx + 1) % INSTRUCTIONS.length;
    this.prevIdx = idx;
    this.instr = INSTRUCTIONS[idx]!;

    let window = lerp(WINDOW_START, WINDOW_END, rampFrac) * (chained ? 0.78 : 1);
    if (this.instr.trap) window += TRAP_BONUS;
    this.window = window;
    this.windowTotal = window;
    this.clauseRevealT = this.instr.clauses.length > 1 ? CLAUSE_DELAY : 0;
    this.trapBadgeAlpha = this.instr.trap ? 1 : 0;

    this.snapshotBlueUp = this.prevBlueUp;
    this.snapshotWhiteUp = this.prevWhiteUp;
    this.touchedBlueKeep = false;
    this.touchedWhiteKeep = false;
    this.justStarted = true;

    if (chained) this.queueDepth--;
    else if (elapsedFrac > DOUBLE_AFTER && this.ctx.rng() < DOUBLE_CHANCE) this.queueDepth = 1;
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    if (this.player) g.ghostBody(this.player, 0.1);
    if (this.player) g.skeleton(this.player, { alpha: 0.5 });

    this.drawFlag(g, this.handR.x, this.handR.y, this.prevBlueUp, BLUE_COLOR, 'blue');
    this.drawFlag(g, this.handL.x, this.handL.y, this.prevWhiteUp, WHITE_COLOR, 'white');

    this.drawBanner(g);
  }

  private drawFlag(
    g: Renderer, x: number, y: number, up: boolean, color: string, badge: 'blue' | 'white',
  ): void {
    const poleLen = 72 * g.s;
    const poleTopY = up ? y - poleLen : y - poleLen * 0.35;
    g.line(x, y, x, poleTopY, 3 * g.s, { stroke: C.textDim });
    const wave = Math.sin(g.t * 5 + x * 0.01) * (up ? 6 * g.s : 2 * g.s);
    const clothW = 34 * g.s;
    const clothH = 24 * g.s;
    const fill = badge === 'white' ? C.white : color;
    g.roundRect(x + 2 * g.s, poleTopY, clothW + wave, clothH, 4 * g.s, {
      fill, stroke: C.ink, sw: 2.5 * g.s,
    });
    // Shape badge, never color alone: ◆ for 청기, ● for 백기.
    const bx = x + 2 * g.s + (clothW + wave) / 2;
    const by = poleTopY + clothH / 2;
    if (badge === 'blue') {
      drawDiamond(g, bx, by, 7 * g.s, C.white);
    } else {
      g.circle(bx, by, 6 * g.s, { fill: C.ink });
    }
  }

  private drawBanner(g: Renderer): void {
    const clauses = this.instr.clauses;
    const rows = this.clauseRevealT > 0 ? 1 : clauses.length;
    const rowH = 70 * g.s;
    const bw = Math.min(g.w * 0.82, 620 * g.s);
    const bh = rowH * rows + 24 * g.s;
    const bx = g.w / 2 - bw / 2;
    const by = g.h * 0.07;

    g.roundRect(bx, by, bw, bh, 18 * g.s, {
      fill: fade(C.bg, 0.92), stroke: this.instr.trap ? C.warn : C.textFaint, sw: 3 * g.s,
    });

    for (let i = 0; i < rows; i++) {
      this.drawClause(g, bx + bw / 2, by + 12 * g.s + rowH * i + rowH / 2, clauses[i]!);
    }

    if (this.trapBadgeAlpha > 0) {
      g.save();
      g.alpha(this.trapBadgeAlpha);
      g.roundRect(bx + bw - 72 * g.s, by - 16 * g.s, 64 * g.s, 30 * g.s, 10 * g.s, {
        fill: C.warn, stroke: C.ink, sw: 2 * g.s,
      });
      g.text('함정!', bx + bw - 40 * g.s, by - 1 * g.s, {
        size: 16 * g.s, weight: 800, align: 'center', baseline: 'middle', fill: C.ink,
      });
      g.restore();
    }

    const ratio = this.windowTotal > 0 ? clamp01(this.window / this.windowTotal) : 0;
    const barW = bw * 0.86;
    const barX = g.w / 2 - barW / 2;
    const barY = by + bh + 10 * g.s;
    const barCol = ratio > 0.4 ? C.success : ratio > 0.18 ? C.warn : C.danger;
    g.roundRect(barX, barY, barW, 10 * g.s, 5 * g.s, { fill: fade(C.ink, 0.1) });
    g.roundRect(barX, barY, barW * ratio, 10 * g.s, 5 * g.s, { fill: barCol });
  }

  private drawClause(g: Renderer, cx: number, cy: number, clause: Clause): void {
    const color = clause.flag === 'blue' ? BLUE_COLOR : WHITE_COLOR;
    const iconX = cx - 190 * g.s;
    // Shape badge first, so color-blind play never depends on the flag color.
    if (clause.flag === 'blue') {
      drawDiamond(g, iconX - 34 * g.s, cy, 11 * g.s, color, C.ink, 2 * g.s);
    } else {
      g.circle(iconX - 34 * g.s, cy, 10 * g.s, { fill: C.white, stroke: C.ink, sw: 2 * g.s });
    }
    // Direction chevron; a slash across it is what makes a clause "don't".
    const dir = clause.dir === 'up' ? Math.PI / 2 : -Math.PI / 2;
    g.chevron(iconX, cy, 16 * g.s, dir, { fill: color });
    if (clause.negate) {
      g.circle(iconX, cy, 20 * g.s, { stroke: C.danger, sw: 4 * g.s });
      g.line(iconX - 14 * g.s, cy + 14 * g.s, iconX + 14 * g.s, cy - 14 * g.s, 4 * g.s, { stroke: C.danger });
    }
    g.text(clause.textKo, cx + 14 * g.s, cy, {
      size: 32 * g.s, weight: 800, display: true, align: 'center', baseline: 'middle',
      fill: color === C.ink ? C.text : color,
    });
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.bestCombo >= 6) highlights.push(`콤보 ${this.bestCombo}연속!`);
    if (this.hits >= 10) highlights.push(`지시 ${this.hits}번 정답!`);
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

/** The ◆ badge: a 45°-rotated square. No scratch buffer needed — `rect` plus
 *  the transform stack draws it with zero allocation. */
function drawDiamond(
  g: Renderer, cx: number, cy: number, r: number, fill: string, stroke?: string, sw?: number,
): void {
  const k = r * 1.02;
  g.save();
  g.translate(cx, cy);
  g.rotate(Math.PI / 4);
  g.rect(-k, -k, k * 2, k * 2, { fill, stroke, sw });
  g.restore();
}

export default (): MiniGame => new BlueFlagWhiteFlag();

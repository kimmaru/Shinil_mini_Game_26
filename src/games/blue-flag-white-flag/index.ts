// ─── blue-flag-white-flag — 청기백기 (Shape A, discrete cue x pose trigger) ──
//
// MIRRORING, checked against src/engine/pose/landmarks.ts rather than assumed:
// Side 'L'/'R' (and RaiseSignal.left/right) are already THE PLAYER'S OWN left
// and right — the engine mirrors `px` once, centrally, specifically so that
// "왼손" never needs a flip in game code. 왼손(subject's left) = 백기,
// 오른손(subject's right) = 청기, read straight off `raise.left`/`raise.right`.
//
// An instruction is answered the moment the flags match it and stay matched for
// HOLD_SEC (so a flick through the right pose never scores); if time runs out
// nothing loud happens. Instructions are always picked so that at least one
// flag has to MOVE from where it is now: a child standing still with both arms
// down must never collect points.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { palm } from '@/engine/pose/landmarks';
import { clamp01, lerp } from '@/engine/math';
import { C, fade } from '@/engine/render/palette';
import { manifest } from './manifest';
import { INSTRUCTIONS, type Clause, type FlagState, type Instruction, t } from './locale';

const WINDOW_START = 5.2;
const WINDOW_END = 3.4;
const RAMP_UNTIL = 0.8;
/** 함정 지시 gets this much extra time to read. */
const TRAP_BONUS = 0.6;
/** Seconds before the second clause of a multi-clause instruction appears. */
const CLAUSE_DELAY = 0.55;
/** Traps (negations) only appear once the child has the plain ones. */
const TRAP_AFTER = 0.3;
/** Fraction of the round after which an un-mentioned flag must not move at
 *  all — "안 바뀌면 유지": unnecessary movement becomes wrong too. */
const STRICT_KEEP_AT = 0.55;
/** Flags must match for this long before it counts: one noisy frame is never
 *  worth points, and a swinging arm passing through "up" must not score. */
const HOLD_SEC = 0.35;
/** The result stays on screen this long before the next instruction. */
const GAP_SEC = 0.6;

const POINTS = 10;

const BLUE_COLOR = C.primary;
const WHITE_COLOR = C.ink;
/** Colour strings built once: render() builds none. */
const PANEL_FILL = fade(C.white, 0.9);
const BANNER_FILL = fade(C.white, 0.96);
const BAR_TRACK = fade(C.ink, 0.15);

class BlueFlagWhiteFlag implements MiniGame {
  private ctx!: GameContext;
  private raise!: Detector<'raise'>;

  private player: PlayerPose | null = null;
  private readonly handL: Pt = { x: 0, y: 0 };
  private readonly handR: Pt = { x: 0, y: 0 };
  private readonly plus: string[] = [];

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
  private since = 0;
  private minRead = 0;
  private matchT = 0;
  private matchNow = false;
  private gap = 0;
  private lastCorrect = false;
  private clauseRevealT = 0;
  private trapBadgeAlpha = 0;

  private strictKeep = false;
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
    for (let i = 0; i <= POINTS; i++) this.plus.push('+' + String(i));
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

    if (this.gap > 0) {
      this.gap -= dt;
      if (this.gap <= 0) this.startNextInstruction();
      return;
    }

    this.window -= dt;
    this.since += dt;
    this.matchNow = this.matches(blueUp, whiteUp);
    if (this.matchNow && this.since >= this.minRead) this.matchT += dt;
    else this.matchT = 0;
    if (this.matchT >= HOLD_SEC) this.resolve(true);
    else if (this.window <= 0) this.resolve(this.matchNow);
  }

  private matches(blueUp: boolean, whiteUp: boolean): boolean {
    return (
      this.flagOk(this.instr.blue, blueUp, this.snapshotBlueUp, this.touchedBlueKeep) &&
      this.flagOk(this.instr.white, whiteUp, this.snapshotWhiteUp, this.touchedWhiteKeep)
    );
  }

  private flagOk(target: FlagState, up: boolean, snapshot: boolean, touched: boolean): boolean {
    if (target === 'up') return up;
    if (target === 'down') return !up;
    // 'keep': don't-care early, "untouched and unchanged" once strictKeep.
    return this.strictKeep ? up === snapshot && !touched : true;
  }

  /** True when the child has to move at least one flag to satisfy `ins`. */
  private needsMove(ins: Instruction): boolean {
    return (
      (ins.blue !== 'keep' && (ins.blue === 'up') !== this.prevBlueUp) ||
      (ins.white !== 'keep' && (ins.white === 'up') !== this.prevWhiteUp)
    );
  }

  /**
   * A "don't" clause means "leave that flag alone", so a trap is only fair
   * when every negated flag ALREADY sits at the instruction's target for it.
   * Otherwise "청기 올리지 말고" with blue up would demand lowering a flag
   * nobody said to lower. The two double negatives can never pass this AND
   * need a move, so they are retired by construction.
   */
  private trapFair(ins: Instruction): boolean {
    for (let i = 0; i < ins.clauses.length; i++) {
      const cl = ins.clauses[i]!;
      if (!cl.negate) continue;
      const blue = cl.flag === 'blue';
      const target = blue ? ins.blue : ins.white;
      const up = blue ? this.prevBlueUp : this.prevWhiteUp;
      if ((target === 'up') !== up) return false;
    }
    return true;
  }

  private resolve(correct: boolean): void {
    const cx = (this.handL.x + this.handR.x) / 2;
    const cy = (this.handL.y + this.handR.y) / 2;
    this.lastCorrect = correct;
    this.gap = GAP_SEC;
    this.matchNow = false;
    this.matchT = 0;
    if (correct) {
      this.hits++;
      this.combo++;
      if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      this.score += POINTS;
      this.ctx.fx.impact(cx, cy, this.combo >= 6 ? 'big' : 'hit', {
        color: C.success, sprite: 'sparkle', label: this.plus[POINTS] ?? '',
      });
      this.ctx.audio.playLadder('pop', this.combo);
      // No HUD toast here: it lands at 24% of the height, on top of the next
      // instruction's first line. The burst, its label and the combo pill
      // carry the praise instead.
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
  }

  private startNextInstruction(): void {
    const totalSec = manifest.durationMs / 1000;
    const elapsedFrac = clamp01(this.time / totalSec);

    if (!this.strictKeep && elapsedFrac >= STRICT_KEEP_AT) {
      this.strictKeep = true;
      // Announce only (bottom of the screen): a toast would cover the banner.
      this.ctx.hud.announce(t('keepWarn'), { assertive: true });
    }

    const n = INSTRUCTIONS.length;
    const first = Math.floor(this.ctx.rng() * n);
    let idx = first;
    for (let k = 0; k < n; k++) {
      const c = (first + k) % n;
      const cand = INSTRUCTIONS[c]!;
      if (
        c !== this.prevIdx && this.needsMove(cand) &&
        (!cand.trap || (elapsedFrac >= TRAP_AFTER && this.trapFair(cand)))
      ) {
        idx = c;
        break;
      }
    }
    this.prevIdx = idx;
    this.instr = INSTRUCTIONS[idx]!;

    const rampFrac = clamp01(elapsedFrac / RAMP_UNTIL);
    let window = lerp(WINDOW_START, WINDOW_END, rampFrac);
    if (this.instr.trap) window += TRAP_BONUS;
    this.window = window;
    this.windowTotal = window;
    this.since = 0;
    this.matchT = 0;
    this.matchNow = false;
    this.clauseRevealT = this.instr.clauses.length > 1 ? CLAUSE_DELAY : 0;
    // Nobody can obey a half-shown instruction, so the earliest answer waits
    // for the whole thing to be on screen and readable.
    this.minRead = this.instr.trap ? 1.1 : this.instr.clauses.length > 1 ? 0.9 : 0.4;
    this.trapBadgeAlpha = this.instr.trap ? 1 : 0;

    this.snapshotBlueUp = this.prevBlueUp;
    this.snapshotWhiteUp = this.prevWhiteUp;
    this.touchedBlueKeep = false;
    this.touchedWhiteKeep = false;
    this.justStarted = true;
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    if (this.player) {
      g.ghostBody(this.player, 0.1);
      g.skeleton(this.player, { alpha: 0.5 });
      this.drawFlag(g, this.handR.x, this.handR.y, BLUE_COLOR, true);
      this.drawFlag(g, this.handL.x, this.handL.y, C.white, false);
    }

    const show = this.gap > 0 ? this.lastCorrect : this.matchNow;
    this.drawTarget(g, g.w * 0.09, g.h * 0.52, true, this.instr.white, show);
    this.drawTarget(g, g.w * 0.91, g.h * 0.52, false, this.instr.blue, show);
    this.drawBanner(g);
  }

  /** A flag on its pole, planted on the hand. Big on purpose: this is what the
   *  child watches themselves control from 2 m away. */
  private drawFlag(g: Renderer, x: number, y: number, color: string, blue: boolean): void {
    const poleLen = 130 * g.s;
    const top = y - poleLen;
    g.line(x, y, x, top, 7 * g.s, { stroke: C.ink });
    const wave = Math.sin(g.t * 5 + x * 0.01) * 5 * g.s;
    const cw = 96 * g.s + wave;
    const ch = 64 * g.s;
    g.roundRect(x + 3 * g.s, top, cw, ch, 8 * g.s, { fill: color, stroke: C.ink, sw: 5 * g.s });
    const bx = x + 3 * g.s + cw / 2;
    const by = top + ch / 2;
    // Shape badge, never colour alone: diamond for 청기, disc for 백기.
    if (blue) drawDiamond(g, bx, by, 15 * g.s, C.white);
    else g.circle(bx, by, 14 * g.s, { fill: C.ink });
  }

  /** One flag's goal, in the player's own mirrored layout: white on the left,
   *  blue on the right. Turns green while the child is matching it. */
  private drawTarget(
    g: Renderer, cx: number, cy: number, white: boolean, state: FlagState, ok: boolean,
  ): void {
    const pw = 170 * g.s;
    const ph = 250 * g.s;
    g.roundRect(cx - pw / 2, cy - ph / 2, pw, ph, 22 * g.s, {
      fill: PANEL_FILL, stroke: ok ? C.success : C.ink, sw: (ok ? 10 : 4) * g.s,
    });
    const px = cx - 26 * g.s;
    const top = cy - ph * 0.38;
    g.line(px, top, px, top + 78 * g.s, 6 * g.s, { stroke: C.ink });
    g.roundRect(px + 2 * g.s, top, 62 * g.s, 42 * g.s, 6 * g.s, {
      fill: white ? C.white : BLUE_COLOR, stroke: C.ink, sw: 4 * g.s,
    });
    if (white) g.circle(px + 33 * g.s, top + 21 * g.s, 9 * g.s, { fill: C.ink });
    else drawDiamond(g, px + 33 * g.s, top + 21 * g.s, 10 * g.s, C.white);

    const col = white ? C.text : BLUE_COLOR;
    if (state === 'keep') {
      // A target the child reacts to: never under 34 px, whatever the scale.
      g.text(t('stay'), cx, cy + ph * 0.3, {
        size: Math.max(34, 40 * g.s), weight: 800, display: true, align: 'center', baseline: 'middle', fill: C.textDim,
      });
      return;
    }
    g.chevron(cx, cy + ph * 0.1, 26 * g.s, state === 'up' ? -Math.PI / 2 : Math.PI / 2, { fill: col });
    g.text(state === 'up' ? t('up') : t('down'), cx, cy + ph * 0.34, {
      size: Math.max(34, 46 * g.s), weight: 800, display: true, align: 'center', baseline: 'middle', fill: col,
    });
  }

  private drawBanner(g: Renderer): void {
    const clauses = this.instr.clauses;
    const rows = this.clauseRevealT > 0 ? 1 : clauses.length;
    const rowH = 84 * g.s;
    // Inside the HUD safe area: below the DOM top band (0.18h, with room for
    // the trap badge that pokes above the banner) and clear of the score
    // column on the left (x >= 0.25w).
    const bw = Math.min(g.w * 0.5, 900 * g.s);
    const bh = rowH * clauses.length + 24 * g.s;
    const bx = g.w / 2 - bw / 2;
    const by = g.h * 0.18 + 22 * g.s;

    g.roundRect(bx, by, bw, bh, 22 * g.s, {
      fill: BANNER_FILL, stroke: this.instr.trap ? C.warn : C.ink, sw: 5 * g.s,
    });

    for (let i = 0; i < rows; i++) {
      this.drawClause(g, bx, bw, by + 12 * g.s + rowH * i + rowH / 2, clauses[i]!);
    }

    if (this.trapBadgeAlpha > 0) {
      g.save();
      g.alpha(this.trapBadgeAlpha);
      g.roundRect(bx + bw - 104 * g.s, by - 22 * g.s, 96 * g.s, 40 * g.s, 12 * g.s, {
        fill: C.warn, stroke: C.ink, sw: 3 * g.s,
      });
      g.text(t('trap'), bx + bw - 56 * g.s, by - 2 * g.s, {
        size: 30 * g.s, weight: 800, align: 'center', baseline: 'middle', fill: C.ink,
      });
      g.restore();
    }

    if (this.gap <= 0) {
      const ratio = this.windowTotal > 0 ? clamp01(this.window / this.windowTotal) : 0;
      const barW = bw * 0.9;
      const barX = g.w / 2 - barW / 2;
      const barY = by + bh + 12 * g.s;
      g.roundRect(barX, barY, barW, 14 * g.s, 7 * g.s, { fill: BAR_TRACK });
      g.roundRect(barX, barY, Math.max(1, barW * ratio), 14 * g.s, 7 * g.s, {
        fill: ratio > 0.3 ? C.success : C.warn,
      });
    }
  }

  private drawClause(g: Renderer, bx: number, bw: number, cy: number, clause: Clause): void {
    const color = clause.flag === 'blue' ? BLUE_COLOR : WHITE_COLOR;
    const iconX = bx + 78 * g.s;
    // Shape badge first, so colour-blind play never depends on the flag colour.
    if (clause.flag === 'blue') {
      drawDiamond(g, iconX - 38 * g.s, cy, 13 * g.s, color, C.ink, 2 * g.s);
    } else {
      g.circle(iconX - 38 * g.s, cy, 12 * g.s, { fill: C.white, stroke: C.ink, sw: 3 * g.s });
    }
    // Direction chevron; a slash across it is what makes a clause "don't".
    const dir = clause.dir === 'up' ? -Math.PI / 2 : Math.PI / 2;
    g.chevron(iconX + 12 * g.s, cy, 20 * g.s, dir, { fill: color });
    if (clause.negate) {
      g.circle(iconX + 12 * g.s, cy, 26 * g.s, { stroke: C.danger, sw: 5 * g.s });
      g.line(iconX - 6 * g.s, cy + 18 * g.s, iconX + 30 * g.s, cy - 18 * g.s, 5 * g.s, { stroke: C.danger });
    }
    g.text(clause.textKo, bx + bw * 0.58, cy, {
      size: 48 * g.s, weight: 800, display: true, align: 'center', baseline: 'middle',
      fill: color === C.ink ? C.text : color, maxWidth: bw - 190 * g.s,
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

/** The diamond badge: a 45°-rotated square. No scratch buffer needed — `rect`
 *  plus the transform stack draws it with zero allocation. */
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

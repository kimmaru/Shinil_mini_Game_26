// ─── cheer-combo — 응원 콤보 (Shape A, discrete cue x pose trigger) ───────────
//
// MIRRORING, checked against src/engine/pose/landmarks.ts rather than assumed:
// "left"/"right" everywhere in this engine (Side 'L'/'R', L.LEFT_WRIST, the
// RaiseDetector's `left`/`right`) are already THE PLAYER'S OWN left and right.
// The preview is mirrored so the player's actual left hand appears on the
// screen-LEFT — landmarks.ts says so explicitly, and VirtualPoseSource's Z/X
// keys confirm it the other way (Z, the physically-left key, raises
// LEFT_WRIST). So "왼손!" simply watches `raiseEither.left`; there is no flip
// to apply anywhere in this file — the engine already did it, once, for everyone.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Renderer, SignalOf,
} from '@/engine/types';
import { palm } from '@/engine/pose/landmarks';
import { clamp01, lerp, pulse, TAU } from '@/engine/math';
import { randRange } from '@/engine/spawn';
import { C, fade, hue } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

const CUE_L = 0;
const CUE_R = 1;
const CUE_BOTH = 2;
const CUE_MANSAE = 3;
const CUE_COUNT = 4;

const WINDOW_START = 1.6;
const WINDOW_END = 0.7;
/** Fraction of the round at which the cue window reaches its minimum. */
const RAMP_UNTIL = 0.85;
/** Fraction of the round after which cues occasionally come in a pair. */
const DOUBLE_AFTER = 0.45;
const DOUBLE_CHANCE = 0.32;
/** Fraction of the round after which "반대로" (opposite) mode stays on. */
const REVERSE_AT = 0.6;

const BASE_POINTS = 10;
/** Combo steps to reach the x1.5 cap (5% per step). */
const COMBO_MULT_STEPS = 10;

const CROWD_CAP = 14;

class CheerCombo implements MiniGame {
  private ctx!: GameContext;
  private raise!: Detector<'raise'>;
  private raiseOver!: Detector<'raise'>;

  private player: PlayerPose | null = null;
  private readonly handL = { x: 0, y: 0 };
  private readonly handR = { x: 0, y: 0 };

  // Crowd silhouettes: positions fixed at init, count grows with best combo.
  private readonly crowdX = new Float32Array(CROWD_CAP);
  private readonly crowdY = new Float32Array(CROWD_CAP);
  private readonly crowdHue = new Float32Array(CROWD_CAP);

  private time = 0;
  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private hits = 0;
  private misses = 0;

  private cueKind = CUE_L;
  private prevCue = -1;
  private cueWindow = 0;
  private cueWindowTotal = 1;
  /** Extra cues already decided to chain immediately after this one. */
  private queueDepth = 0;
  private reverseActive = false;

  private flash = 0;
  private flashGood = false;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // Normal threshold for 왼손/오른손/양손. Shoulder-relative, so a short
    // 7-year-old and a tall 12-year-old clear it at the same effort.
    this.raise = ctx.gestures.use('raise', { side: 'either', above: 0.25 });
    // 만세 needs real overhead, not just "above the shoulder" — this is a
    // second rented Trigger with its own hysteresis, not a hand threshold.
    this.raiseOver = ctx.gestures.use('raise', { side: 'both', above: 0.85 });

    for (let i = 0; i < CROWD_CAP; i++) {
      this.crowdX[i] = randRange(ctx.rng, 0.04, 0.96);
      this.crowdY[i] = randRange(ctx.rng, 0.03, 0.17);
      this.crowdHue[i] = randRange(ctx.rng, 0, 360);
    }
    this.startNextCue();
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.audio.music({ bpm: 120 });
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt);

    const p = f.p1;
    this.player = p ?? null;
    if (p) {
      palm(p, 'L', this.handL);
      palm(p, 'R', this.handR);
    }

    this.reverseActive = this.time >= (manifest.durationMs / 1000) * REVERSE_AT;

    const r = this.raise.read(f);
    const rOver = this.raiseOver.read(f);

    if (p && r.ok && this.matches(r, rOver)) {
      this.resolve(true);
    } else if (this.cueWindow > 0) {
      this.cueWindow -= dt;
      if (this.cueWindow <= 0) this.resolve(false);
    }
  }

  /** Does the player's CURRENT pose satisfy the ACTIVE cue? Reads only the
   *  rented detectors' already-debounced booleans — no raw threshold here. */
  private matches(r: SignalOf<'raise'>, rOver: SignalOf<'raise'>): boolean {
    switch (this.cueKind) {
      case CUE_L: return this.reverseActive ? r.right : r.left;
      case CUE_R: return this.reverseActive ? r.left : r.right;
      case CUE_BOTH: return r.both;
      case CUE_MANSAE: return rOver.both;
      default: return false;
    }
  }

  private resolve(hit: boolean): void {
    if (hit) {
      this.hits++;
      this.combo++;
      if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      const mult = 1 + Math.min(this.combo, COMBO_MULT_STEPS) * 0.05;
      const pts = Math.round(BASE_POINTS * mult);
      this.score += pts;
      this.flash = 0.3;
      this.flashGood = true;

      const ix = (this.handL.x + this.handR.x) / 2;
      const iy = (this.handL.y + this.handR.y) / 2;
      this.ctx.fx.impact(ix, iy, this.combo >= 8 ? 'big' : 'hit', {
        color: this.cueColor(),
        sprite: 'sparkle',
        label: `+${pts}`,
      });
      this.ctx.audio.playLadder('pop', this.combo);
      if (this.combo > 0 && this.combo % 4 === 0) {
        this.ctx.audio.play('combo.up');
        this.ctx.hud.toast(this.combo >= 12 ? t('huge') : this.combo >= 8 ? t('wow') : t('nice'), {
          color: C.accent,
        });
      }
      this.ctx.hud.setScore(this.score);
      this.ctx.hud.setCombo(this.combo);
      this.ctx.emit({ kind: 'scored', points: pts });
    } else {
      this.misses++;
      this.combo = 0;
      this.flash = 0.2;
      this.flashGood = false;
      // Quiet by construction: no shake, no flash, no red.
      this.ctx.fx.miss();
      this.ctx.hud.setCombo(0);
      this.ctx.emit({ kind: 'miss' });
    }
    this.startNextCue();
  }

  private startNextCue(): void {
    const totalSec = manifest.durationMs / 1000;
    const elapsedFrac = clamp01(this.time / totalSec);
    const rampFrac = clamp01(elapsedFrac / RAMP_UNTIL);
    const chained = this.queueDepth > 0;
    const window = lerp(WINDOW_START, WINDOW_END, rampFrac) * (chained ? 0.8 : 1);

    let k = Math.floor(this.ctx.rng() * CUE_COUNT);
    if (k === this.prevCue) k = (k + 1) % CUE_COUNT;
    this.prevCue = k;
    this.cueKind = k;
    this.cueWindow = window;
    this.cueWindowTotal = window;

    if (chained) {
      this.queueDepth--;
    } else if (elapsedFrac > DOUBLE_AFTER && this.ctx.rng() < DOUBLE_CHANCE) {
      this.queueDepth = 1;
    }
  }

  private cueColor(): string {
    switch (this.cueKind) {
      case CUE_L: return C.primary;
      case CUE_R: return C.hot;
      case CUE_BOTH: return C.secondary;
      default: return C.accent;
    }
  }

  private cueLabel(): string {
    switch (this.cueKind) {
      case CUE_L: return t('cueLeft');
      case CUE_R: return t('cueRight');
      case CUE_BOTH: return t('cueBoth');
      default: return t('cueMansae');
    }
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    this.drawCrowd(g);

    if (this.player) g.ghostBody(this.player, 0.1);
    if (this.player) g.skeleton(this.player, { alpha: 0.5 });
    this.drawPompom(g, this.handL.x, this.handL.y, 0);
    this.drawPompom(g, this.handR.x, this.handR.y, Math.PI);

    this.drawCueBanner(g);

    if (this.flash > 0) {
      const k = this.flash / 0.3;
      const cx = (this.handL.x + this.handR.x) / 2;
      const cy = (this.handL.y + this.handR.y) / 2;
      g.circle(cx, cy, Math.min(g.w, g.h) * 0.12 * (1.1 - k * 0.4), {
        stroke: this.flashGood ? C.success : fade(C.white, 0.35),
        sw: (this.flashGood ? 6 : 3) * g.s,
      });
    }
  }

  private drawCrowd(g: Renderer): void {
    const shown = Math.min(CROWD_CAP, Math.floor(this.bestCombo / 2));
    if (shown <= 0) return;
    g.save();
    g.alpha(0.5);
    for (let i = 0; i < shown; i++) {
      const x = this.crowdX[i]! * g.w;
      const y = this.crowdY[i]! * g.h;
      const r = 14 * g.s;
      const col = hue(this.crowdHue[i]!, 70, 60);
      g.circle(x, y - r * 1.3, r * 0.55, { fill: col });
      g.roundRect(x - r * 0.6, y - r * 0.6, r * 1.2, r * 1.3, r * 0.4, { fill: col });
    }
    g.restore();
  }

  /** The cheer tool: a small burst of colored streamers at the palm. */
  private drawPompom(g: Renderer, x: number, y: number, phase: number): void {
    const n = 7;
    const len = 20 * g.s;
    const sw = 3 * g.s;
    for (let i = 0; i < n; i++) {
      const a = phase + (i / n) * TAU + this.time * 0.6;
      const wig = Math.sin(this.time * 4 + i) * 0.18;
      const ex = x + Math.cos(a + wig) * len;
      const ey = y + Math.sin(a + wig) * len;
      g.line(x, y, ex, ey, sw, { stroke: i % 2 === 0 ? C.primary : C.white });
    }
    g.circle(x, y, 7 * g.s, { fill: C.accent, stroke: C.ink, sw: 2 * g.s });
  }

  private drawCueBanner(g: Renderer): void {
    const col = this.cueColor();
    const bw = Math.min(g.w * 0.74, 560 * g.s);
    const bh = 128 * g.s;
    const bx = g.w / 2 - bw / 2;
    const by = g.h * 0.08;

    g.roundRect(bx, by, bw, bh, 20 * g.s, { fill: fade(col, 0.16), stroke: col, sw: 3 * g.s });

    const leftUp = this.cueKind === CUE_L || this.cueKind === CUE_BOTH || this.cueKind === CUE_MANSAE;
    const rightUp = this.cueKind === CUE_R || this.cueKind === CUE_BOTH || this.cueKind === CUE_MANSAE;
    const overhead = this.cueKind === CUE_MANSAE;
    drawPictogram(g, bx + bh * 0.62, by + bh * 0.5, bh * 0.82, leftUp, rightUp, overhead, col);

    g.text(this.cueLabel(), bx + bw * 0.58, by + bh * 0.42, {
      size: 44 * g.s, weight: 800, display: true, align: 'center', baseline: 'middle',
      fill: col, stroke: C.bg, sw: 5 * g.s,
    });

    // Shrinking response-window bar: green with time to spare, red as it runs
    // out — the one sanctioned use of red, per the catalogue's own rule.
    const ratio = this.cueWindowTotal > 0 ? clamp01(this.cueWindow / this.cueWindowTotal) : 0;
    const barW = bw * 0.82;
    const barX = g.w / 2 - barW / 2;
    const barY = by + bh + 10 * g.s;
    const barCol = ratio > 0.4 ? C.success : ratio > 0.18 ? C.warn : C.danger;
    g.roundRect(barX, barY, barW, 10 * g.s, 5 * g.s, { fill: fade(C.ink, 0.12) });
    g.roundRect(barX, barY, barW * ratio, 10 * g.s, 5 * g.s, { fill: barCol });

    if (this.reverseActive) {
      const p = 0.9 + 0.1 * pulse((this.time * 2) % 1);
      g.save();
      g.translate(g.w / 2, by + bh + 42 * g.s);
      g.scale(p, p);
      g.roundRect(-70 * g.s, -18 * g.s, 140 * g.s, 36 * g.s, 12 * g.s, {
        fill: C.warn, stroke: C.ink, sw: 2 * g.s,
      });
      g.text(t('reverse'), 0, 0, {
        size: 20 * g.s, weight: 800, align: 'center', baseline: 'middle', fill: C.ink,
      });
      g.restore();
    }
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.bestCombo >= 8) highlights.push(`콤보 ${this.bestCombo}연속!`);
    if (this.hits >= 20) highlights.push(`지시 ${this.hits}번 성공!`);
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

  dispose(): void {
    this.ctx.audio.stopMusic();
  }
}

/** A tiny mannequin pictogram: which arm(s) are raised, and how high. Drawn
 *  from primitives, not a shared sprite — this exact 4-pose set (L/R/both/
 *  overhead) is specific to this game and would cost more than 2 new sprite
 *  ids to express as the shared registry's authored shapes. */
function drawPictogram(
  g: Renderer, cx: number, cy: number, size: number,
  leftUp: boolean, rightUp: boolean, overhead: boolean, color: string,
): void {
  const headR = size * 0.15;
  const headY = cy - size * 0.22;
  const hipY = cy + size * 0.3;
  const sw = Math.max(2, size * 0.09);
  const shoulderY = headY + headR * 1.5;

  g.circle(cx, headY, headR, { fill: color });
  g.line(cx, shoulderY, cx, hipY, sw, { stroke: color });
  g.line(cx, hipY, cx - size * 0.16, cy + size * 0.56, sw, { stroke: color });
  g.line(cx, hipY, cx + size * 0.16, cy + size * 0.56, sw, { stroke: color });

  // Screen-left is the player's actual left (the engine mirrors px for us),
  // so the icon's left arm is drawn on its own screen-left.
  drawArm(g, cx, shoulderY, -1, leftUp, overhead, size, sw, color);
  drawArm(g, cx, shoulderY, 1, rightUp, overhead, size, sw, color);
}

function drawArm(
  g: Renderer, sx: number, sy: number, side: -1 | 1, up: boolean, overhead: boolean,
  size: number, sw: number, color: string,
): void {
  const len = size * 0.42;
  const ex = up ? sx + side * len * (overhead ? 0.22 : 0.8) : sx + side * len * 0.82;
  const ey = up ? sy - len * (overhead ? 1.1 : 0.5) : sy + len * 0.78;
  g.line(sx, sy, ex, ey, sw, { stroke: color });
}

export default (): MiniGame => new CheerCombo();

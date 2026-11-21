// ─── cheer-combo — 응원 콤보 (Shape A, discrete cue x pose trigger) ───────────
//
// MIRRORING, checked against src/engine/pose/landmarks.ts rather than assumed:
// "left"/"right" everywhere in this engine (L.LEFT_WRIST, the raise detector's
// `left`/`right`) are already THE PLAYER'S OWN left and right, and the preview
// is mirrored, so the player's left hand appears on the screen-LEFT. "왼손!"
// simply watches `raise.left`; the pictogram and the glowing hand marker for a
// left cue are drawn on the screen's left. No flip is needed anywhere.
//
// FAIRNESS OF THE CUE: "왼손" means the left hand ONLY. Without the `!right`
// condition, keeping both hands up would satisfy 왼손, 오른손, 양손 and 만세
// alike and the game would be a free-points machine. A cue is also never
// chosen if the player's current pose already satisfies it, so a match always
// means the player moved after the cue appeared.
//
// Two rented raise detectors do the work: `above: 0.25` for the ordinary cues
// and a stricter `above: 0.85` for 만세. A miss is quiet: the combo ends, a
// soft "다음!" shows, and the next cue comes after a short rest.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer, SignalOf,
} from '@/engine/types';
import { palm } from '@/engine/pose/landmarks';
import { clamp01, easeOutBack, lerp, pulse, TAU } from '@/engine/math';
import { randRange } from '@/engine/spawn';
import { C, fade, hue } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

const CUE_L = 0;
const CUE_R = 1;
const CUE_BOTH = 2;
const CUE_MANSAE = 3;
const CUE_COUNT = 4;

const WINDOW_START = 2.4;
const WINDOW_END = 1.5;
const RAMP_UNTIL = 0.8;
const REST_START = 0.7;
const REST_END = 0.4;
const FIRST_REST = 0.9;

const BASE_POINTS = 10;
const COMBO_MULT_STEPS = 10;
const CROWD_CAP = 14;
const INK_18 = fade(C.ink, 0.18);
const INK_15 = fade(C.ink, 0.15);
const BACKDROP = hue(290, 75, 91);

/** Precomputed "+N" labels: no string building while playing. */
const LABELS: string[] = [];
for (let i = 0; i <= 40; i++) LABELS.push(`+${i}`);

class CheerCombo implements MiniGame {
  private ctx!: GameContext;
  private raise!: Detector<'raise'>;
  private raiseOver!: Detector<'raise'>;

  private player: PlayerPose | null = null;
  private readonly handL: Pt = { x: 0, y: 0 };
  private readonly handR: Pt = { x: 0, y: 0 };

  private readonly crowdX = new Float32Array(CROWD_CAP);
  private readonly crowdHue = new Float32Array(CROWD_CAP);
  private readonly crowdCol: string[] = [];

  private time = 0;
  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private hits = 0;
  private misses = 0;

  private cueKind = CUE_L;
  private prevCue = -1;
  /** True while a cue is live; false during the rest beat. */
  private live = false;
  private window = 0;
  private windowTotal = 1;
  private rest = FIRST_REST;
  private lastHit = true;
  private flash = 0;
  private born = 1;
  private lastGoodX = 0;
  private lastGoodY = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.raise = ctx.gestures.use('raise', { side: 'either', above: 0.25 });
    this.raiseOver = ctx.gestures.use('raise', { side: 'both', above: 0.85 });
    for (let i = 0; i < CROWD_CAP; i++) {
      this.crowdX[i] = (i + 0.5 + randRange(ctx.rng, -0.25, 0.25)) / CROWD_CAP;
      this.crowdHue[i] = randRange(ctx.rng, 0, 360);
      this.crowdCol.push(hue(this.crowdHue[i]!, 70, 58));
    }
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.audio.music({ bpm: 120 });
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt);
    if (this.born < 1) this.born = Math.min(1, this.born + dt * 6);

    const p = f.p1;
    this.player = p ?? null;
    if (p) {
      palm(p, 'L', this.handL);
      palm(p, 'R', this.handR);
    }
    const r = this.raise.read(f);
    const rOver = this.raiseOver.read(f);
    // Nobody in frame: freeze the clock rather than punish an empty room.
    if (!p || !r.ok) return;

    const frac = clamp01(this.time / (manifest.durationMs / 1000) / RAMP_UNTIL);

    if (!this.live) {
      this.rest -= dt;
      if (this.rest <= 0) this.startCue(r, rOver, frac);
      return;
    }
    if (this.satisfied(this.cueKind, r, rOver)) {
      this.resolve(true, frac);
    } else {
      this.window -= dt;
      if (this.window <= 0) this.resolve(false, frac);
    }
  }

  /** Is the player's CURRENT pose a correct answer to `kind`? Reads only the
   *  rented detectors' debounced booleans — no raw threshold here. */
  private satisfied(kind: number, r: SignalOf<'raise'>, rOver: SignalOf<'raise'>): boolean {
    switch (kind) {
      case CUE_L: return r.left && !r.right;
      case CUE_R: return r.right && !r.left;
      case CUE_BOTH: return r.both;
      default: return rOver.both;
    }
  }

  private startCue(r: SignalOf<'raise'>, rOver: SignalOf<'raise'>, frac: number): void {
    let k = Math.floor(this.ctx.rng() * CUE_COUNT);
    // Never open on an answer the player is already giving.
    for (let tries = 0; tries < CUE_COUNT; tries++) {
      if (k !== this.prevCue && !this.satisfied(k, r, rOver)) break;
      k = (k + 1) % CUE_COUNT;
    }
    this.prevCue = k;
    this.cueKind = k;
    this.window = lerp(WINDOW_START, WINDOW_END, frac);
    this.windowTotal = this.window;
    this.live = true;
    this.born = 0;
    this.ctx.audio.play('ui.tick', { gain: 0.35 });
  }

  private resolve(hit: boolean, frac: number): void {
    this.live = false;
    this.rest = lerp(REST_START, REST_END, frac);
    this.lastHit = hit;
    if (hit) {
      this.hits++;
      this.combo++;
      if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      const mult = 1 + Math.min(this.combo, COMBO_MULT_STEPS) * 0.05;
      const pts = Math.round(BASE_POINTS * mult);
      this.score += pts;
      this.flash = 0.35;
      const ix = (this.handL.x + this.handR.x) / 2;
      const iy = (this.handL.y + this.handR.y) / 2;
      this.lastGoodX = ix;
      this.lastGoodY = iy;
      this.ctx.fx.impact(ix, iy, this.combo >= 8 ? 'big' : 'hit', {
        color: this.cueColor(),
        sprite: 'sparkle',
        label: LABELS[Math.min(pts, 40)],
      });
      this.ctx.audio.playLadder('pop', this.combo);
      if (this.combo % 4 === 0) {
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
      // Quiet by construction: no shake, no flash, no red, no buzzer.
      this.ctx.fx.miss();
      this.ctx.hud.setCombo(0);
      this.ctx.emit({ kind: 'miss' });
    }
  }

  private cueColor(): string {
    switch (this.cueKind) {
      case CUE_L: return C.primary;
      case CUE_R: return C.hot;
      case CUE_BOTH: return C.secondary;
      default: return C.accentHi;
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
    g.rect(0, 0, g.w, g.h, { fill: BACKDROP });
    const s = g.s;
    this.drawCrowd(g);

    const live = this.live;
    const leftOn = live && this.cueKind !== CUE_R;
    const rightOn = live && this.cueKind !== CUE_L;
    const high = live && this.cueKind === CUE_MANSAE;
    this.drawHandMarker(g, g.w * 0.14, high ? g.h * 0.3 : g.h * 0.52, leftOn);
    this.drawHandMarker(g, g.w * 0.86, high ? g.h * 0.3 : g.h * 0.52, rightOn);

    if (this.player) {
      g.ghostBody(this.player, 0.1);
      g.skeleton(this.player, { alpha: 0.7, outline: true });
    }
    this.drawPompom(g, this.handL.x, this.handL.y, 0);
    this.drawPompom(g, this.handR.x, this.handR.y, Math.PI);
    this.drawBanner(g, s);

    if (this.flash > 0) {
      const k = this.flash / 0.35;
      g.circle(this.lastGoodX, this.lastGoodY, Math.min(g.w, g.h) * 0.14 * (1.15 - k * 0.4), {
        stroke: fade(C.success, k), sw: 7 * s,
      });
    }
  }

  /** A big marker at the screen edge, on the side of the hand to raise. */
  private drawHandMarker(g: Renderer, x: number, y: number, on: boolean): void {
    const s = g.s;
    const r = 78 * s;
    const col = this.cueColor();
    if (on) {
      const k = 0.95 + 0.05 * pulse((this.time * 2.5) % 1);
      g.circle(x, y, r * k, { fill: fade(col, 0.28), stroke: col, sw: 6 * s });
      g.chevron(x, y - 4 * s + Math.sin(this.time * 7) * 6 * s, 40 * s, -Math.PI / 2, { fill: col, stroke: C.ink, sw: 3 * s });
    } else {
      g.circle(x, y, r * 0.8, { stroke: INK_18, sw: 4 * s });
    }
  }

  private drawCrowd(g: Renderer): void {
    const shown = Math.min(CROWD_CAP, Math.floor(this.bestCombo / 2) + (this.hits > 0 ? 2 : 0));
    const base = g.h * 0.96;
    const r = 34 * g.s;
    for (let i = 0; i < shown; i++) {
      const x = this.crowdX[i]! * g.w;
      const up = Math.sin(this.time * 5 + i * 1.7) * 6 * g.s * (this.combo > 0 ? 1 : 0.3);
      const col = this.crowdCol[i]!;
      g.circle(x, base - r * 1.9 - up, r * 0.62, { fill: col, stroke: C.ink, sw: 3 * g.s });
      g.roundRect(x - r * 0.75, base - r * 1.3 - up, r * 1.5, r * 1.5, r * 0.5, { fill: col, stroke: C.ink, sw: 3 * g.s });
    }
  }

  /** The cheer tool: a small burst of coloured streamers at the palm. */
  private drawPompom(g: Renderer, x: number, y: number, phase: number): void {
    const n = 7;
    const len = 34 * g.s;
    const sw = 5 * g.s;
    for (let i = 0; i < n; i++) {
      const a = phase + (i / n) * TAU + this.time * 0.6;
      const wig = Math.sin(this.time * 4 + i) * 0.18;
      g.line(x, y, x + Math.cos(a + wig) * len, y + Math.sin(a + wig) * len, sw, {
        stroke: i % 2 === 0 ? C.accent : C.hot,
      });
    }
    g.circle(x, y, 12 * g.s, { fill: C.accentHi, stroke: C.ink, sw: 3 * g.s });
  }

  private drawBanner(g: Renderer, s: number): void {
    const live = this.live;
    const col = live ? this.cueColor() : this.lastHit ? C.success : C.textFaint;
    const bw = Math.min(g.w * 0.62, 640 * s);
    const bh = 150 * s;
    const grow = live ? easeOutBack(this.born) : 1;
    const bx = g.w / 2 - bw / 2;
    const by = g.h * 0.03;

    g.save();
    g.translate(g.w / 2, by + bh / 2);
    g.scale(0.88 + 0.12 * grow, 0.88 + 0.12 * grow);
    g.translate(-g.w / 2, -(by + bh / 2));
    g.roundRect(bx, by, bw, bh, 26 * s, { fill: C.white, stroke: col, sw: 6 * s });
    if (live) {
      const leftUp = this.cueKind !== CUE_R;
      const rightUp = this.cueKind !== CUE_L;
      drawPictogram(g, bx + bh * 0.7, by + bh * 0.47, bh * 0.72, leftUp, rightUp, this.cueKind === CUE_MANSAE, col);
      g.text(this.cueLabel(), bx + bw * 0.6, by + bh * 0.5, {
        size: 76 * s, weight: 800, display: true, align: 'center', baseline: 'middle',
        fill: col, stroke: C.white, sw: 6 * s,
      });
    } else {
      g.text(this.lastHit ? t('nice') : t('next'), g.w / 2, by + bh * 0.5, {
        size: 64 * s, weight: 800, display: true, align: 'center', baseline: 'middle',
        fill: col, stroke: C.white, sw: 6 * s,
      });
    }
    g.restore();

    // Shrinking time bar: calm green, then amber. Never red.
    if (live) {
      const ratio = this.windowTotal > 0 ? clamp01(this.window / this.windowTotal) : 0;
      const barW = bw * 0.9;
      const barX = g.w / 2 - barW / 2;
      const barY = by + bh + 12 * s;
      g.roundRect(barX, barY, barW, 14 * s, 7 * s, { fill: INK_15 });
      if (ratio > 0.02) {
        g.roundRect(barX, barY, barW * ratio, 14 * s, 7 * s, { fill: ratio > 0.35 ? C.success : C.warn });
      }
    }
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.bestCombo >= 8) highlights.push(`콤보 ${this.bestCombo}연속!`);
    if (this.hits >= 15) highlights.push(`지시 ${this.hits}번 성공!`);
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
 *  from primitives: this exact 4-pose set is specific to this game. */
function drawPictogram(
  g: Renderer, cx: number, cy: number, size: number,
  leftUp: boolean, rightUp: boolean, overhead: boolean, color: string,
): void {
  const headR = size * 0.16;
  const headY = cy - size * 0.24;
  const hipY = cy + size * 0.3;
  const sw = Math.max(3, size * 0.1);
  const shoulderY = headY + headR * 1.6;

  g.circle(cx, headY, headR, { fill: color });
  g.line(cx, shoulderY, cx, hipY, sw, { stroke: color });
  g.line(cx, hipY, cx - size * 0.16, cy + size * 0.58, sw, { stroke: color });
  g.line(cx, hipY, cx + size * 0.16, cy + size * 0.58, sw, { stroke: color });
  // Screen-left is the player's actual left (the engine mirrors px for us).
  drawArm(g, cx, shoulderY, -1, leftUp, overhead, size, sw, color);
  drawArm(g, cx, shoulderY, 1, rightUp, overhead, size, sw, color);
}

function drawArm(
  g: Renderer, sx: number, sy: number, side: -1 | 1, up: boolean, overhead: boolean,
  size: number, sw: number, color: string,
): void {
  const len = size * 0.44;
  const ex = up ? sx + side * len * (overhead ? 0.22 : 0.8) : sx + side * len * 0.82;
  const ey = up ? sy - len * (overhead ? 1.1 : 0.5) : sy + len * 0.78;
  g.line(sx, sy, ex, ey, sw, { stroke: color });
}

export default (): MiniGame => new CheerCombo();

// ─── Shape A variant: ordered proximity touches ──────────────────────────────
//
// Numbered dots, connected strictly in order; touching the wrong one is
// silently ignored. Read AGENTS.md + docs/GAME_AUTHORING.md +
// src/games/mosquito-clap/ before touching this.
//
// See NEEDS.md for why the aim smoothing below is hand-rolled rather than a
// per-game `steady` One Euro preset — the hook does not exist yet.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { L, shoulderPx } from '@/engine/pose/landmarks';
import { approach, clamp, dist } from '@/engine/math';
import { C, fade, hue } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

/** approach() rate for the extra aim smoothing — ~90ms time constant. See
 *  the file header and NEEDS.md. */
const SMOOTH_RATE = 10;
const HANDS = [L.LEFT_WRIST, L.RIGHT_WRIST] as const;
const MAX_POINTS = 10;

/** Point layouts in REACH UNITS: (dx, dy) multiples of this player's own arm
 *  length, measured from their shoulder centre — the fairness rule for any
 *  game about reaching, not fixed screen fractions. Index 0 is the free
 *  starting point; the player must touch index 1..n-1 in order. The last
 *  pair is drawn at once, one assigned to each hand, and reaches out past
 *  full extension (>1.0) on purpose — the ramp step that forces a real step
 *  or stretch. */
const PICTURES: readonly (readonly (readonly [number, number])[])[] = [
  [[0, 0.1], [0, -0.75], [0.65, -0.25], [0.4, 0.6], [-0.4, 0.6], [-0.65, -0.25]],
  [
    [0, 0], [-0.2, -0.95], [0.4, -0.75], [0.85, -0.3], [0.7, 0.35], [0.3, 0.85],
    [-0.3, 0.85], [-0.7, 0.35], [-0.85, -0.3], [-0.4, -0.75],
  ],
  // Left-hand half of the final, simultaneous pair.
  [[-0.1, 0], [-0.3, -1.1], [-0.9, -0.7], [-1.15, 0.1], [-0.8, 0.7], [-0.2, 0.9], [0.2, 0.5]],
  // Right-hand half, mirrored.
  [[0.1, 0], [0.3, -1.1], [0.9, -0.7], [1.15, 0.1], [0.8, 0.7], [0.2, 0.9], [-0.2, 0.5]],
];
const RADIUS_FRAC = [0.095, 0.085, 0.08, 0.08] as const;
const PAR_SEC = [8, 12, 10, 10] as const;
const POINTS_PER_DOT = 2;
const COMPLETE_BONUS = 30;

interface PictureSlot {
  active: boolean;
  defIndex: number;
  pointCount: number;
  /** Flat [x0,y0,x1,y1,...] in view px. Fixed-size, overwritten in place —
   *  spawnPicture() never allocates. */
  px: Float32Array;
  nextIndex: number;
  hand: -1 | 0 | 1;
  /** 0..1, decays after completion — drives the "colour pours in" render. */
  completedT: number;
  startClock: number;
  radius: number;
  done: boolean;
}

function makeSlot(): PictureSlot {
  return {
    active: false, defIndex: -1, pointCount: 0, px: new Float32Array(MAX_POINTS * 2),
    nextIndex: 0, hand: -1, completedT: 0, startClock: 0, radius: 0, done: false,
  };
}

class ConnectDotsOrder implements MiniGame {
  private ctx!: GameContext;
  private reach!: Detector<'reach'>;

  private readonly smL: Pt = { x: 0, y: 0 };
  private readonly smR: Pt = { x: 0, y: 0 };
  private smPrimed = false;

  private readonly shoulderC: Pt = { x: 0, y: 0 };
  private armLenPx = 0;
  private player: PlayerPose | null = null;
  private time = 0;

  private readonly slotA: PictureSlot = makeSlot();
  private readonly slotB: PictureSlot = makeSlot();
  /** 0 = picture 0 solo, 1 = picture 1 solo, 2 = the simultaneous pair. */
  private stage: 0 | 1 | 2 = 0;
  private announcedTwoHand = false;

  private score = 0;
  private picturesDone = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.reach = ctx.gestures.use('reach', { side: 'both' });
    this.shoulderC.x = ctx.view.w / 2;
    this.shoulderC.y = ctx.view.h * 0.4;
    this.armLenPx = Math.min(ctx.view.w, ctx.view.h) * 0.3;
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.spawnPicture(this.slotA, 0, -1);
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    const p = f.p1;
    this.player = p ?? null;
    if (p) {
      shoulderPx(p, this.shoulderC);
      const armLen = p.calib.armLen > 0.5 ? p.calib.armLen : 1.6;
      this.armLenPx = armLen * p.scalePx;
    }

    const sig = this.reach.read(f);
    if (sig.ok) {
      if (!this.smPrimed) {
        this.smL.x = sig.leftPalm.x;
        this.smL.y = sig.leftPalm.y;
        this.smR.x = sig.rightPalm.x;
        this.smR.y = sig.rightPalm.y;
        this.smPrimed = true;
      } else {
        this.smL.x = approach(this.smL.x, sig.leftPalm.x, SMOOTH_RATE, dt);
        this.smL.y = approach(this.smL.y, sig.leftPalm.y, SMOOTH_RATE, dt);
        this.smR.x = approach(this.smR.x, sig.rightPalm.x, SMOOTH_RATE, dt);
        this.smR.y = approach(this.smR.y, sig.rightPalm.y, SMOOTH_RATE, dt);
      }
    }

    if (this.slotA.completedT > 0) this.slotA.completedT = Math.max(0, this.slotA.completedT - dt);
    if (this.slotB.completedT > 0) this.slotB.completedT = Math.max(0, this.slotB.completedT - dt);

    if (sig.ok) {
      if (this.slotA.active && !this.slotA.done) this.updateSlot(this.slotA);
      if (this.slotB.active && !this.slotB.done) this.updateSlot(this.slotB);
    }

    // Advance the sequence once the current stage's work is actually done.
    if (this.stage === 0 && this.slotA.done) {
      this.stage = 1;
      this.spawnPicture(this.slotA, 1, -1);
    } else if (this.stage === 1 && this.slotA.done) {
      this.stage = 2;
      if (!this.announcedTwoHand) {
        this.announcedTwoHand = true;
        this.ctx.hud.toast(t('bothHands'), { color: C.info });
      }
      this.spawnPicture(this.slotA, 2, 0);
      this.spawnPicture(this.slotB, 3, 1);
    }
  }

  private spawnPicture(slot: PictureSlot, defIndex: number, hand: -1 | 0 | 1): void {
    const def = PICTURES[defIndex]!;
    const g = this.ctx.view.w;
    const marginPx = g * RADIUS_FRAC[defIndex]! * 1.3;
    for (let i = 0; i < def.length; i++) {
      const [ux, uy] = def[i]!;
      const x = clamp(this.shoulderC.x + ux * this.armLenPx, marginPx, this.ctx.view.w - marginPx);
      const y = clamp(this.shoulderC.y + uy * this.armLenPx, marginPx, this.ctx.view.h * 0.95 - marginPx);
      slot.px[i * 2] = x;
      slot.px[i * 2 + 1] = y;
    }
    slot.active = true;
    slot.defIndex = defIndex;
    slot.pointCount = def.length;
    slot.nextIndex = 1; // index 0 is the free starting point
    slot.hand = hand;
    slot.completedT = 0;
    slot.startClock = this.time;
    slot.radius = g * RADIUS_FRAC[defIndex]!;
    slot.done = false;
  }

  private updateSlot(slot: PictureSlot): void {
    const tx = slot.px[slot.nextIndex * 2]!;
    const ty = slot.px[slot.nextIndex * 2 + 1]!;
    const d = slot.hand === -1
      ? Math.min(dist(this.smL.x, this.smL.y, tx, ty), dist(this.smR.x, this.smR.y, tx, ty))
      : dist(
        (slot.hand === 0 ? this.smL : this.smR).x, (slot.hand === 0 ? this.smL : this.smR).y,
        tx, ty,
      );
    if (d > slot.radius) return;

    this.score += POINTS_PER_DOT;
    this.ctx.hud.setScore(this.score);
    this.ctx.audio.playLadder('pop.low', slot.nextIndex);
    this.ctx.fx.pop(tx, ty, slot.radius * 0.9, hue(manifest.theme?.hue ?? 42, 80, 65));
    slot.nextIndex++;

    if (slot.nextIndex < slot.pointCount) return;

    slot.done = true;
    slot.completedT = 0.8;
    this.picturesDone++;
    const parSec = PAR_SEC[slot.defIndex] ?? 10;
    const usedSec = this.time - slot.startClock;
    const speedBonus = Math.round(Math.min(Math.max(parSec - usedSec, 0), parSec) * 2);
    const points = COMPLETE_BONUS + speedBonus;
    this.score += points;
    this.ctx.hud.setScore(this.score);
    this.ctx.fx.impact(tx, ty, 'big', { color: C.accent, sprite: 'sparkle', label: `+${points}` });
    this.ctx.audio.play('fanfare', { gain: 0.6 });
    this.ctx.hud.toast(t('pictureDone'), { color: C.accent });
    this.ctx.emit({ kind: 'scored', points });
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    if (this.player) g.ghostBody(this.player, 0.08);
    if (this.player) g.skeleton(this.player, { alpha: 0.35, emphasize: HANDS });

    this.drawSlot(g, this.slotA);
    this.drawSlot(g, this.slotB);
  }

  private drawSlot(g: Renderer, slot: PictureSlot): void {
    if (!slot.active) return;
    const lit = slot.completedT > 0;
    const lineColor = lit
      ? hue(manifest.theme?.hue ?? 42, 85, 60)
      : fade(C.white, 0.55);

    for (let i = 0; i < slot.nextIndex - 1; i++) {
      g.line(
        slot.px[i * 2]!, slot.px[i * 2 + 1]!, slot.px[i * 2 + 2]!, slot.px[i * 2 + 3]!,
        (lit ? 6 : 4) * g.s, { stroke: lineColor, glow: lit ? 14 : 0 },
      );
    }

    for (let i = 0; i < slot.pointCount; i++) {
      const x = slot.px[i * 2]!;
      const y = slot.px[i * 2 + 1]!;
      const reached = i < slot.nextIndex;
      const isNext = i === slot.nextIndex;
      if (reached) {
        g.sprite('circle', x, y, slot.radius * 1.5, { hue: manifest.theme?.hue ?? 42 });
      } else {
        g.sprite('ring', x, y, slot.radius * 1.5, { tint: fade(C.white, 0.6) });
      }
      if (isNext) {
        // A soft pulse on the one dot that currently matters — never a
        // dwell gauge, since there is nothing to dwell on here.
        const pulse = 1 + 0.08 * Math.sin(this.time * 6);
        g.circle(x, y, slot.radius * 1.25 * pulse, { stroke: C.accent, sw: 3 * g.s, glow: 10 });
      }
      g.text(String(i + 1), x, y, {
        size: Math.max(20, slot.radius * 0.8), weight: 800, align: 'center', baseline: 'middle',
        fill: reached ? C.white : C.textDim, display: true,
      });
    }

    if (slot.hand !== -1) {
      const hp = slot.hand === 0 ? this.smL : this.smR;
      g.circle(hp.x, hp.y, 14 * g.s, {
        stroke: slot.hand === 0 ? C.slot[0] : C.slot[1], sw: 3 * g.s, glow: 8,
      });
    }
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.picturesDone >= 3) highlights.push('그림 3개 전부 완성!');
    else if (this.picturesDone > 0) highlights.push(`그림 ${this.picturesDone}개 완성`);
    return {
      gameId: manifest.id,
      cleared: this.picturesDone > 0,
      rawScore: this.score,
      maxScore: manifest.scoring.maxScore,
      normalized: 0,
      stars: 0,
      durationMs: manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score: this.score,
        hits: this.picturesDone, misses: 0, bestCombo: 0,
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }
}

export default (): MiniGame => new ConnectDotsOrder();

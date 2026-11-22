// ─── Shape A variant: ordered proximity touches ──────────────────────────────
//
// Numbered dots; touch them 1, 2, 3... with a hand and the picture draws
// itself. Touching a wrong dot does nothing at all. Later pictures are drawn
// by both hands at once, each hand owning its own picture.
//
// Fairness: every dot is placed in units of THIS player's own arm length (S)
// from their shoulders, so a short child and a tall one are asked to reach
// the same fraction of their own reach, and nothing sits out of range. The
// pictures stay inside ~0.95 S of the nearest shoulder.
//
// Scoring safety: a dot needs 0.3 s of continuous touch, and each slot has a
// 0.3 s lock-out after a dot, so no single frame can score and a hand parked
// between two close dots cannot chain through them.
//
// See NEEDS.md for why the aim smoothing below is hand-rolled rather than a
// per-game `steady` One Euro preset: the hook does not exist.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { L, jx, jy } from '@/engine/pose/landmarks';
import { approach, clamp, clamp01, dist, easeOutBack } from '@/engine/math';
import { C, fade, hue, KEYLINE } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

/** approach() rate for the extra aim smoothing, ~90 ms time constant. */
const SMOOTH_RATE = 10;
const HANDS = [L.LEFT_WRIST, L.RIGHT_WRIST] as const;
/** Colours built once: render() must not build strings. */
const GUIDE = fade(C.ink, 0.25);
const MAX_DOTS = 6;
/** Touch time a dot needs (a windmilling arm covers a dot in ~0.1 s, so it cannot farm), and the quiet time after one counts. */
const TOUCH_SEC = 0.25;
const LOCK_SEC = 0.3;
/** Hit radius as a fraction of VIEW WIDTH: 11% across, above the 8% floor. */
const HIT_FRAC = 0.056;
const DOT_POINTS = 4;
const STAGE_BONUS = 20;
const FAST_BONUS = 10;
const DONE_HOLD = 1.3;

/** Where a picture is anchored. */
const CENTER = 0;
const LEFT_HAND = 1;
const RIGHT_HAND = 2;

interface PicDef {
  frame: number;
  /** [x, y] in S. CENTER: x from the shoulder centre. A hand frame: x
   *  OUTWARD from that hand's own shoulder. y is down from the shoulder
   *  line. Every dot is 0.55-1.0 S from a shoulder: inside that arm's reach. */
  dots: readonly (readonly [number, number])[];
  /** Fill the finished outline (a star, a house). */
  closed: boolean;
}

const PICS: readonly PicDef[] = [
  // 0: a rainbow arch, left to right: the gentlest first picture there is.
  { frame: CENTER, closed: false, dots: [[-1.3, 0.1], [-1.05, -0.72], [0, -0.92], [1.05, -0.72], [1.3, 0.1]] },
  // 1: a big five-pointed star, drawn as a pentagram.
  { frame: CENTER, closed: true, dots: [[0, -0.85], [0.75, 0.7], [-1.25, -0.15], [1.25, -0.15], [-0.75, 0.7]] },
  // 2, 3: a pair of flags, one per hand.
  { frame: LEFT_HAND, closed: true, dots: [[0.7, 0.65], [1.0, -0.1], [0.45, -0.85]] },
  { frame: RIGHT_HAND, closed: true, dots: [[0.7, 0.65], [1.0, -0.1], [0.45, -0.85]] },
  // 4: a house.
  { frame: CENTER, closed: true, dots: [[-0.9, 0.75], [-0.9, 0], [0, -0.85], [0.9, 0], [0.9, 0.75]] },
  // 5, 6: a pair of low flags, the easy-on-the-shoulders finale.
  { frame: LEFT_HAND, closed: true, dots: [[0.45, -0.55], [1.0, 0.1], [0.6, 0.8]] },
  { frame: RIGHT_HAND, closed: true, dots: [[0.45, -0.55], [1.0, 0.1], [0.6, 0.8]] },
];

/** Stages: which pictures are live together, and the par time for a bonus. */
const STAGE_A = [0, 1, 2, 4, 5] as const;
const STAGE_B = [-1, -1, 3, -1, 6] as const;
const STAGE_PAR = [9, 10, 12, 10, 14] as const;

interface Slot {
  active: boolean;
  pic: number;
  count: number;
  /** [x0,y0,x1,y1,...] in view px, overwritten in place. */
  px: Float32Array;
  next: number;
  /** -1 either hand, 0 left, 1 right. */
  hand: number;
  touch: number;
  lock: number;
  done: boolean;
  closed: boolean;
  appear: number;
}

function makeSlot(): Slot {
  return {
    active: false, pic: 0, count: 0, px: new Float32Array(MAX_DOTS * 2),
    next: 0, hand: -1, touch: 0, lock: 0, done: false, closed: false, appear: 0,
  };
}

class ConnectDotsOrder implements MiniGame {
  private ctx!: GameContext;
  private reach!: Detector<'reach'>;

  private readonly smL: Pt = { x: 0, y: 0 };
  private readonly smR: Pt = { x: 0, y: 0 };
  private smPrimed = false;

  private readonly shL: Pt = { x: 0, y: 0 };
  private readonly shR: Pt = { x: 0, y: 0 };
  private armPx = 0;
  private hitR = 0;
  private player: PlayerPose | null = null;
  private time = 0;
  private cStrong = '';
  private cStrongSoft = '';
  private cPale = '';

  private readonly slotA = makeSlot();
  private readonly slotB = makeSlot();
  private stage = 0;
  private stageClock = 0;
  private wait = 0.8;
  private doneTimer = 0;
  private stageCounted = false;
  private pairTold = false;
  private finished = false;

  private score = 0;
  private dots = 0;
  private stagesDone = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    const th = manifest.theme?.hue ?? 42;
    this.cStrong = hue(th, 85, 52);
    this.cStrongSoft = hue(th, 85, 52, 0.6);
    this.cPale = hue(th, 60, 90);
    this.reach = ctx.gestures.use('reach', { side: 'both' });
    const { w, h } = ctx.view;
    this.hitR = w * HIT_FRAC;
    this.shL.x = w * 0.44; this.shR.x = w * 0.56;
    this.shL.y = h * 0.42; this.shR.y = h * 0.42;
    this.armPx = Math.min(w, h) * 0.3;
    this.smL.x = w * 0.4; this.smL.y = h * 0.6;
    this.smR.x = w * 0.6; this.smR.y = h * 0.6;
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    const p = f.p1;
    this.player = p ?? null;
    if (p) {
      this.shL.x = jx(p, L.LEFT_SHOULDER); this.shL.y = jy(p, L.LEFT_SHOULDER);
      this.shR.x = jx(p, L.RIGHT_SHOULDER); this.shR.y = jy(p, L.RIGHT_SHOULDER);
      this.armPx = (p.calib.armLen > 0.5 ? p.calib.armLen : 1.6) * p.scalePx;
    }

    const sig = this.reach.read(f);
    if (sig.ok) {
      if (!this.smPrimed) {
        this.smL.x = sig.leftPalm.x; this.smL.y = sig.leftPalm.y;
        this.smR.x = sig.rightPalm.x; this.smR.y = sig.rightPalm.y;
        this.smPrimed = true;
      } else {
        this.smL.x = approach(this.smL.x, sig.leftPalm.x, SMOOTH_RATE, dt);
        this.smL.y = approach(this.smL.y, sig.leftPalm.y, SMOOTH_RATE, dt);
        this.smR.x = approach(this.smR.x, sig.rightPalm.x, SMOOTH_RATE, dt);
        this.smR.y = approach(this.smR.y, sig.rightPalm.y, SMOOTH_RATE, dt);
      }
    }

    if (this.finished) return;
    this.stageClock += dt;
    this.tickSlot(this.slotA, dt, sig.ok);
    this.tickSlot(this.slotB, dt, sig.ok);

    const live = this.slotA.active || this.slotB.active;
    if (!live) {
      this.wait -= dt;
      if (this.wait <= 0 && p) this.beginStage();
      return;
    }
    const doneA = !this.slotA.active || this.slotA.done;
    const doneB = !this.slotB.active || this.slotB.done;
    if (doneA && doneB) {
      if (!this.stageCounted) { this.stageCounted = true; this.stageComplete(); }
      this.doneTimer += dt;
      if (this.doneTimer >= DONE_HOLD) this.endStage();
    }
  }

  private tickSlot(s: Slot, dt: number, ok: boolean): void {
    if (!s.active) return;
    if (s.appear < 1) s.appear = Math.min(1, s.appear + dt / 0.3);
    if (s.lock > 0) s.lock -= dt;
    if (s.done || !ok) return;

    const tx = s.px[s.next * 2]!;
    const ty = s.px[s.next * 2 + 1]!;
    let d: number;
    if (s.hand === 0) d = dist(this.smL.x, this.smL.y, tx, ty);
    else if (s.hand === 1) d = dist(this.smR.x, this.smR.y, tx, ty);
    else d = Math.min(dist(this.smL.x, this.smL.y, tx, ty), dist(this.smR.x, this.smR.y, tx, ty));

    if (d > this.hitR) { s.touch = 0; return; }
    s.touch += dt;
    if (s.touch < TOUCH_SEC || s.lock > 0) return;

    s.touch = 0;
    s.lock = LOCK_SEC;
    this.score += DOT_POINTS;
    this.dots++;
    this.ctx.hud.setScore(this.score);
    this.ctx.audio.playLadder('pop', s.next);
    this.ctx.fx.pop(tx, ty, this.hitR * 1.1, this.cStrong);
    s.next++;
    if (s.next >= s.count) {
      s.done = true;
      this.ctx.fx.burst(tx, ty, { count: 18, color: C.accent, sprite: 'sparkle' });
    }
  }

  /** Called once, the frame the last live picture closes. */
  private stageComplete(): void {
    const fast = this.stageClock <= STAGE_PAR[this.stage]!;
    const points = STAGE_BONUS + (fast ? FAST_BONUS : 0);
    this.score += points;
    this.stagesDone++;
    this.ctx.hud.setScore(this.score);
    this.ctx.fx.impact(this.ctx.view.w / 2, this.ctx.view.h * 0.5, 'big', {
      color: C.accent, sprite: 'star', label: fast ? LABEL_FAST : LABEL_OK,
    });
    this.ctx.audio.play('fanfare', { gain: 0.6 });
    this.ctx.hud.toast(t('pictureDone'), { color: C.accent });
    this.ctx.emit({ kind: 'scored', points });
  }

  private endStage(): void {
    this.slotA.active = false;
    this.slotB.active = false;
    this.doneTimer = 0;
    this.stageCounted = false;
    this.wait = 0.4;
    this.stage++;
    if (this.stage >= STAGE_A.length) {
      this.finished = true;
      this.ctx.emit({ kind: 'clearEarly' });
    }
  }

  private beginStage(): void {
    this.stageClock = 0;
    this.place(this.slotA, STAGE_A[this.stage]!);
    const b = STAGE_B[this.stage]!;
    if (b >= 0) {
      this.place(this.slotB, b);
      if (!this.pairTold) {
        this.pairTold = true;
        this.ctx.hud.toast(t('bothHands'), { color: C.info });
      }
    }
  }

  private place(s: Slot, pic: number): void {
    const def = PICS[pic]!;
    this.layout(s, pic);
    s.active = true;
    s.pic = pic;
    s.count = def.dots.length;
    s.next = 0;
    s.hand = def.frame === LEFT_HAND ? 0 : def.frame === RIGHT_HAND ? 1 : -1;
    s.touch = 0;
    s.lock = 0.4;
    s.done = false;
    s.closed = def.closed;
    s.appear = 0;
  }

  /** Dot positions in view px from the live view and this player's body. */
  private layout(s: Slot, pic: number): void {
    const def = PICS[pic]!;
    const { w, h } = this.ctx.view;
    const S = this.armPx;
    const cx = (this.shL.x + this.shR.x) / 2;
    const cy = (this.shL.y + this.shR.y) / 2;
    const m = this.hitR * 1.3;
    for (let i = 0; i < def.dots.length; i++) {
      const ox = def.dots[i]![0];
      const oy = def.dots[i]![1];
      let x: number;
      if (def.frame === LEFT_HAND) x = this.shL.x - ox * S;
      else if (def.frame === RIGHT_HAND) x = this.shR.x + ox * S;
      else x = cx + ox * S;
      x = clamp(x, m, w - m);
      // HUD safe area: below the DOM top band, deeper under the score column.
      const top = h * (x < w * 0.25 ? 0.26 : 0.2);
      s.px[i * 2] = x;
      s.px[i * 2 + 1] = clamp(cy + oy * S, top, h * 0.92 - m * 0.3);
    }
  }

  onResize(): void {
    this.hitR = this.ctx.view.w * HIT_FRAC;
    if (this.slotA.active) this.layout(this.slotA, this.slotA.pic);
    if (this.slotB.active) this.layout(this.slotB, this.slotB.pic);
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    if (this.player) {
      g.ghostBody(this.player, 0.1);
      g.skeleton(this.player, { alpha: 0.5, emphasize: HANDS });
    }

    this.drawSlot(g, this.slotA);
    this.drawSlot(g, this.slotB);

    if (this.smPrimed) {
      this.drawCursor(g, this.smL, C.slot[0]);
      this.drawCursor(g, this.smR, C.slot[1]);
    }
  }

  private drawCursor(g: Renderer, p: Pt, color: string): void {
    g.circle(p.x, p.y, 30 * g.s, { stroke: color, sw: 7 * g.s });
    g.circle(p.x, p.y, 13 * g.s, { fill: C.hot, stroke: C.white, sw: 3 * g.s, glow: 10 });
  }

  private drawSlot(g: Renderer, s: Slot): void {
    if (!s.active) return;
    const r = this.hitR * 0.76 * (0.86 + 0.14 * easeOutBack(clamp01(s.appear)));
    const strong = this.cStrong;

    // The finished picture fills in; until then only the drawn edges show.
    if (s.done && s.closed) {
      g.poly(s.px, s.count, { fill: this.cStrongSoft, stroke: KEYLINE, sw: 6 * g.s }, true);
    }
    for (let i = 0; i < s.next - 1; i++) {
      g.line(s.px[i * 2]!, s.px[i * 2 + 1]!, s.px[i * 2 + 2]!, s.px[i * 2 + 3]!, 12 * g.s, { stroke: strong });
    }
    if (s.done && s.closed) {
      const l = s.count - 1;
      g.line(s.px[l * 2]!, s.px[l * 2 + 1]!, s.px[0]!, s.px[1]!, 12 * g.s, { stroke: strong });
    }
    // Faint guide from the last dot to the next, so the order reads at a glance.
    if (!s.done && s.next > 0) {
      const a = s.next - 1;
      g.line(s.px[a * 2]!, s.px[a * 2 + 1]!, s.px[s.next * 2]!, s.px[s.next * 2 + 1]!, 8 * g.s, {
        stroke: GUIDE,
      });
    }

    const handColor = s.hand === 0 ? C.slot[0] : C.slot[1];
    for (let i = 0; i < s.count; i++) {
      const x = s.px[i * 2]!;
      const y = s.px[i * 2 + 1]!;
      const reached = i < s.next;
      const isNext = i === s.next && !s.done;
      if (isNext) {
        const pulse = 1 + 0.1 * Math.sin(this.time * 7);
        g.circle(x, y, r * 1.35 * pulse, { stroke: s.hand >= 0 ? handColor : C.accent, sw: 8 * g.s, glow: 10 });
        g.circle(x, y, r * 1.1, { fill: C.accentHi, stroke: KEYLINE, sw: 5 * g.s });
      } else {
        g.circle(x, y, r, {
          fill: reached ? strong : this.cPale, stroke: KEYLINE, sw: 5 * g.s,
        });
      }
      g.text(NUM[i]!, x, y, {
        size: 52 * g.s, weight: 800, align: 'center', baseline: 'middle', display: true,
        fill: reached ? C.white : C.ink,
      });
    }
    if (s.hand >= 0 && !s.done) {
      // Above the first dot, unless that would put it under the DOM HUD.
      const above = s.px[1]! - r * 1.9;
      const ly = above < g.h * (s.px[0]! < g.w * 0.25 ? 0.26 : 0.18) ? s.px[1]! + r * 1.9 : above;
      g.text(s.hand === 0 ? t('left') : t('right'), s.px[0]!, ly, {
        size: 44 * g.s, weight: 800, align: 'center', baseline: 'middle',
        fill: handColor, stroke: C.white, sw: 7 * g.s,
      });
    }
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.stagesDone >= STAGE_A.length) highlights.push('그림 5개 전부 완성!');
    else if (this.stagesDone > 0) highlights.push(`그림 ${this.stagesDone}장 완성`);
    return {
      gameId: manifest.id,
      cleared: this.stagesDone > 0,
      rawScore: this.score,
      maxScore: manifest.scoring.maxScore,
      normalized: 0,
      stars: 0,
      durationMs: manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score: this.score,
        hits: this.dots, misses: 0, bestCombo: 0,
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }
}

/** Dot numbers, built once: the draw path builds no string. */
const NUM: readonly string[] = ['1', '2', '3', '4', '5', '6'];
const LABEL_FAST = '+30';
const LABEL_OK = '+20';

export default (): MiniGame => new ConnectDotsOrder();

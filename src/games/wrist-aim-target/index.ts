// ─── Shape A variant: dwell-to-fire aim ──────────────────────────────────────
//
// A laser from the fingertip; hold it on a target for a dwell window and it
// fires. Read AGENTS.md + docs/GAME_AUTHORING.md + src/games/mosquito-clap/
// before touching this.
//
// Precision-aim genre note (see NEEDS.md): there is no per-game hook to ask
// the pose pipeline for the `steady` One Euro preset (low beta) that
// src/engine/pose/oneEuro.ts documents for exactly this genre. The honest
// substitute used here: an extra approach()-based low-pass on top of the
// already-filtered `reach` signal, plus target radii well above the 8%
// floor so landmark jitter cannot flicker a dwell in or out.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { L, shoulderPx } from '@/engine/pose/landmarks';
import { approach, clamp, clamp01, dist, easeOutBack, TAU } from '@/engine/math';
import { Entities } from '@/engine/entities';
import { chance, randRange, Spawner } from '@/engine/spawn';
import { C, fade, hue } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

const NORMAL = 0;
const BOMB = 1;

/** Which hand a target demands. -1 = either hand may aim it. */
const HAND_EITHER = -1;
const HAND_L = 0;
const HAND_R = 1;

const RING_POINTS = 15;
const BULLSEYE_POINTS = 30;
const BOMB_PENALTY = 20;
const COMBO_STEP = 4;
/** approach() rate for the extra aim smoothing. ~90ms time constant: enough
 *  to deaden resting jitter without reading as sluggish between targets. */
const SMOOTH_RATE = 10;

const HANDS = [L.LEFT_WRIST, L.RIGHT_WRIST] as const;

class WristAimTarget implements MiniGame {
  private ctx!: GameContext;
  private reach!: Detector<'reach'>;
  private spawner!: Spawner;

  private readonly targets = new Entities(8);
  /** Extra-smoothed aim points. See the file header. */
  private readonly smL: Pt = { x: 0, y: 0 };
  private readonly smR: Pt = { x: 0, y: 0 };
  private smPrimed = false;

  private readonly shoulderC: Pt = { x: 0, y: 0 };
  private armLenPx = 0;
  private player: PlayerPose | null = null;
  private time = 0;

  /** Scratch for the per-target wobble position. Two instances so the
   *  update-pass and the render-pass never clobber each other mid-frame. */
  private readonly dwellPt: Pt = { x: 0, y: 0 };
  private readonly drawPt: Pt = { x: 0, y: 0 };

  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private hits = 0;
  private misses = 0;
  private announcedTwoHand = false;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.reach = ctx.gestures.use('reach', { side: 'both' });
    this.spawner = new Spawner(
      { startInterval: 2.6, endInterval: 1.5, jitter: 0.3, burstLate: 2, rampUntil: 0.82 },
      ctx.rng,
      manifest.durationMs / 1000,
    );
    this.shoulderC.x = ctx.view.w / 2;
    this.shoulderC.y = ctx.view.h * 0.42;
    this.armLenPx = Math.min(ctx.view.w, ctx.view.h) * 0.3;
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

    const k = this.spawner.tick(dt);
    if (k > 0) {
      if (k >= 2 && !this.announcedTwoHand) {
        this.announcedTwoHand = true;
        this.ctx.hud.toast(t('bothHands'), { color: C.info });
      }
      for (let i = 0; i < k; i++) {
        if (this.targets.n >= 2) break;
        this.spawnTarget(k >= 2 ? (i === 0 ? HAND_L : HAND_R) : HAND_EITHER);
      }
    }

    // This pool never calls Entities.step(): `vx` is repurposed to carry each
    // target's own holdMs rather than velocity, so life is decayed by hand.
    for (let i = this.targets.n - 1; i >= 0; i--) {
      this.targets.life[i] = this.targets.life[i]! - dt;
      if (this.targets.life[i]! <= 0) this.targets.kill(i);
    }

    if (sig.ok) this.updateDwell(dt);

    this.targets.sweep();
  }

  private spawnTarget(hand: -1 | 0 | 1): void {
    const d = this.spawner.difficulty;
    const isBomb = d > 0.22 && chance(this.ctx.rng, Math.min(0.07 + d * 0.16, 0.22));
    const g = Math.min(this.ctx.view.w, this.ctx.view.h);
    // Shrinks toward, but never below, the 8%-of-view-width floor the
    // catalogue's own threshold table demands.
    const radiusFrac = 0.125 - 0.04 * d;
    const r = g * radiusFrac;

    // Angle from the shoulder centre, screen convention (x right, y down).
    // A wide arc — excludes only the straight-down-into-the-lap sector, so
    // the layout stays reachable from whichever side a player favours.
    const angleDeg = randRange(this.ctx.rng, 160, 380);
    const a = (angleDeg * Math.PI) / 180;
    const distFrac = randRange(this.ctx.rng, 0.4 + d * 0.15, 0.85 + d * 0.2);
    const reach = this.armLenPx * distFrac;
    const margin = r * 1.3;
    const x = clamp(this.shoulderC.x + Math.cos(a) * reach, margin, this.ctx.view.w - margin);
    const y = clamp(this.shoulderC.y + Math.sin(a) * reach, margin, this.ctx.view.h * 0.92 - margin);

    const holdMs = 1000 - 400 * d;
    const lifeSec = Math.max(4, (holdMs / 1000) * 2.6);

    const i = this.targets.spawn(x, y, 0, 0, r, lifeSec, isBomb ? BOMB : NORMAL);
    if (i < 0) return;
    this.targets.vx[i] = holdMs; // repurposed scratch: holdMs, not velocity
    this.targets.vy[i] = 0;
    this.targets.hp[i] = hand;
    this.targets.data[i] = 0; // dwell ms accumulated
    this.targets.spin[i] = this.ctx.rng() * TAU; // wobble phase
  }

  /** Target's drawn/hit-tested centre: the stored anchor plus a slow wobble
   *  that only appears once the round demands "이동 과녁". Shared by the
   *  dwell check and the render pass so they can never disagree. */
  private targetPos(i: number, out: Pt): void {
    const amp = Math.min(this.ctx.view.w, this.ctx.view.h)
      * 0.022 * clamp01((this.spawner.difficulty - 0.55) * 2.2);
    const wob = amp > 0 ? Math.sin(this.time * 1.6 + this.targets.spin[i]!) * amp : 0;
    out.x = this.targets.x[i]!;
    out.y = this.targets.y[i]! + wob;
  }

  private updateDwell(dt: number): void {
    const dtMs = dt * 1000;
    for (let i = 0; i < this.targets.n; i++) {
      this.targetPos(i, this.dwellPt);
      const hand = this.targets.hp[i]!;
      const d = hand === HAND_EITHER
        ? Math.min(
          dist(this.smL.x, this.smL.y, this.dwellPt.x, this.dwellPt.y),
          dist(this.smR.x, this.smR.y, this.dwellPt.x, this.dwellPt.y),
        )
        : dist(
          (hand === HAND_L ? this.smL : this.smR).x,
          (hand === HAND_L ? this.smL : this.smR).y,
          this.dwellPt.x, this.dwellPt.y,
        );

      const r = this.targets.r[i]!;
      // Shrink to get in, grow to get out: the same dead-zone-margin trick
      // the engine's own ZoneDetector uses, so a hand parked on the rim does
      // not strobe the dwell timer.
      const wasEngaged = this.targets.data[i]! > 0;
      const inside = d <= (wasEngaged ? r * 1.2 : r);
      if (!inside) {
        this.targets.data[i] = 0;
        continue;
      }
      const dwell = this.targets.data[i]! + dtMs;
      this.targets.data[i] = dwell;
      const holdMs = this.targets.vx[i]!;
      if (dwell >= holdMs) this.resolve(i, d <= r * 0.4);
    }
  }

  private resolve(i: number, bullseye: boolean): void {
    const x = this.targets.x[i]!;
    const y = this.targets.y[i]!;
    const isBomb = this.targets.kind[i] === BOMB;
    this.targets.kill(i);

    if (isBomb) {
      // A real penalty, not a whiff: a soft buzz and a quiet fx.miss — the
      // engine refuses shake/flash/red even here. The lesson is "stop aiming
      // at it", not "you failed".
      this.misses++;
      this.combo = 0;
      this.score = Math.max(0, this.score - BOMB_PENALTY);
      this.ctx.hud.setCombo(0);
      this.ctx.hud.setScore(this.score);
      this.ctx.hud.toast(t('bombWarn'), { color: C.danger });
      this.ctx.audio.play('buzz', { gain: 0.6 });
      this.ctx.fx.miss(x, y);
      this.ctx.emit({ kind: 'miss' });
      return;
    }

    this.hits++;
    this.combo++;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    const points = bullseye ? BULLSEYE_POINTS : RING_POINTS;
    this.score += points;

    this.ctx.fx.impact(x, y, bullseye ? 'big' : 'hit', {
      color: bullseye ? C.accent : C.success,
      sprite: 'sparkle',
      label: `+${points}`,
    });
    this.ctx.audio.playLadder('pop', this.combo);
    if (bullseye) {
      this.ctx.hud.toast(t('wow'), { color: C.accent });
      this.ctx.audio.play('bonus');
    } else if (this.combo % COMBO_STEP === 0) {
      this.ctx.hud.toast(t('nice'), { color: C.success });
      this.ctx.audio.play('combo.up');
    }
    this.ctx.hud.setScore(this.score);
    this.ctx.hud.setCombo(this.combo);
    this.ctx.emit({ kind: 'scored', points });
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    // Always draw the body: visible response reads as "it can see me", and
    // it is the proof the camera only ever leaves this room as joints.
    if (this.player) g.ghostBody(this.player, 0.1);
    if (this.player) g.skeleton(this.player, { alpha: 0.4, emphasize: HANDS });

    for (let i = 0; i < this.targets.n; i++) {
      this.targetPos(i, this.drawPt);
      const x = this.drawPt.x;
      const y = this.drawPt.y;
      const r = this.targets.r[i]!;
      const isBomb = this.targets.kind[i] === BOMB;
      const hand = this.targets.hp[i]!;
      const holdMs = this.targets.vx[i]!;
      const progress = clamp01(this.targets.data[i]! / holdMs);
      const age = this.targets.age(i);
      const grow = age < 0.12 ? easeOutBack(age / 0.12) : 1;

      if (isBomb) {
        g.sprite('rock', x, y, r * 1.7 * grow);
        g.circle(x, y, r * grow, { stroke: C.danger, sw: 3 * g.s });
      } else {
        g.sprite('target', x, y, r * 2 * grow);
        if (hand !== HAND_EITHER) {
          g.circle(x, y, r * 1.3 * grow, {
            stroke: hand === HAND_L ? C.slot[0] : C.slot[1],
            sw: 2.5 * g.s,
          });
        }
      }

      // The dwell gauge: the only way a player can tell a selection is in
      // progress. A track ring plus a filling arc, always drawn once started.
      if (progress > 0) {
        g.circle(x, y, r * 1.22, { stroke: fade(C.white, 0.5), sw: 3 * g.s });
        g.arc(x, y, r * 1.22, -Math.PI / 2, -Math.PI / 2 + progress * TAU, {
          stroke: isBomb ? C.danger : C.success,
          sw: 5 * g.s,
          glow: 10,
        });
      }
    }

    this.drawLaser(g, this.smL, hue(manifest.theme?.hue ?? 238, 85, 68));
    this.drawLaser(g, this.smR, hue(manifest.theme?.hue ?? 238, 85, 68));
  }

  /** A short glowing beam from the palm, pointed outward from the shoulder
   *  through the hand — a cheap "aiming" read with no raycasting needed,
   *  since the real hit test is a plain distance check against the target. */
  private drawLaser(g: Renderer, palmPt: Pt, strokeColor: string): void {
    const dx = palmPt.x - this.shoulderC.x;
    const dy = palmPt.y - this.shoulderC.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const beam = Math.min(this.ctx.view.w, this.ctx.view.h) * 0.16;
    g.line(palmPt.x, palmPt.y, palmPt.x + ux * beam, palmPt.y + uy * beam, 3 * g.s, {
      stroke: strokeColor,
      glow: 12,
    });
    g.circle(palmPt.x, palmPt.y, 16 * g.s, { stroke: C.white, sw: 3 * g.s, glow: 8 });
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.bestCombo >= COMBO_STEP) highlights.push(`콤보 ${this.bestCombo}연속!`);
    if (this.hits >= 10) highlights.push(`과녁 ${this.hits}개 명중!`);
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
    this.targets.clear();
  }
}

export default (): MiniGame => new WristAimTarget();

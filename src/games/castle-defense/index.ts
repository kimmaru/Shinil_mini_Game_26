// ─── SHAPE A — discrete trigger (a swing) x screen-space joints x hit test ───
//
// Rocks fall on a castle. A fast swing — hand OR foot — knocks one away with
// `hitSegCircle`; a bare touch does nothing, which is the whole point of
// basing this on `swing` rather than `clap`/`zone`. The hand half rents the
// engine's SwingDetector; the foot half is a hand-rolled equivalent because
// no rented detector covers ankles (see NEEDS.md).
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { L, MIN_VIS, jointPx, vx, vy } from '@/engine/pose/landmarks';
import { clamp01, hitSegCircle, lerp } from '@/engine/math';
import { Entities } from '@/engine/entities';
import { chance, randRange, Spawner } from '@/engine/spawn';
import { C, KEYLINE, fade, hue } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

const SMALL = 0;
const BIG = 1;
const HEAL = 2;

const CASTLE_HP_MAX = 10;
const POINTS = 10;

/** Not corpus-measured — see NEEDS.md. Scaled down from the hand swing
 *  default (3.5 sw/s) on the assumption a kick reads slower than a swat from
 *  this camera distance. */
const FOOT_SWING_GATE = 2.4;

const HANDS_FEET = [L.LEFT_WRIST, L.RIGHT_WRIST, L.LEFT_ANKLE, L.RIGHT_ANKLE] as const;

class CastleDefense implements MiniGame {
  private ctx!: GameContext;
  private swing!: Detector<'swing'>;
  private spawner!: Spawner;

  private readonly rocks = new Entities(48);
  private player: PlayerPose | null = null;

  // Fixed geometry, computed once in init() from the view.
  private castleX = 0;
  private castleTopY = 0;
  private castleW = 0;
  private castleH = 0;
  private floorY = 0;

  // Foot-swing scratch. NaN sentinels mean "no previous sample yet", the same
  // idiom SwingDetector itself uses internally.
  private readonly curAnkleL: Pt = { x: 0, y: 0 };
  private readonly curAnkleR: Pt = { x: 0, y: 0 };
  private readonly prevAnkleL: Pt = { x: NaN, y: NaN };
  private readonly prevAnkleR: Pt = { x: NaN, y: NaN };

  private castleHp = CASTLE_HP_MAX;
  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private hits = 0;
  private misses = 0;
  private time = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    const { w, h } = ctx.view;
    this.castleX = w * 0.5;
    this.castleTopY = h * 0.78;
    this.castleW = Math.min(w, h) * 0.56;
    this.castleH = h - this.castleTopY - h * 0.02;
    this.floorY = this.castleTopY + this.castleH * 0.1;

    this.swing = ctx.gestures.use('swing', { side: 'both' });
    this.spawner = new Spawner(
      { startInterval: 1.1, endInterval: 0.48, jitter: 0.3, burstMid: 1, burstLate: 2 },
      ctx.rng,
      manifest.durationMs / 1000,
    );
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.hud.setBar('castleHp', 1, { labelKo: t('castleHp'), color: C.success });
    this.ctx.audio.music({ bpm: 124 });
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    for (let i = 0, k = this.spawner.tick(dt); i < k; i++) this.spawnRock();
    const g = Math.min(this.ctx.view.w, this.ctx.view.h);
    this.rocks.step(dt, g * 0.4);

    const p = f.p1;
    this.player = p ?? null;
    if (p) {
      const sw = this.swing.read(f);
      if (sw.active) this.sweepSwing(sw.from.x, sw.from.y, sw.to.x, sw.to.y);
      this.handleFoot(p, 'L');
      this.handleFoot(p, 'R');
    }

    this.resolveFloor();
    this.rocks.sweep();
  }

  private handleFoot(p: PlayerPose, side: 'L' | 'R'): void {
    const ankle = side === 'L' ? L.LEFT_ANKLE : L.RIGHT_ANKLE;
    if (p.vis[ankle]! < MIN_VIS) return;
    const cur = side === 'L' ? this.curAnkleL : this.curAnkleR;
    const prev = side === 'L' ? this.prevAnkleL : this.prevAnkleR;
    jointPx(p, ankle, cur);
    // The engine's own filtered normalized velocity, not a hand-differenced
    // pixel delta — the One Euro filter already did the noise rejection.
    const speed = Math.hypot(vx(p, ankle), vy(p, ankle));
    if (speed > FOOT_SWING_GATE && Number.isFinite(prev.x)) {
      this.sweepSwing(prev.x, prev.y, cur.x, cur.y);
    }
    prev.x = cur.x;
    prev.y = cur.y;
  }

  private sweepSwing(fromX: number, fromY: number, toX: number, toY: number): void {
    for (let i = 0; i < this.rocks.n; i++) {
      // Already resolved by another limb earlier in THIS same frame — sweep()
      // has not run yet, so the dead entity is still sitting in the array.
      if (this.rocks.life[i]! <= 0) continue;
      if (!hitSegCircle(fromX, fromY, toX, toY, this.rocks.x[i]!, this.rocks.y[i]!, this.rocks.r[i]!)) continue;
      this.hitRock(i, fromX, fromY, toX, toY);
    }
  }

  private hitRock(i: number, fromX: number, fromY: number, toX: number, toY: number): void {
    const kind = this.rocks.kind[i]!;
    const x = this.rocks.x[i]!;
    const y = this.rocks.y[i]!;

    if (kind === HEAL) {
      this.rocks.kill(i);
      this.castleHp = Math.min(CASTLE_HP_MAX, this.castleHp + 2);
      this.ctx.hud.setBar('castleHp', this.castleHp / CASTLE_HP_MAX, { labelKo: t('castleHp'), color: C.success });
      this.ctx.hud.toast(t('heal'), { color: C.success });
      this.ctx.audio.play('chime');
      this.ctx.fx.impact(x, y, 'tap', { color: C.success, sprite: 'heart' });
      return;
    }

    // Away from the direction the limb was travelling — the "flew backward"
    // read the brief calls the core feel.
    const dir = Math.atan2(toY - fromY, toX - fromX) + Math.PI;
    const hpLeft = this.rocks.hp[i]! - 1;
    this.rocks.hp[i] = hpLeft;

    if (hpLeft > 0) {
      // A big rock takes two: this is the first, a chip, not a kill.
      this.rocks.vx[i] = this.rocks.vx[i]! + Math.cos(dir) * 160;
      this.rocks.vy[i] = this.rocks.vy[i]! + Math.sin(dir) * 100;
      this.ctx.audio.play('hit.soft', { gain: 0.5 });
      this.ctx.fx.impact(x, y, 'tap', { color: C.textFaint, sprite: 'rock', dir });
      return;
    }

    this.rocks.kill(i);
    this.hits++;
    this.combo++;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    const points = POINTS + Math.floor(this.combo / 5) * 2;
    this.score += points;

    this.ctx.fx.impact(x, y, kind === BIG ? 'big' : 'hit', {
      color: C.accent, sprite: 'rock', label: `+${points}`, dir,
    });
    if (kind === BIG) this.ctx.audio.play('break', { gain: 0.65 });
    else this.ctx.audio.playLadder('pop', this.combo);
    if (this.combo > 0 && this.combo % 5 === 0) this.ctx.audio.play('combo.up');
    this.ctx.hud.setScore(this.score);
    this.ctx.hud.setCombo(this.combo);
    this.ctx.emit({ kind: 'scored', points });
  }

  private resolveFloor(): void {
    for (let i = this.rocks.n - 1; i >= 0; i--) {
      if (this.rocks.life[i]! <= 0) continue;
      if (this.rocks.y[i]! < this.floorY) continue;
      const kind = this.rocks.kind[i]!;
      const x = this.rocks.x[i]!;
      this.rocks.kill(i);
      if (kind === HEAL) continue; // an unswatted heal item is just gone, no cost

      this.combo = 0;
      this.ctx.hud.setCombo(0);
      this.castleHp = Math.max(0, this.castleHp - 1);
      this.ctx.hud.setBar('castleHp', this.castleHp / CASTLE_HP_MAX, { labelKo: t('castleHp'), color: C.danger });
      this.ctx.audio.play('thud', { gain: 0.6 });
      // Bricks falling: small debris with gravity, not a particle flourish.
      this.ctx.fx.burst(x, this.floorY, {
        count: 12, color: hue(26, 55, 42), sprite: 'square', speed: 220, gravity: 500, life: 0.5,
      });
      this.ctx.fx.shake(0.1);
      this.ctx.fx.squash('castle', 0.3);
      this.misses++;
      this.ctx.emit({ kind: 'miss' });
      if (this.castleHp <= 0) this.ctx.emit({ kind: 'clearEarly' });
    }
  }

  private spawnRock(): void {
    const { w, h } = this.ctx.view;
    const d = this.spawner.difficulty;
    const heal = d > 0.25 && chance(this.ctx.rng, 0.07);
    const big = !heal && d > 0.35 && chance(this.ctx.rng, 0.22);
    const kind = heal ? HEAL : big ? BIG : SMALL;
    const x = randRange(this.ctx.rng, w * 0.12, w * 0.88);
    const r = Math.min(w, h) * (big ? 0.075 : 0.05);
    const vy0 = lerp(140, 260, d) * (big ? 0.85 : 1);
    const hp = big ? 2 : 1;
    const i = this.rocks.spawn(x, -r * 2, randRange(this.ctx.rng, -20, 20), vy0, r, 20, kind, hp);
    if (i >= 0) this.rocks.data[i] = this.ctx.rng() * 6.28;
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);
    this.drawCastle(g);

    if (this.player) g.ghostBody(this.player, 0.1);
    if (this.player) g.skeleton(this.player, { alpha: 0.45, emphasize: HANDS_FEET });

    for (let i = 0; i < this.rocks.n; i++) {
      const x = this.rocks.x[i]!;
      const y = this.rocks.y[i]!;
      const r = this.rocks.r[i]!;
      const kind = this.rocks.kind[i]!;
      const spin = this.rocks.data[i]! + this.time * 1.5;
      if (kind === HEAL) {
        g.sprite('heart', x, y, r * 2.2);
      } else {
        g.sprite('rock', x, y, r * 2.2 * (kind === BIG ? 1.15 : 1), { rot: Math.sin(spin) * 0.3 });
        if (kind === BIG && this.rocks.hp[i]! < 2) {
          // Chipped once: a crack, so the second-hit requirement is legible.
          g.line(x - r * 0.3, y - r * 0.2, x + r * 0.2, y + r * 0.35, 3 * g.s, { stroke: fade(C.ink, 0.5) });
        }
      }
    }
  }

  private drawCastle(g: Renderer): void {
    const th = manifest.theme?.hue ?? 26;
    const cx = this.castleX;
    const baseY = this.castleTopY;
    const bw = this.castleW;
    const bh = this.castleH;
    const dmg = clamp01(1 - this.castleHp / CASTLE_HP_MAX);
    const sq = this.ctx.fx.squashAt('castle');

    g.save();
    g.translate(cx, baseY + bh * 0.5);
    g.scale(1 + sq * 0.1, 1 - sq * 0.08);
    g.translate(-cx, -(baseY + bh * 0.5));

    const towerW = bw * 0.2;
    const towerH = bh * 0.62;
    g.roundRect(cx - bw * 0.5 - towerW * 0.25, baseY - towerH * 0.55, towerW, towerH, 8 * g.s, {
      fill: hue(th), stroke: KEYLINE, sw: 4 * g.s,
    });
    g.roundRect(cx + bw * 0.5 - towerW * 0.75, baseY - towerH * 0.55, towerW, towerH, 8 * g.s, {
      fill: hue(th), stroke: KEYLINE, sw: 4 * g.s,
    });
    g.roundRect(cx - bw * 0.5, baseY, bw, bh, 10 * g.s, { fill: hue(th), stroke: KEYLINE, sw: 4 * g.s });
    g.roundRect(cx - bw * 0.09, baseY + bh * 0.32, bw * 0.18, bh * 0.68, 6 * g.s, { fill: fade(C.ink, 0.35) });
    g.sprite('triangle', cx - bw * 0.5 - towerW * 0.25 + towerW * 0.5, baseY - towerH * 0.55 - 8 * g.s, 16 * g.s, {
      hue: th, rot: Math.PI / 2,
    });
    g.sprite('triangle', cx + bw * 0.5 - towerW * 0.75 + towerW * 0.5, baseY - towerH * 0.55 - 8 * g.s, 16 * g.s, {
      hue: th, rot: Math.PI / 2,
    });
    if (dmg > 0.3) {
      g.line(cx - bw * 0.22, baseY + bh * 0.18, cx - bw * 0.08, baseY + bh * 0.55, 3 * g.s, { stroke: fade(C.ink, 0.3) });
    }
    if (dmg > 0.6) {
      g.line(cx + bw * 0.1, baseY + bh * 0.1, cx + bw * 0.24, baseY + bh * 0.48, 3 * g.s, { stroke: fade(C.ink, 0.3) });
    }
    g.restore();
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.bestCombo >= 10) highlights.push(`콤보 ${this.bestCombo}연속!`);
    if (this.castleHp >= CASTLE_HP_MAX) highlights.push('성이 멀쩡해요!');
    return {
      gameId: manifest.id,
      cleared: this.castleHp > 0,
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
    this.rocks.clear();
  }
}

export default (): MiniGame => new CastleDefense();

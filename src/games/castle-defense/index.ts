// ─── SHAPE A — discrete trigger (a swing) x screen-space joints x hit test ───
//
// Rocks fall toward a castle wall. A fast swing — hand or foot — knocks one
// away with `hitSegCircle`; a bare touch does nothing, which is the whole point
// of basing this on `swing` rather than `clap`/`zone`. The hand half rents the
// engine's SwingDetector; the foot half is hand-rolled because no rented
// detector covers ankles (see NEEDS.md).
//
// FAIRNESS: most rocks fall within this child's own arm reach of their body
// (calib.armLen x scalePx), so a short child and a tall one are asked for the
// same effort. Hands alone are enough for the whole game; the foot swat is a
// bonus for children whose legs are in frame.
//
// A rock that reaches the wall costs nothing but the combo: no life bar, no
// early end. Failure is quiet by design (AGENTS.md).
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { L, MIN_VIS, jointPx, shoulderPx } from '@/engine/pose/landmarks';
import { clamp, hitSegCircle, lerp } from '@/engine/math';
import { Entities } from '@/engine/entities';
import { chance, randRange, Spawner } from '@/engine/spawn';
import { C, KEYLINE, fade, hue } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

const SMALL = 0;
const BIG = 1;
const GOLD = 2;

const POINTS_SMALL = 10;
const POINTS_BIG = 20;
const POINTS_GOLD = 30;
const LABEL: string[] = [];
for (let i = 0; i <= 60; i++) LABEL.push('+' + i);

const FALLBACK_ARM_LEN = 1.6;
/** Seconds before the same rock can take another hit: a big rock needs two
 *  separate swats, not two frames of the same swing. */
const ROCK_HIT_GAP = 0.3;

/** Foot swat. Not corpus-measured (see NEEDS.md), so it is deliberately
 *  strict: ankle speed above the gate for FOOT_FRAMES frames running AND a net
 *  travel of FOOT_TRAVEL shoulder-widths since the run began. Sensor jitter on
 *  a distant, still child is fast but random — it never travels. */
const FOOT_GATE = 3.0;
const FOOT_FRAMES = 3;
const FOOT_TRAVEL = 0.5;
/** The swatting foot must also be this far above the other ankle (shoulder-
 *  widths): a real kick lifts the foot; noise on two grounded feet does not. */
const FOOT_LIFT = 0.4;
const FOOT_CD = 0.26;
const HAND_PAD = 0.2;
/** The same run + net-travel gate on the hand swing, so jitter on a distant
 *  child that happens to cross the detector's speed gate cannot swat rocks. */
const HAND_FRAMES = 3;
const HAND_TRAVEL = 0.35;

const HANDS_FEET = [L.LEFT_WRIST, L.RIGHT_WRIST, L.LEFT_ANKLE, L.RIGHT_ANKLE] as const;
const CRACKS = 5;

class CastleDefense implements MiniGame {
  private ctx!: GameContext;
  private swing!: Detector<'swing'>;
  private spawner!: Spawner;

  private readonly rocks = new Entities(48);
  private player: PlayerPose | null = null;

  private wallTop = 0;
  private floorY = 0;
  private fallG = 0;
  private vScale = 1;
  private readonly sh: Pt = { x: 0, y: 0 };

  // Foot-swing state, one slot per foot (0 = left, 1 = right).
  private readonly footCur: Pt[] = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
  private readonly footPrev: Pt[] = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
  /** Run-length and start point of the current fast move, per limb slot:
   *  0 = left foot, 1 = right foot, 2 = hands (swing detector). */
  private readonly anchor: Pt[] = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
  private readonly run = new Uint8Array(3);
  private readonly footCd = new Float32Array(2);
  private readonly footHave = new Uint8Array(2);

  // Where rocks recently landed, for the cracks on the wall.
  private readonly crackX = new Float32Array(CRACKS);
  private crackN = 0;

  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private hits = 0;
  private misses = 0;
  private time = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    const { w, h } = ctx.view;
    this.wallTop = h * 0.8;
    this.floorY = this.wallTop - h * 0.02;
    this.fallG = Math.min(w, h) * 0.2;
    this.vScale = h / 720;

    this.swing = ctx.gestures.use('swing', { side: 'both' });
    this.spawner = new Spawner(
      { startInterval: 1.2, endInterval: 0.55, jitter: 0.3, burstMid: 1, burstLate: 2 },
      ctx.rng,
      manifest.durationMs / 1000,
    );
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.audio.music({ bpm: 124 });
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    if (this.footCd[0]! > 0) this.footCd[0] = this.footCd[0]! - dt;
    if (this.footCd[1]! > 0) this.footCd[1] = this.footCd[1]! - dt;
    const p = f.p1;
    this.player = p ?? null;

    for (let i = 0, k = this.spawner.tick(dt); i < k; i++) this.spawnRock(p);
    this.rocks.step(dt, this.fallG);

    if (p) {
      const sw = this.swing.read(f);
      if (this.travelled(2, sw.active, sw.from, sw.to, p.scalePx, HAND_FRAMES, HAND_TRAVEL)) {
        this.sweepSwing(sw.from.x, sw.from.y, sw.to.x, sw.to.y, HAND_PAD * p.scalePx);
      }
      this.handleFoot(p, 0);
      this.handleFoot(p, 1);
    } else {
      this.footHave[0] = 0;
      this.footHave[1] = 0;
      this.run[0] = 0;
      this.run[1] = 0;
      this.run[2] = 0;
    }

    this.resolveFloor();
    this.rocks.sweep();
  }

  /** True once a fast move has lasted `frames` frames AND the limb has
   *  travelled `travel` shoulder-widths from where the move began. */
  private travelled(slot: number, on: boolean, from: Pt, to: Pt, sw: number, frames: number, travel: number): boolean {
    if (!on) {
      this.run[slot] = 0;
      return false;
    }
    const a = this.anchor[slot]!;
    if (this.run[slot] === 0) {
      a.x = from.x;
      a.y = from.y;
    }
    if (this.run[slot]! < 255) this.run[slot] = this.run[slot]! + 1;
    return this.run[slot]! >= frames && Math.hypot(to.x - a.x, to.y - a.y) / sw >= travel;
  }

  private handleFoot(p: PlayerPose, foot: number): void {
    const ankle = foot === 0 ? L.LEFT_ANKLE : L.RIGHT_ANKLE;
    if (p.vis[ankle]! < MIN_VIS) {
      this.footHave[foot] = 0;
      this.run[foot] = 0;
      return;
    }
    const cur = this.footCur[foot]!;
    const prev = this.footPrev[foot]!;
    jointPx(p, ankle, cur);
    // The engine's own filtered normalized velocity (shoulder-widths/sec).
    const other = foot === 0 ? L.RIGHT_ANKLE : L.LEFT_ANKLE;
    const speed = Math.hypot(p.v[ankle * 2]!, p.v[ankle * 2 + 1]!);
    const lifted = p.vis[other]! >= MIN_VIS && p.n[other * 2 + 1]! - p.n[ankle * 2 + 1]! >= FOOT_LIFT;
    const go = this.travelled(foot, lifted && speed > FOOT_GATE && this.footHave[foot] === 1, prev, cur, p.scalePx, FOOT_FRAMES, FOOT_TRAVEL);
    if (go && this.footCd[foot]! <= 0 && this.sweepSwing(prev.x, prev.y, cur.x, cur.y, 0.25 * p.scalePx)) {
      this.footCd[foot] = FOOT_CD;
    }
    prev.x = cur.x;
    prev.y = cur.y;
    this.footHave[foot] = 1;
  }

  /** Returns true if anything was hit. */
  private sweepSwing(fx: number, fy: number, tx: number, ty: number, pad: number): boolean {
    let any = false;
    for (let i = 0; i < this.rocks.n; i++) {
      // Already resolved earlier in THIS frame: sweep() has not run yet.
      if (this.rocks.life[i]! <= 0) continue;
      if (this.time - this.rocks.data[i]! < ROCK_HIT_GAP) continue;
      if (!hitSegCircle(fx, fy, tx, ty, this.rocks.x[i]!, this.rocks.y[i]!, this.rocks.r[i]! * 1.1 + pad)) continue;
      this.hitRock(i, fx, fy, tx, ty);
      any = true;
    }
    return any;
  }

  private hitRock(i: number, fx: number, fy: number, tx: number, ty: number): void {
    const kind = this.rocks.kind[i]!;
    const x = this.rocks.x[i]!;
    const y = this.rocks.y[i]!;
    // Away from the direction the limb was travelling.
    const dir = Math.atan2(ty - fy, tx - fx);
    const hpLeft = this.rocks.hp[i]! - 1;
    this.rocks.hp[i] = hpLeft;
    this.rocks.data[i] = this.time;

    if (hpLeft > 0) {
      // A big rock takes two: this is the first, a chip, not a kill. It gets
      // knocked sideways and keeps falling.
      this.rocks.vx[i] = this.rocks.vx[i]! + Math.cos(dir) * 260 * this.vScale;
      this.rocks.vy[i] = this.rocks.vy[i]! * 0.4 + Math.sin(dir) * 120 * this.vScale;
      this.ctx.audio.play('hit.hard', { gain: 0.6 });
      this.ctx.fx.impact(x, y, 'hit', { color: C.textFaint, sprite: 'rock', dir });
      return;
    }

    this.rocks.kill(i);
    this.hits++;
    this.combo++;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    const base = kind === GOLD ? POINTS_GOLD : kind === BIG ? POINTS_BIG : POINTS_SMALL;
    const points = base + Math.min(Math.floor(this.combo / 5), 5) * 2;
    this.score += points;

    this.ctx.fx.impact(x, y, kind === SMALL ? 'hit' : 'big', {
      color: kind === GOLD ? C.accent : C.warn,
      sprite: kind === GOLD ? 'star' : 'rock',
      label: LABEL[points]!,
      dir,
    });
    if (kind === BIG) this.ctx.audio.play('break', { gain: 0.7 });
    else if (kind === GOLD) this.ctx.audio.play('bonus');
    else this.ctx.audio.playLadder('pop', this.combo);
    if (this.combo % 5 === 0) this.ctx.audio.play('combo.up');
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
      // A rock that lands is a quiet miss: the combo breaks, a little dust and
      // a crack in the wall. No shake, no bar, no early end.
      if (this.combo > 0) {
        this.combo = 0;
        this.ctx.hud.setCombo(0);
      }
      this.ctx.audio.play('thud', { gain: 0.3 });
      this.ctx.fx.burst(x, this.floorY, {
        count: 6, color: hue(26, 40, 55), sprite: 'square', speed: 140, gravity: 400, life: 0.4,
        dir: -Math.PI / 2, spread: 2.2,
      });
      this.ctx.fx.squash('castle', 0.25);
      this.crackX[this.crackN % CRACKS] = x;
      this.crackN++;
      if (kind !== GOLD) this.misses++;
      this.ctx.emit({ kind: 'miss' });
    }
  }

  private spawnRock(p: PlayerPose | undefined): void {
    const { w, h } = this.ctx.view;
    const d = this.spawner.difficulty;
    const gold = d > 0.3 && chance(this.ctx.rng, 0.07);
    const big = !gold && d > 0.3 && chance(this.ctx.rng, 0.2);
    const kind = gold ? GOLD : big ? BIG : SMALL;

    let x: number;
    if (p && chance(this.ctx.rng, 0.85)) {
      // Within this child's own arm reach, sideways, of their body centre.
      shoulderPx(p, this.sh);
      const armLen = p.calib.armLen > 0.5 ? p.calib.armLen : FALLBACK_ARM_LEN;
      const span = clamp((armLen + 0.3) * p.scalePx * 1.1, w * 0.12, w * 0.36);
      x = this.sh.x + randRange(this.ctx.rng, -span, span);
    } else {
      x = randRange(this.ctx.rng, w * 0.1, w * 0.9);
    }
    x = clamp(x, w * 0.08, w * 0.92);
    // 7% / 10% of the short side: ~100 / ~145 px wide on a 1280x720 view.
    const r = Math.min(w, h) * (big ? 0.1 : 0.07);
    const vy0 = lerp(120, 210, d) * this.vScale * (gold ? 0.75 : 1);
    const hp = big ? 2 : 1;
    const i = this.rocks.spawn(x, -r * 1.5, randRange(this.ctx.rng, -18, 18), vy0, r, 20, kind, hp);
    if (i >= 0) {
      this.rocks.data[i] = -9;
      this.rocks.spin[i] = randRange(this.ctx.rng, -1.4, 1.4);
    }
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);
    this.drawWall(g);

    if (this.player) g.ghostBody(this.player, 0.1);
    if (this.player) g.skeleton(this.player, { alpha: 0.5, emphasize: HANDS_FEET });

    for (let i = 0; i < this.rocks.n; i++) {
      const x = this.rocks.x[i]!;
      const y = this.rocks.y[i]!;
      const r = this.rocks.r[i]!;
      const kind = this.rocks.kind[i]!;
      if (kind === GOLD) {
        g.sprite('rock', x, y, r * 2.3, { rot: this.rocks.rot[i]!, flatten: C.accent, glow: 12 });
        g.sprite('star', x, y, r * 1.1, { rot: -this.rocks.rot[i]! });
        continue;
      }
      g.sprite('rock', x, y, r * 2.3, { rot: this.rocks.rot[i]! });
      if (kind === BIG) {
        // Two swats needed: one pip per swat still owed, so it is legible.
        const left = this.rocks.hp[i]!;
        g.circle(x - r * 0.28, y, r * 0.17, { fill: C.white, stroke: KEYLINE, sw: 3 * g.s });
        if (left >= 2) g.circle(x + r * 0.28, y, r * 0.17, { fill: C.white, stroke: KEYLINE, sw: 3 * g.s });
      }
    }
  }

  private drawWall(g: Renderer): void {
    const { w, h } = g;
    const th = manifest.theme?.hue ?? 26;
    const top = this.wallTop;
    const sq = this.ctx.fx.squashAt('castle');

    g.save();
    g.translate(w * 0.5, h);
    g.scale(1 + sq * 0.02, 1 - sq * 0.05);
    g.translate(-w * 0.5, -h);

    const mw = 70 * g.s;
    const mh = 40 * g.s;
    const n = Math.ceil(w / (mw * 2)) + 1;
    for (let k = 0; k < n; k++) {
      g.roundRect(k * mw * 2 + mw * 0.25, top - mh, mw, mh + 8 * g.s, 6 * g.s, {
        fill: hue(th, 40, 60), stroke: KEYLINE, sw: 4 * g.s,
      });
    }
    g.rect(-10, top, w + 20, h - top + 10, { fill: hue(th, 40, 60), stroke: KEYLINE, sw: 4 * g.s });
    // Brick courses.
    g.line(0, top + (h - top) * 0.36, w, top + (h - top) * 0.36, 3 * g.s, { stroke: hue(th, 40, 40, 0.5) });
    g.line(0, top + (h - top) * 0.7, w, top + (h - top) * 0.7, 3 * g.s, { stroke: hue(th, 40, 40, 0.5) });
    // Cracks where rocks landed.
    const cn = this.crackN < CRACKS ? this.crackN : CRACKS;
    for (let k = 0; k < cn; k++) {
      const cx = this.crackX[k]!;
      g.line(cx, top, cx - 14 * g.s, top + 30 * g.s, 4 * g.s, { stroke: fade(C.ink, 0.45) });
      g.line(cx - 14 * g.s, top + 30 * g.s, cx + 4 * g.s, top + 56 * g.s, 4 * g.s, { stroke: fade(C.ink, 0.45) });
    }
    g.restore();
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.bestCombo >= 8) highlights.push(`콤보 ${this.bestCombo}연속!`);
    if (this.hits >= 20) highlights.push(`바위 ${this.hits}개를 쳐냈어요`);
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
    this.rocks.clear();
  }
}

export default (): MiniGame => new CastleDefense();

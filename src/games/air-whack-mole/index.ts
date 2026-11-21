// ─── SHAPE A — discrete trigger x screen-space joints x hit test ─────────────
//
// Moles pop up in the air AROUND THE PLAYER, not at fixed screen spots: the
// five hand cells sit on a fan at 80% of this child's own reach (calib.armLen
// x scalePx), and the two knee cells sit half-way up this child's own thigh. A short
// child and a tall one are therefore asked for the same effort. A hand touches
// a mole; a lifted knee touches a low mole. If the legs are not visible only
// hand moles spawn, so a child standing close to the laptop still has a game.
import type {
  EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { L, MIN_VIS, hipPx, jointPx, palm, shoulderPx } from '@/engine/pose/landmarks';
import { clamp, clamp01, dist, easeOutBack, lerp, pulse } from '@/engine/math';
import { Entities } from '@/engine/entities';
import { chance, randRange, Spawner } from '@/engine/spawn';
import { C, KEYLINE, fade, hue } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

const MOLE = 0;
const BOMB = 1;
const GOLD = 2;

/** Hand cells 0-4 are a fan above/beside the shoulders; 5-6 are knee cells. */
const HAND_CELLS = 5;
const CELLS = 7;
const FAN_DEG = [168, 126, 90, 54, 12] as const;
/** Fraction of the player's own reach a hand cell sits at. */
const REACH_FRAC = 0.8;
/** Knee cell, as fractions of THIS child's own standing thigh drop (knee y
 *  minus hip y, measured when the mole spawns): under half-way up, hit radius a quarter
 *  of it. A standing knee sits a full thigh below the hip, so it is ~2 radii
 *  away from the cell and can never touch by itself, whatever the proportions. */
const KNEE_DX = 0.35;
const KNEE_DY_FRAC = 0.45;
const KNEE_HIT_FRAC = 0.27;
/** Below this the knees are already lifted (or mis-tracked): no knee mole. */
const MIN_THIGH = 0.6;
/** Leg tracking is too noisy to trust on a distant child (shoulder width under
 *  7% of the view): hand moles only. */
const MIN_SW_FOR_KNEES = 0.07;

/** Limbs: 0/1 = left/right hand, 2/3 = left/right knee. */
const LIMBS = 4;
const HIT_CD = 0.26;
const CONFIRM = 2;

const FALLBACK_ARM_LEN = 1.6;
const PALM_EXT = 0.3;

const LABEL: string[] = [];
for (let i = 0; i <= 60; i++) LABEL.push('+' + i);

const EMPHASIZE = [L.LEFT_WRIST, L.RIGHT_WRIST, L.LEFT_KNEE, L.RIGHT_KNEE] as const;

class AirWhackMole implements MiniGame {
  private ctx!: GameContext;
  private spawner!: Spawner;

  private readonly moles = new Entities(8);
  private readonly sh: Pt = { x: 0, y: 0 };
  private readonly hip: Pt = { x: 0, y: 0 };
  private readonly limb: Pt[] = [
    { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
  ];
  private readonly limbOk = new Uint8Array(LIMBS);
  private readonly limbCd = new Float32Array(LIMBS);
  private moleR = 0;
  private lastKneeSide = 0;

  private player: PlayerPose | null = null;
  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private hits = 0;
  private misses = 0;
  private time = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // 8.5% of the short side: a ~120 px wide mole on a 1280x720 view.
    this.moleR = Math.min(ctx.view.w, ctx.view.h) * 0.085;
    this.spawner = new Spawner(
      { startInterval: 0.9, endInterval: 0.55, jitter: 0.3, burstLate: 1 },
      ctx.rng,
      manifest.durationMs / 1000,
    );
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.audio.music({ bpm: 118 });
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    const p = f.p1;
    this.player = p ?? null;
    for (let k = 0; k < LIMBS; k++) {
      if (this.limbCd[k]! > 0) this.limbCd[k] = this.limbCd[k]! - dt;
    }

    if (p) {
      for (let i = 0, k = this.spawner.tick(dt); i < k; i++) this.spawnMole(p);
    }
    this.moles.step(dt);
    if (p) {
      this.readLimbs(p);
      this.resolveTouches();
    }
    for (let i = this.moles.n - 1; i >= 0; i--) {
      // Timed out un-hit: a quiet miss — the combo breaks, nothing else.
      if (this.moles.life[i]! <= 0 && this.moles.kind[i] === MOLE) {
        this.misses++;
        if (this.combo > 0) {
          this.combo = 0;
          this.ctx.hud.setCombo(0);
        }
      }
    }
    this.moles.sweep();
  }

  private readLimbs(p: PlayerPose): void {
    const okL = p.vis[L.LEFT_WRIST]! >= MIN_VIS;
    const okR = p.vis[L.RIGHT_WRIST]! >= MIN_VIS;
    this.limbOk[0] = okL ? 1 : 0;
    this.limbOk[1] = okR ? 1 : 0;
    if (okL) palm(p, 'L', this.limb[0]!);
    if (okR) palm(p, 'R', this.limb[1]!);
    const kl = p.vis[L.LEFT_KNEE]! >= MIN_VIS && p.vis[L.LEFT_HIP]! >= MIN_VIS;
    const kr = p.vis[L.RIGHT_KNEE]! >= MIN_VIS && p.vis[L.RIGHT_HIP]! >= MIN_VIS;
    this.limbOk[2] = kl ? 1 : 0;
    this.limbOk[3] = kr ? 1 : 0;
    if (kl) jointPx(p, L.LEFT_KNEE, this.limb[2]!);
    if (kr) jointPx(p, L.RIGHT_KNEE, this.limb[3]!);
  }

  private resolveTouches(): void {
    for (let i = this.moles.n - 1; i >= 0; i--) {
      if (this.moles.life[i]! <= 0) continue;
      const cell = this.moles.data[i]!;
      const knee = cell >= HAND_CELLS;
      const first = knee ? 2 : 0;
      const rad = this.moles.spin[i]!;
      const mx = this.moles.x[i]!;
      const my = this.moles.y[i]!;
      let by = -1;
      for (let k = first; k < first + 2; k++) {
        if (this.limbOk[k] === 0 || this.limbCd[k]! > 0) continue;
        const pt = this.limb[k]!;
        if (dist(pt.x, pt.y, mx, my) <= rad) { by = k; break; }
      }
      if (by < 0) { this.moles.hp[i] = 0; continue; }
      // A touch must hold for two frames: one noisy landmark frame is not a hit.
      const n = this.moles.hp[i]! + 1;
      this.moles.hp[i] = n;
      if (n >= CONFIRM) {
        this.limbCd[by] = HIT_CD;
        this.resolve(i);
      }
    }
  }

  private spawnMole(p: PlayerPose): void {
    if (this.moles.n >= 2) return;
    const d = this.spawner.difficulty;
    let thigh = 0;
    if (p.calib.lowerBodyVisible && p.scalePx >= MIN_SW_FOR_KNEES * this.ctx.view.w
      && p.vis[L.LEFT_KNEE]! >= MIN_VIS && p.vis[L.RIGHT_KNEE]! >= MIN_VIS
      && p.vis[L.LEFT_HIP]! >= MIN_VIS && p.vis[L.RIGHT_HIP]! >= MIN_VIS) {
      // The lower knee is the planted one: its drop below the hip is one thigh.
      const dl = p.px[L.LEFT_KNEE * 2 + 1]! - p.px[L.LEFT_HIP * 2 + 1]!;
      const dr = p.px[L.RIGHT_KNEE * 2 + 1]! - p.px[L.RIGHT_HIP * 2 + 1]!;
      thigh = Math.max(dl, dr) / p.scalePx;
    }
    const kneesOk = thigh >= MIN_THIGH;
    const knee = kneesOk && chance(this.ctx.rng, 0.3);
    let cell = -1;
    for (let attempt = 0; attempt < 6 && cell < 0; attempt++) {
      let c: number;
      if (knee) {
        this.lastKneeSide = 1 - this.lastKneeSide;
        c = HAND_CELLS + this.lastKneeSide;
      } else {
        c = Math.floor(this.ctx.rng() * HAND_CELLS);
      }
      if (this.cellFree(c)) cell = c;
    }
    if (cell < 0) return;

    const gold = !knee && d > 0.6 && chance(this.ctx.rng, 0.1);
    const bomb = !knee && !gold && d > 0.25 && chance(this.ctx.rng, 0.14);
    const kind = gold ? GOLD : bomb ? BOMB : MOLE;
    const life = gold ? 2.2 : lerp(knee ? 2.0 : 1.7, knee ? 1.3 : 1.0, d);

    const sw = p.scalePx; 
    let x = 0;
    let y = 0;
    if (cell >= HAND_CELLS) {
      hipPx(p, this.hip);
      x = this.hip.x + (cell === HAND_CELLS ? -KNEE_DX : KNEE_DX) * sw;
      y = this.hip.y + KNEE_DY_FRAC * thigh * sw;
    } else {
      shoulderPx(p, this.sh);
      const armLen = p.calib.armLen > 0.5 ? p.calib.armLen : FALLBACK_ARM_LEN;
      let reach = (armLen + PALM_EXT) * REACH_FRAC * sw;
      const a = ((FAN_DEG[cell]! + randRange(this.ctx.rng, -6, 6)) * Math.PI) / 180;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const { w, h } = this.ctx.view;
      const m = this.moleR * 1.2;
      // Off the edge of the view: pull the mole in along the same ray from the
      // shoulder, so it stays somewhere this arm can point at.
      for (let k = 0; k < 8; k++) {
        x = this.sh.x + ca * reach;
        y = this.sh.y - sa * reach;
        if (x >= m && x <= w - m && y >= m && y <= h - m) break;
        reach *= 0.88;
      }
    }
    const m2 = this.moleR * 1.2;
    x = clamp(x, m2, this.ctx.view.w - m2);
    y = clamp(y, m2, this.ctx.view.h - m2);
    const i = this.moles.spawn(x, y, 0, 0, this.moleR, life, kind, 0);
    if (i >= 0) {
      this.moles.data[i] = cell;
      // Hit radius in px, fixed for this mole's life.
      this.moles.spin[i] = cell >= HAND_CELLS ? KNEE_HIT_FRAC * thigh * sw : this.moleR * 1.15;
    }
  }

  private cellFree(c: number): boolean {
    for (let i = 0; i < this.moles.n; i++) if (this.moles.data[i] === c) return false;
    return true;
  }

  private resolve(i: number): void {
    const kind = this.moles.kind[i]!;
    const x = this.moles.x[i]!;
    const y = this.moles.y[i]!;
    this.moles.kill(i);

    if (kind === BOMB) {
      // Quiet: the combo breaks and a soft puff, no score loss, no red.
      if (this.combo > 0) {
        this.combo = 0;
        this.ctx.hud.setCombo(0);
      }
      this.ctx.audio.play('miss', { gain: 0.4 });
      this.ctx.fx.miss(x, y);
      this.ctx.emit({ kind: 'miss' });
      return;
    }

    this.hits++;
    this.combo++;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    const points = kind === GOLD ? 30 : 10 + Math.min(Math.floor(this.combo / 5), 4) * 2;
    this.score += points;

    this.ctx.fx.impact(x, y, kind === GOLD ? 'big' : 'hit', {
      color: kind === GOLD ? C.accent : C.success,
      sprite: kind === GOLD ? 'star' : 'sparkle',
      label: LABEL[points]!,
    });
    this.ctx.audio.playLadder('pop', this.combo);
    if (kind === GOLD) {
      this.ctx.hud.toast(t('gold'), { color: C.accent, big: true });
      this.ctx.audio.play('bonus');
    } else if (this.combo % 5 === 0) {
      this.ctx.audio.play('combo.up');
      this.ctx.hud.toast(this.combo >= 10 ? t('wow') : t('nice'), { color: C.accent });
    }
    this.ctx.hud.setScore(this.score);
    this.ctx.hud.setCombo(this.combo);
    this.ctx.emit({ kind: 'scored', points });
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);
    if (this.player) g.ghostBody(this.player, 0.12);
    if (this.player) g.skeleton(this.player, { alpha: 0.55, emphasize: EMPHASIZE });

    for (let i = 0; i < this.moles.n; i++) {
      const x = this.moles.x[i]!;
      const y = this.moles.y[i]!;
      const r = this.moles.r[i]!;
      const kind = this.moles.kind[i]!;
      const age = this.moles.age(i);
      const grow = age < 0.14 ? easeOutBack(age / 0.14) : 1;
      const rr = r * grow;

      // The hole it pops out of.
      g.roundRect(x - rr * 1.15, y + rr * 0.45, rr * 2.3, rr * 0.7, rr * 0.35, { fill: hue(26, 35, 20, 0.55) });

      if (kind === BOMB) {
        const fuse = this.time * 9;
        g.circle(x, y, rr * 0.95, { fill: hue(236, 30, 26), stroke: KEYLINE, sw: 4 * g.s });
        g.circle(x - rr * 0.3, y - rr * 0.3, rr * 0.2, { fill: hue(236, 20, 60) });
        g.line(x + rr * 0.35, y - rr * 0.8, x + rr * 0.6, y - rr * 1.2, 5 * g.s, { stroke: KEYLINE });
        g.sprite('burst', x + rr * 0.62, y - rr * 1.25, rr * (0.5 + 0.12 * Math.sin(fuse)), { rot: fuse * 0.3 });
        continue;
      }

      const gold = kind === GOLD;
      const th = gold ? 42 : 26;
      g.circle(x - rr * 0.62, y - rr * 0.62, rr * 0.3, { fill: hue(th, 60, 34), stroke: KEYLINE, sw: 3 * g.s });
      g.circle(x + rr * 0.62, y - rr * 0.62, rr * 0.3, { fill: hue(th, 60, 34), stroke: KEYLINE, sw: 3 * g.s });
      g.sprite('circle', x, y, rr * 2.1, { hue: th });
      // Snout and eyes only — a creature you chase never gets a mouth.
      g.circle(x, y + rr * 0.22, rr * 0.42, { fill: hue(th, 70, 78) });
      g.circle(x, y + rr * 0.06, rr * 0.15, { fill: C.hot });
      g.circle(x - rr * 0.36, y - rr * 0.2, rr * 0.16, { fill: C.white });
      g.circle(x + rr * 0.36, y - rr * 0.2, rr * 0.16, { fill: C.white });
      g.circle(x - rr * 0.34, y - rr * 0.18, rr * 0.08, { fill: C.ink });
      g.circle(x + rr * 0.34, y - rr * 0.18, rr * 0.08, { fill: C.ink });
      if (gold) {
        g.circle(x, y, rr * 1.35 * (0.9 + 0.1 * pulse(clamp01((this.time * 2) % 1))), {
          stroke: C.accent, sw: 4 * g.s, glow: 10,
        });
        g.sprite('star', x, y - rr * 1.3, rr * 0.7, { rot: this.time });
      }
    }
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.bestCombo >= 8) highlights.push(`콤보 ${this.bestCombo}연속!`);
    if (this.hits >= 15) highlights.push(`두더지 ${this.hits}마리 잡았어요`);
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
    this.moles.clear();
  }
}

export default (): MiniGame => new AirWhackMole();

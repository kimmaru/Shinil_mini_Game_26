// ─── SHAPE A — discrete trigger x screen-space joints x hit test ─────────────
//
// A 3-column x 2-row grid of holes. The top row is hand territory (reach
// palms, speed-gated); the bottom row is knee territory (a rented `zone`
// detector per cell). Forcing both halves of the body into one game is the
// whole point (see the brief in docs — this is the one game in the wave that
// must not be playable with hands alone).
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Renderer,
} from '@/engine/types';
import { L } from '@/engine/pose/landmarks';
import { clamp01, dist, easeOutBack, lerp, pulse } from '@/engine/math';
import { Entities } from '@/engine/entities';
import { chance, Spawner } from '@/engine/spawn';
import { C, fade } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

const MOLE = 0;
const BOMB = 1;
const GOLD = 2;
/** Sentinel written into `kind` the instant a mole is resolved by a hit, so
 *  the sweep's natural-expiry callback does not also count it as a miss. */
const RESOLVED = -1;

const COLS = 3;
/** Cell index 0-2 = top row (hand), 3-5 = bottom row (knee). */
const CELLS = 6;
const CELL_X = [0.22, 0.5, 0.78] as const;
const TOP_Y = 0.36;
const BOTTOM_Y = 0.72;

const KNEES = [L.LEFT_KNEE, L.RIGHT_KNEE] as const;
// Pre-built once at module scope — render() must not allocate, so the
// skeleton's emphasized-joint list cannot be assembled with a spread there.
const EMPHASIZE = [L.LEFT_WRIST, L.RIGHT_WRIST, L.LEFT_KNEE, L.RIGHT_KNEE] as const;

class AirWhackMole implements MiniGame {
  private ctx!: GameContext;
  private reach!: Detector<'reach'>;
  private readonly footZones: Detector<'zone'>[] = [];
  private spawner!: Spawner;

  private readonly moles = new Entities(8);
  // Cell geometry, computed once in init() from the view and never touched
  // again in update()/render().
  private readonly cellPxX = new Float32Array(CELLS);
  private readonly cellPxY = new Float32Array(CELLS);
  private holeR = 0;
  private handGate = 0;
  /** Consecutive-frame confirm counters for the 3 hand cells — the "noise
   *  removal" the brief calls for. The knee cells get the same debounce for
   *  free from the rented zone detectors' own confirmFrames. */
  private readonly topConfirm = new Uint8Array(COLS);

  private player: PlayerPose | null = null;
  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private hits = 0;
  private misses = 0;
  private time = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    const { w, h } = ctx.view;
    this.holeR = Math.min(w, h) * 0.15;
    // A resting hand must not farm holes: it has to actually be moving in.
    // Same fraction-of-view-size gate candy-rain-catch uses for its catchers.
    this.handGate = Math.min(w, h) * 0.22;

    for (let c = 0; c < CELLS; c++) {
      this.cellPxX[c] = CELL_X[c % COLS]! * w;
      this.cellPxY[c] = (c < COLS ? TOP_Y : BOTTOM_Y) * h;
    }

    const rx = this.holeR / w;
    const ry = this.holeR / h;
    for (let c = 0; c < COLS; c++) {
      const fx = CELL_X[c]!;
      this.footZones.push(
        ctx.gestures.use('zone', {
          x: fx - rx, y: BOTTOM_Y - ry, w: rx * 2, h: ry * 2,
          joints: KNEES,
          confirmFrames: 2,
          margin: 0.18,
        }),
      );
    }
    this.reach = ctx.gestures.use('reach', { side: 'both' });

    this.spawner = new Spawner(
      { startInterval: 0.75, endInterval: 0.42, jitter: 0.3, burstLate: 1 },
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
    for (let i = 0, k = this.spawner.tick(dt); i < k; i++) this.spawnMole();
    this.moles.step(dt);

    const p = f.p1;
    this.player = p ?? null;
    if (p) {
      const r = this.reach.read(f);
      this.resolveHands(r.leftPalm.x, r.leftPalm.y, r.leftSpeed, r.rightPalm.x, r.rightPalm.y, r.rightSpeed);
      for (let c = 0; c < COLS; c++) {
        const z = this.footZones[c]!.read(f);
        if (z.entered) this.resolveCell(c + COLS, this.cellPxX[c + COLS]!, this.cellPxY[c + COLS]!);
      }
    } else {
      this.topConfirm[0] = 0; this.topConfirm[1] = 0; this.topConfirm[2] = 0;
    }

    this.moles.sweep((i) => {
      // Only a mole that timed out un-hit counts as a quiet miss. A mole the
      // player already resolved was marked RESOLVED before kill() and must
      // not be double-counted here.
      if (this.moles.kind[i] === MOLE) this.misses++;
    });
  }

  private resolveHands(
    lx: number, ly: number, lSpeed: number,
    rx: number, ry: number, rSpeed: number,
  ): void {
    const fastL = lSpeed > this.handGate;
    const fastR = rSpeed > this.handGate;
    for (let c = 0; c < COLS; c++) {
      const cx = this.cellPxX[c]!;
      const cy = this.cellPxY[c]!;
      const hitL = fastL && dist(lx, ly, cx, cy) <= this.holeR;
      const hitR = fastR && dist(rx, ry, cx, cy) <= this.holeR;
      if (hitL || hitR) {
        const n = this.topConfirm[c]! + 1;
        this.topConfirm[c] = n > 2 ? 2 : n;
      } else {
        this.topConfirm[c] = 0;
      }
      if (this.topConfirm[c]! >= 2) {
        this.topConfirm[c] = 0;
        this.resolveCell(c, cx, cy);
      }
    }
  }

  /** Pick an unoccupied cell. A handful of rejection-sampled attempts rather
   *  than building a free-list — CELLS is 6, so this never allocates and
   *  rarely loops more than once. */
  private spawnMole(): void {
    if (this.moles.n >= 2) return;
    for (let attempt = 0; attempt < 6; attempt++) {
      const c = Math.floor(this.ctx.rng() * CELLS);
      if (this.cellFree(c)) {
        this.doSpawn(c);
        return;
      }
    }
  }

  private cellFree(c: number): boolean {
    for (let i = 0; i < this.moles.n; i++) if (this.moles.data[i] === c) return false;
    return true;
  }

  private doSpawn(c: number): void {
    const d = this.spawner.difficulty;
    const gold = d > 0.72 && chance(this.ctx.rng, 0.12);
    const bomb = !gold && chance(this.ctx.rng, 0.16);
    const kind = gold ? GOLD : bomb ? BOMB : MOLE;
    // Golden moles get a generous 2s window — a breather and a big reward,
    // not another thing to react to in 0.5s. Regular moles ramp 1.2s -> 0.5s.
    const life = gold ? 2.0 : lerp(1.2, 0.5, d);
    const r = this.holeR * (gold ? 0.72 : 0.64);
    const i = this.moles.spawn(this.cellPxX[c]!, this.cellPxY[c]!, 0, 0, r, life, kind);
    if (i >= 0) this.moles.data[i] = c;
  }

  private resolveCell(cellIdx: number, atX: number, atY: number): void {
    let found = -1;
    for (let i = 0; i < this.moles.n; i++) {
      if (this.moles.data[i] === cellIdx) { found = i; break; }
    }
    if (found < 0) return; // swung at an empty hole — not a miss, just air

    const kind = this.moles.kind[found]!;
    const x = this.moles.x[found]!;
    const y = this.moles.y[found]!;
    this.moles.kind[found] = RESOLVED;
    this.moles.kill(found);

    if (kind === BOMB) {
      this.combo = 0;
      this.score = Math.max(0, this.score - 5);
      this.ctx.hud.setCombo(0);
      this.ctx.hud.setScore(this.score);
      this.ctx.hud.toast(t('bomb'), { color: C.warn });
      this.ctx.audio.play('miss', { gain: 0.55 });
      this.ctx.fx.miss(x, y);
      this.ctx.emit({ kind: 'miss' });
      return;
    }

    this.hits++;
    this.combo++;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    const points = kind === GOLD ? 30 : 10 + Math.floor(this.combo / 4) * 2;
    this.score += points;

    this.ctx.fx.impact(atX, atY, kind === GOLD ? 'big' : 'hit', {
      color: kind === GOLD ? C.accent : C.success,
      sprite: 'sparkle',
      label: `+${points}`,
    });
    this.ctx.audio.playLadder('pop', this.combo);
    if (kind === GOLD) {
      this.ctx.hud.toast(t('gold'), { color: C.accent, big: true });
      this.ctx.audio.play('bonus');
    } else if (this.combo > 0 && this.combo % 4 === 0) {
      this.ctx.audio.play('combo.up');
      this.ctx.hud.toast(this.combo >= 8 ? t('wow') : t('nice'), { color: C.accent });
    }
    this.ctx.hud.setScore(this.score);
    this.ctx.hud.setCombo(this.combo);
    this.ctx.emit({ kind: 'scored', points });
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    for (let c = 0; c < CELLS; c++) {
      const x = this.cellPxX[c]!;
      const y = this.cellPxY[c]!;
      g.circle(x, y, this.holeR, { fill: fade(C.ink, 0.16) });
      g.circle(x, y, this.holeR, { stroke: fade(C.ink, 0.3), sw: 3 * g.s });
    }

    if (this.player) g.ghostBody(this.player, 0.1);
    if (this.player) g.skeleton(this.player, { alpha: 0.45, emphasize: EMPHASIZE });

    for (let i = 0; i < this.moles.n; i++) {
      const x = this.moles.x[i]!;
      const y = this.moles.y[i]!;
      const r = this.moles.r[i]!;
      const kind = this.moles.kind[i]!;
      const age = this.moles.age(i);
      const grow = age < 0.12 ? easeOutBack(age / 0.12) : 1;
      const size = r * 2.1 * grow;
      if (kind === BOMB) {
        g.sprite('rock', x, y, size);
      } else {
        const hue = kind === GOLD ? 42 : manifest.theme?.hue ?? 92;
        g.sprite('circle', x, y, size, { hue });
        // Eyes only — a creature you chase, never a mouth (ART.md 2.5).
        const er = 4 * g.s * grow;
        g.circle(x - r * 0.3, y - r * 0.15, er, { fill: C.ink });
        g.circle(x + r * 0.3, y - r * 0.15, er, { fill: C.ink });
        if (kind === GOLD) {
          g.circle(x, y, r * 1.35 * pulse(1 - clamp01(age)), {
            stroke: fade(C.accent, 0.6), sw: 3 * g.s,
          });
        }
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

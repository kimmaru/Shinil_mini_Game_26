// ─── SHAPE A reference structure, whole-body hit test ────────────────────────
//
// There is no discrete gesture here: the brief for this game is explicitly
// "any of the 33 landmarks OR any bone segment touching a balloon pops it",
// which is this game's identity (elbows and knees count, not just hands). The
// lifecycle, Entities/Spawner usage and juice calls still follow the
// mosquito-clap skeleton; only the hit test itself is whole-body overlap
// instead of a rented trigger, same as candy-rain-catch's per-frame
// `resolveCatches()` — a one-shot kill-on-contact entity needs no detector or
// cooldown, because a dead entity cannot be scored twice.
import type {
  EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Renderer, SfxId,
} from '@/engine/types';
import { LANDMARK_COUNT, MIN_VIS, POSE_EDGES } from '@/engine/pose/landmarks';
import { distSegPoint, hitCircle, TAU } from '@/engine/math';
import { Entities } from '@/engine/entities';
import { chance, randRange, Spawner } from '@/engine/spawn';
import { C, snapHue } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

const NORMAL = 0;
const SPIKE = 1;

/** Cycles through a little scale as balloons pop — enough pops and it reads
 *  as a melody, per the brief. Deliberately not `playLadder`: that ladder is
 *  combo-driven, and this game has no combo mechanic to drive it with. */
const NOTES: readonly SfxId[] = ['note.c', 'note.d', 'note.e', 'note.f', 'note.g', 'note.a', 'note.b'];

/** A balloon this young before its grow-in animation finishes cannot be
 *  popped yet — otherwise one spawning mid-body on a standing-still child
 *  scores for free the instant it exists. */
const MIN_AGE = 0.15;

class BalloonPopParty implements MiniGame {
  private ctx!: GameContext;
  private spawner!: Spawner;

  private readonly balloons = new Entities(44);
  private ballR = 0;
  private player: PlayerPose | null = null;

  private score = 0;
  private comboNoSpike = 0;
  private bestCombo = 0;
  private noteIdx = 0;
  private time = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // 4.5% of view width per balloon: smaller than a single precision target
    // would be, but the real hit area is the player's whole moving silhouette
    // through a packed field, which is far more generous in aggregate.
    this.ballR = ctx.view.w * 0.045;
    this.spawner = new Spawner(
      { startInterval: 0.55, endInterval: 0.22, jitter: 0.3, burstMid: 2, burstLate: 3 },
      ctx.rng,
      manifest.durationMs / 1000,
    );
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.audio.music({ bpm: 112 });
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    for (let i = 0, k = this.spawner.tick(dt); i < k; i++) this.spawnBalloon();
    this.balloons.step(dt);
    this.balloons.cullOutside(-200, -400, this.ctx.view.w + 200, this.ctx.view.h + 200);

    const p = f.p1;
    this.player = p ?? null;
    if (p) this.checkTouches(p);

    this.balloons.sweep();
  }

  private checkTouches(p: PlayerPose): void {
    for (let i = this.balloons.n - 1; i >= 0; i--) {
      if (this.balloons.age(i) < MIN_AGE) continue;
      const bx = this.balloons.x[i]!;
      const by = this.balloons.y[i]!;
      const br = this.balloons.r[i]!;
      let hit = false;
      for (let j = 0; j < LANDMARK_COUNT; j++) {
        if (p.vis[j]! < MIN_VIS) continue;
        if (hitCircle(p.px[j * 2]!, p.px[j * 2 + 1]!, bx, by, br)) { hit = true; break; }
      }
      if (!hit) {
        for (let e = 0; e < POSE_EDGES.length; e++) {
          const a = POSE_EDGES[e]![0];
          const b = POSE_EDGES[e]![1];
          if (p.vis[a]! < MIN_VIS || p.vis[b]! < MIN_VIS) continue;
          if (distSegPoint(p.px[a * 2]!, p.px[a * 2 + 1]!, p.px[b * 2]!, p.px[b * 2 + 1]!, bx, by) <= br) {
            hit = true;
            break;
          }
        }
      }
      if (hit) this.resolvePop(i, bx, by);
    }
  }

  private spawnBalloon(): void {
    const { w, h } = this.ctx.view;
    const d = this.spawner.difficulty;
    const spike = d > 0.6 && chance(this.ctx.rng, 0.12);
    const x = randRange(this.ctx.rng, w * 0.08, w * 0.92);
    // Starts just below the frame and floats up through it, rather than
    // spawning already overlapping whatever is standing in the middle.
    const y = h * 1.08;
    const vy = -randRange(this.ctx.rng, 55, 95) * (1 + d * 0.35);
    const vx = randRange(this.ctx.rng, -16, 16);
    const i = this.balloons.spawn(x, y, vx, vy, this.ballR, 9, spike ? SPIKE : NORMAL);
    if (i >= 0) {
      this.balloons.data[i] = snapHue(randRange(this.ctx.rng, 0, 360));
      this.balloons.spin[i] = randRange(this.ctx.rng, -0.5, 0.5);
    }
  }

  private resolvePop(i: number, x: number, y: number): void {
    const kind = this.balloons.kind[i]!;
    this.balloons.kill(i);

    if (kind === SPIKE) {
      this.comboNoSpike = 0;
      this.ctx.hud.toast(t('spike'), { color: C.warn });
      this.ctx.audio.play('miss', { gain: 0.4 });
      this.ctx.fx.miss(x, y);
      this.ctx.emit({ kind: 'miss' });
      return;
    }

    this.score++;
    this.comboNoSpike++;
    if (this.comboNoSpike > this.bestCombo) this.bestCombo = this.comboNoSpike;

    this.ctx.audio.play(NOTES[this.noteIdx]!, { gain: 0.5 });
    this.noteIdx = (this.noteIdx + 1) % NOTES.length;
    this.ctx.fx.impact(x, y, 'tap', { color: C.success, sprite: 'sparkle' });
    this.ctx.hud.setScore(this.score);
    this.ctx.emit({ kind: 'scored', points: 1 });
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    for (let i = 0; i < this.balloons.n; i++) {
      const x = this.balloons.x[i]!;
      const y = this.balloons.y[i]!;
      const r = this.balloons.r[i]!;
      const kind = this.balloons.kind[i]!;
      const hue = this.balloons.data[i]!;
      const age = this.balloons.age(i);
      const grow = age < MIN_AGE ? age / MIN_AGE : 1;
      const size = r * 2.3 * grow;
      g.sprite('balloon', x, y, size, { rot: this.balloons.rot[i]!, hue });
      if (kind === SPIKE) {
        for (let s = 0; s < 6; s++) {
          const a = (s / 6) * TAU + this.time * 0.6;
          const x0 = x + Math.cos(a) * r * 0.95;
          const y0 = y + Math.sin(a) * r * 0.95;
          const x1 = x + Math.cos(a) * r * 1.4;
          const y1 = y + Math.sin(a) * r * 1.4;
          g.line(x0, y0, x1, y1, 3 * g.s, { stroke: C.danger });
        }
      }
    }

    if (this.player) g.ghostBody(this.player, 0.1);
    // No single joint matters more than another here, so nothing is
    // emphasized — the whole body is the hit zone.
    if (this.player) g.skeleton(this.player, { alpha: 0.5 });
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.score >= 25) highlights.push(`풍선 ${this.score}개 터뜨렸어요`);
    if (this.bestCombo >= 15) highlights.push('가시 풍선을 쏙쏙 피했어요!');
    return {
      gameId: manifest.id,
      cleared: this.score > 0,
      rawScore: this.score,
      maxScore: manifest.scoring.maxScore,
      normalized: 0,
      stars: 0,
      durationMs: manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score: this.score,
        hits: this.score, misses: 0, bestCombo: this.bestCombo,
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }

  dispose(): void {
    this.ctx.audio.stopMusic();
    this.balloons.clear();
  }
}

export default (): MiniGame => new BalloonPopParty();

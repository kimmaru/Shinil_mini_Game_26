// ─── SHAPE B-ish — whole-body overlap, gated on motion ───────────────────────
//
// Balloons float up through the room; any visible landmark or bone that MOVES
// into one pops it. "Moves" matters: a child standing still must not collect
// balloons that happen to drift through their torso, so a joint only counts
// while its own filtered speed (shoulder-widths/sec) is above a small gate.
// Balloons are mostly placed within this child's own arm reach of their body
// (a fifth go anywhere, so stepping is rewarded but never required). A pop is
// a one-shot kill, so it cannot score twice.
import type {
  EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer, SfxId,
} from '@/engine/types';
import { L, LANDMARK_COUNT, MIN_VIS, POSE_EDGES, shoulderPx } from '@/engine/pose/landmarks';
import { clamp, distSegPoint, hitCircle } from '@/engine/math';
import { Entities } from '@/engine/entities';
import { chance, randRange, Spawner } from '@/engine/spawn';
import { C, KEYLINE, THEME_HUES, fade, hue, snapHue } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

const NORMAL = 0;
const SPIKE = 1;

/** Climbing a musical scale as balloons pop reads as a melody. */
const NOTES: readonly SfxId[] = ['note.c', 'note.d', 'note.e', 'note.f', 'note.g', 'note.a', 'note.b'];

/** Seconds a balloon is too young to pop (its grow-in animation). */
const MIN_AGE = 0.15;
/** A joint only counts while it is clearly moving: its filtered speed must be
 *  above SPEED_GATE (shoulder-widths/sec) for CONFIRM frames running, AND it
 *  must have travelled MOVE_GATE shoulder-widths over the last HIST frames.
 *  Either test alone leaks on a distant child, whose sensor jitter is large in
 *  shoulder-widths; jitter that is both fast and net-travelling is rare. */
const SPEED_GATE = 1.8;
const CONFIRM = 2;
const MOVE_GATE = 0.3;
/** Sensor jitter is roughly constant in view pixels, so on a distant child it
 *  is large in shoulder-widths. The travel gate therefore never drops below
 *  this fraction of the view width, however small the child is. */
const MOVE_FLOOR = 0.045;
const HIST = 8;
/** Every Nth pop in a row is a loud party moment worth a bonus. */
const MILESTONE = 10;
const BONUS = 5;

const FALLBACK_ARM_LEN = 1.6;
const HANDS_FEET = [
  L.LEFT_WRIST, L.RIGHT_WRIST, L.LEFT_ANKLE, L.RIGHT_ANKLE,
] as const;

class BalloonPopParty implements MiniGame {
  private ctx!: GameContext;
  private spawner!: Spawner;

  private readonly balloons = new Entities(44);
  private readonly sh: Pt = { x: 0, y: 0 };
  /** Per-frame: 1 where the joint is visible AND has travelled far enough lately. */
  private readonly active = new Uint8Array(LANDMARK_COUNT);
  private readonly hist = new Float32Array(HIST * LANDMARK_COUNT * 2);
  private readonly run = new Uint8Array(LANDMARK_COUNT);
  private histHead = 0;
  private histFill = 0;
  private ballR = 0;
  private vScale = 1;
  private player: PlayerPose | null = null;

  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private pops = 0;
  private noteIdx = 0;
  private time = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // 5.2% of view width: a ~133 px balloon on a 1280-wide view.
    this.ballR = ctx.view.w * 0.052;
    this.vScale = ctx.view.h / 720;
    this.spawner = new Spawner(
      { startInterval: 0.6, endInterval: 0.3, jitter: 0.3, burstMid: 1, burstLate: 2 },
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
    const p = f.p1;
    this.player = p ?? null;
    for (let i = 0, k = this.spawner.tick(dt); i < k; i++) this.spawnBalloon(p);
    this.balloons.step(dt);
    this.balloons.cullOutside(-200, -400, this.ctx.view.w + 200, this.ctx.view.h + 200);
    if (p) this.checkTouches(p);
    else this.histFill = 0;
    this.balloons.sweep();
  }

  private checkTouches(p: PlayerPose): void {
    const act = this.active;
    const slot = this.histHead * LANDMARK_COUNT * 2;
    const gate = Math.max(MOVE_GATE * p.scalePx, MOVE_FLOOR * this.ctx.view.w);
    const warm = this.histFill >= HIST;
    for (let j = 0; j < LANDMARK_COUNT; j++) {
      const x = p.px[j * 2]!;
      const y = p.px[j * 2 + 1]!;
      // slot currently holds the sample from HIST frames ago.
      const ox = this.hist[slot + j * 2]!;
      const oy = this.hist[slot + j * 2 + 1]!;
      const fast = Math.hypot(p.v[j * 2]!, p.v[j * 2 + 1]!) > SPEED_GATE;
      this.run[j] = fast ? Math.min(this.run[j]! + 1, CONFIRM) : 0;
      act[j] = warm && this.run[j]! >= CONFIRM && p.vis[j]! >= MIN_VIS && Math.hypot(x - ox, y - oy) > gate ? 1 : 0;
      this.hist[slot + j * 2] = x;
      this.hist[slot + j * 2 + 1] = y;
    }
    this.histHead = (this.histHead + 1) % HIST;
    if (this.histFill < HIST) this.histFill++;
    for (let i = this.balloons.n - 1; i >= 0; i--) {
      if (this.balloons.life[i]! <= 0 || this.balloons.age(i) < MIN_AGE) continue;
      const bx = this.balloons.x[i]!;
      const by = this.balloons.y[i]!;
      const br = this.balloons.r[i]!;
      let hit = false;
      for (let j = 0; j < LANDMARK_COUNT && !hit; j++) {
        if (act[j] === 1 && hitCircle(p.px[j * 2]!, p.px[j * 2 + 1]!, bx, by, br)) hit = true;
      }
      for (let e = 0; e < POSE_EDGES.length && !hit; e++) {
        const a = POSE_EDGES[e]![0];
        const b = POSE_EDGES[e]![1];
        if ((act[a] === 0 && act[b] === 0) || p.vis[a]! < MIN_VIS || p.vis[b]! < MIN_VIS) continue;
        if (distSegPoint(p.px[a * 2]!, p.px[a * 2 + 1]!, p.px[b * 2]!, p.px[b * 2 + 1]!, bx, by) <= br) hit = true;
      }
      if (hit) this.resolvePop(i, bx, by);
    }
  }

  private spawnBalloon(p: PlayerPose | undefined): void {
    const { w, h } = this.ctx.view;
    const d = this.spawner.difficulty;
    const spike = d > 0.5 && chance(this.ctx.rng, 0.12);
    let x: number;
    if (p && chance(this.ctx.rng, 0.8)) {
      // Within this child's own arm reach of their body centre.
      shoulderPx(p, this.sh);
      const armLen = p.calib.armLen > 0.5 ? p.calib.armLen : FALLBACK_ARM_LEN;
      const span = clamp((armLen + 0.4) * p.scalePx * 1.4, w * 0.16, w * 0.4);
      x = this.sh.x + randRange(this.ctx.rng, -span, span);
    } else {
      x = randRange(this.ctx.rng, w * 0.08, w * 0.92);
    }
    x = clamp(x, w * 0.06, w * 0.94);
    // Starts just below the frame and floats up through it.
    const y = h + this.ballR * 1.4;
    const vy = -randRange(this.ctx.rng, 85, 130) * this.vScale * (1 + d * 0.3);
    const i = this.balloons.spawn(x, y, 0, vy, this.ballR, 12, spike ? SPIKE : NORMAL);
    if (i >= 0) this.balloons.data[i] = snapHue(randRange(this.ctx.rng, 0, 360));
  }

  private resolvePop(i: number, x: number, y: number): void {
    const kind = this.balloons.kind[i]!;
    const bh = this.balloons.data[i]!;
    this.balloons.kill(i);

    if (kind === SPIKE) {
      // Quiet: the combo breaks, a soft puff, nothing else.
      if (this.combo > 0) {
        this.combo = 0;
        this.ctx.hud.setCombo(0);
      }
      this.ctx.audio.play('miss', { gain: 0.35 });
      this.ctx.fx.miss(x, y);
      this.ctx.emit({ kind: 'miss' });
      return;
    }

    this.pops++;
    this.combo++;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    this.score++;
    const milestone = this.combo % MILESTONE === 0;
    if (milestone) this.score += BONUS;

    this.ctx.audio.play(NOTES[this.noteIdx]!, { gain: 0.55 });
    this.noteIdx = (this.noteIdx + 1) % NOTES.length;
    this.ctx.fx.impact(x, y, milestone ? 'big' : 'hit', {
      color: hue(bh), sprite: milestone ? 'star' : 'sparkle',
    });
    if (milestone) {
      this.ctx.audio.play('combo.up');
      this.ctx.hud.toast(t('party'), { color: C.accent, big: true });
    }
    this.ctx.hud.setScore(this.score);
    this.ctx.hud.setCombo(this.combo);
    this.ctx.emit({ kind: 'scored', points: milestone ? 1 + BONUS : 1 });
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);
    this.drawBunting(g);

    if (this.player) g.ghostBody(this.player, 0.1);
    if (this.player) g.skeleton(this.player, { alpha: 0.55, emphasize: HANDS_FEET });

    for (let i = 0; i < this.balloons.n; i++) {
      const r = this.balloons.r[i]!;
      const kind = this.balloons.kind[i]!;
      const age = this.balloons.age(i);
      const grow = age < MIN_AGE ? 0.86 + 0.14 * (age / MIN_AGE) : 1;
      const ph = this.balloons.id[i]! * 1.7;
      const sway = Math.sin(this.time * 1.6 + ph);
      const x = this.balloons.x[i]! + sway * 8 * g.s;
      const y = this.balloons.y[i]!;
      if (kind === SPIKE) {
        // A spiky mine, not a balloon: shape alone says "keep away".
        g.star(x, y, r * 1.5 * grow, 9, { fill: hue(236, 30, 28), stroke: KEYLINE, sw: 4 * g.s });
        g.circle(x, y, r * 0.55 * grow, { fill: C.danger, stroke: KEYLINE, sw: 3 * g.s });
        continue;
      }
      g.line(x, y + r * 1.1, x - sway * 10 * g.s, y + r * 2.1, 3 * g.s, { stroke: fade(C.ink, 0.45) });
      g.sprite('balloon', x, y, r * 2.4 * grow, { rot: sway * 0.12, hue: this.balloons.data[i]! });
    }
  }

  private drawBunting(g: Renderer): void {
    const { w } = g;
    const n = 9;
    const gap = w / n;
    const y0 = 20 * g.s;
    g.line(0, y0, w, y0, 4 * g.s, { stroke: fade(C.ink, 0.5) });
    for (let k = 0; k < n; k++) {
      const x = gap * (k + 0.5);
      const wob = Math.sin(this.time * 2 + k) * 0.08;
      g.sprite('triangle', x, y0 + 30 * g.s, 56 * g.s, {
        rot: Math.PI + wob, hue: THEME_HUES[(k * 3) % THEME_HUES.length]!,
      });
    }
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.pops >= 25) highlights.push(`풍선 ${this.pops}개 터뜨렸어요`);
    if (this.bestCombo >= 15) highlights.push(`가시 풍선을 피하며 ${this.bestCombo}연속!`);
    return {
      gameId: manifest.id,
      cleared: this.pops > 0,
      rawScore: this.score,
      maxScore: manifest.scoring.maxScore,
      normalized: 0,
      stars: 0,
      durationMs: manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score: this.score,
        hits: this.pops, misses: 0, bestCombo: this.bestCombo,
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

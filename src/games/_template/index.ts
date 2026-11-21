// The canonical shape of a mini-game. Read the archetype reference that matches
// your game before writing anything:
//
//   Shape A (trigger)    src/games/mosquito-clap/
//   Shape B (overlap)    src/games/candy-rain-catch/
//   Shape C (locomotion) src/games/wave-jump/
//
// Full rules: AGENTS.md. Craft guidance and threshold table: docs/GAME_AUTHORING.md.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { L, palm } from '@/engine/pose/landmarks';
import { hitCircle } from '@/engine/math';
import { Entities } from '@/engine/entities';
import { Spawner } from '@/engine/spawn';
import { C } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

/** Joints to highlight on the skeleton: "these are the parts that matter". */
const HANDS = [L.LEFT_WRIST, L.RIGHT_WRIST] as const;

/** Entity kinds. Numbers, because entities are typed arrays. */
const GOOD = 0;
const BAD = 1;

class TemplateGame implements MiniGame {
  private ctx!: GameContext;

  // --- Rented in init(), read in update(). Never constructed per frame. ---
  private clap!: Detector<'clap'>;
  private spawner!: Spawner;

  // --- Pre-allocated. update() and render() must not allocate anything. ---
  private readonly targets = new Entities(48);
  private readonly handL: Pt = { x: 0, y: 0 };
  private readonly handR: Pt = { x: 0, y: 0 };
  /** Last seen player, kept so render() can draw the body. render() must never
   *  call a detector's read(): it can run between fixed updates. */
  private player: PlayerPose | null = null;

  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private hits = 0;
  private misses = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // A rented detector gives you hysteresis, cooldown, confirm-frames and
    // visibility gating. Hand-rolled threshold code is where double-scoring lives.
    this.clap = ctx.gestures.use('clap', { cooldownMs: 280 });
    this.spawner = new Spawner(
      { startInterval: 1.4, endInterval: 0.55, jitter: 0.3 },
      ctx.rng, // seeded — Math.random() is banned
      manifest.durationMs / 1000,
    );
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
  }

  update(dt: number, f: PoseFrame): void {
    const spawns = this.spawner.tick(dt);
    for (let i = 0; i < spawns; i++) this.spawnTarget();

    this.targets.step(dt);
    this.targets.cullOutside(-200, -200, this.ctx.view.w + 200, this.ctx.view.h + 200);

    const p = f.p1;
    this.player = p ?? null;
    if (p) {
      palm(p, 'L', this.handL);
      palm(p, 'R', this.handR);
      const clap = this.clap.read(f);
      if (clap.fired) this.resolveHit(clap.at.x, clap.at.y);
    }

    this.targets.sweep();
  }

  private spawnTarget(): void {
    const { w, h } = this.ctx.view;
    const bad = this.spawner.difficulty > 0.4 && this.ctx.rng() < 0.2;
    // Keep targets inside the reachable band: the `reach-grid` clip proves
    // whether a player can actually get to them.
    const x = w * (0.15 + this.ctx.rng() * 0.7);
    const y = h * (0.2 + this.ctx.rng() * 0.5);
    this.targets.spawn(x, y, 0, 0, Math.max(w, h) * 0.05, 2.4, bad ? BAD : GOOD);
  }

  private resolveHit(x: number, y: number): void {
    for (let i = 0; i < this.targets.n; i++) {
      if (!hitCircle(x, y, this.targets.x[i]!, this.targets.y[i]!, this.targets.r[i]!)) continue;
      const bad = this.targets.kind[i] === BAD;
      this.targets.kill(i);

      if (bad) {
        // Misses are QUIET. Break the combo; no red X, no buzzer.
        this.combo = 0;
        this.misses++;
        this.ctx.audio.play('miss', { gain: 0.5 });
        this.ctx.hud.setCombo(0);
        this.ctx.emit({ kind: 'miss' });
        return;
      }

      this.hits++;
      this.combo++;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
      this.score += 1 + Math.floor(this.combo / 5);

      // Everything below lands within 100ms. This is where the delight is.
      this.ctx.fx.burst(x, y, { count: 16, color: C.accent, sprite: 'sparkle' });
      this.ctx.fx.pop(x, y, this.targets.r[i]! * 1.6, C.accent);
      this.ctx.fx.shake(0.1);
      this.ctx.fx.hitstop(0.04);
      this.ctx.fx.popText(x, y, `+${1 + Math.floor(this.combo / 5)}`);
      this.ctx.audio.playLadder('pop', this.combo); // rising pitch per combo step
      this.ctx.hud.setScore(this.score);
      this.ctx.hud.setCombo(this.combo);
      this.ctx.emit({ kind: 'scored', points: 1 });
      return;
    }
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    for (let i = 0; i < this.targets.n; i++) {
      const age = this.targets.age(i);
      // Everything enters with a scale pop and leaves with a fade. Nothing cuts.
      const grow = age < 0.12 ? age / 0.12 : 1;
      const r = this.targets.r[i]! * (0.6 + 0.4 * grow);
      g.sprite(
        this.targets.kind[i] === BAD ? 'rock' : 'star',
        this.targets.x[i]!, this.targets.y[i]!, r * 2,
      );
    }

    // ALWAYS draw the body. Even with latency, visible response to movement
    // reads as "it can see me"; a game that draws nothing reads as broken.
    if (this.player) g.skeleton(this.player, { alpha: 0.5, emphasize: HANDS });

    // Hit zones sit on the PALMS, not the wrists: a child aims with their hand,
    // and the wrist trails a hand-length behind it.
    g.circle(this.handL.x, this.handL.y, 20 * g.s, { stroke: C.slot[0], sw: 3 * g.s, glow: 8 });
    g.circle(this.handR.x, this.handR.y, 20 * g.s, { stroke: C.slot[0], sw: 3 * g.s, glow: 8 });
  }

  end(_reason: EndReason): GameResult {
    return {
      gameId: manifest.id,
      cleared: this.score > 0,
      rawScore: this.score,
      maxScore: manifest.scoring.maxScore,
      // Leave these at 0: the engine computes them from starCuts so the rating
      // means the same thing in every one of the 58 games.
      normalized: 0,
      stars: 0,
      durationMs: manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score: this.score,
        hits: this.hits, misses: this.misses, bestCombo: this.bestCombo,
      }],
      highlightsKo: this.bestCombo >= 5 ? [`콤보 ${this.bestCombo}연속!`] : undefined,
    };
  }
}

export default (): MiniGame => new TemplateGame();

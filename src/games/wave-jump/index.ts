// ─── REFERENCE GAME — SHAPE C (locomotion vs a scrolling world) ──────────────
//
// ~10 games in the catalogue are this shape: the world moves, a body signal
// clears it, and surviving IS the score. Read this whole file before writing
// one.
//
// What it demonstrates that Shapes A and B do not: a timing window measured
// against a moving object rather than an overlap, a signal that must be
// SUPPRESSED as well as produced (the foam), and an intensity-3 design whose
// pacing is a safety feature rather than a difficulty knob.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Renderer,
} from '@/engine/types';
import { L, visible } from '@/engine/pose/landmarks';
import { lerp } from '@/engine/math';
import { chance, randRange, Spawner } from '@/engine/spawn';
import { C, fade, hue } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

/**
 * There are deliberately no lives.
 *
 * Knocking a child out of a 35-second round at the 12-second mark is the worst
 * outcome this catalogue can produce: they stand there watching. A missed wave
 * breaks the combo and soaks their feet, and the next wave is already coming.
 * The round ends when the clock does.
 */
/** Hard cap on waves, because every wave is a jump and jumping is the most
 *  tiring thing in the catalogue. */
const MAX_WAVES = 14;

interface Wave {
  /** 0 = just spawned at the horizon, 1 = past the player. */
  p: number;
  speed: number;
  /** Foam looks like a wave and must NOT be jumped — the inhibition mechanic. */
  foam: boolean;
  /** Set once the wave has been judged, so it cannot score twice. */
  judged: boolean;
  cleared: boolean;
  /** Was the player airborne at ANY point while this wave crossed their feet?
   *  A single-frame check is hopeless: a child is airborne for ~12% of the
   *  time, so judging one exact frame failed almost every real jump. */
  sawAir: boolean;
}

class WaveJump implements MiniGame {
  private ctx!: GameContext;
  private jump!: Detector<'jump'>;
  private spawner!: Spawner;

  /** Fixed-size pool. Allocated once; `active` says how many are live. */
  // `p: 1` means "finished, slot free". Starting these at 0 made every slot
  // look permanently in-flight, so no wave ever spawned and the game was an
  // empty sea.
  private readonly waves: Wave[] = Array.from({ length: 8 }, () => ({
    p: 1, speed: 0, foam: false, judged: true, cleared: false, sawAir: false,
  }));
  private player: PlayerPose | null = null;

  private score = 0;
  private cleared = 0;
  private soaked = 0;
  private combo = 0;
  private bestCombo = 0;
  private jumps = 0;
  private time = 0;
  private airborne = false;
  private splash = 0;
  private lowerBodyOk = true;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.jump = ctx.gestures.use('jump', {
      // Slightly easier than the attract screen's 1.9: here a missed jump
      // costs a life, so a false negative is the worse failure.
      enter: 1.45,
      cooldownMs: 320,
      requireFeetVisible: false,
    });
    this.spawner = new Spawner(
      // 2.8 -> 2.2s between waves. Tighter than this forces back-to-back
      // jumping, which the safety guidance rules out and which no 7-year-old
      // sustains for 35 seconds anyway.
      { startInterval: 2.8, endInterval: 2.2, jitter: 0.18 },
      ctx.rng,
      manifest.durationMs / 1000,
    );
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.audio.music({ bpm: 128 });
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    if (this.splash > 0) this.splash = Math.max(0, this.splash - dt * 2.5);

    const p = f.p1;
    this.player = p ?? null;
    if (p) {
      // Legs out of frame is the common laptop case. Say so rather than
      // silently scoring the player as missing every wave.
      this.lowerBodyOk = visible(p, L.LEFT_HIP, L.RIGHT_HIP);
      const j = this.jump.read(f);
      this.airborne = j.airborne;
      if (j.fired) {
        this.jumps++;
        this.ctx.audio.play('jump', { gain: 0.5 });
        this.ctx.fx.burst(p.px[L.LEFT_HIP * 2]!, p.px[L.LEFT_HIP * 2 + 1]!, {
          count: 8, color: fade(C.white, 0.6), speed: 180, life: 0.3,
        });
      }
    }

    if (this.jumps < MAX_WAVES && this.spawner.tick(dt) > 0) this.spawnWave();
    this.advance(dt);
  }

  private spawnWave(): void {
    const w = this.waves.find((x) => x.judged && x.p >= 1);
    if (!w) return;
    const d = this.spawner.difficulty;
    // Foam only appears once the real rhythm is established, or the game is
    // just confusing rather than playful.
    w.foam = d > 0.35 && chance(this.ctx.rng, 0.25);
    w.p = 0;
    w.speed = lerp(0.42, 0.62, d) * randRange(this.ctx.rng, 0.92, 1.08);
    w.judged = false;
    w.cleared = false;
    w.sawAir = false;
  }

  /**
   * A wave is judged over the whole stretch where it crosses the player's
   * feet, not at one instant: being airborne at any point inside the window
   * clears it. The window is ~0.35s at typical wave speed, which is about one
   * child's jump — generous on purpose, the way every good rhythm game is.
   */
  private static readonly WINDOW_IN = 0.58;
  private static readonly WINDOW_OUT = 1.0;

  private advance(dt: number): void {
    for (const w of this.waves) {
      if (w.p >= 1) continue;
      w.p += w.speed * dt;
      if (w.judged) continue;
      if (w.p >= WaveJump.WINDOW_IN && w.p < WaveJump.WINDOW_OUT && this.airborne) {
        w.sawAir = true;
      }
      if (w.p >= WaveJump.WINDOW_OUT) {
        w.judged = true;
        this.judge(w);
      }
    }
  }

  private judge(w: Wave): void {
    const { h } = this.ctx.view;
    const y = h * 0.8;
    if (w.foam) {
      // Jumping foam is not punished — it is just a wasted jump, and the game
      // says so gently. Punishing a false positive here would teach children
      // to stop moving.
      if (w.sawAir) this.ctx.hud.toast(t('fake'), { color: C.info });
      return;
    }
    if (w.sawAir) {
      w.cleared = true;
      this.cleared++;
      this.combo++;
      if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      this.score += 4 + Math.floor(this.combo / 3);
      this.ctx.fx.burst(this.ctx.view.w / 2, y, {
        count: 16, color: hue(manifest.theme!.hue), sprite: 'droplet', speed: 380, gravity: 500,
      });
      this.ctx.fx.popText(this.ctx.view.w / 2, y - 40, `+${4 + Math.floor(this.combo / 3)}`);
      this.ctx.audio.playLadder('splash', this.combo);
      if (this.combo % 3 === 0) this.ctx.hud.toast(t('nice'), { color: C.accent });
      this.ctx.hud.setScore(this.score);
      this.ctx.hud.setCombo(this.combo);
      this.ctx.emit({ kind: 'scored', points: 4 });
      return;
    }
    // Soaked: a splash, a broken combo, and nothing else. No scolding, no
    // elimination — the next wave is already on its way.
    this.soaked++;
    this.combo = 0;
    this.splash = 1;
    this.ctx.hud.setCombo(0);
    this.ctx.hud.toast(t('wet'), { color: C.info });
    this.ctx.audio.play('splash', { gain: 0.6 });
    this.ctx.fx.shake(0.12);
    this.ctx.emit({ kind: 'miss' });
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    // Sea: a horizon and a few parallax bands, so "towards you" is legible.
    const horizon = g.h * 0.34;
    g.rect(0, horizon, g.w, g.h - horizon, { fill: 'hsl(200 70% 16%)' });
    for (let i = 0; i < 4; i++) {
      const y = lerp(horizon, g.h, (i + 1) / 5) + Math.sin(this.time * 1.2 + i) * 4 * g.s;
      g.line(0, y, g.w, y, 2 * g.s, { stroke: fade(C.white, 0.06) });
    }

    for (const w of this.waves) {
      if (w.p >= 1 || w.p <= 0) continue;
      // Perspective: a wave starts small and far, and arrives wide and near.
      const y = lerp(horizon, g.h * 0.88, w.p * w.p);
      const halfW = lerp(g.w * 0.12, g.w * 0.62, w.p);
      const thick = lerp(3, 26, w.p) * g.s;
      const inWindow = w.p >= WaveJump.WINDOW_IN && w.p < WaveJump.WINDOW_OUT;
      const col = w.foam
        ? fade(C.white, 0.45)
        : inWindow ? C.accent : hue(200, 85, 62);
      g.line(g.w / 2 - halfW, y, g.w / 2 + halfW, y, thick, { stroke: col, glow: w.foam ? 0 : 10 });
      if (!w.foam && w.p > 0.45) {
        g.sprite('wave', g.w / 2, y - thick, lerp(34, 100, w.p) * g.s, { hue: 200 });
      }
      if (w.foam && w.p > 0.45) {
        g.sprite('bubble', g.w / 2, y - thick, lerp(26, 64, w.p) * g.s);
      }
    }

    if (this.player) g.ghostBody(this.player, 0.1);
    if (this.player) {
      g.skeleton(this.player, {
        alpha: this.airborne ? 0.85 : 0.5,
        // Airborne reads as "the game saw your jump" without a single word.
        color: this.airborne ? C.accent : undefined,
      });
    }

    if (this.splash > 0) {
      g.circle(g.w / 2, g.h * 0.86, g.w * 0.45 * (1.2 - this.splash), {
        stroke: fade(C.info, this.splash * 0.6), sw: 8 * g.s,
      });
    }

    if (!this.lowerBodyOk) {
      g.text('몸이 다 보이게 뒤로 가 볼까요?', g.w / 2, g.h * 0.2, {
        size: 30 * g.s, weight: 700, align: 'center', fill: C.accent,
        stroke: C.ink, sw: 5 * g.s,
      });
    }
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.bestCombo >= 3) highlights.push(`${this.bestCombo}번 연속 성공!`);
    if (this.soaked === 0 && this.cleared > 0) highlights.push('한 번도 안 젖었어요!');
    return {
      gameId: manifest.id,
      cleared: this.cleared > 0,
      rawScore: this.score,
      maxScore: manifest.scoring.maxScore,
      normalized: 0,
      stars: 0,
      durationMs: manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score: this.score,
        hits: this.cleared, misses: this.soaked, bestCombo: this.bestCombo,
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }

  dispose(): void {
    this.ctx.audio.stopMusic();
  }
}

export default (): MiniGame => new WaveJump();


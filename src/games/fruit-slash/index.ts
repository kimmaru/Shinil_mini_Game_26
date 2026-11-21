// fruit-slash — SHAPE A (discrete trigger), swept against a moving target.
//
// The one technical point this game exists to get right: a fast hand covers
// 100+ px between two frames, so a point-in-circle test misses exactly when the
// child is swinging hardest. Every hit here is `hitSegCircle(from -> to)` over
// the segment the palm travelled THIS frame, which is what `SwingSignal.from`
// and `.to` are for.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Renderer,
} from '@/engine/types';
import { L, ny, visible } from '@/engine/pose/landmarks';
import { clamp01, easeOutBack, hitSegCircle, lerp, TAU } from '@/engine/math';
import { Entities } from '@/engine/entities';
import { chance, randRange, Spawner } from '@/engine/spawn';
import { C, fade, hue, KEYLINE } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

/** Entity kinds. Plain numbers, because entities are typed arrays. */
const FRUIT = 0;
const ROCK = 1;
const HALF = 2;

/** Fruit varieties, as (sprite, hue) pairs indexed by `hp`.
 *  Two circle hues plus the gold star: ART.md §3.1 caps a screen at seven
 *  colours and the background wash, the rock grey and the ink already take
 *  three of them. */
const FRUIT_SPRITE = ['circle', 'circle', 'star'] as const;
const FRUIT_HUE = [8, 92, 42] as const;
/** The star is the bonus fruit; it is told apart by SHAPE, not only by gold. */
const STAR_FRUIT = 2;

const POINTS = 10;
const STAR_POINTS = 20;
/** Extra for a foot cut — the whole-body nudge. */
const KICK_BONUS = 5;
/** Cutting this many in one stroke starts paying a bonus per extra fruit. */
const STROKE_BONUS_AT = 3;
const STROKE_BONUS = 5;

/** Low-grade mode (the default): no rocks for the first 20 s, and a rock never
 *  ends the round. See manifest.difficulty. */
const ROCK_AFTER_SEC = 20;
/** "Fruit frenzy": 5 s of extra fruit and no rocks, late in the round. */
const FRENZY_AT_SEC = 40;
const FRENZY_SEC = 5;
/** Flat bonus per fruit during the frenzy. A flat add rather than a
 *  multiplier: doubling made the last five seconds worth a third of the round. */
const FRENZY_BONUS = 5;

/** Lanes a cut can come from, so one stroke's cut count is tracked per limb. */
const LANE_HAND_L = 0;
const LANE_HAND_R = 1;
const LANE_FOOT_L = 2;
const LANE_FOOT_R = 3;

/** How long after a kick is counted the ankle keeps slicing. A kick is 3-5
 *  frames of travel; one frame of sweep would cut nothing. */
const KICK_WINDOW_SEC = 0.22;

const HANDS = [L.LEFT_WRIST, L.RIGHT_WRIST] as const;

class FruitSlash implements MiniGame {
  private ctx!: GameContext;
  /** One detector per hand: with `side: 'both'` the engine reports only the
   *  FASTER wrist, and this game wants both hands cutting independently. */
  private swingL!: Detector<'swing'>;
  private swingR!: Detector<'swing'>;
  /** Kicks. There is no ankle swing detector, so the rep counter is rented
   *  with an ankle-lift scalar: that buys the engine's hysteresis, confirm
   *  frames and refractory period for a signal it does not ship. See NEEDS.md. */
  private kickL!: Detector<'rep'>;
  private kickR!: Detector<'rep'>;
  private spawner!: Spawner;

  // Everything below is allocated HERE. update() and render() allocate nothing.
  private readonly bits = new Entities(96);
  /** Cuts made so far by the current stroke of each limb. */
  private readonly strokeCuts = new Int32Array(4);
  private readonly strokeOn = new Uint8Array(4);
  /** Seconds of slicing left on each foot after a counted kick. */
  private readonly kickLeft = new Float32Array(2);
  /** Previous ankle position in view px: [lx, ly, rx, ry]. */
  private readonly ankPrev = new Float32Array(4);
  private ankPrevOk = false;
  /** '+0'..'+63', so a hit never builds a string in the hot path. */
  private readonly labels: string[] = [];
  private player: PlayerPose | null = null;

  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private hits = 0;
  private misses = 0;
  private kicks = 0;
  private bestStroke = 0;
  private time = 0;
  private frenzyShown = false;
  private lowerBodyOk = false;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // minSpeed is left at the engine default of 3.5 shoulder-widths/sec,
    // measured at the WRIST. A resting hand reads 2.6 sw/s on the `fidget`
    // clip, so anything lower hands out points for standing still; the
    // `swing-wide` clip peaks at 14.3, so 3.5 is nowhere near a real slash.
    // The refractory period is left at the detector's own 200 ms rather than
    // the 250 ms scoring floor: a slash game is back-and-forth, and at 1.5 Hz
    // a 250 ms gate swallowed every second stroke. The hysteresis, the confirm
    // frames and the speed gate are all still the engine's.
    this.swingL = ctx.gestures.use('swing', { side: 'L' });
    this.swingR = ctx.gestures.use('swing', { side: 'R' });
    // Ankle lift above the OTHER ankle, in shoulder-widths. Measured over the
    // clip corpus: idle 0.08, fidget 0.10, step-lr 0.13, jump 0.16, running in
    // place 0.43, the 10 fps `laggy` clip 0.52. 0.60 clears all of them, and a
    // real kick lifts the foot well past one shoulder-width.
    this.kickL = ctx.gestures.use('rep', {
      signal: (p) => ny(p, L.RIGHT_ANKLE) - ny(p, L.LEFT_ANKLE),
      enter: 0.6, exit: 0.28, cooldownMs: 300,
      needs: [L.LEFT_ANKLE, L.RIGHT_ANKLE],
    });
    this.kickR = ctx.gestures.use('rep', {
      signal: (p) => ny(p, L.LEFT_ANKLE) - ny(p, L.RIGHT_ANKLE),
      enter: 0.6, exit: 0.28, cooldownMs: 300,
      needs: [L.LEFT_ANKLE, L.RIGHT_ANKLE],
    });
    this.spawner = new Spawner(
      { startInterval: 1.8, endInterval: 0.95, jitter: 0.3, burstMid: 2, burstLate: 3 },
      ctx.rng,
      manifest.durationMs / 1000,
    );
    for (let i = 0; i < 80; i++) this.labels.push('+' + String(i));
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.audio.music({ bpm: 120 });
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    const frenzy = this.inFrenzy();
    if (frenzy && !this.frenzyShown) {
      this.frenzyShown = true;
      this.ctx.hud.toast(t('frenzy'), { color: C.accent, big: true });
      this.ctx.audio.play('bonus');
      this.spawner.delay(0.1);
    }

    let k = this.spawner.tick(dt);
    // Only ON a tick: adding to `k` unconditionally would spawn two fruit per
    // FRAME for the whole frenzy.
    if (k > 0 && frenzy) k += 2;
    for (let i = 0; i < k; i++) this.launch(frenzy);
    this.fly(dt);

    const p = f.p1;
    this.player = p ?? null;
    if (p) {
      this.lowerBodyOk = visible(p, L.LEFT_ANKLE, L.RIGHT_ANKLE);
      const sl = this.swingL.read(f);
      this.stroke(LANE_HAND_L, sl.ok && sl.active, sl.from.x, sl.from.y, sl.to.x, sl.to.y, false);
      const sr = this.swingR.read(f);
      this.stroke(LANE_HAND_R, sr.ok && sr.active, sr.from.x, sr.from.y, sr.to.x, sr.to.y, false);
      this.feet(dt, f, p);
    }

    this.bits.sweep();
  }

  private inFrenzy(): boolean {
    return this.time >= FRENZY_AT_SEC && this.time < FRENZY_AT_SEC + FRENZY_SEC;
  }

  /** One frame of one limb's stroke: start it, sweep it, or close it. */
  private stroke(
    lane: number, active: boolean,
    x0: number, y0: number, x1: number, y1: number,
    kick: boolean,
  ): void {
    if (!active) {
      this.strokeOn[lane] = 0;
      return;
    }
    if (this.strokeOn[lane] === 0) {
      this.strokeOn[lane] = 1;
      this.strokeCuts[lane] = 0;
      if (!kick) this.ctx.audio.play('swing', { gain: 0.26 });
    }
    // The blade trail IS this game. Drawn by the engine on top of the game, so
    // it survives hitstop and never fights the skeleton overlay.
    this.ctx.fx.trail(x0, y0, x1, y1, {
      color: kick ? C.info : hue(manifest.theme?.hue ?? 205, 82, 46),
      width: kick ? 9 : 14,
      life: 0.22,
    });
    this.slice(lane, x0, y0, x1, y1, kick);
  }

  /** Swept segment vs every live fruit. */
  private slice(
    lane: number,
    x0: number, y0: number, x1: number, y1: number,
    kick: boolean,
  ): void {
    const pad = Math.min(this.ctx.view.w, this.ctx.view.h) * 0.03;
    for (let i = 0; i < this.bits.n; i++) {
      const kind = this.bits.kind[i]!;
      if (kind === HALF) continue;
      if (!hitSegCircle(x0, y0, x1, y1, this.bits.x[i]!, this.bits.y[i]!, this.bits.r[i]! + pad)) {
        continue;
      }
      if (kind === ROCK) this.hitRock(i);
      else this.cut(i, lane, x1 - x0, y1 - y0, kick);
    }
  }

  private cut(i: number, lane: number, dx: number, dy: number, kick: boolean): void {
    const x = this.bits.x[i]!;
    const y = this.bits.y[i]!;
    const variety = this.bits.hp[i]!;
    const r = this.bits.r[i]!;
    const grav = this.bits.data[i]!;
    this.bits.kill(i);

    this.strokeCuts[lane] = this.strokeCuts[lane]! + 1;
    const inStroke = this.strokeCuts[lane]!;
    if (inStroke > this.bestStroke) this.bestStroke = inStroke;

    let points = variety === STAR_FRUIT ? STAR_POINTS : POINTS;
    if (kick) points += KICK_BONUS;
    if (inStroke >= STROKE_BONUS_AT) points += STROKE_BONUS;
    if (this.inFrenzy()) points += FRENZY_BONUS;

    this.hits++;
    if (kick) this.kicks++;
    this.combo++;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    this.score += points;

    this.halves(x, y, r, variety, grav, dx, dy);

    // One call, one grade: particles, ring, shake, hitstop, squash and the
    // floating score all land together at the catalogue's standard weight.
    const level = inStroke >= STROKE_BONUS_AT ? 'big' : variety === STAR_FRUIT ? 'big' : 'hit';
    this.ctx.fx.impact(x, y, level, {
      color: hue(FRUIT_HUE[variety]!, 82, 50),
      sprite: variety === STAR_FRUIT ? 'sparkle' : 'burst',
      label: this.labels[points] ?? '',
    });
    // Rising pitch per combo step: the cheapest strong reward signal there is.
    this.ctx.audio.playLadder(variety === STAR_FRUIT ? 'chime' : 'pop', this.combo);
    if (kick) {
      this.ctx.audio.play('hit.hard', { gain: 0.5 });
      this.ctx.hud.toast(t('kick'), { color: C.info });
    } else if (inStroke === 2) {
      this.ctx.hud.toast(t('double'), { color: C.accent });
    } else if (inStroke === STROKE_BONUS_AT) {
      this.ctx.audio.play('combo.up');
      this.ctx.hud.toast(t('triple'), { color: C.accent, big: true });
    }
    this.ctx.hud.setScore(this.score);
    this.ctx.hud.setCombo(this.combo);
    this.ctx.emit({ kind: 'scored', points });
  }

  /** Two halves tumbling apart along the blade's normal. The cross-section is
   *  the whole point of a slice game, so it gets its own entities rather than
   *  a particle burst. */
  private halves(
    x: number, y: number, r: number, variety: number, grav: number,
    dx: number, dy: number,
  ): void {
    const len = Math.hypot(dx, dy) || 1;
    // Normal to the cut, so the halves part along the blade rather than follow it.
    const nxv = -dy / len;
    const nyv = dx / len;
    const push = Math.min(this.ctx.view.w, this.ctx.view.h) * 0.42;
    for (let s = -1; s <= 1; s += 2) {
      const j = this.bits.spawn(
        x + nxv * r * 0.3 * s, y + nyv * r * 0.3 * s,
        nxv * push * s + dx * 0.45, nyv * push * s + dy * 0.45,
        r, 0.85, HALF,
      );
      if (j < 0) return;
      this.bits.hp[j] = variety;
      this.bits.data[j] = grav;
      this.bits.spin[j] = s * randRange(this.ctx.rng, 3, 7);
    }
  }

  private hitRock(i: number): void {
    const x = this.bits.x[i]!;
    const y = this.bits.y[i]!;
    this.bits.kill(i);
    this.misses++;
    this.combo = 0;
    this.ctx.hud.setCombo(0);
    // A rock is a QUIET penalty: no score loss, no red, no shake. The combo
    // break and the missing reward are the whole feedback.
    this.ctx.fx.miss(x, y);
    this.ctx.audio.play('thud', { gain: 0.42 });
    this.ctx.hud.toast(t('rock'), { color: C.textDim });
    this.ctx.emit({ kind: 'miss' });
  }

  /** Kicks. The rep counter owns the state machine; this owns the 0.22 s
   *  window during which the ankle actually slices. */
  private feet(dt: number, f: PoseFrame, p: PlayerPose): void {
    const kl = this.kickL.read(f);
    const kr = this.kickR.read(f);
    if (kl.justCounted) this.kickLeft[0] = KICK_WINDOW_SEC;
    if (kr.justCounted) this.kickLeft[1] = KICK_WINDOW_SEC;

    const lx = p.px[L.LEFT_ANKLE * 2]!;
    const ly = p.px[L.LEFT_ANKLE * 2 + 1]!;
    const rx = p.px[L.RIGHT_ANKLE * 2]!;
    const ry = p.px[L.RIGHT_ANKLE * 2 + 1]!;
    const prevOk = this.ankPrevOk && this.lowerBodyOk;

    if (this.kickLeft[0]! > 0) {
      this.kickLeft[0] = Math.max(0, this.kickLeft[0]! - dt);
      if (prevOk) this.stroke(LANE_FOOT_L, true, this.ankPrev[0]!, this.ankPrev[1]!, lx, ly, true);
      else this.strokeOn[LANE_FOOT_L] = 0;
    } else {
      this.strokeOn[LANE_FOOT_L] = 0;
    }
    if (this.kickLeft[1]! > 0) {
      this.kickLeft[1] = Math.max(0, this.kickLeft[1]! - dt);
      if (prevOk) this.stroke(LANE_FOOT_R, true, this.ankPrev[2]!, this.ankPrev[3]!, rx, ry, true);
      else this.strokeOn[LANE_FOOT_R] = 0;
    } else {
      this.strokeOn[LANE_FOOT_R] = 0;
    }

    this.ankPrev[0] = lx;
    this.ankPrev[1] = ly;
    this.ankPrev[2] = rx;
    this.ankPrev[3] = ry;
    this.ankPrevOk = this.lowerBodyOk;
  }

  /** Own integrator rather than `Entities.step(dt, gravity)`: each fruit
   *  carries its OWN gravity in `data`, so the late-round speed ramp cannot
   *  bend the arc of a fruit already in the air. */
  private fly(dt: number): void {
    const { w, h } = this.ctx.view;
    for (let i = 0; i < this.bits.n; i++) {
      this.bits.vy[i] = this.bits.vy[i]! + this.bits.data[i]! * dt;
      this.bits.x[i] = this.bits.x[i]! + this.bits.vx[i]! * dt;
      this.bits.y[i] = this.bits.y[i]! + this.bits.vy[i]! * dt;
      this.bits.rot[i] = this.bits.rot[i]! + this.bits.spin[i]! * dt;
      this.bits.life[i] = this.bits.life[i]! - dt;
      // A fruit that falls back off the bottom was simply not cut. Quiet:
      // the combo stops, and the next fruit is already on its way up.
      if (
        this.bits.kind[i] === FRUIT &&
        this.bits.y[i]! > h + this.bits.r[i]! * 2 &&
        this.combo !== 0
      ) {
        this.combo = 0;
        this.ctx.hud.setCombo(0);
      }
    }
    this.bits.cullOutside(-w * 0.3, -h, w * 1.3, h * 1.25);
  }

  private launch(frenzy: boolean): void {
    const { w, h } = this.ctx.view;
    const g = Math.min(w, h);
    const d = this.spawner.difficulty;
    // 1.0 -> 1.6x. Gravity scales with the square and the launch speed with
    // the first power, so the arc keeps its shape and only the clock changes.
    const k = lerp(1, 1.6, d);
    const grav = g * 1.25 * k * k;
    const rock = !frenzy && this.time >= ROCK_AFTER_SEC && chance(this.ctx.rng, 0.16);
    const variety = rock
      ? 0
      : chance(this.ctx.rng, 0.12)
        ? STAR_FRUIT
        : (this.ctx.rng() < 0.5 ? 0 : 1);
    const r = g * (rock ? 0.062 : variety === STAR_FRUIT ? 0.066 : 0.072);
    // Peak the arc inside the band a standing child's hands sweep.
    const rise = h * randRange(this.ctx.rng, 0.54, 0.72);
    const v0 = Math.sqrt(2 * grav * rise);
    const flight = (2 * v0) / grav;
    const x0 = randRange(this.ctx.rng, w * 0.14, w * 0.86);
    // Drift toward the middle, so nothing arcs out of the frame.
    const vx = ((w * 0.5 - x0) * randRange(this.ctx.rng, 0.35, 1.05)) / flight;
    const i = this.bits.spawn(x0, h + r, vx, -v0, r, flight + 0.5, rock ? ROCK : FRUIT);
    if (i < 0) return;
    this.bits.hp[i] = variety;
    this.bits.data[i] = grav;
    this.bits.spin[i] = randRange(this.ctx.rng, -2.4, 2.4);
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    // A ground band, so a fruit launching from "below the floor" reads as
    // thrown rather than as spawning in midair.
    g.rect(0, g.h * 0.93, g.w, g.h * 0.07, { fill: fade(KEYLINE, 0.07) });
    g.line(0, g.h * 0.93, g.w, g.h * 0.93, 3 * g.s, { stroke: fade(KEYLINE, 0.22) });

    // Always draw the body. Even with latency, visible response to movement
    // reads as "it can see me"; a game that draws nothing reads as broken.
    if (this.player) {
      g.ghostBody(this.player, 0.09);
      g.skeleton(this.player, { alpha: 0.6, emphasize: HANDS });
    }

    for (let i = 0; i < this.bits.n; i++) {
      const kind = this.bits.kind[i]!;
      const x = this.bits.x[i]!;
      const y = this.bits.y[i]!;
      const r = this.bits.r[i]!;
      const rot = this.bits.rot[i]!;
      const age = this.bits.age(i);
      g.save();
      if (kind === HALF) {
        g.alpha(clamp01(1 - age) * 0.92);
        const v = this.bits.hp[i]!;
        g.sprite(FRUIT_SPRITE[v]!, x, y, r * 1.5, {
          rot, hue: FRUIT_HUE[v]!, scaleY: 0.52,
        });
      } else if (kind === ROCK) {
        // Shape, not colour: a lumpy grey rock next to round bright fruit, so
        // a red-green colour-blind child reads the rule off the silhouette.
        g.circle(x, y, r * 1.22, { stroke: fade(KEYLINE, 0.3), sw: 3 * g.s });
        g.sprite('rock', x, y, r * 2.1, { rot });
      } else {
        // Nothing simply appears: 0.86 -> 1 with easeOutBack.
        const grow = age < 0.1 ? 0.86 + 0.14 * easeOutBack(age / 0.1) : 1;
        const v = this.bits.hp[i]!;
        g.circle(x, y, r * 1.16 * grow, { stroke: fade(KEYLINE, 0.34), sw: 3 * g.s });
        g.sprite(FRUIT_SPRITE[v]!, x, y, r * 2 * grow, { rot, hue: FRUIT_HUE[v]! });
        if (v !== STAR_FRUIT) {
          // A leaf and a glint, so a round tinted disc reads as fruit. They
          // turn with the fruit, which is what makes the spin visible.
          g.circle(x + Math.sin(rot) * r * 0.98, y - Math.cos(rot) * r * 0.98, r * 0.2, {
            fill: hue(125, 70, 38),
          });
          g.circle(x + Math.cos(rot - 2.3) * r * 0.5, y + Math.sin(rot - 2.3) * r * 0.5, r * 0.14, {
            fill: fade(C.white, 0.7),
          });
        }
      }
      g.restore();
    }

    if (this.player) {
      const p = this.player;
      const hr = 20 * g.s;
      const blade = hue(manifest.theme?.hue ?? 205, 82, 46);
      for (let s = 0; s < 2; s++) {
        const j = s === 0 ? L.LEFT_WRIST : L.RIGHT_WRIST;
        g.circle(p.px[j * 2]!, p.px[j * 2 + 1]!, hr, { stroke: blade, sw: 4 * g.s, glow: 10 });
      }
      if (this.lowerBodyOk) {
        for (let s = 0; s < 2; s++) {
          const j = s === 0 ? L.LEFT_ANKLE : L.RIGHT_ANKLE;
          const live = this.kickLeft[s]! > 0;
          g.circle(p.px[j * 2]!, p.px[j * 2 + 1]!, hr * (live ? 1.3 : 0.9), {
            stroke: live ? C.info : fade(C.info, 0.4),
            sw: 3 * g.s,
          });
        }
      }
    }

    if (this.inFrenzy()) {
      // A frame around the play area, so "frenzy" is visible with sound off.
      const pulse = 4 + 3 * Math.sin(g.t * TAU * 2.4);
      g.rect(0, 0, g.w, g.h, { stroke: C.accent, sw: pulse * g.s });
    }
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.bestStroke >= 3) highlights.push(`한 번에 ${this.bestStroke}개!`);
    if (this.bestCombo >= 6) highlights.push(`콤보 ${this.bestCombo}연속!`);
    if (this.kicks > 0) highlights.push(`발로 ${this.kicks}번 찼어요`);
    return {
      gameId: manifest.id,
      cleared: this.hits > 0,
      rawScore: this.score,
      maxScore: manifest.scoring.maxScore,
      // The ENGINE computes these from starCuts, so a rating means the same
      // thing in all 58 games.
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
    this.bits.clear();
  }
}

export default (): MiniGame => new FruitSlash();

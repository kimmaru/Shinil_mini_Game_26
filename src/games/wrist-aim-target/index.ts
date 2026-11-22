// ─── Shape A variant: dwell-to-fire aim ──────────────────────────────────────
//
// A glowing laser dot sits on the player's hand; park it on a big target for a
// moment and it fires. Waves of one target (either hand), then one target per
// hand, with a bomb decoy sprinkled in after the opening.
//
// Fairness: every target is placed from a SHOULDER, at a fraction of THIS
// player's own arm length, and pulled back inside 0.95 of it — so a short
// child and a tall one are asked for the same effort, and nothing is ever
// out of reach.
//
// See NEEDS.md: there is no per-game "steady" filter, so the aim point gets a
// small local low-pass (SMOOTH_RATE), the dwell drains instead of resetting
// (a jittery hand does not lose its progress) and the hit test has a dead
// zone (enter at r, leave at 1.2r).
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PlayOpts, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { L, jx, jy } from '@/engine/pose/landmarks';
import { approach, clamp, clamp01, dist, easeOutBack, TAU } from '@/engine/math';
import { chance, randRange } from '@/engine/spawn';
import { C, fade, hue, KEYLINE } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

const NORMAL = 0;
const BOMB = 1;
const HAND_ANY = -1;
const HAND_L = 0;
const HAND_R = 1;
const MAXT = 3;

const RING_POINTS = 10;
const BULL_POINTS = 20;
const BOMB_PENALTY = 10;
/** Inner fraction of the radius that counts as a bullseye. */
const BULL_FRAC = 0.4;
/** Combo count that earns a cheer. */
const COMBO_STEP = 4;
/** approach() rate for the extra aim smoothing, ~90 ms time constant. */
const SMOOTH_RATE = 10;
/** Dwell drains this many times faster than it fills when the hand leaves. */
const DRAIN = 1.2;
/** Target radius as a fraction of VIEW WIDTH. 8% is the engine floor. */
const R_FRAC = 0.09;
const GAP_SEC = 0.55;

const HANDS = [L.LEFT_WRIST, L.RIGHT_WRIST] as const;
/** Colours built once: render() must not build strings. */
const TRACK = fade(C.ink, 0.18);
const GLINT = fade(C.white, 0.6);
const LABEL_RING = '+10';
const LABEL_BULL = '+20';
/** A bomb is a quiet miss: soft sound, no toast (the point loss stays). */
const SFX_BOMB: PlayOpts = { gain: 0.3 };
const EV_MISS = { kind: 'miss' as const };

class WristAimTarget implements MiniGame {
  private ctx!: GameContext;
  private reach!: Detector<'reach'>;

  private readonly tOn = new Uint8Array(MAXT);
  private readonly tx = new Float32Array(MAXT);
  private readonly ty = new Float32Array(MAXT);
  private readonly tr = new Float32Array(MAXT);
  private readonly tLife = new Float32Array(MAXT);
  private readonly tAge = new Float32Array(MAXT);
  private readonly tDwell = new Float32Array(MAXT);
  private readonly tKind = new Uint8Array(MAXT);
  private readonly tHand = new Int8Array(MAXT);
  private readonly tPhase = new Float32Array(MAXT);
  private readonly tWob = new Float32Array(MAXT);

  private readonly smL: Pt = { x: 0, y: 0 };
  private readonly smR: Pt = { x: 0, y: 0 };
  private smPrimed = false;

  private readonly shL: Pt = { x: 0, y: 0 };
  private readonly shR: Pt = { x: 0, y: 0 };
  private armPx = 0;
  private holdSec = 0.7;
  private player: PlayerPose | null = null;
  private time = 0;
  private beam = '';
  private gap = 1;
  private realLeft = 0;
  private pairTold = false;

  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private hits = 0;
  private bulls = 0;
  private misses = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.beam = hue(manifest.theme?.hue ?? 238, 85, 60);
    this.reach = ctx.gestures.use('reach', { side: 'both' });
    const { w, h } = ctx.view;
    this.shL.x = w * 0.44;
    this.shR.x = w * 0.56;
    this.shL.y = h * 0.42;
    this.shR.y = h * 0.42;
    this.armPx = Math.min(w, h) * 0.3;
    this.smL.x = w * 0.4; this.smL.y = h * 0.6;
    this.smR.x = w * 0.6; this.smR.y = h * 0.6;
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
  }

  /** 0..1 progress through the round. */
  private get u(): number {
    return clamp01(this.time / (manifest.durationMs / 1000));
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    const p = f.p1;
    this.player = p ?? null;
    if (p) {
      this.shL.x = jx(p, L.LEFT_SHOULDER); this.shL.y = jy(p, L.LEFT_SHOULDER);
      this.shR.x = jx(p, L.RIGHT_SHOULDER); this.shR.y = jy(p, L.RIGHT_SHOULDER);
      this.armPx = (p.calib.armLen > 0.5 ? p.calib.armLen : 1.6) * p.scalePx;
    }

    const sig = this.reach.read(f);
    if (sig.ok) {
      if (!this.smPrimed) {
        this.smL.x = sig.leftPalm.x; this.smL.y = sig.leftPalm.y;
        this.smR.x = sig.rightPalm.x; this.smR.y = sig.rightPalm.y;
        this.smPrimed = true;
      } else {
        this.smL.x = approach(this.smL.x, sig.leftPalm.x, SMOOTH_RATE, dt);
        this.smL.y = approach(this.smL.y, sig.leftPalm.y, SMOOTH_RATE, dt);
        this.smR.x = approach(this.smR.x, sig.rightPalm.x, SMOOTH_RATE, dt);
        this.smR.y = approach(this.smR.y, sig.rightPalm.y, SMOOTH_RATE, dt);
      }
    }

    this.holdSec = 0.7 - 0.15 * this.u;
    for (let i = 0; i < MAXT; i++) {
      if (this.tOn[i] === 0) continue;
      this.tAge[i] = this.tAge[i]! + dt;
      this.tLife[i] = this.tLife[i]! - dt;
      if (this.tLife[i]! <= 0) { this.expire(i); continue; }
      if (sig.ok) this.dwell(i, dt);
    }

    if (this.realLeft <= 0) {
      // Wave over: clear leftover bombs, breathe, then serve the next one.
      for (let i = 0; i < MAXT; i++) this.tOn[i] = 0;
      this.gap -= dt;
      if (this.gap <= 0 && p) this.spawnWave();
    }
  }

  private spawnWave(): void {
    const u = this.u;
    const rng = this.ctx.rng;
    this.gap = GAP_SEC;
    if (u > 0.45 && chance(rng, 0.45)) {
      this.spawnTarget(0, NORMAL, HAND_L, 6);
      this.spawnTarget(1, NORMAL, HAND_R, 6);
      if (!this.pairTold) {
        this.pairTold = true;
        this.ctx.hud.toast(t('bothHands'), { color: C.info });
      }
      return;
    }
    this.spawnTarget(0, NORMAL, HAND_ANY, 5);
    if (u > 0.25 && chance(rng, 0.4)) this.spawnTarget(1, BOMB, HAND_ANY, 5);
  }

  /** Place slot `i` from a shoulder, at a fraction of this player's arm
   *  length, in the upper-outer arc the hand actually sweeps through. */
  private spawnTarget(i: number, kind: number, hand: number, lifeSec: number): void {
    const { w, h } = this.ctx.view;
    const rng = this.ctx.rng;
    const r = w * R_FRAC;
    // A bomb sits on the opposite side from the real target, so the choice is
    // "go there, not there" rather than "the thing under my hand is bad".
    let left: boolean;
    if (hand === HAND_L) left = true;
    else if (hand === HAND_R) left = false;
    else if (kind === BOMB) left = this.tx[0]! > w / 2;
    else left = chance(rng, 0.5);

    const sh = left ? this.shL : this.shR;
    const out = left ? -1 : 1;
    // phi: -70 deg = up and a little in, 0 = straight out, +40 = low.
    const phi = (randRange(rng, -70, 40) * Math.PI) / 180;
    const frac = randRange(rng, 0.7, 0.95);
    let x = sh.x + out * Math.cos(phi) * this.armPx * frac;
    let y = sh.y + Math.sin(phi) * this.armPx * frac;
    x = clamp(x, r * 1.1, w - r * 1.1);
    y = clamp(y, this.topAt(x, r), h * 0.88 - r * 0.3);
    // The view clamp must never push it out of this arm's reach.
    const dx = x - sh.x;
    const dy = y - sh.y;
    const d = Math.hypot(dx, dy);
    const cap = this.armPx * 0.95;
    if (d > cap) { x = sh.x + (dx / d) * cap; y = sh.y + (dy / d) * cap; }
    // ...nor back up under the HUD (only possible for a body far off-centre).
    if (y < this.topAt(x, r)) y = this.topAt(x, r);

    this.tOn[i] = 1;
    this.tx[i] = x; this.ty[i] = y; this.tr[i] = r;
    this.tLife[i] = lifeSec;
    this.tAge[i] = 0;
    this.tDwell[i] = 0;
    this.tKind[i] = kind;
    this.tHand[i] = hand;
    this.tPhase[i] = rng() * TAU;
    this.tWob[i] = this.u > 0.6 ? w * 0.012 : 0;
    if (kind === NORMAL) this.realLeft++;
  }

  /** Highest target centre at screen x: the whole target stays below the DOM
   *  HUD band (score + combo pill on the left, goal and timer across the top). */
  private topAt(x: number, r: number): number {
    const { w, h } = this.ctx.view;
    return (x < w * 0.25 ? h * 0.26 : h * 0.18) + r;
  }

  private posX(i: number): number {
    return this.tx[i]! + Math.sin(this.time * 1.5 + this.tPhase[i]!) * this.tWob[i]!;
  }

  private posY(i: number): number {
    return this.ty[i]! + Math.cos(this.time * 1.9 + this.tPhase[i]!) * this.tWob[i]!;
  }

  private dwell(i: number, dt: number): void {
    const x = this.posX(i);
    const y = this.posY(i);
    const hand = this.tHand[i]!;
    let d: number;
    if (hand === HAND_L) d = dist(this.smL.x, this.smL.y, x, y);
    else if (hand === HAND_R) d = dist(this.smR.x, this.smR.y, x, y);
    else d = Math.min(dist(this.smL.x, this.smL.y, x, y), dist(this.smR.x, this.smR.y, x, y));

    const r = this.tr[i]!;
    const engaged = this.tDwell[i]! > 0;
    if (d <= (engaged ? r * 1.2 : r)) {
      const v = this.tDwell[i]! + dt / this.holdSec;
      this.tDwell[i] = v;
      if (v >= 1) this.resolve(i, d <= r * BULL_FRAC);
    } else {
      this.tDwell[i] = Math.max(0, this.tDwell[i]! - (dt / this.holdSec) * DRAIN);
    }
  }

  private resolve(i: number, bull: boolean): void {
    const x = this.posX(i);
    const y = this.posY(i);
    const bomb = this.tKind[i] === BOMB;
    this.tOn[i] = 0;

    if (bomb) {
      // Quiet by design: a small, soft loss and a broken combo. The lesson is
      // "aim at the other one", not "you failed".
      this.misses++;
      this.combo = 0;
      this.score = Math.max(0, this.score - BOMB_PENALTY);
      this.ctx.hud.setCombo(0);
      this.ctx.hud.setScore(this.score);
      this.ctx.audio.play('miss', SFX_BOMB);
      this.ctx.fx.miss(x, y);
      this.ctx.emit(EV_MISS);
      return;
    }

    this.realLeft--;
    this.hits++;
    this.combo++;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    if (bull) this.bulls++;
    const points = bull ? BULL_POINTS : RING_POINTS;
    this.score += points;

    this.ctx.fx.impact(x, y, bull ? 'big' : 'hit', {
      color: bull ? C.accent : C.success,
      sprite: bull ? 'star' : 'sparkle',
      label: bull ? LABEL_BULL : LABEL_RING,
    });
    this.ctx.audio.playLadder(bull ? 'pop.high' : 'pop', this.combo);
    if (bull) {
      this.ctx.hud.toast(t('wow'), { color: C.accent });
    } else if (this.combo % COMBO_STEP === 0) {
      this.ctx.hud.toast(t('nice'), { color: C.success });
      this.ctx.audio.play('combo.up');
    }
    this.ctx.hud.setScore(this.score);
    this.ctx.hud.setCombo(this.combo);
    this.ctx.emit({ kind: 'scored', points });
  }

  /** A target nobody got to in time just fades: no sound, no mark. */
  private expire(i: number): void {
    this.tOn[i] = 0;
    if (this.tKind[i] === BOMB) return;
    this.realLeft--;
    this.misses++;
    if (this.combo > 0) {
      this.combo = 0;
      this.ctx.hud.setCombo(0);
    }
    this.ctx.fx.miss(this.tx[i]!, this.ty[i]!);
    this.ctx.emit({ kind: 'miss' });
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    if (this.player) {
      g.ghostBody(this.player, 0.12);
      g.skeleton(this.player, { alpha: 0.55, emphasize: HANDS });
    }

    for (let i = 0; i < MAXT; i++) {
      if (this.tOn[i] === 0) continue;
      const x = this.posX(i);
      const y = this.posY(i);
      const r = this.tr[i]!;
      const age = this.tAge[i]!;
      const grow = age < 0.25 ? 0.86 + 0.14 * easeOutBack(age / 0.25) : 1;
      // Last second: shrink a touch so "it is leaving" reads without a clock.
      const leave = this.tLife[i]! < 1 ? 0.85 + 0.15 * this.tLife[i]! : 1;
      const rr = r * grow * leave;
      const prog = clamp01(this.tDwell[i]!);
      const hand = this.tHand[i]!;

      if (this.tKind[i] === BOMB) {
        g.circle(x, y, rr * 0.9, { fill: KEYLINE, stroke: C.warn, sw: 5 * g.s });
        g.circle(x - rr * 0.28, y - rr * 0.28, rr * 0.2, { fill: GLINT });
        g.line(x + rr * 0.45, y - rr * 0.65, x + rr * 0.7, y - rr * 0.95, 6 * g.s, { stroke: C.accentHi });
        g.star(x + rr * 0.72, y - rr * 1.0, rr * 0.2, 4, { fill: C.warn });
      } else {
        g.sprite('target', x, y, rr * 2);
        if (hand !== HAND_ANY) {
          g.circle(x, y, rr * 1.12, {
            stroke: hand === HAND_L ? C.slot[0] : C.slot[1], sw: 8 * g.s,
          });
          // Above the target unless that is inside the HUD band; then below.
          const half = 26 * g.s;
          const safe = x < g.w * 0.25 ? g.h * 0.26 : g.h * 0.18;
          const ly = y - rr * 1.42 - half >= safe ? y - rr * 1.42 : Math.min(y + rr * 1.42, g.h - half);
          g.text(hand === HAND_L ? t('left') : t('right'), x, ly, {
            size: 48 * g.s, weight: 800, align: 'center', baseline: 'middle',
            fill: hand === HAND_L ? C.slot[0] : C.slot[1], stroke: C.white, sw: 7 * g.s,
          });
        }
      }

      if (prog > 0.01) {
        g.circle(x, y, rr * 1.25, { stroke: TRACK, sw: 10 * g.s });
        g.arc(x, y, rr * 1.25, -Math.PI / 2, -Math.PI / 2 + prog * TAU, {
          stroke: this.tKind[i] === BOMB ? C.warn : C.success, sw: 10 * g.s,
        });
      }
    }

    // The two laser dots. Always drawn once the hands have been seen.
    this.drawLaser(g, this.smL, this.shL, C.slot[0]);
    this.drawLaser(g, this.smR, this.shR, C.slot[1]);
  }

  /** A hot-pink dot with a short beam pointing away from the shoulder. */
  private drawLaser(g: Renderer, pt: Pt, sh: Pt, ring: string): void {
    if (!this.smPrimed) return;
    const dx = pt.x - sh.x;
    const dy = pt.y - sh.y;
    const len = Math.hypot(dx, dy) || 1;
    const beam = this.ctx.view.w * 0.05;
    g.line(pt.x, pt.y, pt.x + (dx / len) * beam, pt.y + (dy / len) * beam, 8 * g.s, {
      stroke: this.beam,
    });
    g.circle(pt.x, pt.y, 34 * g.s, { stroke: ring, sw: 7 * g.s });
    g.circle(pt.x, pt.y, 16 * g.s, { fill: C.hot, stroke: C.white, sw: 3 * g.s, glow: 12 });
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.bestCombo >= COMBO_STEP) highlights.push(`콤보 ${this.bestCombo}연속!`);
    if (this.bulls >= 3) highlights.push(`정중앙 ${this.bulls}번!`);
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
}

export default (): MiniGame => new WristAimTarget();

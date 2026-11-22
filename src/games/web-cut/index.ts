// web-cut — SHAPE A (discrete trigger), but judged on the ANGLE of the stroke.
//
// The whole feel of this game is one extra gate on top of `fruit-slash`'s swept
// hit: a stroke cuts a thread only when it crosses it at 60 degrees or more.
// Dragging a hand along a thread does nothing, which is why this plays
// completely differently from a slice game even though both are swings.
//
// Both halves of a cut thread whip back to their anchors. That recoil is the
// reward; the points are bookkeeping.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame, Paint,
  PlayerPose, PlayOpts, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import type { ImpactOpts, TrailOpts } from '@/engine/fx/index';
import type { SpriteOpts } from '@/engine/render/sprite';
import { L, palm } from '@/engine/pose/landmarks';
import {
  angleDelta, clamp, clamp01, distSegPoint, easeOutQuint, hitSegCircle, limbAngle,
  segsCross, TAU,
} from '@/engine/math';
import { Entities } from '@/engine/entities';
import { chance, randRange, Spawner } from '@/engine/spawn';
import { C, fade, hue, KEYLINE } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

/** Thread kinds. */
const SILK = 0;
const GOLD = 1;
const SILK_CUT = 2;
const GOLD_CUT = 3;

/** A stroke must cross a thread at least this far off parallel to cut it.
 *  Below it the thread only wobbles — this is the whole mechanic. 45 rather
 *  than 60: a child sweeping an arm cannot hold a 30-degree window. */
const CUT_DEG = 45;
/** Seconds of whip-back after a cut. */
const RECOIL_SEC = 0.34;
/** Seconds a hand is dead after touching the spider. Quiet by design. */
const STUN_SEC = 1;
/** Seconds a thread shivers after a too-shallow pass. */
const SHIVER_SEC = 0.3;
/** Pause before the spider traps the next friend, so a rescue is not instantly
 *  undone and a strong player cannot farm rescues. */
const FOLK_GAP_SEC = 2.5;

const SILK_POINTS = 10;
const SAVE_POINTS = 50;

/** Threads live on screen until cut; this is the limit the ramp walks to. */
const THREADS_MIN = 5;
const THREADS_MAX = 12;
/** Threads holding one friend. Cut all of them and the friend is free. */
const BONDS = 3;

const HANDS = [L.LEFT_WRIST, L.RIGHT_WRIST] as const;
const SKELETON = { alpha: 0.42, emphasize: HANDS };

// Built once: update() and render() must not build objects or strings.
const SFX_BREAK: PlayOpts = { gain: 0.5 };
const SFX_TICK: PlayOpts = { gain: 0.5 };
const SFX_TRAP: PlayOpts = { gain: 0.4 };
/** Misses are quiet: one soft sound, no toast. */
const SFX_GOLD: PlayOpts = { gain: 0.22 };
const SFX_BITE: PlayOpts = { gain: 0.25 };
const TOAST_HINT = { color: C.textDim };
const TOAST_SAVED = { color: C.success, big: true };
const EV_MISS = { kind: 'miss' as const };
const FRAME_COL = fade(C.white, 0.35);
const BOND_OFF = fade(KEYLINE, 0.18);
const DEAD_COL = fade(KEYLINE, 0.35);
const SPIDER_COL = '#3A3F55';

class WebCut implements MiniGame {
  private ctx!: GameContext;
  /** One per hand: `side: 'both'` reports only the faster wrist, and either
   *  hand must be able to cut. */
  private swingL!: Detector<'swing'>;
  private swingR!: Detector<'swing'>;
  private spawner!: Spawner;

  // Allocated HERE. update() and render() allocate nothing.
  private readonly webs = new Entities(40);
  private readonly folks = new Entities(6);
  private readonly bugs = new Entities(3);
  private readonly handL: Pt = { x: 0, y: 0 };
  private readonly handR: Pt = { x: 0, y: 0 };
  /** Seconds of stun left per hand. */
  private readonly stun = new Float32Array(2);
  private readonly labels: string[] = [];
  private readonly trailCol = hue(manifest.theme?.hue ?? 266, 80, 42);
  private readonly sparkCol = hue(manifest.theme?.hue ?? 266, 80, 46);
  private readonly silkCol = '#FFFFFF';
  private readonly trailOpts: TrailOpts = { color: this.trailCol, width: 11, life: 0.2 };
  private readonly snipFx: ImpactOpts = { color: this.sparkCol, sprite: 'sparkle', label: '', dir: 0 };
  private readonly saveFx: ImpactOpts = { color: C.success, sprite: 'star', label: '' };
  private readonly evScored = { kind: 'scored' as const, points: 0 };
  private readonly pt: Paint = {};
  private readonly so: SpriteOpts = {};
  private player: PlayerPose | null = null;

  /** The reachable rect the web is strung inside, in view px. Recomputed from
   *  the player's OWN arm length every frame, so a short child is never asked
   *  to reach further than a tall one. */
  private fx0 = 0;
  private fy0 = 0;
  private fx1 = 0;
  private fy1 = 0;

  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private cuts = 0;
  private saved = 0;
  private misses = 0;
  private nextFolk = 1;
  private time = 0;
  private hintT = 0;
  private grazes = 0;
  private folkGap = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // The engine default of 3.5 shoulder-widths/sec at the wrist. A hand
    // resting in frame reads 2.6 on `fidget`, so a lower gate would let a
    // child cut the web by standing still; `swing-wide` peaks at 14.3.
    // The refractory period stays at the detector's own 200 ms: cutting a web
    // is a flurry of back-and-forth strokes and a 250 ms gate ate every second
    // one. The speed gate, hysteresis and confirm frames are all the engine's.
    this.swingL = ctx.gestures.use('swing', { side: 'L' });
    this.swingR = ctx.gestures.use('swing', { side: 'R' });
    this.spawner = new Spawner(
      // The spawner only paces REPAIRS here; the live thread count is what the
      // ramp actually controls.
      { startInterval: 1.2, endInterval: 0.5, jitter: 0.25 },
      ctx.rng,
      manifest.durationMs / 1000,
    );
    for (let i = 0; i < 80; i++) this.labels.push('+' + String(i));
    this.snipFx.label = this.labels[SILK_POINTS] ?? '';
    this.saveFx.label = this.labels[SAVE_POINTS] ?? '';
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.audio.music({ bpm: 96 });
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    if (this.hintT > 0) this.hintT = Math.max(0, this.hintT - dt);
    const p = f.p1;
    this.player = p ?? null;
    this.measureField(p);

    const d = this.spawner.difficulty;
    // "줄 재생성": the web repairs itself, and the limit it repairs up to is
    // the difficulty ramp.
    const want = THREADS_MIN + Math.round(d * (THREADS_MAX - THREADS_MIN));
    if (this.spawner.tick(dt) > 0 && this.liveThreads() < want) this.stringThread(d, -1);
    if (this.folkGap > 0) this.folkGap = Math.max(0, this.folkGap - dt);
    else if (this.folks.n === 0 || (this.folks.n < 2 && d > 0.5 && chance(this.ctx.rng, 0.01))) {
      this.trapFriend();
    }
    if (this.bugs.n === 0) this.hatchSpider();
    else if (this.bugs.n < 2 && d > 0.7 && chance(this.ctx.rng, 0.004)) this.hatchSpider();
    this.crawl(dt, d);

    if (this.stun[0]! > 0) this.stun[0] = Math.max(0, this.stun[0]! - dt);
    if (this.stun[1]! > 0) this.stun[1] = Math.max(0, this.stun[1]! - dt);
    for (let i = 0; i < this.webs.n; i++) {
      if (this.webs.data[i]! > 0) this.webs.data[i] = Math.max(0, this.webs.data[i]! - dt);
    }

    if (p) {
      palm(p, 'L', this.handL);
      palm(p, 'R', this.handR);
      const sl = this.swingL.read(f);
      if (sl.ok && sl.active && this.stun[0] === 0) {
        this.sweep(0, sl.from.x, sl.from.y, sl.to.x, sl.to.y, sl.dirDeg);
      }
      const sr = this.swingR.read(f);
      if (sr.ok && sr.active && this.stun[1] === 0) {
        this.sweep(1, sr.from.x, sr.from.y, sr.to.x, sr.to.y, sr.dirDeg);
      }
    }

    this.webs.step(dt);
    this.webs.sweep();
    this.folks.step(dt);
    this.folks.sweep();
  }

  /** The reachable play area, from this player's own calibration. */
  private measureField(p: PlayerPose | undefined): void {
    const { w, h } = this.ctx.view;
    if (!p) {
      this.fx0 = w * 0.2;
      this.fx1 = w * 0.8;
      this.fy0 = h * 0.14;
      this.fy1 = h * 0.66;
    } else {
      const sx = (p.px[L.LEFT_SHOULDER * 2]! + p.px[L.RIGHT_SHOULDER * 2]!) / 2;
      const sy = (p.px[L.LEFT_SHOULDER * 2 + 1]! + p.px[L.RIGHT_SHOULDER * 2 + 1]!) / 2;
      // armLen is shoulder-to-wrist; add half a shoulder width to get the span
      // from the shoulder CENTRE, then keep 90% of it so the far edge is a
      // stretch rather than a limit.
      const reach = (p.calib.armLen + 0.5) * p.scalePx * 0.9;
      const m = Math.min(w, h) * 0.06;
      this.fx0 = clamp(sx - reach, m, w - m);
      this.fx1 = clamp(sx + reach, m, w - m);
      this.fy0 = clamp(sy - reach * 0.85, m, h - m);
      this.fy1 = clamp(sy + reach * 0.55, m, h - m);
    }
    // Keep the web below the HUD band (goal text and timer across the top;
    // the score/combo column is handled per object by topAt()).
    if (this.fy0 < h * 0.18) this.fy0 = h * 0.18;
    if (this.fy1 < this.fy0 + h * 0.25) this.fy1 = Math.min(h * 0.96, this.fy0 + h * 0.25);
  }

  /** Highest y anything a child must see may reach at screen x. */
  private topAt(x: number): number {
    const { w, h } = this.ctx.view;
    return x < w * 0.25 ? h * 0.26 : h * 0.18;
  }

  private liveThreads(): number {
    let n = 0;
    for (let i = 0; i < this.webs.n; i++) {
      const k = this.webs.kind[i]!;
      if (k === SILK || k === GOLD) n++;
    }
    return n;
  }

  /** Hang one thread across the web field. `folk` >= 0 binds it to a friend. */
  private stringThread(d: number, folk: number): void {
    const fw = this.fx1 - this.fx0;
    const fh = this.fy1 - this.fy0;
    const span = Math.min(fw, fh);
    let cx: number;
    let cy: number;
    if (folk >= 0) {
      cx = this.folks.x[folk]! + randRange(this.ctx.rng, -span * 0.06, span * 0.06);
      cy = this.folks.y[folk]! + randRange(this.ctx.rng, -span * 0.06, span * 0.06);
    } else {
      cx = randRange(this.ctx.rng, this.fx0 + fw * 0.12, this.fx1 - fw * 0.12);
      cy = randRange(this.ctx.rng, this.fy0 + fh * 0.12, this.fy1 - fh * 0.12);
    }
    // Gold threads only once the player has the rhythm.
    const gold = folk < 0 && d > 0.35 && chance(this.ctx.rng, 0.2);
    const len = span * randRange(this.ctx.rng, 0.3, 0.42);
    const rot = this.ctx.rng() * Math.PI;
    // The upper anchor stays below the HUD band, so no thread hides under it.
    const top = this.topAt(cx) + Math.abs(Math.sin(rot)) * len;
    if (cy < top) cy = top;
    const i = this.webs.spawn(cx, cy, 0, 0, len, 1e5, gold ? GOLD : SILK);
    if (i < 0) return;
    this.webs.rot[i] = rot;
    this.webs.hp[i] = folk >= 0 ? this.folks.hp[folk]! : 0;
    // `data` is the shiver timer and nothing else; the drawing phase comes
    // from the entity's own monotonic id, which survives a sweep().
    this.webs.data[i] = 0;
  }

  private trapFriend(): void {
    const span = Math.min(this.fx1 - this.fx0, this.fy1 - this.fy0);
    const fx = randRange(this.ctx.rng, this.fx0 + span * 0.2, this.fx1 - span * 0.2);
    const fy = randRange(this.ctx.rng, this.fy0 + span * 0.2, this.fy1 - span * 0.2);
    // The bond dots ring the friend at 1.7 r: keep the whole ring out of the HUD.
    const i = this.folks.spawn(fx, Math.max(fy, this.topAt(fx) + span * 0.14 * 2), 0, 0, span * 0.14, 1e5, 0);
    if (i < 0) return;
    // `hp` on a friend is its OWN id, matched by the threads' `hp`; `data`
    // counts the bonds still holding it. Indices move on sweep(), ids do not.
    this.folks.hp[i] = this.nextFolk++;
    this.folks.data[i] = BONDS;
    for (let k = 0; k < BONDS; k++) this.stringThread(this.spawner.difficulty, i);
    this.ctx.audio.play('wobble', SFX_TRAP);
  }

  private hatchSpider(): void {
    const span = Math.min(this.fx1 - this.fx0, this.fy1 - this.fy0);
    const i = this.bugs.spawn(
      randRange(this.ctx.rng, this.fx0, this.fx1),
      randRange(this.ctx.rng, this.fy0, this.fy1),
      0, 0, span * 0.1, 1e5, 0,
    );
    if (i >= 0) this.bugs.data[i] = this.ctx.rng() * TAU;
  }

  /** Spiders sit still early and start patrolling once the ramp allows it. */
  private crawl(dt: number, d: number): void {
    const move = d > 0.4;
    const span = Math.min(this.fx1 - this.fx0, this.fy1 - this.fy0);
    for (let i = 0; i < this.bugs.n; i++) {
      const phase = this.bugs.data[i]!;
      if (move) {
        const speed = span * (0.1 + d * 0.16);
        this.bugs.x[i] = this.bugs.x[i]! + Math.cos(this.time * 0.7 + phase) * speed * dt;
        this.bugs.y[i] = this.bugs.y[i]! + Math.sin(this.time * 0.9 + phase * 1.7) * speed * dt;
      }
      // Steer back inside: a spider off-screen (or under the HUD) is a spider
      // nobody can avoid.
      this.bugs.x[i] = clamp(this.bugs.x[i]!, this.fx0, this.fx1);
      const top = Math.max(this.fy0, this.topAt(this.bugs.x[i]!) + this.bugs.r[i]!);
      this.bugs.y[i] = clamp(this.bugs.y[i]!, top, Math.max(top, this.fy1));
      this.bugs.rot[i] = Math.sin(this.time * 4 + phase) * 0.12;
    }
  }

  /** One frame of one hand's stroke against the whole web. */
  private sweep(
    side: number,
    x0: number, y0: number, x1: number, y1: number,
    dirDeg: number,
  ): void {
    this.ctx.fx.trail(x0, y0, x1, y1, this.trailOpts);

    const tol = Math.min(this.ctx.view.w, this.ctx.view.h) * 0.034;
    for (let i = 0; i < this.webs.n; i++) {
      const kind = this.webs.kind[i]!;
      if (kind !== SILK && kind !== GOLD) continue;
      const r = this.webs.r[i]!;
      const c = Math.cos(this.webs.rot[i]!);
      const s = Math.sin(this.webs.rot[i]!);
      const ax = this.webs.x[i]! - c * r;
      const ay = this.webs.y[i]! - s * r;
      const bx = this.webs.x[i]! + c * r;
      const by = this.webs.y[i]! + s * r;

      // Exact crossing, plus a little forgiveness near the ends — a child
      // aiming at a 3 px line needs the line to be thicker than it looks.
      let touched = segsCross(x0, y0, x1, y1, ax, ay, bx, by);
      if (!touched) {
        touched =
          distSegPoint(x0, y0, x1, y1, ax, ay) <= tol ||
          distSegPoint(x0, y0, x1, y1, bx, by) <= tol ||
          distSegPoint(x0, y0, x1, y1, this.webs.x[i]!, this.webs.y[i]!) <= tol;
      }
      if (!touched) continue;

      // Acute angle between the stroke and the thread, 0..90. `dirDeg` is the
      // detector's 120 ms net direction, which is far steadier than one
      // frame's difference.
      let off = Math.abs(angleDelta(limbAngle(ax, ay, bx, by), dirDeg));
      if (off > 90) off = 180 - off;
      if (off < CUT_DEG) {
        this.graze(i);
        continue;
      }
      if (kind === GOLD) this.hitGold(i);
      else this.snip(i, side);
    }

    for (let i = 0; i < this.bugs.n; i++) {
      if (!hitSegCircle(x0, y0, x1, y1, this.bugs.x[i]!, this.bugs.y[i]!, this.bugs.r[i]!)) continue;
      this.bite(side, this.bugs.x[i]!, this.bugs.y[i]!);
      return;
    }
  }

  /** Too shallow: the thread shivers and nothing else happens. The hint only
   *  appears after several shallow passes, so it teaches without nagging. */
  private graze(i: number): void {
    this.webs.data[i] = SHIVER_SEC;
    if (this.hintT > 0) return;
    this.grazes++;
    if (this.grazes % 6 !== 0) return;
    this.hintT = 2.4;
    this.ctx.hud.toast(t('slide'), TOAST_HINT);
  }

  private snip(i: number, side: number): void {
    const x = this.webs.x[i]!;
    const y = this.webs.y[i]!;
    const folk = this.webs.hp[i]!;
    // Keep the entity alive for the recoil; `kind` takes it out of collision.
    this.webs.kind[i] = SILK_CUT;
    this.webs.life[i] = RECOIL_SEC;
    this.webs.life0[i] = RECOIL_SEC;

    this.cuts++;
    this.combo++;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    this.score += SILK_POINTS;

    this.snipFx.dir = side === 0 ? Math.PI : 0;
    this.ctx.fx.impact(x, y, 'hit', this.snipFx);
    this.ctx.audio.play('break', SFX_BREAK);
    this.ctx.audio.playLadder('pop.high', this.combo);
    this.ctx.hud.setScore(this.score);
    this.ctx.hud.setCombo(this.combo);
    this.evScored.points = SILK_POINTS;
    this.ctx.emit(this.evScored);

    if (folk > 0) this.loosen(folk);
  }

  private loosen(folkId: number): void {
    for (let i = 0; i < this.folks.n; i++) {
      if (this.folks.hp[i] !== folkId) continue;
      this.folks.data[i] = this.folks.data[i]! - 1;
      if (this.folks.data[i]! > 0) {
        this.ctx.audio.play('ui.tick', SFX_TICK);
        return;
      }
      const x = this.folks.x[i]!;
      const y = this.folks.y[i]!;
      this.folks.kill(i);
      this.saved++;
      this.folkGap = FOLK_GAP_SEC;
      this.score += SAVE_POINTS;
      this.ctx.fx.impact(x, y, 'big', this.saveFx);
      this.ctx.audio.play('bonus');
      this.ctx.hud.toast(t('saved'), TOAST_SAVED);
      this.ctx.hud.setScore(this.score);
      this.evScored.points = SAVE_POINTS;
      this.ctx.emit(this.evScored);
      return;
    }
  }

  /** Cutting a gold thread is the mistake, so it does snap — but quietly: no
   *  score change, no shake, no red, no toast. The lost combo is the feedback. */
  private hitGold(i: number): void {
    const x = this.webs.x[i]!;
    const y = this.webs.y[i]!;
    this.webs.kind[i] = GOLD_CUT;
    this.webs.life[i] = RECOIL_SEC;
    this.webs.life0[i] = RECOIL_SEC;
    this.misses++;
    this.combo = 0;
    this.ctx.hud.setCombo(0);
    this.ctx.fx.miss(x, y);
    this.ctx.audio.play('thud', SFX_GOLD);
    this.ctx.emit(EV_MISS);
  }

  private bite(side: number, x: number, y: number): void {
    if (this.stun[side]! > 0) return;
    this.stun[side] = STUN_SEC;
    this.combo = 0;
    this.ctx.hud.setCombo(0);
    this.ctx.fx.miss(x, y);
    this.ctx.audio.play('wobble', SFX_BITE);
    this.ctx.emit(EV_MISS);
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    // The web frame, so the play area reads as a thing rather than as empty air.
    g.roundRect(this.fx0, this.fy0, this.fx1 - this.fx0, this.fy1 - this.fy0, 18 * g.s,
      this.paint(undefined, FRAME_COL, 4 * g.s));

    for (let i = 0; i < this.folks.n; i++) {
      const x = this.folks.x[i]!;
      const y = this.folks.y[i]!;
      const r = this.folks.r[i]!;
      const left = this.folks.data[i]!;
      // Bonds remaining as a ring of dots: a count, not a colour.
      for (let k = 0; k < BONDS; k++) {
        const a = -Math.PI / 2 + (k / BONDS) * TAU;
        g.circle(x + Math.cos(a) * r * 1.7, y + Math.sin(a) * r * 1.7, 9 * g.s,
          this.paint(k < left ? C.warn : BOND_OFF, undefined, 0));
      }
      this.so.rot = Math.sin(g.t * 2 + x) * 0.08;
      g.sprite('bee', x, y, r * 2.6, this.so);
    }

    for (let i = 0; i < this.webs.n; i++) {
      const kind = this.webs.kind[i]!;
      const r = this.webs.r[i]!;
      const c = Math.cos(this.webs.rot[i]!);
      const s = Math.sin(this.webs.rot[i]!);
      const cx = this.webs.x[i]!;
      const cy = this.webs.y[i]!;
      const ax = cx - c * r;
      const ay = cy - s * r;
      const bx = cx + c * r;
      const by = cy + s * r;
      const gold = kind === GOLD || kind === GOLD_CUT;
      const col = gold ? C.accent : this.silkCol;

      if (kind === SILK_CUT || kind === GOLD_CUT) {
        // SNAP. Both halves whip back toward their anchors, which is the
        // whole payoff of the game.
        const k = easeOutQuint(clamp01(this.webs.age(i)));
        const keep = 1 - k * 0.92;
        const curl = Math.sin(k * Math.PI) * r * 0.3;
        g.save();
        g.alpha(1 - k * 0.65);
        const pc = this.paint(undefined, col, 0);
        g.line(ax, ay, ax + c * r * keep - s * curl, ay + s * r * keep + c * curl, 9 * g.s, pc);
        g.line(bx, by, bx - c * r * keep + s * curl, by - s * r * keep - c * curl, 9 * g.s, pc);
        g.restore();
        continue;
      }

      // A live thread. The anchors are fixed, so a too-shallow pass shows up
      // as the MIDDLE shivering: the thread was touched and held.
      const amp = (this.webs.data[i]! / SHIVER_SEC) * 14 * g.s;
      const buzz = amp > 0 ? Math.sin(g.t * 40 + this.webs.id[i]!) * amp : 0;
      const mx = cx - s * buzz;
      const my = cy + c * buzz;
      const sw = (gold ? 10 : 8) * g.s;
      // Dark underlay, then the bright silk: a thin light line vanishes on a
      // bright background, a keyed one does not.
      const pk = this.paint(undefined, KEYLINE, 0);
      g.line(ax, ay, mx, my, sw + 5 * g.s, pk);
      g.line(mx, my, bx, by, sw + 5 * g.s, pk);
      const ps = this.paint(undefined, col, 0);
      g.line(ax, ay, mx, my, sw, ps);
      g.line(mx, my, bx, by, sw, ps);
      const pd = this.paint(KEYLINE, undefined, 0);
      g.circle(ax, ay, 9 * g.s, pd);
      g.circle(bx, by, 9 * g.s, pd);
      if (gold) {
        // Shape as well as colour: ART.md forbids leaning on gold-vs-grey
        // alone, and one child per class cannot tell them apart.
        g.sprite('cross', cx, cy, 52 * g.s);
      } else {
        // Which way to swipe. A telegraph is information, not decoration.
        const perp = this.webs.rot[i]! + Math.PI / 2;
        g.save();
        g.alpha(0.75);
        const pf = this.paint(KEYLINE, undefined, 0);
        g.chevron(cx + Math.cos(perp) * r * 0.26, cy + Math.sin(perp) * r * 0.26, 16 * g.s, -perp, pf);
        g.chevron(cx - Math.cos(perp) * r * 0.26, cy - Math.sin(perp) * r * 0.26, 16 * g.s, Math.PI - perp, pf);
        g.restore();
      }
    }

    // Spiders: drawn from primitives, with no face. ART.md §2.5 — a face on
    // something a child must avoid reads as "the cute one you must not hit".
    for (let i = 0; i < this.bugs.n; i++) {
      const x = this.bugs.x[i]!;
      const y = this.bugs.y[i]!;
      const r = this.bugs.r[i]!;
      const wob = this.bugs.rot[i]!;
      for (let k = 0; k < 8; k++) {
        const a = -Math.PI + (k / 7) * TAU * 0.5 + wob * (k % 2 === 0 ? 1 : -1);
        const sgn = k < 4 ? -1 : 1;
        const mx = x + Math.cos(a) * r * 1.2 * sgn;
        const my = y + Math.sin(a) * r * 0.9 - r * 0.2;
        const pl = this.paint(undefined, KEYLINE, 0);
        g.line(x, y, mx, my, 4 * g.s, pl);
        g.line(mx, my, mx + sgn * r * 0.3, my + r * 0.7, 4 * g.s, pl);
      }
      const pb = this.paint(SPIDER_COL, KEYLINE, 4 * g.s);
      g.circle(x, y, r * 0.78, pb);
      g.circle(x, y - r * 0.72, r * 0.42, pb);
    }

    // Always draw the body.
    if (this.player) {
      g.ghostBody(this.player, 0.09);
      g.skeleton(this.player, SKELETON);
    }

    for (let s = 0; s < 2; s++) {
      const h = s === 0 ? this.handL : this.handR;
      const dead = this.stun[s]! > 0;
      g.circle(h.x, h.y, (dead ? 13 : 20) * g.s,
        this.paint(undefined, dead ? DEAD_COL : this.trailCol, (dead ? 3 : 4) * g.s, dead ? 0 : 10));
      if (dead) {
        const k = this.stun[s]! / STUN_SEC;
        g.arc(h.x, h.y, 22 * g.s, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - k),
          this.paint(undefined, C.textDim, 4 * g.s));
      }
    }
  }

  /** The one reusable Paint: render() builds no objects. */
  private paint(fill: string | undefined, stroke: string | undefined, sw: number, glow = 0): Paint {
    const pt = this.pt;
    pt.fill = fill;
    pt.stroke = stroke;
    pt.sw = sw;
    pt.glow = glow;
    return pt;
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.saved > 0) highlights.push(`친구 ${this.saved}명 구했어요`);
    if (this.bestCombo >= 6) highlights.push(`콤보 ${this.bestCombo}연속!`);
    return {
      gameId: manifest.id,
      cleared: this.cuts > 0,
      rawScore: this.score,
      maxScore: manifest.scoring.maxScore,
      normalized: 0,
      stars: 0,
      durationMs: manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score: this.score,
        hits: this.cuts, misses: this.misses, bestCombo: this.bestCombo,
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }

  dispose(): void {
    this.ctx.audio.stopMusic();
    this.webs.clear();
    this.folks.clear();
    this.bugs.clear();
  }
}

export default (): MiniGame => new WebCut();

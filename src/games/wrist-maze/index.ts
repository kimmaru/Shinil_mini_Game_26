// ─── Precision trace: carry the light orb along a winding track ─────────────
//
// The hand's position is tested against the corridor every frame, with no
// discrete gesture anywhere. Read AGENTS.md + docs/GAME_AUTHORING.md +
// src/games/candy-rain-catch/ (continuous overlap) before touching this.
//
// Fairness: every maze is laid out in units of THIS player's own arm length
// (S), measured out from the shoulder of the hand that must trace it, so the
// whole track sits inside that hand's reach whatever the child's size or
// distance. The hand alternates maze to maze (right, left, right...) which
// also spreads the load across both arms.
//
// Forgiveness: stepping off the track does not wipe the run. There is a short
// grace, then the orb drops and the child restarts from the last checkpoint.
// No sound, no flash, no counter: the orb simply lets go.
//
// See NEEDS.md for why the aim smoothing below is hand-rolled rather than a
// per-game `steady` One Euro preset: the hook does not exist.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { L, jx, jy } from '@/engine/pose/landmarks';
import { approach, clamp01, dist } from '@/engine/math';
import { C, fade, hue, KEYLINE } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

/** approach() rate for the extra aim smoothing, ~90 ms time constant. */
const SMOOTH_RATE = 10;
/** The collision test is this many times the drawn corridor's half-width. */
const COLLISION_SLACK = 1.12;
/** Seconds the hand may be off the track before the orb drops. */
const GRACE = 0.3;
const TRAIL_LEN = 14;
const MAX_PTS = 5;
const MAX_SPUR = 3;
const MAZE_COUNT = 6;
const CELEBRATE_SEC = 1.0;
/** Seconds on one maze before it quietly moves on to the next. */
const MAZE_TIMEOUT = 14;
const HANDS = [L.LEFT_WRIST, L.RIGHT_WRIST] as const;
/** Colours built once: render() must not build strings. */
const WARN80 = fade(C.warn, 0.8);

interface MazeDef {
  /** Centreline in arm-length units (S): x outward from the tracing hand's
   *  own shoulder, y down from it. Everything is inside 0.9 S. */
  pts: readonly (readonly [number, number])[];
  /** Optional dead-end branch: same wall rule, leads nowhere. */
  spur?: readonly (readonly [number, number])[];
  /** Full corridor width in S. Never below 8.5% of the view width. */
  width: number;
  /** A barrier that periodically closes the track partway along. */
  gate?: { at: number; period: number; open: number; close: number };
  /** A strong-but-not-perfect finish time, for the speed bonus. */
  par: number;
}

const DEFS: readonly MazeDef[] = [
  // A gentle outward lane with one small hump: the tutorial.
  { pts: [[0.30, 0.10], [0.55, -0.12], [0.85, 0.08]], width: 0.62, par: 6 },
  // A real wave plus a dead end that goes nowhere.
  {
    pts: [[0.30, 0.38], [0.45, -0.32], [0.65, 0.25], [0.85, -0.28]],
    spur: [[0.65, 0.25], [0.55, 0.6]],
    width: 0.56, par: 8,
  },
  // A C-shape with a barrier that opens and closes.
  {
    pts: [[0.85, -0.38], [0.52, -0.3], [0.52, 0.2], [0.85, 0.34]],
    width: 0.54, par: 9,
    gate: { at: 0.5, period: 2.8, open: 1.9, close: 0.6 },
  },
];

class WristMaze implements MiniGame {
  private ctx!: GameContext;
  private reach!: Detector<'reach'>;

  private readonly smL: Pt = { x: 0, y: 0 };
  private readonly smR: Pt = { x: 0, y: 0 };
  private smPrimed = false;
  private readonly shL: Pt = { x: 0, y: 0 };
  private readonly shR: Pt = { x: 0, y: 0 };
  private armPx = 0;
  private player: PlayerPose | null = null;
  private time = 0;
  private cFloor = '';
  private cFill = '';
  private cTrail = '';
  private cOrb = '';
  private cCore = '';

  // ── The current maze, rebuilt in place for each one. ──
  private readonly path = new Float32Array(MAX_PTS * 2);
  private readonly cum = new Float32Array(MAX_PTS);
  private n = 0;
  private total = 0;
  private readonly spur = new Float32Array(MAX_SPUR * 2);
  private readonly spurCum = new Float32Array(MAX_SPUR);
  private sn = 0;
  private hw = 0;
  private startR = 0;
  private hasGate = false;
  private gateX = 0;
  private gateY = 0;
  private gatePeriod = 1;
  private gateOpen = 1;
  private gateClose = 1;
  private gateFrac = 0;
  private readonly ckX = new Float32Array(3);
  private readonly ckY = new Float32Array(3);
  private readonly ckS = new Float32Array(3);
  private par = 8;

  private mazeIdx = 0;
  private ready = false;
  private wait = 0.8;
  private hand: 0 | 1 = 1;
  private armed = false;
  private ckIdx = 0;
  private bestS = 0;
  private outT = 0;
  private mazeClock = 0;
  private celebrate = 0;
  private readonly cur: Pt = { x: 0, y: 0 };
  private readonly proj = { s: 0, d: 0 };
  private readonly projSpur = { s: 0, d: 0 };

  private readonly trailX = new Float32Array(TRAIL_LEN);
  private readonly trailY = new Float32Array(TRAIL_LEN);
  private trailHead = 0;
  private trailCount = 0;

  private score = 0;
  private clears = 0;
  private falls = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    const th = manifest.theme?.hue ?? 168;
    this.cFloor = hue(th, 55, 90);
    this.cFill = hue(th, 80, 62);
    this.cTrail = hue(th, 80, 60, 0.6);
    this.cOrb = hue(th, 85, 45);
    this.cCore = hue(th, 85, 55);
    this.reach = ctx.gestures.use('reach', { side: 'both' });
    const { w, h } = ctx.view;
    this.shL.x = w * 0.44; this.shR.x = w * 0.56;
    this.shL.y = h * 0.42; this.shR.y = h * 0.42;
    this.armPx = Math.min(w, h) * 0.3;
    this.smL.x = w * 0.4; this.smL.y = h * 0.6;
    this.smR.x = w * 0.6; this.smR.y = h * 0.6;
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    if (this.celebrate > 0) this.celebrate = Math.max(0, this.celebrate - dt);

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

    if (this.mazeIdx >= MAZE_COUNT) return;
    if (!this.ready) {
      this.wait -= dt;
      if (this.wait <= 0 && p) this.build();
      return;
    }
    this.mazeClock += dt;
    if (this.mazeClock > MAZE_TIMEOUT) {
      this.skip();
      return;
    }
    if (sig.ok) this.stepMaze(dt);
  }

  /** Out of time on this maze: move on without a sound or a counter. A maze a
   *  child cannot finish must never eat the rest of the round. */
  private skip(): void {
    this.mazeIdx++;
    this.ready = false;
    this.armed = false;
    this.trailCount = 0;
    this.wait = 0.6;
    if (this.mazeIdx >= MAZE_COUNT) this.ctx.emit({ kind: 'clearEarly' });
  }

  onResize(): void {
    // Re-fit the current maze to the new view; its progress restarts.
    if (this.ready) {
      this.ready = false;
      this.armed = false;
      this.wait = 0;
    }
  }

  /** Lay maze `mazeIdx` out around the tracing hand's own shoulder. */
  private build(): void {
    const def = DEFS[this.mazeIdx % DEFS.length]!;
    const lap = Math.floor(this.mazeIdx / DEFS.length);
    // Right hand first, then alternate. Lap 2 flips every maze's hand.
    this.hand = this.mazeIdx % 2 === 0 ? 1 : 0;
    const sh = this.hand === 0 ? this.shL : this.shR;
    const out = this.hand === 0 ? -1 : 1;
    const S = this.armPx;
    const { w } = this.ctx.view;

    const { h } = this.ctx.view;
    this.n = def.pts.length;
    this.sn = def.spur ? def.spur.length : 0;

    // Fit the whole corridor on screen and inside the HUD safe area: shrink
    // the maze if it is simply too big (a child close to the camera), then
    // slide it toward the middle. Sliding inward only ever brings the track
    // nearer the body, so it stays in reach. Without this a child standing a
    // hand's width off centre at 1.2 m gets a finish line off the screen.
    let scale = 1;
    let dx = 0;
    let dy = 0;
    for (let pass = 0; ; pass++) {
      const k = S * scale;
      // Corridor: arm-length based, never under 8.5% of the view width; each
      // lap trims 10%, but the floor still holds.
      this.hw = Math.max(w * 0.085, def.width * k * (1 - 0.1 * lap)) / 2;
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (let i = 0; i < this.n + this.sn; i++) {
        const pt = i < this.n ? def.pts[i]! : def.spur![i - this.n]!;
        const x = sh.x + out * pt[0] * k;
        const y = sh.y + pt[1] * k;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      x0 -= this.hw; x1 += this.hw; y0 -= this.hw; y1 += this.hw;
      const xLo = w * 0.03;
      const xHi = w * 0.97;
      const yHi = h * 0.97;
      dx = x0 < xLo ? xLo - x0 : x1 > xHi ? xHi - x1 : 0;
      // Under the score column (left quarter) the safe top is deeper.
      const yLo = h * (x0 + dx < w * 0.25 ? 0.26 : 0.18);
      dy = y0 < yLo ? yLo - y0 : y1 > yHi ? yHi - y1 : 0;
      const fit = Math.min((xHi - xLo) / (x1 - x0), (yHi - yLo) / (y1 - y0));
      // The last pass keeps whatever it measured, so hw/dx/dy always match `scale`.
      if (fit >= 1 || pass === 2) break;
      scale *= fit * 0.98;
    }
    const k = S * scale;
    for (let i = 0; i < this.n; i++) {
      this.path[i * 2] = sh.x + out * def.pts[i]![0] * k + dx;
      this.path[i * 2 + 1] = sh.y + def.pts[i]![1] * k + dy;
    }
    this.total = this.accumulate(this.path, this.n, this.cum);
    for (let i = 0; i < this.sn; i++) {
      this.spur[i * 2] = sh.x + out * def.spur![i]![0] * k + dx;
      this.spur[i * 2 + 1] = sh.y + def.spur![i]![1] * k + dy;
    }
    if (this.sn > 0) this.accumulate(this.spur, this.sn, this.spurCum);
    this.startR = this.hw * 1.5;
    this.par = def.par;

    this.hasGate = def.gate !== undefined;
    if (def.gate) {
      this.pointAt(def.gate.at * this.total, this.cur);
      this.gateX = this.cur.x;
      this.gateY = this.cur.y;
      this.gatePeriod = def.gate.period;
      this.gateOpen = def.gate.open;
      this.gateClose = def.gate.close;
    }
    for (let k = 0; k < 3; k++) {
      this.ckS[k] = (this.total * k) / 3;
      this.pointAt(this.ckS[k]!, this.cur);
      this.ckX[k] = this.cur.x;
      this.ckY[k] = this.cur.y;
    }

    this.ready = true;
    this.armed = false;
    this.ckIdx = 0;
    this.bestS = 0;
    this.outT = 0;
    this.mazeClock = 0;
    this.gateFrac = 0;
    this.trailCount = 0;
    this.trailHead = 0;
    this.ctx.hud.toast(this.hand === 0 ? t('useLeft') : t('useRight'), { color: C.info });
  }

  private accumulate(pts: Float32Array, n: number, out: Float32Array): number {
    out[0] = 0;
    let acc = 0;
    for (let i = 1; i < n; i++) {
      acc += Math.hypot(pts[i * 2]! - pts[i * 2 - 2]!, pts[i * 2 + 1]! - pts[i * 2 - 1]!);
      out[i] = acc;
    }
    return acc;
  }

  /** Point on the main centreline at arc length `s`. */
  private pointAt(s: number, out: Pt): void {
    let i = 0;
    while (i < this.n - 2 && this.cum[i + 1]! < s) i++;
    const len = this.cum[i + 1]! - this.cum[i]!;
    const k = len > 1e-6 ? clamp01((s - this.cum[i]!) / len) : 0;
    out.x = this.path[i * 2]! + (this.path[i * 2 + 2]! - this.path[i * 2]!) * k;
    out.y = this.path[i * 2 + 1]! + (this.path[i * 2 + 3]! - this.path[i * 2 + 1]!) * k;
  }

  /** Closest point on a polyline: perpendicular distance and arc length. */
  private project(
    px: number, py: number, pts: Float32Array, n: number, cum: Float32Array,
    out: { s: number; d: number },
  ): void {
    let bestD = Infinity;
    let bestS = 0;
    for (let i = 0; i < n - 1; i++) {
      const x0 = pts[i * 2]!;
      const y0 = pts[i * 2 + 1]!;
      const dx = pts[i * 2 + 2]! - x0;
      const dy = pts[i * 2 + 3]! - y0;
      const len2 = dx * dx + dy * dy;
      let k = len2 < 1e-6 ? 0 : ((px - x0) * dx + (py - y0) * dy) / len2;
      k = k < 0 ? 0 : k > 1 ? 1 : k;
      const d = Math.hypot(px - (x0 + dx * k), py - (y0 + dy * k));
      if (d < bestD) {
        bestD = d;
        bestS = cum[i]! + k * Math.sqrt(len2);
      }
    }
    out.s = bestS;
    out.d = bestD;
  }

  private stepMaze(dt: number): void {
    const hp = this.hand === 0 ? this.smL : this.smR;

    if (!this.armed) {
      // Pick the orb up at the start, or at the last checkpoint after a drop.
      if (dist(hp.x, hp.y, this.ckX[this.ckIdx]!, this.ckY[this.ckIdx]!) > this.startR) return;
      this.armed = true;
      this.outT = 0;
      this.trailCount = 0;
      this.trailHead = 0;
      this.ctx.audio.play('sparkle', { gain: 0.3 });
    }

    this.cur.x = hp.x;
    this.cur.y = hp.y;
    this.trailX[this.trailHead] = hp.x;
    this.trailY[this.trailHead] = hp.y;
    this.trailHead = (this.trailHead + 1) % TRAIL_LEN;
    if (this.trailCount < TRAIL_LEN) this.trailCount++;

    const eff = this.hw * COLLISION_SLACK;
    this.project(hp.x, hp.y, this.path, this.n, this.cum, this.proj);
    let inside = this.proj.d <= eff;
    if (!inside && this.sn > 0) {
      this.project(hp.x, hp.y, this.spur, this.sn, this.spurCum, this.projSpur);
      inside = this.projSpur.d <= eff;
    }

    let blocked = false;
    if (this.hasGate) {
      const ph = this.mazeClock % this.gatePeriod;
      if (ph >= this.gateOpen) {
        const ct = ph - this.gateOpen;
        const tele = this.gateClose * 0.4;
        this.gateFrac = clamp01((ct - tele) / Math.max(1e-3, this.gateClose - tele));
        const gr = this.hw * this.gateFrac * 0.95;
        blocked = gr > 1 && dist(hp.x, hp.y, this.gateX, this.gateY) <= gr;
      } else {
        this.gateFrac = 0;
      }
    }

    if (!inside || blocked) {
      this.outT += dt;
      if (blocked || this.outT > GRACE) this.drop();
      return;
    }
    this.outT = 0;

    // Progress only counts when the hand is on the main track and not jumping
    // far ahead (two arms of a bend can sit close together).
    if (this.proj.d <= eff && this.proj.s > this.bestS && this.proj.s < this.bestS + this.total * 0.45) {
      this.bestS = this.proj.s;
      while (this.ckIdx < 2 && this.bestS >= this.ckS[this.ckIdx + 1]!) {
        this.ckIdx++;
        this.score += 4;
        this.ctx.hud.setScore(this.score);
        this.ctx.audio.playLadder('pop', this.ckIdx * 2);
        this.ctx.fx.pop(this.ckX[this.ckIdx]!, this.ckY[this.ckIdx]!, this.hw, C.success);
      }
    }

    const gx = this.path[(this.n - 1) * 2]!;
    const gy = this.path[(this.n - 1) * 2 + 1]!;
    if (this.bestS >= this.total * 0.85 && dist(hp.x, hp.y, gx, gy) <= this.hw * 1.2) this.complete(gx, gy);
  }

  /** The orb lets go. Deliberately silent: no sound, no shake, no flash. */
  private drop(): void {
    this.armed = false;
    this.falls++;
    this.outT = 0;
    this.ctx.fx.miss(this.cur.x, this.cur.y);
  }

  private complete(gx: number, gy: number): void {
    const used = this.mazeClock;
    // Three speed tiers, so the floating label is always exactly the score.
    const fast = used <= this.par * 0.7;
    const points = fast ? 35 : used <= this.par ? 28 : 20;
    this.score += points;
    this.clears++;
    this.celebrate = CELEBRATE_SEC;
    this.ctx.fx.impact(gx, gy, 'big', { color: C.accent, sprite: 'star', label: fast ? LABEL_FAST : points === 28 ? LABEL_MID : LABEL_OK });
    this.ctx.audio.play('chime');
    this.ctx.hud.toast(t('clear'), { color: C.success });
    this.ctx.hud.setScore(this.score);
    this.ctx.emit({ kind: 'scored', points });

    this.mazeIdx++;
    this.ready = false;
    this.armed = false;
    this.wait = CELEBRATE_SEC;
    if (this.mazeIdx >= MAZE_COUNT) {
      this.ctx.hud.toast(t('all'), { color: C.accent, big: true });
      this.ctx.emit({ kind: 'clearEarly' });
    }
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);
    if (this.player) {
      g.ghostBody(this.player, 0.1);
      g.skeleton(this.player, { alpha: 0.5, emphasize: HANDS });
    }
    if (this.ready) this.drawMaze(g);

    // Trail behind the orb: lit gold for a moment after a clear.
    const lit = this.celebrate > 0;
    for (let k = 0; k < this.trailCount; k++) {
      const idx = (this.trailHead - 1 - k + TRAIL_LEN * 2) % TRAIL_LEN;
      const age = k / TRAIL_LEN;
      g.circle(this.trailX[idx]!, this.trailY[idx]!, (16 - age * 11) * g.s, {
        fill: lit ? C.accentHi : this.cTrail,
      });
    }

    const hp = this.hand === 0 ? this.smL : this.smR;
    if (this.ready && this.armed) {
      g.circle(hp.x, hp.y, 30 * g.s, { fill: C.white, stroke: this.cOrb, sw: 7 * g.s, glow: 16 });
      g.circle(hp.x, hp.y, 12 * g.s, { fill: this.cCore });
    } else if (this.ready) {
      // "Put THIS hand on the start": a pulsing ring on the right palm.
      const pulse = 1 + 0.12 * Math.sin(this.time * 7);
      g.circle(hp.x, hp.y, 34 * g.s * pulse, {
        stroke: this.hand === 0 ? C.slot[0] : C.slot[1], sw: 7 * g.s, glow: 8,
      });
    }
  }

  private drawMaze(g: Renderer): void {
    const w2 = this.hw * 2;
    const floor = this.cFloor;
    // Outline first (one fat dark line per segment), then the pale floor.
    for (let i = 0; i < this.n - 1; i++) {
      g.line(this.path[i * 2]!, this.path[i * 2 + 1]!, this.path[i * 2 + 2]!, this.path[i * 2 + 3]!,
        w2 + 14 * g.s, { stroke: KEYLINE });
    }
    for (let i = 0; i < this.sn - 1; i++) {
      g.line(this.spur[i * 2]!, this.spur[i * 2 + 1]!, this.spur[i * 2 + 2]!, this.spur[i * 2 + 3]!,
        w2 + 14 * g.s, { stroke: KEYLINE });
    }
    for (let i = 0; i < this.n - 1; i++) {
      g.line(this.path[i * 2]!, this.path[i * 2 + 1]!, this.path[i * 2 + 2]!, this.path[i * 2 + 3]!,
        w2, { stroke: floor });
    }
    for (let i = 0; i < this.sn - 1; i++) {
      g.line(this.spur[i * 2]!, this.spur[i * 2 + 1]!, this.spur[i * 2 + 2]!, this.spur[i * 2 + 3]!,
        w2, { stroke: floor });
    }

    // Progress: the part already travelled fills with colour.
    const fill = this.cFill;
    for (let i = 0; i < this.n - 1; i++) {
      if (this.cum[i]! >= this.bestS) break;
      const segEnd = this.cum[i + 1]!;
      const k = segEnd <= this.bestS ? 1 : (this.bestS - this.cum[i]!) / (segEnd - this.cum[i]!);
      const x0 = this.path[i * 2]!;
      const y0 = this.path[i * 2 + 1]!;
      g.line(x0, y0, x0 + (this.path[i * 2 + 2]! - x0) * k, y0 + (this.path[i * 2 + 3]! - y0) * k,
        w2 * 0.5, { stroke: fill });
    }

    // Checkpoints (flags as dots) and the finish.
    for (let k = 1; k < 3; k++) {
      g.circle(this.ckX[k]!, this.ckY[k]!, this.hw * 0.3, {
        fill: this.ckIdx >= k ? C.success : C.white, stroke: KEYLINE, sw: 4 * g.s,
      });
    }
    const gx = this.path[(this.n - 1) * 2]!;
    const gy = this.path[(this.n - 1) * 2 + 1]!;
    g.sprite('star', gx, gy, this.hw * 2.1, { glow: 10 });

    // The start: a pulsing ring with its label, until the orb is picked up.
    const sx = this.ckX[this.ckIdx]!;
    const sy = this.ckY[this.ckIdx]!;
    if (!this.armed) {
      const pulse = 1 + 0.08 * Math.sin(this.time * 6);
      g.circle(sx, sy, this.startR * 0.8 * pulse, {
        stroke: this.hand === 0 ? C.slot[0] : C.slot[1], sw: 8 * g.s,
      });
      // Above the start ring, unless that would put it under the DOM HUD.
      const above = sy - this.startR - 30 * g.s;
      const safeTop = g.h * (sx < g.w * 0.25 ? 0.26 : 0.18) + 24 * g.s;
      const ly = above < safeTop ? sy + this.startR + 30 * g.s : above;
      g.text(this.hand === 0 ? t('startLeft') : t('startRight'), sx, ly, {
        size: 48 * g.s, weight: 800, align: 'center', baseline: 'middle',
        fill: this.hand === 0 ? C.slot[0] : C.slot[1], stroke: C.white, sw: 8 * g.s,
      });
    } else {
      g.circle(this.path[0]!, this.path[1]!, this.hw * 0.4, { fill: C.info, stroke: KEYLINE, sw: 4 * g.s });
    }

    if (this.hasGate && this.gateFrac > 0.02) {
      const r = this.hw * this.gateFrac * 0.95;
      g.circle(this.gateX, this.gateY, r, {
        fill: this.gateFrac > 0.75 ? C.danger : C.warn, stroke: KEYLINE, sw: 5 * g.s,
      });
    } else if (this.hasGate) {
      g.circle(this.gateX, this.gateY, this.hw * 0.35, { stroke: C.warn, sw: 6 * g.s });
    }
    // One thin pulse so the gate's next close is never a surprise.
    if (this.hasGate && this.gateFrac === 0) {
      const ph = this.mazeClock % this.gatePeriod;
      if (ph > this.gateOpen - 0.5) {
        g.circle(this.gateX, this.gateY, this.hw * 0.7, { stroke: WARN80, sw: 5 * g.s });
      }
    }
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.clears >= MAZE_COUNT) highlights.push(`미로 ${MAZE_COUNT}개 전부 통과!`);
    else if (this.clears > 0) highlights.push(`미로 ${this.clears}개 통과`);
    return {
      gameId: manifest.id,
      cleared: this.clears > 0,
      rawScore: this.score,
      maxScore: manifest.scoring.maxScore,
      normalized: 0,
      stars: 0,
      durationMs: manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score: this.score,
        hits: this.clears, misses: this.falls, bestCombo: 0,
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }
}

/** Pre-built so the clear path builds no string. */
const LABEL_FAST = '+35';
const LABEL_MID = '+28';
const LABEL_OK = '+20';

export default (): MiniGame => new WristMaze();


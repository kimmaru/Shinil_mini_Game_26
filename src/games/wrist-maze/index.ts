// ─── Precision trace: stay inside a winding corridor to the goal ────────────
//
// The filtering litmus test for this batch: the hand's px position is tested
// against the corridor width every frame, with no discrete gesture anywhere.
// Read AGENTS.md + docs/GAME_AUTHORING.md + src/games/candy-rain-catch/
// (continuous overlap, the closest existing shape) before touching this.
//
// See NEEDS.md for why the aim smoothing below is hand-rolled rather than a
// per-game `steady` One Euro preset — the hook does not exist yet.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Pt, Renderer,
} from '@/engine/types';
import { L } from '@/engine/pose/landmarks';
import { approach, clamp01, dist } from '@/engine/math';
import { C, fade, hue, KEYLINE } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

/** approach() rate for the extra aim smoothing — ~90ms time constant. See
 *  the file header and NEEDS.md. */
const SMOOTH_RATE = 10;
/** The collision test is this many times the drawn corridor's half-width, a
 *  flat forgiving margin on top of an already-generous corridor. */
const COLLISION_SLACK = 1.15;
const TRAIL_LEN = 42;
const HANDS = [L.LEFT_WRIST, L.RIGHT_WRIST] as const;

interface MazeDef {
  /** Centreline, as 0..1 fractions of the view. */
  points: readonly (readonly [number, number])[];
  /** An optional dead-end branch off the main path — same wall rule, leads
   *  nowhere. */
  spur?: readonly (readonly [number, number])[];
  /** Full corridor width, as a fraction of VIEW WIDTH. Never below 0.10. */
  widthFrac: number;
  /** A periodic barrier partway along the path. */
  gate?: { atFrac: number; period: number; openSec: number; closeSec: number };
  /** This maze must be driven by whichever hand did NOT finish maze 0. */
  forceOpposite?: boolean;
}

const MAZE_DEFS: readonly MazeDef[] = [
  // Maze 1: gentle single wave, generous width — also the dev-clip baseline.
  {
    points: [[0.20, 0.50], [0.42, 0.42], [0.58, 0.58], [0.80, 0.50]],
    widthFrac: 0.17,
  },
  // Maze 2: a real curve plus a dead end that goes nowhere.
  {
    points: [[0.18, 0.62], [0.32, 0.37], [0.48, 0.58], [0.63, 0.34], [0.80, 0.52]],
    spur: [[0.48, 0.58], [0.46, 0.80]],
    widthFrac: 0.14,
  },
  // Maze 3: narrower (still above the 10% floor), a moving gate, and the
  // hand that sat out maze 1.
  {
    points: [[0.82, 0.58], [0.66, 0.34], [0.50, 0.56], [0.34, 0.32], [0.18, 0.50]],
    widthFrac: 0.115,
    gate: { atFrac: 0.52, period: 2.6, openSec: 1.7, closeSec: 0.6 },
    forceOpposite: true,
  },
];

/** A strong-but-not-perfect finish time per maze, for the speed bonus. */
const PAR_SEC = [6, 8, 10] as const;

interface MazeRuntime {
  pathPx: Float32Array;
  segCount: number;
  cumLen: Float32Array;
  totalLen: number;
  spurPx: Float32Array | null;
  spurSegCount: number;
  spurCumLen: Float32Array | null;
  halfWidthPx: number;
  gate: { x: number; y: number; period: number; openSec: number; closeSec: number } | null;
  forceOpposite: boolean;
  startX: number;
  startY: number;
  goalX: number;
  goalY: number;
}

/** Cumulative arc length at each vertex, built once per maze in init(). */
function buildCumLen(path: Float32Array, n: number, out: Float32Array): number {
  out[0] = 0;
  let acc = 0;
  for (let i = 1; i < n; i++) {
    acc += Math.hypot(path[i * 2]! - path[i * 2 - 2]!, path[i * 2 + 1]! - path[i * 2 - 1]!);
    out[i] = acc;
  }
  return acc;
}

function buildMazeRuntime(def: MazeDef, viewW: number, viewH: number): MazeRuntime {
  const n = def.points.length;
  const pathPx = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    pathPx[i * 2] = def.points[i]![0] * viewW;
    pathPx[i * 2 + 1] = def.points[i]![1] * viewH;
  }
  const cumLen = new Float32Array(n);
  const totalLen = buildCumLen(pathPx, n, cumLen);

  let spurPx: Float32Array | null = null;
  let spurCumLen: Float32Array | null = null;
  let spurSegCount = 0;
  if (def.spur) {
    const sn = def.spur.length;
    spurPx = new Float32Array(sn * 2);
    for (let i = 0; i < sn; i++) {
      spurPx[i * 2] = def.spur[i]![0] * viewW;
      spurPx[i * 2 + 1] = def.spur[i]![1] * viewH;
    }
    spurCumLen = new Float32Array(sn);
    buildCumLen(spurPx, sn, spurCumLen);
    spurSegCount = sn - 1;
  }

  let gate: MazeRuntime['gate'] = null;
  if (def.gate) {
    const target = def.gate.atFrac * totalLen;
    let seg = 0;
    while (seg < n - 2 && cumLen[seg + 1]! < target) seg++;
    const segLen = cumLen[seg + 1]! - cumLen[seg]!;
    const tt = segLen > 1e-6 ? (target - cumLen[seg]!) / segLen : 0;
    gate = {
      x: pathPx[seg * 2]! + (pathPx[seg * 2 + 2]! - pathPx[seg * 2]!) * tt,
      y: pathPx[seg * 2 + 1]! + (pathPx[seg * 2 + 3]! - pathPx[seg * 2 + 1]!) * tt,
      period: def.gate.period,
      openSec: def.gate.openSec,
      closeSec: def.gate.closeSec,
    };
  }

  return {
    pathPx, segCount: n - 1, cumLen, totalLen,
    spurPx, spurSegCount, spurCumLen,
    halfWidthPx: (def.widthFrac * viewW) / 2,
    gate,
    forceOpposite: def.forceOpposite === true,
    startX: pathPx[0]!, startY: pathPx[1]!,
    goalX: pathPx[(n - 1) * 2]!, goalY: pathPx[(n - 1) * 2 + 1]!,
  };
}

/** Closest point on a polyline: both the perpendicular distance and the arc
 *  length to it. Zero allocation — writes into `out`. */
function projectOntoPolyline(
  px: number, py: number,
  path: Float32Array, segCount: number, cumLen: Float32Array,
  out: { s: number; d: number },
): void {
  let bestD = Infinity;
  let bestS = 0;
  for (let i = 0; i < segCount; i++) {
    const x0 = path[i * 2]!;
    const y0 = path[i * 2 + 1]!;
    const x1 = path[i * 2 + 2]!;
    const y1 = path[i * 2 + 3]!;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    let tt = len2 < 1e-6 ? 0 : ((px - x0) * dx + (py - y0) * dy) / len2;
    tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
    const cx = x0 + dx * tt;
    const cy = y0 + dy * tt;
    const d = Math.hypot(px - cx, py - cy);
    if (d < bestD) {
      bestD = d;
      bestS = cumLen[i]! + tt * Math.sqrt(len2);
    }
  }
  out.s = bestS;
  out.d = bestD;
}

class WristMaze implements MiniGame {
  private ctx!: GameContext;
  private reach!: Detector<'reach'>;
  private mazes: MazeRuntime[] = [];

  private readonly smL: Pt = { x: 0, y: 0 };
  private readonly smR: Pt = { x: 0, y: 0 };
  private smPrimed = false;
  private readonly cur: Pt = { x: 0, y: 0 };
  private readonly proj = { s: 0, d: 0 };
  private readonly projSpur = { s: 0, d: 0 };

  private readonly trailX = new Float32Array(TRAIL_LEN);
  private readonly trailY = new Float32Array(TRAIL_LEN);
  private trailHead = 0;
  private trailCount = 0;

  private player: PlayerPose | null = null;
  private time = 0;

  private mazeIndex = 0;
  private armed = false;
  private controllingHand: 0 | 1 = 0;
  private firstHand: 0 | 1 = 0;
  private bestS = 0;
  private milestones = 0;
  private mazeStartClock = 0;
  private gateClosedFrac = 0;
  private celebrateT = 0;

  private score = 0;
  private clears = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.reach = ctx.gestures.use('reach', { side: 'both' });
    this.mazes = MAZE_DEFS.map((def) => buildMazeRuntime(def, ctx.view.w, ctx.view.h));
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    if (this.celebrateT > 0) this.celebrateT = Math.max(0, this.celebrateT - dt);

    const p = f.p1;
    this.player = p ?? null;

    const sig = this.reach.read(f);
    if (sig.ok) {
      if (!this.smPrimed) {
        this.smL.x = sig.leftPalm.x;
        this.smL.y = sig.leftPalm.y;
        this.smR.x = sig.rightPalm.x;
        this.smR.y = sig.rightPalm.y;
        this.smPrimed = true;
      } else {
        this.smL.x = approach(this.smL.x, sig.leftPalm.x, SMOOTH_RATE, dt);
        this.smL.y = approach(this.smL.y, sig.leftPalm.y, SMOOTH_RATE, dt);
        this.smR.x = approach(this.smR.x, sig.rightPalm.x, SMOOTH_RATE, dt);
        this.smR.y = approach(this.smR.y, sig.rightPalm.y, SMOOTH_RATE, dt);
      }
    }

    if (sig.ok && this.mazeIndex < this.mazes.length) this.stepMaze();
  }

  private stepMaze(): void {
    const maze = this.mazes[this.mazeIndex]!;

    if (!this.armed) {
      const startR = maze.halfWidthPx * 1.4;
      const candidates: readonly (0 | 1)[] = maze.forceOpposite
        ? [this.firstHand === 0 ? 1 : 0]
        : [0, 1];
      for (const h of candidates) {
        const hp = h === 0 ? this.smL : this.smR;
        if (dist(hp.x, hp.y, maze.startX, maze.startY) <= startR) {
          this.armed = true;
          this.controllingHand = h;
          this.mazeStartClock = this.time;
          this.trailCount = 0;
          this.trailHead = 0;
          break;
        }
      }
      if (!this.armed) return;
    }

    const hp = this.controllingHand === 0 ? this.smL : this.smR;
    this.cur.x = hp.x;
    this.cur.y = hp.y;

    this.trailX[this.trailHead] = this.cur.x;
    this.trailY[this.trailHead] = this.cur.y;
    this.trailHead = (this.trailHead + 1) % TRAIL_LEN;
    if (this.trailCount < TRAIL_LEN) this.trailCount++;

    projectOntoPolyline(this.cur.x, this.cur.y, maze.pathPx, maze.segCount, maze.cumLen, this.proj);
    const effHalf = maze.halfWidthPx * COLLISION_SLACK;
    const insideMain = this.proj.d <= effHalf;
    let insideSpur = false;
    if (maze.spurPx && maze.spurCumLen) {
      projectOntoPolyline(this.cur.x, this.cur.y, maze.spurPx, maze.spurSegCount, maze.spurCumLen, this.projSpur);
      insideSpur = this.projSpur.d <= effHalf;
    }

    let gateBlocked = false;
    if (maze.gate) {
      const ph = this.time % maze.gate.period;
      if (ph >= maze.gate.openSec) {
        const closT = ph - maze.gate.openSec;
        const telegraphSec = maze.gate.closeSec * 0.4;
        const span = Math.max(1e-3, maze.gate.closeSec - telegraphSec);
        this.gateClosedFrac = clamp01((closT - telegraphSec) / span);
        const gateR = maze.halfWidthPx * this.gateClosedFrac * 0.92;
        if (gateR > 1 && dist(this.cur.x, this.cur.y, maze.gate.x, maze.gate.y) <= gateR) gateBlocked = true;
      } else {
        this.gateClosedFrac = 0;
      }
    }

    if (!((insideMain || insideSpur) && !gateBlocked)) {
      // Quiet, instant retry — no shake, no flash, no penalty beyond losing
      // the run back to the start marker.
      this.ctx.fx.miss(this.cur.x, this.cur.y);
      this.armed = false;
      return;
    }

    if (insideMain && this.proj.s > this.bestS) {
      this.bestS = this.proj.s;
      this.creditMilestones(maze);
    }

    if (dist(this.cur.x, this.cur.y, maze.goalX, maze.goalY) <= maze.halfWidthPx * 1.3) {
      this.completeMaze();
    }
  }

  private creditMilestones(maze: MazeRuntime): void {
    const frac = maze.totalLen > 0 ? this.bestS / maze.totalLen : 0;
    const steps: readonly [number, number][] = [[0.25, 1], [0.5, 2], [0.75, 4]];
    for (const [f, bit] of steps) {
      if (frac >= f && !(this.milestones & bit)) {
        this.milestones |= bit;
        this.score += 3;
        this.ctx.hud.setScore(this.score);
        this.ctx.audio.play('score.tick', { gain: 0.5 });
      }
    }
  }

  private completeMaze(): void {
    const usedSec = this.time - this.mazeStartClock;
    const parSec = PAR_SEC[this.mazeIndex] ?? 8;
    const speedBonus = Math.round(Math.min(Math.max(parSec - usedSec, 0), parSec) * 2);
    const points = 25 + speedBonus;
    this.score += points;
    this.clears++;
    this.celebrateT = 0.9;

    const maze = this.mazes[this.mazeIndex]!;
    this.ctx.fx.impact(maze.goalX, maze.goalY, 'big', {
      color: C.success, sprite: 'star', label: `+${points}`,
    });
    this.ctx.audio.play('chime');
    this.ctx.hud.toast(t('clear'), { color: C.success });
    this.ctx.hud.setScore(this.score);
    this.ctx.emit({ kind: 'scored', points });

    if (this.mazeIndex === 0) this.firstHand = this.controllingHand;
    this.mazeIndex++;
    this.armed = false;
    this.bestS = 0;
    this.milestones = 0;
    this.gateClosedFrac = 0;

    if (this.mazeIndex < this.mazes.length && this.mazes[this.mazeIndex]!.forceOpposite) {
      this.ctx.hud.toast(t('oppositeHand'), { color: C.info });
    }
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    if (this.mazeIndex < this.mazes.length) this.drawMaze(g, this.mazes[this.mazeIndex]!);

    // The trail: faint normally, and set alight on the frame a maze clears.
    const lit = this.celebrateT > 0;
    for (let k = 0; k < this.trailCount; k++) {
      const idx = (this.trailHead - 1 - k + TRAIL_LEN * 2) % TRAIL_LEN;
      const age = k / TRAIL_LEN;
      g.circle(this.trailX[idx]!, this.trailY[idx]!, (7 - age * 5) * g.s, {
        fill: lit ? hue(manifest.theme?.hue ?? 168, 85, 72) : fade(C.white, (1 - age) * 0.5),
        glow: lit ? 10 : 0,
      });
    }

    if (this.player) g.ghostBody(this.player, 0.08);
    if (this.player) g.skeleton(this.player, { alpha: 0.35, emphasize: HANDS });

    if (this.mazeIndex < this.mazes.length) {
      const maze = this.mazes[this.mazeIndex]!;
      if (this.armed) {
        const hp = this.controllingHand === 0 ? this.smL : this.smR;
        g.circle(hp.x, hp.y, 15 * g.s, {
          fill: hue(manifest.theme?.hue ?? 168, 80, 72), stroke: C.white, sw: 3 * g.s, glow: 16,
        });
      } else {
        const onlyHand = maze.forceOpposite ? (this.firstHand === 0 ? 1 : 0) : -1;
        this.drawHandHint(g, this.smL, onlyHand === -1 || onlyHand === 0);
        this.drawHandHint(g, this.smR, onlyHand === -1 || onlyHand === 1);
      }
    }
  }

  private drawMaze(g: Renderer, maze: MazeRuntime): void {
    const hw = maze.halfWidthPx;
    this.drawFloor(g, maze.pathPx, maze.segCount, hw, 0.35);
    if (maze.spurPx) this.drawFloor(g, maze.spurPx, maze.spurSegCount, hw, 0.22);
    this.drawRails(g, maze.pathPx, maze.segCount, hw);
    if (maze.spurPx) this.drawRails(g, maze.spurPx, maze.spurSegCount, hw);

    g.circle(maze.startX, maze.startY, hw * 1.25, { stroke: C.info, sw: 3 * g.s });
    g.sprite('star', maze.goalX, maze.goalY, hw * 1.6);

    if (maze.gate) {
      const r = hw * this.gateClosedFrac * 0.92;
      if (r > 1) {
        g.circle(maze.gate.x, maze.gate.y, r, {
          fill: hue(this.gateClosedFrac > 0.75 ? 8 : 42, 80, 55), stroke: KEYLINE, sw: 3 * g.s,
        });
      } else {
        g.circle(maze.gate.x, maze.gate.y, hw * 0.3, { stroke: fade(C.warn, 0.6), sw: 2 * g.s });
      }
    }
  }

  private drawFloor(g: Renderer, path: Float32Array, segCount: number, hw: number, alpha: number): void {
    for (let i = 0; i < segCount; i++) {
      g.line(
        path[i * 2]!, path[i * 2 + 1]!, path[i * 2 + 2]!, path[i * 2 + 3]!,
        hw * 2, { stroke: fade(hue(manifest.theme?.hue ?? 168, 55, 85), alpha) },
      );
    }
  }

  private drawRails(g: Renderer, path: Float32Array, segCount: number, hw: number): void {
    for (let i = 0; i < segCount; i++) {
      const x0 = path[i * 2]!;
      const y0 = path[i * 2 + 1]!;
      const x1 = path[i * 2 + 2]!;
      const y1 = path[i * 2 + 3]!;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      g.line(x0 + nx * hw, y0 + ny * hw, x1 + nx * hw, y1 + ny * hw, 4 * g.s, { stroke: KEYLINE });
      g.line(x0 - nx * hw, y0 - ny * hw, x1 - nx * hw, y1 - ny * hw, 4 * g.s, { stroke: KEYLINE });
    }
  }

  private drawHandHint(g: Renderer, p: Pt, allowed: boolean): void {
    g.circle(p.x, p.y, 13 * g.s, {
      stroke: allowed ? fade(C.white, 0.7) : fade(C.white, 0.2),
      sw: (allowed ? 3 : 2) * g.s,
      glow: allowed ? 8 : 0,
    });
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.clears >= this.mazes.length) highlights.push('미로 3개 전부 통과!');
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
        hits: this.clears, misses: 0, bestCombo: 0,
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }
}

export default (): MiniGame => new WristMaze();

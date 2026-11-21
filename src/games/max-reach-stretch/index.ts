// MAX-REACH-STRETCH (쭉쭉 스트레칭) — Shape B variant: reach, then HOLD.
//
// A star appears at the end of one arm's reach; the child stretches that arm
// out to it and holds for a moment. Sides alternate; now and then two stars
// ask for both arms at once.
//
// FAIRNESS is the whole point of this game (docs/GAME_AUTHORING.md §5). Every
// star is placed from THIS child's own calibrated arm length, at 90-95% of it,
// measured from their own shoulder, in shoulder-width units — and the hit also
// requires the reach detector's extension (shoulder-to-wrist / own armLen) to
// be at least ~0.85. A short child and a tall child stretch exactly as hard.
// No position on screen is ever fixed.
import type {
  Detector, EndReason, GameContext, GameEvent, GameResult, MiniGame, Paint,
  PlayerPose, PlayOpts, PoseFrame, Renderer, SignalOf, SkeletonOpts, TextOpts,
} from '@/engine/types';
import type { ImpactOpts } from '@/engine/fx/index';
import type { SpriteOpts } from '@/engine/render/sprite';
import { L, MIN_VIS } from '@/engine/pose/landmarks';
import { approach, clamp, clamp01, easeOutBack, lerp } from '@/engine/math';
import { C, KEYLINE, fade, hue, hueDark } from '@/engine/render/palette';
import { manifest } from './manifest';
import { perfectLine, stretchLine, t } from './locale';

// ─── Where stars go ─────────────────────────────────────────────────────────
// Directions in degrees, measured OUTWARD from the shoulder: 0 = straight out
// to the side, 90 = straight up, negative = below shoulder height. Straight
// down is never used: a resting arm already hangs there.
const BUCKET_LO = [48, 18, -6, -36, 72] as const;
const BUCKET_HI = [62, 34, 10, -22, 80] as const;
const B_HIGH = 0;
const B_LEVEL = 2;
const B_OVERHEAD = 4;
const NBUCKET = 5;
/** Never turned outside this while fitting a star on screen. */
const ANG_MIN = -40;
const ANG_MAX = 84;

/** The palm sits this far past the wrist, shoulder widths. Stars are placed
 *  for the PALM, extension is judged at the WRIST (as the detector measures). */
const PALM_OFF = 0.25;
/** Reach fraction a fresh star asks for, from the first star to the last. */
const FRAC_START = 0.9;
const FRAC_END = 0.95;
/** An unreached star drifts in to this fraction, so nobody is stuck. */
const FRAC_KIND = 0.8;
/** Extension may fall this far short of the star's own fraction. */
const EXT_SLACK = 0.08;
/** Extension that earns the "all the way" bonus. */
const EXT_PERFECT = 0.97;

// ─── Pacing ─────────────────────────────────────────────────────────────────
const ST_WAIT = 0;
const ST_ACTIVE = 1;
const ST_REST = 2;
/** Seconds of hold to complete a stretch, rising gently through the round. */
const HOLD_START = 0.8;
const HOLD_END = 1.1;
/** A star waits this long before it starts drifting closer, then gives up. */
const KIND_AT = 2.5;
const LIFE = 5;
const REST = 0.6;
/** Every Nth stretch is a two-arm one (Y or T), once the child has the idea. */
const BOTH_EVERY = 5;

const PTS = 10;
const PTS_BOTH = 20;
const PTS_PERFECT = 5;
const LABELS = ['+10', '+15', '+20', '+25'] as const;

const HANDS = [L.LEFT_WRIST, L.RIGHT_WRIST] as const;
const SKELETON: SkeletonOpts = { alpha: 0.55, emphasize: HANDS };
const TOAST_GOLD = { color: C.accent };
const HOLD_SFX: PlayOpts = { gain: 0.35 };
const EV_MISS: GameEvent = { kind: 'miss' };
const SUN_HUE = 42;
/** The theme's dark shade at an alpha. init() only: it builds a string. */
const hsla = (h: number, a: number): string => hue(h, 72, 28, a);

class MaxReachStretch implements MiniGame {
  private ctx!: GameContext;
  private reach!: Detector<'reach'>;
  private player: PlayerPose | null = null;

  // ── Smoothed shoulders (view px), so stars do not jitter with the landmarks.
  private readonly shX = new Float32Array(2);
  private readonly shY = new Float32Array(2);
  private shReady = false;
  private armLen = 1.6;
  private scale = 100;

  // ── The active star(s): at most two, one per arm. Slot index = side (0 L, 1 R).
  private readonly on = new Uint8Array(2);
  private readonly ang = new Float32Array(2);
  private readonly tx = new Float32Array(2);
  private readonly ty = new Float32Array(2);
  private readonly need = new Float32Array(2);
  private readonly inside = new Uint8Array(2);
  private readonly extOk = new Uint8Array(2);
  private readonly ext = new Float32Array(2);
  private readonly palmX = new Float32Array(2);
  private readonly palmY = new Float32Array(2);
  private fx = 0;
  private fy = 0;
  /** A star had to be pulled well inside the reach to fit on screen. */
  private tooClose = false;
  private frac0 = FRAC_START;
  private frac = FRAC_START;
  private both = false;
  private r = 40;
  private holdNeed = HOLD_START;

  private state = ST_WAIT;
  private stateT = 0;
  private hold = 0;
  private bestExt = 0;
  private nextSide = 0;
  private lastBucket = -1;
  private spawned = 0;
  private beeped = 0;

  private score = 0;
  private combo = 0;
  private best = 0;
  private hits = 0;
  private misses = 0;
  private perfects = 0;
  private time = 0;
  private sunPop = 0;

  // ── Cached colours and reusable draw options (no allocation per frame).
  private colGuide = '';
  private colHalo = '';
  private colHaloEdge = '';
  private colCloudEdge = '';
  private colHaloOn = '';
  private colCloud = '';
  private colRay = '';
  private colHand = '';
  private colTip = '';
  private colHandIdle = '';
  private colHaloHold = '';
  private readonly pt: Paint = {};
  private readonly to: TextOpts = {};
  private readonly so: SpriteOpts = {};
  private readonly imp: ImpactOpts = {};
  private readonly evScored = { kind: 'scored' as const, points: 0 };

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.reach = ctx.gestures.use('reach', { side: 'both' });
    const h = manifest.theme?.hue ?? 168;
    // The in-game sky is a pale wash of the theme hue, so anything a child must
    // see is drawn in the theme's DARK shade, never in white.
    this.colGuide = hsla(h, 0.55);
    this.colHalo = fade(C.white, 0.7);
    this.colHaloEdge = hueDark(h);
    this.colHaloOn = C.success;
    this.colCloud = fade(C.white, 0.9);
    this.colCloudEdge = hsla(h, 0.2);
    this.colRay = hue(SUN_HUE, 90, 60);
    this.colHand = hue(h, 80, 40);
    this.colTip = hueDark(h);
    this.colHandIdle = hsla(h, 0.45);
    this.colHaloHold = fade(C.white, 0.8);
    // A view-relative radius: 8%+ of the view width across, whatever the body.
    this.r = Math.max(ctx.view.w * 0.042, Math.min(ctx.view.w, ctx.view.h) * 0.07);
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    // Unhurried, like a morning stretch.
    this.ctx.audio.music({ bpm: 92 });
  }

  // ─── Update ───────────────────────────────────────────────────────────────

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    this.stateT += dt;
    if (this.sunPop > 0) this.sunPop = Math.max(0, this.sunPop - dt * 2);

    const p = f.p1;
    this.player = p ?? null;
    if (p) this.readBody(p, this.reach.read(f), dt);

    if (this.state === ST_WAIT) {
      if (p && this.shReady && this.stateT >= 0.8) this.spawn();
    } else if (this.state === ST_REST) {
      if (p && this.stateT >= REST) this.spawn();
    } else {
      this.tickActive(dt);
    }
  }

  private get progress(): number {
    return clamp01(this.time / (manifest.durationMs / 1000));
  }

  private readBody(p: PlayerPose, sig: SignalOf<'reach'>, dt: number): void {
    const lx = p.px[L.LEFT_SHOULDER * 2]!;
    const ly = p.px[L.LEFT_SHOULDER * 2 + 1]!;
    const rx = p.px[L.RIGHT_SHOULDER * 2]!;
    const ry = p.px[L.RIGHT_SHOULDER * 2 + 1]!;
    if (!this.shReady) {
      this.shX[0] = lx; this.shY[0] = ly; this.shX[1] = rx; this.shY[1] = ry;
      this.shReady = true;
    } else {
      this.shX[0] = approach(this.shX[0]!, lx, 10, dt);
      this.shY[0] = approach(this.shY[0]!, ly, 10, dt);
      this.shX[1] = approach(this.shX[1]!, rx, 10, dt);
      this.shY[1] = approach(this.shY[1]!, ry, 10, dt);
    }
    // Own arm length, sanity-clamped: an implausibly long one would put stars
    // out of reach, which is the one failure this game must never have.
    this.armLen = clamp(p.calib.armLen > 0.5 ? p.calib.armLen : 1.6, 1.1, 1.9);
    this.scale = Math.max(20, p.scalePx);
    this.palmX[0] = sig.leftPalm.x;
    this.palmY[0] = sig.leftPalm.y;
    this.palmX[1] = sig.rightPalm.x;
    this.palmY[1] = sig.rightPalm.y;
    this.ext[0] = p.vis[L.LEFT_WRIST]! >= MIN_VIS ? sig.leftExtend : 0;
    this.ext[1] = p.vis[L.RIGHT_WRIST]! >= MIN_VIS ? sig.rightExtend : 0;
  }

  // ─── Stars ────────────────────────────────────────────────────────────────

  private spawn(): void {
    const d = this.progress;
    const rng = this.ctx.rng;
    this.state = ST_ACTIVE;
    this.stateT = 0;
    this.hold = 0;
    this.bestExt = 0;
    this.beeped = 0;
    this.frac0 = lerp(FRAC_START, FRAC_END, d);
    this.frac = this.frac0;
    this.holdNeed = lerp(HOLD_START, HOLD_END, d);
    this.spawned++;
    this.on[0] = this.on[1] = 0;

    this.both = this.spawned % BOTH_EVERY === 0;
    if (this.both) {
      // Y or T: symmetric, so neither side does more work.
      const b = rng() < 0.5 ? B_HIGH : B_LEVEL;
      const a = lerp(BUCKET_LO[b]!, BUCKET_HI[b]!, rng());
      this.ang[0] = this.ang[1] = a;
      this.on[0] = this.on[1] = 1;
      this.lastBucket = b;
    } else {
      // A new direction every time. Overhead is the tiring one: at most every
      // third star, never twice running, and its hold is no longer than others.
      const flat = NBUCKET - 1;
      let b = Math.floor(rng() * flat);
      if (b === this.lastBucket) b = (b + 1 + Math.floor(rng() * (flat - 1))) % flat;
      if (this.spawned % 3 === 0 && this.lastBucket !== B_OVERHEAD && rng() < 0.5) b = B_OVERHEAD;
      const side = this.nextSide;
      this.nextSide = 1 - side;
      this.ang[side] = lerp(BUCKET_LO[b]!, BUCKET_HI[b]!, rng());
      this.on[side] = 1;
      this.lastBucket = b;
    }
    this.fitAngles();
    this.place();
  }

  /**
   * Keep the star on screen WITHOUT shortening the reach: when the chosen
   * direction runs off an edge (a child standing close, a high star over a
   * tall child) turn it toward one that fits at the same distance. Only when
   * no direction fits does place() fall back to pulling the star in — and
   * then it asks for no more extension than the star's real distance.
   */
  private fitAngles(): void {
    for (let s = 0; s < 2; s++) {
      if (!this.on[s] || this.fits(s, this.ang[s]!)) continue;
      const a0 = this.ang[s]!;
      for (let k = 1; k <= 20; k++) {
        const a = a0 + (k % 2 === 1 ? -1 : 1) * Math.ceil(k / 2) * 6;
        if (a < ANG_MIN || a > ANG_MAX) continue;
        if (this.fits(s, a) && (!this.both || this.fits(1 - s, a))) {
          this.ang[s] = a;
          if (this.both) this.ang[1 - s] = a;
          break;
        }
      }
    }
  }

  private fits(s: number, angDeg: number): boolean {
    this.starAt(s, angDeg);
    const { w, h } = this.ctx.view;
    const m = this.r * 1.1;
    return this.fx >= m && this.fx <= w - m && this.fy >= m + h * 0.06 && this.fy <= h - m;
  }

  /** Unclamped star centre for side `s` at `angDeg`, into fx/fy. */
  private starAt(s: number, angDeg: number): void {
    // Which way is "outward" for each arm comes from the shoulders themselves,
    // so stars stay correct whether or not the view is mirrored.
    const outL = this.shX[0]! <= this.shX[1]! ? -1 : 1;
    const out = s === 0 ? outL : -outL;
    const a = (angDeg * Math.PI) / 180;
    const dist = (this.frac * this.armLen + PALM_OFF) * this.scale;
    this.fx = this.shX[s]! + Math.cos(a) * out * dist;
    this.fy = this.shY[s]! - Math.sin(a) * dist;
  }

  /** Star positions from the smoothed shoulders and the current fraction. */
  private place(): void {
    const { w, h } = this.ctx.view;
    const m = this.r * 1.1;
    this.tooClose = false;
    for (let s = 0; s < 2; s++) {
      if (!this.on[s]) continue;
      this.starAt(s, this.ang[s]!);
      const x = clamp(this.fx, m, w - m);
      const y = clamp(this.fy, m + h * 0.06, h - m);
      this.tx[s] = x;
      this.ty[s] = y;
      // A star pulled in by the screen edge asks only for the reach it is at.
      const actual = Math.hypot(x - this.shX[s]!, y - this.shY[s]!) / this.scale;
      this.need[s] = clamp((actual - PALM_OFF) / this.armLen - EXT_SLACK, 0.5, this.frac - EXT_SLACK);
      // Pulled in a lot: the child is too close for a full stretch. Say so.
      if (actual < (this.frac * this.armLen + PALM_OFF) * 0.8) this.tooClose = true;
    }
  }

  private tickActive(dt: number): void {
    // Kindness: a star nobody reaches drifts a little closer.
    if (this.stateT > KIND_AT) {
      this.frac = lerp(this.frac0, FRAC_KIND, clamp01((this.stateT - KIND_AT) / 2));
    }
    this.place();

    let all = true;
    let minExt = 9;
    const rHit = this.r * 1.15;
    for (let s = 0; s < 2; s++) {
      if (!this.on[s]) continue;
      const dx = this.palmX[s]! - this.tx[s]!;
      const dy = this.palmY[s]! - this.ty[s]!;
      const e = this.ext[s]!;
      this.inside[s] = this.player !== null && e > 0 && dx * dx + dy * dy <= rHit * rHit ? 1 : 0;
      this.extOk[s] = e >= this.need[s]! ? 1 : 0;
      if (!this.inside[s] || !this.extOk[s]) all = false;
      if (e < minExt) minExt = e;
    }

    if (all) {
      this.hold += dt;
      if (minExt > this.bestExt) this.bestExt = minExt;
      // A soft tick at the halfway mark: "keep going, it is counting".
      if (this.beeped === 0 && this.hold >= this.holdNeed * 0.5) {
        this.beeped = 1;
        this.ctx.audio.play('ui.tick', HOLD_SFX);
      }
    } else {
      // Slipping off for a moment does not throw the stretch away.
      this.hold = Math.max(0, this.hold - dt * 1.2);
    }

    if (this.hold >= this.holdNeed) this.complete();
    else if (this.stateT >= LIFE) this.timeout();
  }

  private complete(): void {
    const perfect = this.bestExt >= EXT_PERFECT;
    const pts = (this.both ? PTS_BOTH : PTS) + (perfect ? PTS_PERFECT : 0);
    this.score += pts;
    this.hits++;
    this.combo++;
    if (this.combo > this.best) this.best = this.combo;
    if (perfect) this.perfects++;
    this.sunPop = 1;

    const imp = this.imp;
    imp.color = perfect ? C.accent : C.success;
    imp.sprite = 'star';
    imp.label = LABELS[(this.both ? 2 : 0) + (perfect ? 1 : 0)];
    for (let s = 0; s < 2; s++) {
      if (!this.on[s]) continue;
      this.ctx.fx.impact(this.tx[s]!, this.ty[s]!, this.both || perfect ? 'big' : 'hit', imp);
      imp.label = undefined; // one score label per stretch, not per star
    }
    this.ctx.audio.playLadder('pop.high', this.combo);
    if (this.both) {
      this.ctx.audio.play('chime');
      this.ctx.hud.toast(t('both'), TOAST_GOLD);
    } else if (perfect) {
      this.ctx.hud.toast(t('perfect'), TOAST_GOLD);
    } else if (this.combo % 4 === 0) {
      this.ctx.hud.toast(t('nice'), TOAST_GOLD);
    }
    if (this.combo % 5 === 0) this.ctx.audio.play('combo.up');
    this.ctx.hud.setScore(this.score);
    this.ctx.hud.setCombo(this.combo);
    this.evScored.points = pts;
    this.ctx.emit(this.evScored);
    this.state = ST_REST;
    this.stateT = 0;
  }

  /** Quiet: the star fades, the combo resets, nothing else. */
  private timeout(): void {
    this.misses++;
    this.combo = 0;
    this.ctx.hud.setCombo(0);
    this.ctx.emit(EV_MISS);
    this.state = ST_REST;
    this.stateT = 0;
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);
    this.drawSky(g);

    const p = this.player;
    if (p) {
      g.ghostBody(p, 0.14);
      g.skeleton(p, SKELETON);
    }

    if (this.state === ST_ACTIVE) {
      for (let s = 0; s < 2; s++) if (this.on[s]) this.drawStar(g, s);
      if (this.tooClose) {
        g.text(t('stepBack'), g.w / 2, g.h * 0.12, this.text(40 * g.s, this.colTip, C.white));
      }
    }

    if (p) {
      const hr = 24 * g.s;
      for (let s = 0; s < 2; s++) {
        if (this.ext[s]! <= 0) continue;
        const live = this.state === ST_ACTIVE && this.on[s] === 1;
        g.circle(this.palmX[s]!, this.palmY[s]!, hr,
          this.paint(live ? C.white : undefined, live ? this.colHand : this.colHandIdle,
            (live ? 5 : 3) * g.s));
      }
    }
  }

  private paint(fill: string | undefined, stroke: string | undefined, sw: number, glow = 0): Paint {
    const pt = this.pt;
    pt.fill = fill;
    pt.stroke = stroke;
    pt.sw = sw;
    pt.glow = glow;
    pt.glowColor = undefined;
    return pt;
  }

  private text(size: number, fill: string, stroke: string | undefined): TextOpts {
    const o = this.to;
    o.size = size;
    o.weight = 800;
    o.align = 'center';
    o.baseline = 'middle';
    o.fill = fill;
    o.stroke = stroke;
    o.sw = stroke ? 6 * (size / 40) : 0;
    o.display = true;
    return o;
  }

  /** A smiling sun that stretches its rays when you finish, and two clouds. */
  private drawSky(g: Renderer): void {
    for (let i = 0; i < 2; i++) {
      const span = g.w + 360 * g.s;
      const x = ((g.t * (14 + i * 6) * g.s + i * span * 0.55) % span) - 180 * g.s;
      const y = g.h * (0.2 + i * 0.13);
      const c = 46 * g.s * (1 - i * 0.25);
      const col = this.paint(this.colCloud, this.colCloudEdge, 2 * g.s);
      g.circle(x - c * 0.9, y + c * 0.25, c * 0.7, col);
      g.circle(x + c * 0.9, y + c * 0.25, c * 0.7, col);
      g.circle(x, y, c, col);
    }

    const sx = g.w * 0.9;
    const sy = g.h * 0.17;
    const R = 54 * g.s;
    const pop = easeOutBack(1 - this.sunPop) * this.sunPop;
    g.save();
    g.translate(sx, sy);
    g.rotate(g.t * 0.25);
    g.star(0, 0, R * (1.55 + pop * 0.35), 12, this.paint(this.colRay, undefined, 0));
    g.restore();
    g.circle(sx, sy, R, this.paint(C.accent, KEYLINE, 4 * g.s));
    g.circle(sx - R * 0.34, sy - R * 0.12, R * 0.11, this.paint(C.ink, undefined, 0));
    g.circle(sx + R * 0.34, sy - R * 0.12, R * 0.11, this.paint(C.ink, undefined, 0));
    g.arc(sx, sy + R * 0.1, R * 0.36, 0.15 * Math.PI, 0.85 * Math.PI,
      this.paint(undefined, C.ink, 3.5 * g.s));
  }

  private drawStar(g: Renderer, s: number): void {
    const x = this.tx[s]!;
    const y = this.ty[s]!;
    const r = this.r;
    const enter = easeOutBack(clamp01(this.stateT / 0.35));
    const fadeOut = this.stateT > LIFE - 0.5 ? clamp01((LIFE - this.stateT) / 0.5) : 1;
    const holding = this.inside[s] === 1 && this.extOk[s] === 1;
    const k = clamp01(this.hold / this.holdNeed);

    // The stretch line: dots from this arm's shoulder out to its star.
    const sx = this.shX[s]!;
    const sy = this.shY[s]!;
    const col = this.paint(this.colGuide, undefined, 0);
    for (let i = 1; i <= 6; i++) {
      const u = i / 7;
      g.circle(sx + (x - sx) * u, sy + (y - sy) * u, (4 + i * 0.9) * g.s * enter, col);
    }

    g.save();
    g.alpha(fadeOut);
    g.circle(x, y, r * enter, this.paint(holding ? this.colHaloHold : this.colHalo,
      holding ? this.colHaloOn : this.colHaloEdge, (holding ? 6 : 4) * g.s, holding ? 12 : 8));
    const so = this.so;
    so.rot = Math.sin(g.t * 2 + s) * 0.18;
    g.sprite('star', x, y, r * 1.5 * enter * (1 + 0.12 * k), so);
    if (k > 0.01) {
      // The hold gauge: the only way a child knows the stretch is counting.
      const a0 = -Math.PI / 2;
      g.arc(x, y, r * 1.12, a0, a0 + Math.PI * 2 * k, this.paint(undefined, C.success, 9 * g.s));
    }
    g.restore();

    if (this.inside[s] === 1) {
      // Above the star, unless that would leave the screen: then below it.
      const ty = y - r * 1.55 > 34 * g.s ? y - r * 1.55 : y + r * 1.55;
      if (this.extOk[s] === 1) {
        g.text(t('hold'), x, ty, this.text(40 * g.s, C.success, C.white));
      } else {
        // Partial success is feedback: the hand found it, now straighten up.
        g.text(t('more'), x, ty, this.text(44 * g.s, this.colTip, C.white));
      }
    }
  }

  // ─── End ──────────────────────────────────────────────────────────────────

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.hits >= 3) highlights.push(stretchLine(this.hits));
    if (this.perfects >= 3) highlights.push(perfectLine(this.perfects));
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
        hits: this.hits, misses: this.misses, bestCombo: this.best,
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }

  dispose(): void {
    this.ctx.audio.stopMusic();
  }
}

export default (): MiniGame => new MaxReachStretch();

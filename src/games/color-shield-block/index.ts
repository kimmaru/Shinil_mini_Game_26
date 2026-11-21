// color-shield-block — SHAPE A, but the gesture is a CHOICE, not a reflex.
//
// Red goes to the right hand, blue to the left hand, yellow to the head, green
// to both hands at once. Blocking with the wrong part does nothing at all, so
// the child has to read the badge before moving. That one rule is the game.
//
// Two things are deliberate and worth reading before changing them:
//
//  - Every ball carries a SHAPE badge as well as a colour. Roughly one boy per
//    Korean classroom is red-green colour-blind (ART.md §3.6), and a game whose
//    only rule is "red vs green" is unplayable for him. The badge is also what
//    makes the rule shoutable across a room: "노란 동그라미!".
//
//  - Blocking is gated on POSITION, not on speed. A shield is held, not swung:
//    the hand slots sit half a shoulder-width above the shoulder line and a
//    shoulder-width and a half out to the side, where a resting arm never is
//    (measured on `idle`: the wrists hang at +1.6 shoulder-widths, below the
//    hips). The hit test is still swept — `hitSegCircle` over the segment the
//    palm travelled this frame — because a child throwing an arm up to the slot
//    covers 150 px between two frames and a point test misses the throw.
import type {
  Detector, EndReason, GameContext, GameResult, MiniGame,
  PlayerPose, PoseFrame, Renderer,
} from '@/engine/types';
import { L, visible } from '@/engine/pose/landmarks';
import { easeOutCubic, hitSegCircle, lerp } from '@/engine/math';
import { Entities } from '@/engine/entities';
import { chance, randInt, randRange, Spawner } from '@/engine/spawn';
import { C, fade, hue, KEYLINE } from '@/engine/render/palette';
import { manifest } from './manifest';
import { t } from './locale';

/** Ball colours. The index IS `Entities.kind`. */
const RED = 0;
const BLUE = 1;
const YELLOW = 2;
const GREEN = 3;

const COLOR_HUE = [8, 212, 42, 140] as const;
/** The shape badge for each colour: triangle / diamond / disc / square.
 *  Never colour alone — ART.md §3.6. */
const COLOR_BADGE = ['triangle', 'square', 'circle', 'square'] as const;
/** The diamond is a square turned 45 degrees, so blue and green read apart
 *  even in greyscale. */
const COLOR_BADGE_ROT = [0, Math.PI / 4, 0, 0] as const;

/** Guard slots, in the player's own body frame. */
const SLOT_HAND_R = 0;
const SLOT_HAND_L = 1;
const SLOT_HEAD_R = 2;
const SLOT_HEAD_L = 3;
const SLOT_BOTH = 4;

/** Lateral offset of each slot from the shoulder centre, in shoulder-widths,
 *  before the player's own arm length is folded in. */
/** The colour each slot belongs to, so the guide rings teach the rule. */
const SLOT_COLOUR = [RED, BLUE, YELLOW, YELLOW, GREEN] as const;

const SLOT_Y = [-0.5, -0.5, -0.72, -0.72, -0.3] as const;

const POINTS = 20;
/** Consecutive frames the part must be on the ball. One frame of landmark
 *  noise must never be worth 20 points. */
const CONFIRM = 2;
/** Seconds between two "wrong part" ticks on the same ball, so a hand parked
 *  on an approaching ball does not chatter. */
const TICK_GAP = 0.4;
/** The ball can be blocked from here on; before it, it is still too far away
 *  to touch. */
const BLOCK_FROM = 0.42;

/**
 * How far off centre the head must be, in shoulder-widths, for a head block
 * to count — and it must be off centre TOWARD the ball.
 *
 * Position alone is not enough here: the slot sits 0.55 shoulder-widths to the
 * side and the block radius is 0.64, so a child standing perfectly still
 * already overlaps it and the `idle` clip scored 460 points for breathing.
 * Measured lateral nose offset from the shoulder centre across the whole clip
 * corpus: idle 0.07, swing-wide 0.15, fidget 0.15, step-lr 0.23, laggy 0.28,
 * and 0.32 at 4 m (`far-small`, where the scale estimate is noisiest). 0.45
 * clears the worst of those by 1.4x and is a lean a 7-year-old makes happily.
 */
const HEAD_LEAN = 0.45;

/** Four colours only after the player has the first three. */
const GREEN_AT = 0.5;
/** "Colour changes in flight" — the late-round twist. */
const SWAP_AT = 0.7;

const PARTS = [L.LEFT_WRIST, L.RIGHT_WRIST, L.NOSE] as const;

class ColorShieldBlock implements MiniGame {
  private ctx!: GameContext;
  /** Palms in view px, both hands, with the engine's visibility gating. */
  private reach!: Detector<'reach'>;
  private spawner!: Spawner;

  // Allocated HERE. update() and render() allocate nothing.
  private readonly balls = new Entities(24);
  /** Previous frame's part positions in view px: [Lx,Ly, Rx,Ry, Hx,Hy]. */
  private readonly prev = new Float32Array(6);
  /** This frame's, same layout. */
  private readonly cur = new Float32Array(6);
  private prevOk = false;
  /** Slot centre scratch, written by `slotAt`. */
  private sxOut = 0;
  private syOut = 0;
  private readonly labels: string[] = [];
  private player: PlayerPose | null = null;

  private score = 0;
  private combo = 0;
  private bestCombo = 0;
  private blocks = 0;
  private wrong = 0;
  private passed = 0;
  private time = 0;
  private greenShown = false;
  private swapShown = false;
  private lastColour = -1;
  private headOk = true;
  /** Ball radius and the three shield radii, in view px. Set in init(). */
  private ballR = 0;
  private handR = 0;
  private headR = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // `reach` is rented for the palms rather than `swing`: this game's gate is
    // where the hand IS, and `reach` reports both palms every frame with the
    // engine's own visibility gating instead of only the faster one.
    this.reach = ctx.gestures.use('reach', { side: 'both' });
    this.spawner = new Spawner(
      { startInterval: 2.6, endInterval: 1.6, jitter: 0.22, burstMid: 2, burstLate: 2 },
      ctx.rng,
      manifest.durationMs / 1000,
    );
    const g = Math.min(ctx.view.w, ctx.view.h);
    this.ballR = g * 0.07;
    this.handR = g * 0.09;
    this.headR = g * 0.085;
    for (let i = 0; i < 80; i++) this.labels.push('+' + String(i));
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.audio.music({ bpm: 112 });
  }

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    const d = this.spawner.difficulty;

    if (d > GREEN_AT && !this.greenShown) {
      this.greenShown = true;
      this.ctx.hud.announce(t('both'));
    }
    if (d > SWAP_AT && !this.swapShown) {
      this.swapShown = true;
      this.ctx.hud.announce(t('swap'));
    }
    const p = f.p1;
    this.player = p ?? null;
    if (p) {
      this.headOk = visible(p, L.NOSE);
      const rs = this.reach.read(f);
      this.cur[0] = rs.leftPalm.x;
      this.cur[1] = rs.leftPalm.y;
      this.cur[2] = rs.rightPalm.x;
      this.cur[3] = rs.rightPalm.y;
      this.cur[4] = p.px[L.NOSE * 2]!;
      this.cur[5] = p.px[L.NOSE * 2 + 1]!;
      if (!this.prevOk) {
        for (let i = 0; i < 6; i++) this.prev[i] = this.cur[i]!;
        this.prevOk = true;
      }

      for (let i = 0, k = this.spawner.tick(dt); i < k; i++) this.throwBall(d, p);
      this.flight(dt, p);

      for (let i = 0; i < 6; i++) this.prev[i] = this.cur[i]!;
    } else {
      // No player: balls hold where they are rather than sailing past and
      // missing while nobody is in frame.
      this.prevOk = false;
    }

    this.balls.sweep();
  }

  /** Where a slot sits in view px this frame, from this player's own body. */
  private slotAt(slot: number, p: PlayerPose): void {
    const s = p.scalePx;
    const cx = (p.px[L.LEFT_SHOULDER * 2]! + p.px[L.RIGHT_SHOULDER * 2]!) / 2;
    const cy = (p.px[L.LEFT_SHOULDER * 2 + 1]! + p.px[L.RIGHT_SHOULDER * 2 + 1]!) / 2;
    // 62% of this child's OWN shoulder-to-wrist length, plus half a shoulder
    // width to get out past the joint. A short child and a tall one are then
    // asked for the same effort rather than the same distance.
    const out = (p.calib.armLen * 0.62 + 0.5) * s;
    const side = slot === SLOT_HAND_R || slot === SLOT_HEAD_R ? 1 : -1;
    const dx =
      slot === SLOT_BOTH ? 0 : slot === SLOT_HAND_R || slot === SLOT_HAND_L ? out * side : 0.55 * s * side;
    this.sxOut = cx + dx;
    this.syOut = cy + SLOT_Y[slot]! * s;
  }

  /** Colour -> slot. The head side comes from the ball's own id, which is
   *  stable across a sweep() while an index is not. */
  private slotOf(colour: number, id: number): number {
    if (colour === RED) return SLOT_HAND_R;
    if (colour === BLUE) return SLOT_HAND_L;
    if (colour === GREEN) return SLOT_BOTH;
    return id % 2 === 0 ? SLOT_HEAD_R : SLOT_HEAD_L;
  }

  private throwBall(d: number, p: PlayerPose): void {
    const { w } = this.ctx.view;
    let colour = d > GREEN_AT && chance(this.ctx.rng, 0.18)
      ? GREEN
      : randInt(this.ctx.rng, 0, 2);
    // Two balls at once is the "one job per hand" moment of the ramp, so a
    // burst never serves the same colour twice.
    if (colour === this.lastColour && colour !== GREEN) colour = (colour + 1) % 3;
    this.lastColour = colour;
    const i = this.balls.spawn(
      0, 0, 0, 0, this.ballR, 12, colour,
    );
    if (i < 0) return;
    // `px`/`py` hold the launch point, `data` the 0..1 flight progress, `vx`
    // the progress per second, `vy` the confirm counter, `spin` the wrong-part
    // tick cooldown and `rot` the progress at which the colour flips.
    this.balls.px[i] = randRange(this.ctx.rng, w * 0.08, w * 0.92);
    this.balls.py[i] = -this.ballR * 2;
    this.balls.data[i] = 0;
    this.balls.vx[i] = 1 / lerp(2.2, 1.3, d);
    this.balls.vy[i] = 0;
    this.balls.spin[i] = 0;
    // Only ever flips between the three single-part colours: a ball that turns
    // into "both hands" halfway down is not a reaction test, it is a trick.
    this.balls.rot[i] =
      d > SWAP_AT && colour !== GREEN && chance(this.ctx.rng, 0.25)
        ? randRange(this.ctx.rng, 0.5, 0.68)
        : 0;
    this.slotAt(this.slotOf(colour, this.balls.id[i]!), p);
    this.balls.x[i] = this.balls.px[i]!;
    this.balls.y[i] = this.balls.py[i]!;
    // 420 ms of warning before it is blockable: a telegraph is information,
    // and a whole-body reaction needs a weight shift first.
    this.ctx.fx.telegraph(this.sxOut, this.syOut, this.handR * 1.3, {
      color: hue(COLOR_HUE[colour]!, 80, 48),
      secs: 0.42,
    });
    this.ctx.audio.play('whoosh', { gain: 0.3 });
  }

  private flight(dt: number, p: PlayerPose): void {
    for (let i = 0; i < this.balls.n; i++) {
      let colour = this.balls.kind[i]!;
      const prog = Math.min(1, this.balls.data[i]! + this.balls.vx[i]! * dt);
      const swapAt = this.balls.rot[i]!;
      if (swapAt > 0 && this.balls.data[i]! < swapAt && prog >= swapAt) {
        // Flip to the next single-part colour and re-aim. Deterministic, so a
        // seeded replay shows the same flip.
        colour = (colour + 1) % 3;
        this.balls.kind[i] = colour;
        this.balls.rot[i] = 0;
        this.balls.vy[i] = 0;
        this.ctx.audio.play('zap', { gain: 0.42 });
        this.slotAt(this.slotOf(colour, this.balls.id[i]!), p);
        this.ctx.fx.pop(this.sxOut, this.syOut, this.handR, hue(COLOR_HUE[colour]!, 80, 48));
      }
      this.balls.data[i] = prog;
      if (this.balls.spin[i]! > 0) this.balls.spin[i] = Math.max(0, this.balls.spin[i]! - dt);
      this.balls.life[i] = this.balls.life[i]! - dt;

      const slot = this.slotOf(colour, this.balls.id[i]!);
      this.slotAt(slot, p);
      // The destination is re-read from the live body every frame, so a child
      // who drifts sideways mid-round is not handed an unreachable ball.
      // easeOutCubic, not linear: the ball covers most of the distance early
      // and then HOVERS at the slot, which is what turns a 1.5 s flight into a
      // half-second window a 7-year-old can actually choose a limb inside.
      const ease = easeOutCubic(prog);
      this.balls.x[i] = lerp(this.balls.px[i]!, this.sxOut, ease);
      this.balls.y[i] = lerp(this.balls.py[i]!, this.syOut, ease);

      if (prog >= BLOCK_FROM && this.judge(i, colour, slot)) continue;
      if (prog >= 1) this.letThrough(i);
    }
  }

  /** @returns true when the ball was resolved (blocked) this frame. */
  private judge(i: number, colour: number, slot: number): boolean {
    const x = this.balls.x[i]!;
    const y = this.balls.y[i]!;
    const r = this.balls.r[i]!;
    const wantBoth = slot === SLOT_BOTH;
    const wantHead = slot === SLOT_HEAD_L || slot === SLOT_HEAD_R;
    const wantL = wantBoth || slot === SLOT_HAND_L;
    const wantR = wantBoth || slot === SLOT_HAND_R;

    const hitL = this.touch(0, x, y, r + this.handR);
    const hitR = this.touch(2, x, y, r + this.handR);
    const hitH = this.headOk && this.touch(4, x, y, r + this.headR) && this.headLean(slot);

    const right = wantBoth ? hitL && hitR : wantHead ? hitH : wantL ? hitL : hitR;
    if (right) {
      this.balls.vy[i] = this.balls.vy[i]! + 1;
      if (this.balls.vy[i]! < CONFIRM) return false;
      this.block(i, colour, x, y);
      return true;
    }
    this.balls.vy[i] = 0;

    // The wrong part DID touch it. Nothing happens, and it must be obvious
    // that nothing happened: one flat, powerless tick.
    const anyWrong = (hitL && !wantL) || (hitR && !wantR) || (hitH && !wantHead);
    if (anyWrong && this.balls.spin[i] === 0) {
      this.balls.spin[i] = TICK_GAP;
      this.wrong++;
      this.combo = 0;
      this.ctx.hud.setCombo(0);
      this.ctx.audio.play('ui.tick', { gain: 0.3 });
      this.ctx.fx.miss(x, y);
    }
    return false;
  }

  /** Is the head actually leaning toward this slot? Normalized, so it asks a
   *  small child and a tall one for the same lean rather than the same pixels. */
  private headLean(slot: number): boolean {
    const p = this.player;
    if (!p) return false;
    const off = p.n[L.NOSE * 2]! - (p.n[L.LEFT_SHOULDER * 2]! + p.n[L.RIGHT_SHOULDER * 2]!) / 2;
    return slot === SLOT_HEAD_R ? off >= HEAD_LEAN : off <= -HEAD_LEAN;
  }

  /** Swept test for one part: the segment it travelled this frame. */
  private touch(o: number, x: number, y: number, r: number): boolean {
    return hitSegCircle(this.prev[o]!, this.prev[o + 1]!, this.cur[o]!, this.cur[o + 1]!, x, y, r);
  }

  private block(i: number, colour: number, x: number, y: number): void {
    this.balls.kill(i);
    this.blocks++;
    this.combo++;
    if (this.combo > this.bestCombo) this.bestCombo = this.combo;
    this.score += POINTS;

    this.ctx.fx.impact(x, y, this.combo >= 6 ? 'big' : 'hit', {
      color: hue(COLOR_HUE[colour]!, 82, 48),
      sprite: 'burst',
      label: this.labels[POINTS] ?? '',
    });
    this.ctx.audio.playLadder('hit.soft', this.combo);
    if (this.combo > 0 && this.combo % 4 === 0) {
      this.ctx.audio.play('combo.up');
      this.ctx.hud.toast(this.combo >= 8 ? t('wow') : t('nice'), { color: C.accent });
    }
    this.ctx.hud.setScore(this.score);
    this.ctx.hud.setCombo(this.combo);
    this.ctx.emit({ kind: 'scored', points: POINTS });
  }

  private letThrough(i: number): void {
    const x = this.balls.x[i]!;
    const y = this.balls.y[i]!;
    this.balls.kill(i);
    this.passed++;
    this.combo = 0;
    this.ctx.hud.setCombo(0);
    // Quiet by construction: the engine refuses to shake, flash or redden here.
    this.ctx.fx.miss(x, y);
    this.ctx.emit({ kind: 'miss' });
  }

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);

    const p = this.player;

    // The slot rings, always on screen: they are the only way a child knows
    // where a ball is going to arrive.
    if (p) {
      for (let s = 0; s < 5; s++) {
        if (s === SLOT_BOTH && !this.greenShown) continue;
        this.slotAt(s, p);
        const sr = s >= SLOT_HEAD_R && s <= SLOT_HEAD_L ? this.headR : this.handR;
        g.save();
        g.alpha(0.4);
        g.circle(this.sxOut, this.syOut, sr, { stroke: hue(COLOR_HUE[SLOT_COLOUR[s]!]!, 82, 46), sw: 5 * g.s });
        g.sprite(COLOR_BADGE[SLOT_COLOUR[s]!]!, this.sxOut, this.syOut, sr * 0.6, {
          rot: COLOR_BADGE_ROT[SLOT_COLOUR[s]!]!,
          flatten: hue(COLOR_HUE[SLOT_COLOUR[s]!]!, 82, 40),
        });
        g.restore();
      }
    }

    // Always draw the body.
    if (p) {
      g.ghostBody(p, 0.09);
      g.skeleton(p, { alpha: 0.42, emphasize: PARTS });
    }

    // Where each ball is headed, in its own colour, on top of the pale slot
    // ring. A telegraph is information: without it the child is guessing.
    if (p) {
      for (let i = 0; i < this.balls.n; i++) {
        const colour = this.balls.kind[i]!;
        const slot = this.slotOf(colour, this.balls.id[i]!);
        this.slotAt(slot, p);
        const rr = slot >= SLOT_HEAD_R && slot <= SLOT_HEAD_L ? this.headR : this.handR;
        g.circle(this.sxOut, this.syOut, rr, {
          stroke: hue(COLOR_HUE[colour]!, 80, 48),
          sw: 5 * g.s,
        });
        g.sprite(COLOR_BADGE[colour]!, this.sxOut, this.syOut, rr * 0.72, {
          rot: COLOR_BADGE_ROT[colour]!,
          flatten: fade(KEYLINE, 0.3),
        });
      }
    }

    for (let i = 0; i < this.balls.n; i++) {
      const colour = this.balls.kind[i]!;
      const x = this.balls.x[i]!;
      const y = this.balls.y[i]!;
      const r = this.balls.r[i]!;
      const prog = this.balls.data[i]!;
      const h = COLOR_HUE[colour]!;
      // Grows as it closes, so "almost here" is readable from across a room.
      const size = r * (0.74 + 0.5 * prog);
      g.circle(x, y, size, { fill: hue(h, 82, 52), stroke: KEYLINE, sw: 4 * g.s });
      g.sprite(COLOR_BADGE[colour]!, x, y, size * 1.05, {
        rot: COLOR_BADGE_ROT[colour]!,
        flatten: KEYLINE,
      });
      if (prog >= BLOCK_FROM) {
        // Live ring: this one can be blocked NOW.
        g.circle(x, y, size * 1.5, { stroke: hue(h, 82, 46), sw: 4 * g.s, glow: 10 });
      }
    }

    // The shields themselves, drawn on the parts, in each part's own colour
    // with its own badge. This is the rule, embodied: the child never has to
    // remember which hand is red.
    if (p) {
      this.shield(g, this.cur[2]!, this.cur[3]!, this.handR, RED);
      this.shield(g, this.cur[0]!, this.cur[1]!, this.handR, BLUE);
      if (this.headOk) this.shield(g, this.cur[4]!, this.cur[5]!, this.headR, YELLOW);
      if (this.greenShown) {
        // Both hands together make the green shield: draw the bridge.
        const mx = (this.cur[0]! + this.cur[2]!) / 2;
        const my = (this.cur[1]! + this.cur[3]!) / 2;
        const near = Math.hypot(this.cur[0]! - this.cur[2]!, this.cur[1]! - this.cur[3]!);
        if (near < this.handR * 3.4) {
          g.circle(mx, my, this.handR * 0.8, {
            stroke: hue(COLOR_HUE[GREEN]!, 82, 44),
            sw: 5 * g.s,
          });
          g.sprite('square', mx, my, this.handR * 0.9, { flatten: hue(COLOR_HUE[GREEN]!, 82, 44) });
        }
      }
    }
  }

  private shield(g: Renderer, x: number, y: number, r: number, colour: number): void {
    const h = COLOR_HUE[colour]!;
    g.circle(x, y, r, { stroke: hue(h, 82, 46), sw: 5 * g.s, glow: 8 });
    g.save();
    g.alpha(0.55);
    g.sprite(COLOR_BADGE[colour]!, x, y, r * 0.85, {
      rot: COLOR_BADGE_ROT[colour]!,
      flatten: hue(h, 82, 40),
    });
    g.restore();
  }

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.bestCombo >= 4) highlights.push(`콤보 ${this.bestCombo}연속!`);
    if (this.blocks >= 10) highlights.push(`${this.blocks}번 막았어요`);
    return {
      gameId: manifest.id,
      cleared: this.blocks > 0,
      rawScore: this.score,
      maxScore: manifest.scoring.maxScore,
      normalized: 0,
      stars: 0,
      durationMs: manifest.durationMs,
      perPlayer: [{
        playerId: 0, slot: 0, score: this.score,
        hits: this.blocks, misses: this.passed + this.wrong, bestCombo: this.bestCombo,
      }],
      highlightsKo: highlights.length > 0 ? highlights : undefined,
    };
  }

  dispose(): void {
    this.ctx.audio.stopMusic();
    this.balls.clear();
  }
}

export default (): MiniGame => new ColorShieldBlock();

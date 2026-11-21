// KOKO-KO-TOUCH (코코코 놀이) — Shape A variant: a cue, then a response window.
//
// The caller chants "코코코코..." tapping its own nose, then shouts a body part.
// The child touches THAT part on their own body. The trick the game is famous
// for: sometimes the caller's finger lands on a DIFFERENT part than the word.
// Following the word is correct; following the finger is being fooled.
//
// Detection is the honest local version described in NEEDS.md (there is no
// "touch your own landmark" detector): palm-to-landmark distance in SHOULDER
// WIDTHS, nearest-region classification, a multi-frame streak plus a "the hand
// has stopped" check, and a one-shot latch per prompt. Prompts are >= 2.5s
// apart, so the >= 250ms scoring cooldown holds by construction.
import type {
  Detector, EndReason, GameContext, GameEvent, GameResult, MiniGame, Paint,
  PlayerPose, PlayOpts, PoseFrame, Renderer, SignalOf, SkeletonOpts, TextOpts,
} from '@/engine/types';
import type { ImpactOpts } from '@/engine/fx/index';
import type { SpriteOpts } from '@/engine/render/sprite';
import { L, MIN_VIS } from '@/engine/pose/landmarks';
import { approach, clamp01, easeOutBack, lerp } from '@/engine/math';
import { C, KEYLINE, fade, hue, hueDark, hueLight } from '@/engine/render/palette';
import { manifest } from './manifest';
import { comboLine, notFooledLine, t, type Key } from './locale';

// ─── Regions: what the camera can actually tell apart ────────────────────────
// Nose, eyes and mouth sit within ~0.15 shoulder-widths of each other, which
// is inside palm-estimate error, so they share ONE region (any of the three is
// accepted for any of the three words). Decoys never come from the word's own
// region, so every trick is judgeable.
const HEAD = 0;
const FACE = 1;
const EAR = 2;
const SHOULDER = 3;
const BELLY = 4;
const NREG = 5;
/** Region radius in shoulder widths. Generous: a child aims with a whole
 *  hand, and the palm estimate sits a few cm behind the fingertip. */
const RAD = [0.42, 0.36, 0.3, 0.34, 0.44] as const;
/** Head-top anchor = nose + (nose - shoulder centre) * this. */
const HEAD_K = 0.6;

// ─── Words the caller can say ───────────────────────────────────────────────
const W_NOSE = 0;
const W_HEAD = 4;
const W_BELLY = 6;
const NWORD = 7;
const WORD_REGION = [FACE, FACE, FACE, EAR, HEAD, SHOULDER, BELLY] as const;
const WORD_KEY: readonly Key[] = ['nose', 'eye', 'mouth', 'ear', 'head', 'shoulder', 'belly'];
/**
 * How often each word is called (ids below). Head, shoulders and belly are the
 * parts the camera separates most reliably, so they come up most; the face
 * cluster and the ears sit on the noisiest landmarks, so they come up less.
 * The warm-up calls only the big parts and the nose.
 */
const WORD_W = [1.5, 1, 1, 1, 2, 2, 2] as const;
const WARM_W = [1.5, 0, 0, 0, 2, 2, 2] as const;
/**
 * Which part the caller may POINT AT while saying each word. Two rules:
 *  - never the same region (an untestable trick is an unfair trick);
 *  - never a part whose usual hand path runs THROUGH the word's part, or a
 *    child following the finger would be credited on the way past.
 * Ids: 0 코, 1 눈, 2 입, 3 귀, 4 머리, 5 어깨, 6 배.
 */
const DECOYS: readonly (readonly number[])[] = [
  [3, 5, 6], // 코
  [3, 5, 6], // 눈
  [3, 5, 6], // 입
  [0, 5, 6], // 귀 — the classic: the finger simply stays on the nose
  [0, 5, 6], // 머리
  [0, 6],    // 어깨
  [5, 4],    // 배
];

// ─── Judging ────────────────────────────────────────────────────────────────
/** Frames a hand must stay in the word's region (~117ms). */
const CORRECT_FRAMES = 7;
/** Frames resting on the DECOY before it counts as fooled (~0.5s). Long on
 *  purpose: passing a hand through on the way somewhere else is not a choice. */
const FOOL_FRAMES = 30;
/** No "fooled" before this: a choice reaction takes a 7-year-old ~0.7s, and
 *  the chant asks them to rest a finger on their nose right up to the call. */
const FOOL_GRACE = 0.8;
/** Position history for the "hand has stopped" check. */
const HIST = 8;
/** Max hand travel over HIST frames, shoulder widths (~3 sw/s): a hand that
 *  has arrived and slowed, not a swipe passing through. */
const SETTLE_SW = 0.4;

// ─── Round pacing ───────────────────────────────────────────────────────────
const PH_WAIT = 0;
const PH_CHANT = 1;
const PH_CALL = 2;
const PH_RESULT = 3;
const OUT_OK = 1;
const OUT_FOOLED = 2;
const OUT_TIMEOUT = 3;
/** Fraction of the round that is warm-up: easy words, no tricks. */
const EASY_UNTIL = 0.28;

const PTS = 10;
const PTS_TRICK = 15;
const LABEL_PTS = '+10';
const LABEL_TRICK = '+15';

// ─── The caller's body, in head-radius units (u), relative to the head ──────
// RING = the part itself; HAND = where the pointing hand rests to show it.
const RING_X = [0, 0.38, 0, 1.0, 0, -0.62, 0] as const;
const RING_Y = [0.12, -0.12, 0.45, 0.05, -0.98, 1.36, 1.95] as const;
const RING_R = [0.3, 0.24, 0.3, 0.36, 0.5, 0.34, 0.46] as const;
const HAND_X = [0.44, 0.7, 0.44, 1.32, 0.42, -0.4, 0.38] as const;
const HAND_Y = [0.34, -0.02, 0.66, 0.2, -1.08, 1.24, 2.04] as const;

// Option objects, built once. Passing a literal per call would allocate.
const HANDS = [L.LEFT_WRIST, L.RIGHT_WRIST] as const;
const SKELETON: SkeletonOpts = { alpha: 0.5, emphasize: HANDS };
const ANNOUNCE = { speak: true };
const TOAST_GOLD = { color: C.accent };
const TOAST_INFO = { color: C.info };
const CHANT_SFX: PlayOpts = { gain: 0.7 };
const BONUS_SFX: PlayOpts = { gain: 0.8 };
const SOFT_SFX: PlayOpts = { gain: 0.35 };
const EV_MISS: GameEvent = { kind: 'miss' };
const OUTFIT_HUE = 212;

class KokoKoTouch implements MiniGame {
  private ctx!: GameContext;
  private reach!: Detector<'reach'>;
  private player: PlayerPose | null = null;

  // ── Per-frame body read. All preallocated. ──
  /** Up to 3 anchors per region, [x,y] in view px. */
  private readonly anc = new Float32Array(NREG * 6);
  private readonly ancN = new Int8Array(NREG);
  private readonly handX = new Float32Array(2);
  private readonly handY = new Float32Array(2);
  private readonly handOk = new Uint8Array(2);
  /** Region each palm is on, -1 for none. */
  private readonly handReg = new Int8Array(2);
  private readonly streak = new Int16Array(2);
  private readonly settled = new Uint8Array(2);
  /** Palm positions relative to the shoulder centre, shoulder widths. */
  private readonly hist = new Float32Array(2 * HIST * 2);
  private histN = 0;
  private histI = 0;

  // ── Prompt state ──
  private phase = PH_WAIT;
  private phaseT = 0;
  private chantDur = 1.6;
  private callDur = 3;
  private resultDur = 0.8;
  private beat = -1;
  private word = W_HEAD;
  private shown = W_HEAD;
  private decoyReg = -1;
  private lastWord = -1;
  private outcome = 0;
  private toldToListen = false;

  // ── Score ──
  private score = 0;
  private combo = 0;
  private best = 0;
  private hits = 0;
  private misses = 0;
  private tricksBeaten = 0;
  private time = 0;

  // ── Caller animation, in head-radius units ──
  private armX = 1.15;
  private armY = 2.1;
  private offX = -1.15;
  private offY = 2.1;
  private cheer = 0;
  private wiggle = 0;
  private wordPop = 1;

  // ── Cached colours and reusable draw options ──
  private colThemeDark = '';
  private colSkin = '';
  private colSkinDark = '';
  private colCheek = '';
  private colShadow = '';
  private colString = '';
  private colWordDim = '';
  private colBunting: readonly string[] = [];
  private colHand = '';
  private colTimer = '';
  private colOutfit = '';
  private colOutfitDark = '';
  private colOutfitLight = '';
  private colHeadFill = '';
  private colSyllable: readonly string[] = [];
  /** The player's own head, so a game about touching your face shows one. */
  private headX = 0;
  private headY = 0;
  private headR = 0;
  private noseX = 0;
  private noseY = 0;
  private neckX = 0;
  private neckY = 0;
  private colNeck = '';
  private readonly pt: Paint = {};
  private readonly to: TextOpts = {};
  private readonly so: SpriteOpts = {};
  private readonly imp: ImpactOpts = {};
  private readonly tri = new Float32Array(6);
  private readonly evScored = { kind: 'scored' as const, points: 0 };

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.reach = ctx.gestures.use('reach', { side: 'both' });
    const h = manifest.theme?.hue ?? 26;
    this.colThemeDark = hueDark(h);
    this.colSkin = 'hsl(30 88% 80%)';
    this.colSkinDark = 'hsl(18 70% 62%)';
    this.colCheek = fade(C.hot, 0.35);
    this.colShadow = 'rgb(0 0 0 / 0.12)';
    this.colString = fade(C.ink, 0.15);
    this.colWordDim = fade(C.text, 0.55);
    this.colBunting = [fade(C.accent, 0.55), fade(C.hot, 0.45), fade(C.info, 0.45)];
    this.colHand = fade(C.slot[0], 0.7);
    this.colTimer = hue(h, 80, 56);
    // The caller's outfit is blue so it never melts into the orange room.
    this.colOutfit = hue(OUTFIT_HUE);
    this.colOutfitDark = hueDark(OUTFIT_HUE);
    this.colOutfitLight = hueLight(OUTFIT_HUE);
    this.colHeadFill = fade(C.white, 0.5);
    this.colNeck = fade(C.slot[0], 0.45);
    this.colSyllable = [this.colThemeDark, C.hot, this.colThemeDark, C.hot];
    this.handReg[0] = this.handReg[1] = -1;
    ctx.hud.setGoal(t('goal'));
  }

  start(): void {
    this.ctx.hud.setScore(0);
    this.ctx.audio.music({ bpm: 104 });
  }

  // ─── Update ───────────────────────────────────────────────────────────────

  update(dt: number, f: PoseFrame): void {
    this.time += dt;
    this.phaseT += dt;
    if (this.cheer > 0) this.cheer = Math.max(0, this.cheer - dt);
    if (this.wiggle > 0) this.wiggle = Math.max(0, this.wiggle - dt);
    if (this.wordPop < 1) this.wordPop = Math.min(1, this.wordPop + dt * 4);

    const p = f.p1;
    this.player = p ?? null;
    if (p) {
      this.readBody(p, this.reach.read(f));
    } else {
      this.handOk[0] = this.handOk[1] = 0;
      this.streak[0] = this.streak[1] = 0;
      this.histN = 0;
    }

    switch (this.phase) {
      case PH_WAIT:
        if (this.phaseT >= 0.6) this.beginChant();
        break;
      case PH_CHANT:
        this.tickChant();
        break;
      case PH_CALL:
        this.tickCall();
        break;
      default:
        if (this.phaseT >= this.resultDur) this.beginChant();
    }
    this.animateCaller(dt);
  }

  private get progress(): number {
    return clamp01(this.time / (manifest.durationMs / 1000));
  }

  /** Anchors for every region, both palms, and which region each palm is on. */
  private readBody(p: PlayerPose, sig: SignalOf<'reach'>): void {
    const px = p.px;
    const nX = px[L.NOSE * 2]!;
    const nY = px[L.NOSE * 2 + 1]!;
    const smX = (px[L.LEFT_SHOULDER * 2]! + px[L.RIGHT_SHOULDER * 2]!) / 2;
    const smY = (px[L.LEFT_SHOULDER * 2 + 1]! + px[L.RIGHT_SHOULDER * 2 + 1]!) / 2;

    this.setAnc(HEAD, 0, nX + (nX - smX) * HEAD_K, nY + (nY - smY) * HEAD_K);
    this.ancN[HEAD] = 1;
    this.setAnc(FACE, 0, nX, nY);
    this.setAnc(FACE, 1,
      (px[L.LEFT_EYE * 2]! + px[L.RIGHT_EYE * 2]!) / 2,
      (px[L.LEFT_EYE * 2 + 1]! + px[L.RIGHT_EYE * 2 + 1]!) / 2);
    this.setAnc(FACE, 2,
      (px[L.MOUTH_LEFT * 2]! + px[L.MOUTH_RIGHT * 2]!) / 2,
      (px[L.MOUTH_LEFT * 2 + 1]! + px[L.MOUTH_RIGHT * 2 + 1]!) / 2);
    this.ancN[FACE] = 3;
    // A hand over an ear hides it; the pose source holds the last good
    // position, which is exactly what this needs.
    this.setAnc(EAR, 0, px[L.LEFT_EAR * 2]!, px[L.LEFT_EAR * 2 + 1]!);
    this.setAnc(EAR, 1, px[L.RIGHT_EAR * 2]!, px[L.RIGHT_EAR * 2 + 1]!);
    this.ancN[EAR] = 2;
    this.setAnc(SHOULDER, 0, px[L.LEFT_SHOULDER * 2]!, px[L.LEFT_SHOULDER * 2 + 1]!);
    this.setAnc(SHOULDER, 1, px[L.RIGHT_SHOULDER * 2]!, px[L.RIGHT_SHOULDER * 2 + 1]!);
    this.ancN[SHOULDER] = 2;
    if (p.vis[L.LEFT_HIP]! >= MIN_VIS && p.vis[L.RIGHT_HIP]! >= MIN_VIS) {
      const hmX = (px[L.LEFT_HIP * 2]! + px[L.RIGHT_HIP * 2]!) / 2;
      const hmY = (px[L.LEFT_HIP * 2 + 1]! + px[L.RIGHT_HIP * 2 + 1]!) / 2;
      this.setAnc(BELLY, 0, smX + (hmX - smX) * 0.62, smY + (hmY - smY) * 0.62);
    } else {
      // Seated behind a desk: continue the head-to-shoulder line downward.
      this.setAnc(BELLY, 0, smX + (smX - nX) * 1.3, smY + (smY - nY) * 1.3);
    }
    this.ancN[BELLY] = 1;
    this.noseX = nX;
    this.noseY = nY;
    this.headX = nX + (nX - smX) * 0.18;
    this.headY = nY + (nY - smY) * 0.18;
    this.headR = 0.36 * p.scalePx;
    this.neckX = smX;
    this.neckY = smY;

    const inv = 1 / Math.max(1, p.scalePx);
    this.handX[0] = sig.leftPalm.x;
    this.handY[0] = sig.leftPalm.y;
    this.handX[1] = sig.rightPalm.x;
    this.handY[1] = sig.rightPalm.y;
    this.handOk[0] = p.vis[L.LEFT_WRIST]! >= MIN_VIS ? 1 : 0;
    this.handOk[1] = p.vis[L.RIGHT_WRIST]! >= MIN_VIS ? 1 : 0;

    // Has each hand stopped? Travel over the last HIST frames, body-relative so
    // a child shifting their weight does not count as a moving hand.
    const slot = this.histI;
    const old = (this.histI + 1) % HIST;
    for (let h = 0; h < 2; h++) {
      const rx = (this.handX[h]! - smX) * inv;
      const ry = (this.handY[h]! - smY) * inv;
      const base = h * HIST * 2;
      this.hist[base + slot * 2] = rx;
      this.hist[base + slot * 2 + 1] = ry;
      const travel = this.histN >= HIST
        ? Math.hypot(rx - this.hist[base + old * 2]!, ry - this.hist[base + old * 2 + 1]!)
        : 1e9;
      this.settled[h] = travel < SETTLE_SW ? 1 : 0;

      const reg = this.handOk[h] ? this.classify(this.handX[h]!, this.handY[h]!, inv) : -1;
      if (reg >= 0 && reg === this.handReg[h]) {
        if (this.streak[h]! < 10000) this.streak[h] = this.streak[h]! + 1;
      } else {
        this.streak[h] = reg >= 0 ? 1 : 0;
      }
      this.handReg[h] = reg;
    }
    this.histI = old;
    if (this.histN < HIST) this.histN++;
  }

  /** Nearest region by distance / radius, or -1 if the palm is on none. */
  private classify(x: number, y: number, inv: number): number {
    let best = -1;
    let bestRatio = 1;
    for (let r = 0; r < NREG; r++) {
      let d = Infinity;
      for (let k = 0; k < this.ancN[r]!; k++) {
        const i = (r * 3 + k) * 2;
        const dk = Math.hypot(x - this.anc[i]!, y - this.anc[i + 1]!);
        if (dk < d) d = dk;
      }
      const ratio = (d * inv) / RAD[r]!;
      if (ratio < bestRatio) { bestRatio = ratio; best = r; }
    }
    return best;
  }

  private setAnc(r: number, k: number, x: number, y: number): void {
    const i = (r * 3 + k) * 2;
    this.anc[i] = x;
    this.anc[i + 1] = y;
  }

  // ─── Prompt cycle ─────────────────────────────────────────────────────────

  private beginChant(): void {
    const d = this.progress;
    this.phase = PH_CHANT;
    this.phaseT = 0;
    this.beat = -1;
    this.outcome = 0;
    this.chantDur = lerp(1.6, 1.15, d);
    // Generous early: a 7-year-old is still finding their ears.
    this.callDur = lerp(3.6, 2.2, d);

    // Never the same word twice running.
    const rng = this.ctx.rng;
    const wts = d < EASY_UNTIL ? WARM_W : WORD_W;
    let w = this.lastWord;
    for (let tries = 0; tries < 8 && w === this.lastWord; tries++) {
      let total = 0;
      for (let i = 0; i < NWORD; i++) total += wts[i]!;
      let r = rng() * total;
      w = NWORD - 1;
      for (let i = 0; i < NWORD; i++) {
        r -= wts[i]!;
        if (r < 0) { w = i; break; }
      }
    }
    this.word = w;
    this.lastWord = w;

    const trickP = d < EASY_UNTIL ? 0 : d < 0.6 ? 0.3 : 0.45;
    const decoys = DECOYS[w]!;
    if (rng() < trickP) {
      this.shown = decoys[Math.floor(rng() * decoys.length)]!;
      this.decoyReg = WORD_REGION[this.shown]!;
    } else {
      this.shown = w;
      this.decoyReg = -1;
    }
  }

  private tickChant(): void {
    const k = Math.floor((this.phaseT / this.chantDur) * 4);
    if (k > this.beat && k < 4) {
      this.beat = k;
      this.ctx.audio.playLadder('pop.low', k * 2, CHANT_SFX);
    }
    if (this.phaseT >= this.chantDur) {
      this.phase = PH_CALL;
      this.phaseT = 0;
      this.wordPop = 0;
      this.ctx.audio.play('beat.hi');
      this.ctx.hud.announce(t(WORD_KEY[this.word]!), ANNOUNCE);
    }
  }

  private tickCall(): void {
    if (this.phaseT >= 0.12) {
      const wr = WORD_REGION[this.word]!;
      for (let h = 0; h < 2; h++) {
        if (this.handOk[h] && this.settled[h] && this.handReg[h] === wr &&
            this.streak[h]! >= CORRECT_FRAMES) {
          this.resolveCorrect(h);
          return;
        }
      }
      if (this.decoyReg >= 0 && this.phaseT >= FOOL_GRACE) {
        for (let h = 0; h < 2; h++) {
          if (this.handOk[h] && this.settled[h] && this.handReg[h] === this.decoyReg &&
              this.streak[h]! >= FOOL_FRAMES) {
            this.resolveFooled(h);
            return;
          }
        }
      }
    }
    // Time up is quiet: the caller just shows the right part. No sound.
    if (this.phaseT >= this.callDur) this.miss(OUT_TIMEOUT);
  }

  private resolveCorrect(h: number): void {
    const trick = this.decoyReg >= 0;
    this.phase = PH_RESULT;
    this.phaseT = 0;
    this.resultDur = 0.75;
    this.outcome = OUT_OK;
    this.hits++;
    this.combo++;
    if (this.combo > this.best) this.best = this.combo;
    if (trick) this.tricksBeaten++;
    const pts = trick ? PTS_TRICK : PTS;
    this.score += pts;
    this.cheer = 0.7;

    const imp = this.imp;
    imp.color = trick ? C.accent : C.success;
    imp.sprite = trick ? 'star' : 'sparkle';
    imp.label = trick ? LABEL_TRICK : LABEL_PTS;
    this.ctx.fx.impact(this.handX[h]!, this.handY[h]!, trick || this.combo >= 5 ? 'big' : 'hit', imp);
    this.ctx.audio.playLadder('pop', this.combo);
    if (trick) this.ctx.audio.play('bonus', BONUS_SFX);
    if (this.combo % 4 === 0) {
      this.ctx.audio.play('combo.up');
      this.ctx.hud.toast(t('wow'), TOAST_GOLD);
    }
    this.ctx.hud.setScore(this.score);
    this.ctx.hud.setCombo(this.combo);
    this.evScored.points = pts;
    this.ctx.emit(this.evScored);
  }

  private resolveFooled(h: number): void {
    // Quiet by construction: no shake, no flash, no red. The caller wiggles.
    this.ctx.fx.miss(this.handX[h]!, this.handY[h]!);
    this.ctx.audio.play('boing', SOFT_SFX);
    this.wiggle = 0.6;
    if (!this.toldToListen) {
      // Said once per round, as a tip rather than a verdict.
      this.toldToListen = true;
      this.ctx.hud.toast(t('listen'), TOAST_INFO);
    }
    this.miss(OUT_FOOLED);
  }

  private miss(out: number): void {
    this.phase = PH_RESULT;
    this.phaseT = 0;
    this.resultDur = 1.0;
    this.outcome = out;
    this.misses++;
    this.combo = 0;
    this.ctx.hud.setCombo(0);
    this.ctx.emit(EV_MISS);
  }

  /** Where the caller's hands go, in head-radius units. */
  private animateCaller(dt: number): void {
    let tx = 1.15;
    let ty = 2.1;
    let ox = -1.15;
    let oy = 2.1;
    if (this.phase === PH_CHANT) {
      // Tap-tap-tap on its own nose, one tap per beat.
      const frac = (this.phaseT / this.chantDur) * 4;
      const out = 0.28 * Math.sin((frac - Math.floor(frac)) * Math.PI);
      tx = HAND_X[W_NOSE] + out;
      ty = HAND_Y[W_NOSE] + out * 0.6;
    } else if (this.phase === PH_CALL) {
      tx = HAND_X[this.shown]!;
      ty = HAND_Y[this.shown]!;
    } else if (this.phase === PH_RESULT) {
      if (this.outcome === OUT_OK) {
        tx = 1.3; ty = -0.9; ox = -1.3; oy = -0.9;
      } else {
        // Teach, gently: the hand moves to the part that was actually said.
        tx = HAND_X[this.word]!;
        ty = HAND_Y[this.word]!;
      }
    }
    this.armX = approach(this.armX, tx, 16, dt);
    this.armY = approach(this.armY, ty, 16, dt);
    this.offX = approach(this.offX, ox, 10, dt);
    this.offY = approach(this.offY, oy, 10, dt);
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  render(g: Renderer, _interp: number): void {
    g.clear(manifest.theme?.hue);
    this.drawBunting(g);

    const p = this.player;
    if (p) {
      g.ghostBody(p, 0.12);
      g.skeleton(p, SKELETON);
      // The skeleton has no face; this game is about faces. A plain head and
      // the caller's pink nose — no target marks, which would give tricks away.
      g.line(this.neckX, this.neckY, this.headX, this.headY, 10 * g.s,
        this.paint(undefined, this.colNeck, 0));
      g.circle(this.headX, this.headY, this.headR,
        this.paint(this.colHeadFill, C.slot[0], 4 * g.s));
      g.circle(this.noseX, this.noseY, Math.max(6 * g.s, this.headR * 0.2),
        this.paint(C.hot, KEYLINE, 2.5 * g.s));
    }

    this.drawCaller(g);
    this.drawBubble(g);

    if (p) {
      // Hand rings light up while a hand rests on any part: "I can see that".
      const r = 26 * g.s;
      for (let h = 0; h < 2; h++) {
        if (!this.handOk[h]) continue;
        const on = this.handReg[h]! >= 0 && this.settled[h] === 1;
        g.circle(this.handX[h]!, this.handY[h]!, on ? r * 1.15 : r,
          this.paint(undefined, on ? C.accent : this.colHand, (on ? 5 : 3) * g.s, on ? 8 : 0));
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

  private text(size: number, fill: string): TextOpts {
    const o = this.to;
    o.size = size;
    o.weight = 800;
    o.align = 'center';
    o.baseline = 'middle';
    o.fill = fill;
    o.display = true;
    return o;
  }

  /** Party pennants across the top: decoration, low contrast by design. */
  private drawBunting(g: Renderer): void {
    const n = 13;
    const y0 = g.h * 0.015;
    const sag = g.h * 0.03;
    g.line(0, y0, g.w, y0, 2 * g.s, this.paint(undefined, this.colString, 0));
    const b = this.tri;
    const r = 22 * g.s;
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n;
      const x = u * g.w;
      const y = y0 + Math.sin(u * Math.PI) * sag * 0.2;
      b[0] = x - r; b[1] = y;
      b[2] = x + r; b[3] = y;
      b[4] = x; b[5] = y + r * 1.5 + Math.sin(g.t * 2 + i) * 2 * g.s;
      g.poly(b, 3, this.paint(this.colBunting[i % 3], undefined, 0));
    }
  }

  private drawCaller(g: Renderer): void {
    const u = 80 * g.s;
    const jump = this.cheer > 0 ? Math.sin((1 - this.cheer / 0.7) * Math.PI) * 0.35 * u : 0;
    const shakeX = this.wiggle > 0 ? Math.sin(this.wiggle * 40) * 0.08 * u * (this.wiggle / 0.6) : 0;
    const cx = g.w * 0.15 + shakeX;
    const hy = g.h * 0.47 - jump;
    const ink = 4 * g.s;
    const bodyTop = hy + 1.05 * u;

    // Ground shadow stays put while the caller hops.
    g.save();
    g.translate(cx, g.h * 0.47 + 3.55 * u);
    g.scale(1, 0.22);
    g.circle(0, 0, 1.15 * u * (1 - jump / (u * 2)), this.paint(this.colShadow, undefined, 0));
    g.restore();

    // Legs and body.
    g.roundRect(cx - 0.6 * u, bodyTop + 1.4 * u, 0.48 * u, 0.85 * u, 0.2 * u,
      this.paint(this.colOutfitDark, KEYLINE, ink));
    g.roundRect(cx + 0.12 * u, bodyTop + 1.4 * u, 0.48 * u, 0.85 * u, 0.2 * u,
      this.paint(this.colOutfitDark, KEYLINE, ink));
    g.roundRect(cx - 0.9 * u, bodyTop, 1.8 * u, 1.65 * u, 0.55 * u,
      this.paint(this.colOutfit, KEYLINE, ink));
    g.circle(cx, hy + RING_Y[W_BELLY] * u, 0.42 * u, this.paint(this.colOutfitLight, undefined, 0));

    // The resting / cheering arm (screen-left).
    this.drawArm(g, cx - 0.7 * u, hy + 1.32 * u, cx + this.offX * u, hy + this.offY * u, u, -1, false);

    // Ears, head, party hat, face.
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      g.circle(cx + sgn * u, hy + 0.05 * u, 0.3 * u, this.paint(this.colSkin, KEYLINE, ink));
      g.circle(cx + sgn * u, hy + 0.05 * u, 0.14 * u, this.paint(this.colSkinDark, undefined, 0));
    }
    g.circle(cx, hy, u, this.paint(this.colSkin, KEYLINE, ink));
    const hat = this.tri;
    hat[0] = cx - 0.62 * u; hat[1] = hy - 0.72 * u;
    hat[2] = cx + 0.62 * u; hat[3] = hy - 0.72 * u;
    hat[4] = cx + 0.12 * u; hat[5] = hy - 1.9 * u;
    g.poly(hat, 3, this.paint(C.accent, KEYLINE, ink));
    g.circle(cx + 0.12 * u, hy - 1.9 * u, 0.17 * u, this.paint(C.white, KEYLINE, ink));

    const blink = g.t % 3.4 < 0.12;
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      const ex = cx + sgn * 0.38 * u;
      const ey = hy - 0.12 * u;
      if (blink) g.line(ex - 0.11 * u, ey, ex + 0.11 * u, ey, 3.5 * g.s, this.paint(undefined, C.ink, 0));
      else g.circle(ex, ey, 0.12 * u, this.paint(C.ink, undefined, 0));
      g.circle(cx + sgn * 0.62 * u, hy + 0.3 * u, 0.15 * u, this.paint(this.colCheek, undefined, 0));
    }
    if (this.cheer > 0) {
      g.arc(cx, hy + 0.34 * u, 0.3 * u, 0, Math.PI, this.paint(C.ink, undefined, 0));
    } else {
      g.arc(cx, hy + 0.3 * u, 0.3 * u, 0.15 * Math.PI, 0.85 * Math.PI,
        this.paint(undefined, C.ink, 3.5 * g.s));
    }
    // The nose: the star of 코코코.
    g.circle(cx, hy + 0.12 * u, 0.2 * u, this.paint(C.hot, KEYLINE, ink));

    // "Look here": a pulsing ring on the part the caller is pointing at.
    const pointing = this.phase === PH_CALL || (this.phase === PH_RESULT && this.outcome !== OUT_OK);
    if (pointing) {
      const part = this.phase === PH_CALL ? this.shown : this.word;
      const k = 1 + 0.12 * Math.sin(g.t * 9);
      g.circle(cx + RING_X[part]! * u, hy + RING_Y[part]! * u, RING_R[part]! * u * k,
        this.paint(undefined, C.hot, 5 * g.s));
    }

    // The pointing arm (screen-right) goes on top of everything it touches.
    this.drawArm(g, cx + 0.7 * u, hy + 1.32 * u, cx + this.armX * u, hy + this.armY * u, u, 1,
      pointing || this.phase === PH_CHANT);
  }

  /** A rubber-hose arm: two bowed segments, an outline pass, a mitten hand. */
  private drawArm(
    g: Renderer, sx: number, sy: number, hx: number, hy: number, u: number,
    side: number, finger: boolean,
  ): void {
    const dx = hx - sx;
    const dy = hy - sy;
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len;
    let ny = dx / len;
    if (nx * side < 0) { nx = -nx; ny = -ny; }
    const ex = (sx + hx) / 2 + nx * 0.22 * u;
    const ey = (sy + hy) / 2 + ny * 0.22 * u;
    const wOut = 0.36 * u;
    const wIn = wOut - 8 * g.s;
    g.line(sx, sy, ex, ey, wOut, this.paint(undefined, KEYLINE, 0));
    g.line(ex, ey, hx, hy, wOut, this.paint(undefined, KEYLINE, 0));
    g.line(sx, sy, ex, ey, wIn, this.paint(undefined, this.colOutfit, 0));
    g.line(ex, ey, hx, hy, wIn, this.paint(undefined, this.colSkin, 0));
    if (finger) {
      // An index finger, continuing the forearm: reads as "this one" from 2m.
      const fx = hx + ((hx - ex) / Math.max(1, Math.hypot(hx - ex, hy - ey))) * 0.42 * u;
      const fy = hy + ((hy - ey) / Math.max(1, Math.hypot(hx - ex, hy - ey))) * 0.42 * u;
      g.line(hx, hy, fx, fy, 0.22 * u, this.paint(undefined, KEYLINE, 0));
      g.line(hx, hy, fx, fy, 0.22 * u - 7 * g.s, this.paint(undefined, this.colSkin, 0));
    }
    g.circle(hx, hy, 0.26 * u, this.paint(this.colSkin, KEYLINE, 4 * g.s));
  }

  private drawBubble(g: Renderer): void {
    const bx = g.w * 0.035;
    const by = g.h * 0.07;
    const bw = g.w * 0.3;
    const bh = g.h * 0.22;
    const u = 80 * g.s;
    const tail = this.tri;
    tail[0] = bx + bw * 0.34; tail[1] = by + bh - 3 * g.s;
    tail[2] = bx + bw * 0.52; tail[3] = by + bh - 3 * g.s;
    tail[4] = g.w * 0.15 + 0.5 * u; tail[5] = g.h * 0.47 - 1.55 * u;
    g.poly(tail, 3, this.paint(C.white, KEYLINE, 4 * g.s));
    g.roundRect(bx, by, bw, bh, 26 * g.s, this.paint(C.white, KEYLINE, 4 * g.s));
    // Paint over the tail's join so bubble and tail read as one shape.
    g.line(tail[0] + 5 * g.s, by + bh - 2 * g.s, tail[2] - 5 * g.s, by + bh - 2 * g.s, 7 * g.s,
      this.paint(undefined, C.white, 0));

    const tx = bx + bw / 2;
    const ty = by + bh * 0.46;
    if (this.phase === PH_WAIT) {
      g.text(t('ready'), tx, ty, this.text(52 * g.s, this.colThemeDark));
    } else if (this.phase === PH_CHANT) {
      // One "코" per beat, each popping in on its tap.
      const frac = (this.phaseT / this.chantDur) * 4;
      const gap = bw * 0.2;
      for (let i = 0; i <= this.beat && i < 4; i++) {
        const age = i === this.beat ? frac - i : 1;
        const sc = 0.5 + 0.5 * easeOutBack(clamp01(age * 4));
        g.text(t('chant'), tx + (i - 1.5) * gap, ty - (i === this.beat ? 6 * g.s : 0),
          this.text(70 * g.s * sc, this.colSyllable[i]!));
      }
    } else if (this.phase === PH_CALL) {
      const sc = 0.6 + 0.4 * easeOutBack(this.wordPop);
      g.text(t(WORD_KEY[this.word]!), tx, ty, this.text(108 * g.s * sc, C.text));
      const remain = clamp01(1 - this.phaseT / this.callDur);
      const pad = 22 * g.s;
      if (remain > 0.01) {
        g.roundRect(bx + pad, by + bh - 24 * g.s, (bw - pad * 2) * remain, 10 * g.s, 5 * g.s,
          this.paint(this.colTimer, undefined, 0));
      }
    } else if (this.outcome === OUT_OK) {
      const trick = this.decoyReg >= 0;
      const sc = 0.7 + 0.3 * easeOutBack(clamp01(this.phaseT * 5));
      g.text(trick ? t('notFooled') : t('nice'), tx, ty,
        this.text((trick ? 60 : 76) * g.s * sc, C.success));
      const so = this.so;
      so.rot = g.t * 2;
      g.sprite('star', bx + 34 * g.s, by + 34 * g.s, 40 * g.s * sc, so);
      g.sprite('star', bx + bw - 34 * g.s, by + 34 * g.s, 40 * g.s * sc, so);
    } else {
      // After a miss the word stays up, softly, while the caller shows it.
      g.text(t(WORD_KEY[this.word]!), tx, ty, this.text(96 * g.s, this.colWordDim));
    }
  }

  // ─── End ──────────────────────────────────────────────────────────────────

  end(_reason: EndReason): GameResult {
    const highlights: string[] = [];
    if (this.best >= 3) highlights.push(comboLine(this.best));
    if (this.tricksBeaten >= 2) highlights.push(notFooledLine(this.tricksBeaten));
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

export default (): MiniGame => new KokoKoTouch();

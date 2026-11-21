// Frame-to-frame player tracking with sticky slots.
//
// MediaPipe gives NO durable per-person id, and the order of
// `result.landmarks[]` is not an identity: two children who walk through each
// other swap array positions at the crossing (RESEARCH-POSE §2, and the Motion
// Gym README documents the same failure). So the engine owns identity.
//
// Greedy nearest-chest matching, plus the kid-proofing that actually matters in
// a classroom:
//
//   probation 0.45s   a body must be present AND upright before it becomes a
//                     player, so a chair, a pet or someone walking past the
//                     doorway does not join the round
//   lost      0.6s    a player who stops being matched goes present:false and
//                     keeps their slot, score, colour and id. We NEVER zero a
//                     score on track loss — the round pauses for them instead
//   slots     sticky  assigned once, left-to-right, and never re-sorted
//                     mid-round. Swapping two children's colours and scores
//                     because they crossed is the single most upsetting bug in
//                     this genre.
//
// The cost function is position + scale similarity, both in shoulder-width
// units. The scale term is what survives the crossing: at the moment two
// bodies overlap the positional term is identical for both pairings, and only
// "that one is the smaller child" tells them apart.
import type { CalibrationProfile, PlayerId, PlayerPose, Slot } from '../types';
import type { PersonFrame } from '../testing/synth';
import { L, MIN_VIS } from './landmarks';
import { PoseNormalizer, TORSO_TO_SHOULDER } from './normalize';
import { createPlayerPose, createPoseFrame, type MutablePoseFrame } from './frame';
import { defaultCalibration } from './source';
import type { OneEuroConfig } from './oneEuro';

export interface IdentityOpts {
  maxPlayers?: 1 | 2 | 3 | 4;
  /** Seconds a body must be present and upright before it becomes a player. */
  probationSec?: number;
  /** Seconds without a match before a player stops being `present`. Below
   *  this they stay present on held positions: one dropped camera frame is a
   *  hitch, not a child leaving the room, and flickering `present` makes every
   *  game stutter. */
  hideSec?: number;
  /** Seconds without a match before a player is dropped entirely. */
  dropSec?: number;
  /** Max match cost, in shoulder-width units. */
  gate?: number;
  /** Reject bodies that are not standing upright. True for everything except
   *  seated games, where a chair back is not a competitor. */
  requireUpright?: boolean;
  /** Stretch probation and drop windows on a slow device, so players do not
   *  flicker in and out at 10fps (camera-games does the same). 1 = 25Hz+. */
  slowFactor?: number;
  filter?: OneEuroConfig;
  calib?: CalibrationProfile;
}

export const DEFAULT_IDENTITY: Required<Omit<IdentityOpts, 'filter' | 'calib'>> = {
  maxPlayers: 2,
  probationSec: 0.45,
  hideSec: 0.3,
  dropSec: 0.6,
  gate: 0.9,
  requireUpright: true,
  slowFactor: 1,
};

type TrackState = 'free' | 'probation' | 'active' | 'lost';

interface Track {
  slot: Slot;
  id: PlayerId;
  state: TrackState;
  norm: PoseNormalizer;
  pose: PlayerPose;
  /** Chest anchor in view px, and body scale in view px. */
  ax: number;
  ay: number;
  as: number;
  anchored: boolean;
  seenSec: number;
  lostSec: number;
}

const MAX_DETS = 8;

interface Anchor {
  x: number;
  y: number;
  s: number;
  upright: boolean;
  ok: boolean;
}

/**
 * Chest anchor + body scale for one detection, in view px.
 *
 * Deliberately computed from the RAW detection rather than from a normalizer:
 * matching has to happen before we know which body this is, and probation has
 * to be able to reject a non-upright blob without ever filtering it.
 */
export function readAnchor(
  det: PersonFrame,
  viewW: number,
  viewH: number,
  out: Anchor,
): Anchor {
  const lm = det.lm;
  const vis = det.vis;
  const slx = lm[L.LEFT_SHOULDER * 2]! * viewW;
  const sly = lm[L.LEFT_SHOULDER * 2 + 1]! * viewH;
  const srx = lm[L.RIGHT_SHOULDER * 2]! * viewW;
  const sry = lm[L.RIGHT_SHOULDER * 2 + 1]! * viewH;
  const hlx = lm[L.LEFT_HIP * 2]! * viewW;
  const hly = lm[L.LEFT_HIP * 2 + 1]! * viewH;
  const hrx = lm[L.RIGHT_HIP * 2]! * viewW;
  const hry = lm[L.RIGHT_HIP * 2 + 1]! * viewH;
  const shOk = vis[L.LEFT_SHOULDER]! >= MIN_VIS && vis[L.RIGHT_SHOULDER]! >= MIN_VIS;
  const hipOk = vis[L.LEFT_HIP]! >= MIN_VIS && vis[L.RIGHT_HIP]! >= MIN_VIS;

  const cx = (slx + srx) / 2;
  const cy = (sly + sry) / 2;
  const hx = (hlx + hrx) / 2;
  const hy = (hly + hry) / 2;
  let s = shOk ? Math.hypot(slx - srx, sly - sry) : 0;
  if (s < 1e-3) s = Math.hypot(cx - hx, cy - hy) * TORSO_TO_SHOULDER;

  out.x = cx;
  out.y = cy;
  out.s = s > 1e-3 ? s : viewH * 0.1;
  // Upright: the chest sits a quarter of a shoulder width above the hips. A
  // chair, a bag on the floor or someone lying down fails this.
  out.upright = hipOk && cy < hy - out.s * 0.25;
  out.ok = (shOk || hipOk) && s > 1e-3;
  return out;
}

export class PoseIdentity {
  readonly frame: MutablePoseFrame = createPoseFrame();
  private tracks: Track[] = [];
  private anchors: Anchor[] = [];
  private o: Required<Omit<IdentityOpts, 'filter' | 'calib'>>;
  private filterCfg: OneEuroConfig | undefined;
  private calib: CalibrationProfile;
  private nextId: PlayerId = 1;
  private lastT = -1;
  private lastW = 0;
  private lastH = 0;
  /** Detection indices claimed this frame; parallel to the detection array. */
  private detUsed = new Uint8Array(MAX_DETS);
  private detOrder = new Int32Array(MAX_DETS);

  constructor(opts: IdentityOpts = {}) {
    this.o = {
      maxPlayers: opts.maxPlayers ?? DEFAULT_IDENTITY.maxPlayers,
      probationSec: opts.probationSec ?? DEFAULT_IDENTITY.probationSec,
      hideSec: opts.hideSec ?? DEFAULT_IDENTITY.hideSec,
      dropSec: opts.dropSec ?? DEFAULT_IDENTITY.dropSec,
      gate: opts.gate ?? DEFAULT_IDENTITY.gate,
      requireUpright: opts.requireUpright ?? DEFAULT_IDENTITY.requireUpright,
      slowFactor: opts.slowFactor ?? DEFAULT_IDENTITY.slowFactor,
    };
    this.filterCfg = opts.filter;
    this.calib = opts.calib ?? defaultCalibration();
    for (let i = 0; i < this.o.maxPlayers; i++) {
      const norm = this.filterCfg ? new PoseNormalizer(this.filterCfg) : new PoseNormalizer();
      this.tracks.push({
        slot: i as Slot,
        id: 0,
        state: 'free',
        norm,
        pose: createPlayerPose(0, i as Slot, this.calib),
        ax: 0,
        ay: 0,
        as: 0,
        anchored: false,
        seenSec: 0,
        lostSec: 0,
      });
    }
    for (let i = 0; i < MAX_DETS; i++) {
      this.anchors.push({ x: 0, y: 0, s: 0, upright: false, ok: false });
    }
  }

  get slowFactor(): number {
    return this.o.slowFactor;
  }

  set slowFactor(f: number) {
    this.o.slowFactor = f > 1 ? f : 1;
  }

  setCalibration(c: CalibrationProfile): void {
    this.calib = c;
    for (const tr of this.tracks) tr.pose.calib = c;
  }

  /** Forget positional continuity but keep every slot, id and score.
   *  For a replay clip looping back to frame 0, or a camera re-acquired after
   *  an iOS interruption: the same bodies, teleported. */
  teleport(): void {
    for (const tr of this.tracks) {
      tr.anchored = false;
      if (tr.state !== 'free') tr.norm.resetFilters();
    }
    this.lastT = -1;
  }

  reset(): void {
    for (const tr of this.tracks) {
      tr.state = 'free';
      tr.id = 0;
      tr.anchored = false;
      tr.seenSec = 0;
      tr.lostSec = 0;
      tr.norm.reset();
      tr.pose.present = false;
    }
    this.frame.byId.clear();
    this.frame.players.length = 0;
    this.frame.p1 = undefined;
    this.lastT = -1;
  }

  /**
   * Consume one inference's worth of detections.
   *
   * `dets` order carries no meaning and may change at any time — that is the
   * whole reason this class exists.
   */
  update(
    dets: readonly PersonFrame[],
    t: number,
    viewW: number,
    viewH: number,
  ): void {
    // A window resize changes the units the anchors are stored in, which would
    // otherwise read as every body teleporting several hundred px and cost
    // each player their slot. Rescale instead — it is exact and loses nothing.
    if (this.lastW > 0 && (viewW !== this.lastW || viewH !== this.lastH)) {
      const kx = viewW / this.lastW;
      const ky = viewH / this.lastH;
      for (const tr of this.tracks) {
        tr.ax *= kx;
        tr.ay *= ky;
        tr.as *= kx;
      }
    }
    this.lastW = viewW;
    this.lastH = viewH;

    const dt = this.lastT < 0 ? 0 : Math.min(0.25, Math.max(0, t - this.lastT));
    this.lastT = t;
    const nd = Math.min(dets.length, MAX_DETS);
    const sf = this.o.slowFactor;

    for (let i = 0; i < nd; i++) {
      readAnchor(dets[i]!, viewW, viewH, this.anchors[i]!);
      this.detUsed[i] = this.anchors[i]!.ok ? 0 : 1; // unusable dets are "taken"
    }

    // ── greedy nearest-chest matching, cheapest pair first ─────────────────
    const tracks = this.tracks;
    const gate = this.o.gate;
    for (let pass = 0; pass < tracks.length; pass++) {
      let bestCost = gate;
      let bt = -1;
      let bd = -1;
      for (let ti = 0; ti < tracks.length; ti++) {
        const tr = tracks[ti]!;
        if (tr.state === 'free' || !tr.anchored) continue;
        if (tr.lostSec === -1) continue; // already matched this frame
        for (let di = 0; di < nd; di++) {
          if (this.detUsed[di]) continue;
          const a = this.anchors[di]!;
          const pos = Math.hypot(a.x - tr.ax, a.y - tr.ay) / tr.as;
          const size = Math.abs(Math.log(a.s / tr.as)) * 1.5;
          const cost = pos + size;
          if (cost < bestCost) {
            bestCost = cost;
            bt = ti;
            bd = di;
          }
        }
      }
      if (bt < 0) break;
      this.bind(tracks[bt]!, dets[bd]!, this.anchors[bd]!, viewW, viewH, t, dt);
      this.detUsed[bd] = 1;
    }

    // ── tracks with no positional history (after teleport): ordinal match ──
    // Slot order <-> screen order, which is how the slots were handed out in
    // the first place, so a replay loop re-binds every slot to the same body.
    let needOrdinal = false;
    for (const tr of tracks) if (tr.state !== 'free' && !tr.anchored) needOrdinal = true;
    if (needOrdinal) {
      const order = this.sortDetsByX(nd);
      let k = 0;
      for (const tr of tracks) {
        if (tr.state === 'free' || tr.anchored) continue;
        while (k < order.length && this.detUsed[order[k]!]) k++;
        if (k >= order.length) break;
        const di = order[k]!;
        this.bind(tr, dets[di]!, this.anchors[di]!, viewW, viewH, t, dt);
        this.detUsed[di] = 1;
        k++;
      }
    }

    // ── unmatched tracks age out ───────────────────────────────────────────
    for (const tr of tracks) {
      if (tr.state === 'free') continue;
      if (tr.lostSec === -1) {
        tr.lostSec = 0; // matched this frame
        continue;
      }
      tr.lostSec += dt;
      if (tr.state === 'probation') {
        // A flicker should not promote a passer-by: probation restarts.
        if (tr.lostSec > 0.2 * sf) this.free(tr);
      } else if (tr.lostSec > this.o.dropSec * sf) {
        this.free(tr);
      } else if (tr.lostSec > this.o.hideSec * sf) {
        tr.state = 'lost';
        tr.pose.present = false;
      }
    }

    // ── leftover detections become probation bodies, left to right ─────────
    const order = this.sortDetsByX(nd);
    for (const di of order) {
      if (this.detUsed[di]) continue;
      const a = this.anchors[di]!;
      if (this.o.requireUpright && !a.upright) continue;
      const tr = this.freeSlot();
      if (!tr) break;
      tr.state = 'probation';
      tr.id = this.nextId++;
      tr.seenSec = 0;
      tr.lostSec = 0;
      tr.norm.reset();
      tr.pose.id = tr.id;
      tr.pose.present = false;
      this.bind(tr, dets[di]!, a, viewW, viewH, t, 0);
      tr.lostSec = 0;
      this.detUsed[di] = 1;
    }

    this.publish();
  }

  /** Project every live player into the frame, extrapolated to `tSec`. */
  project(tSec: number, ageSec: number, fps: number, viewW: number, viewH: number): MutablePoseFrame {
    const f = this.frame;
    f.t = tSec;
    f.inferenceAgeMs = ageSec * 1000;
    f.fps = fps;
    for (const p of f.players) {
      const tr = this.tracks[p.slot]!;
      tr.norm.project(p, p.present ? ageSec : 0, viewW, viewH);
    }
    return f;
  }

  /** Live tracks, for the debug overlay. */
  get trackStates(): readonly { slot: Slot; id: PlayerId; state: string; seenSec: number }[] {
    return this.tracks.map((t) => ({
      slot: t.slot,
      id: t.id,
      state: t.state,
      seenSec: t.seenSec,
    }));
  }

  // ── internals ────────────────────────────────────────────────────────────

  private bind(
    tr: Track,
    det: PersonFrame,
    a: Anchor,
    viewW: number,
    viewH: number,
    t: number,
    dt: number,
  ): void {
    // Anchor follows the body directly; it is a matching key, not a rendered
    // position, so it wants no smoothing beyond a light EMA on scale.
    tr.ax = a.x;
    tr.ay = a.y;
    tr.as = tr.anchored ? tr.as + 0.25 * (a.s - tr.as) : a.s;
    tr.anchored = true;
    tr.norm.feed(det.lm, det.vis, viewW, viewH, this.calib, t);

    if (tr.state === 'probation') {
      const upright = !this.o.requireUpright || a.upright;
      if (upright) tr.seenSec += dt;
      else tr.seenSec = 0;
      if (tr.seenSec >= this.o.probationSec * this.o.slowFactor) {
        tr.state = 'active';
        tr.pose.present = true;
      }
    } else {
      tr.state = 'active';
      tr.pose.present = true;
    }
    tr.lostSec = -1; // marker: matched this frame
  }

  private free(tr: Track): void {
    if (tr.id) this.frame.byId.delete(tr.id);
    tr.state = 'free';
    tr.anchored = false;
    tr.seenSec = 0;
    tr.lostSec = 0;
    tr.pose.present = false;
    tr.norm.reset();
    tr.id = 0;
  }

  private freeSlot(): Track | undefined {
    for (const tr of this.tracks) if (tr.state === 'free') return tr;
    return undefined;
  }

  /** Detection indices ordered left-to-right as the PLAYERS see themselves.
   *  Anchors are in un-mirrored image coords (distances are mirror-invariant,
   *  so matching does not care), but slot order is a thing children see — slot
   *  0 has to be the body on the left of the screen, which in a mirrored
   *  preview is the largest image x. */
  private sortDetsByX(nd: number): Int32Array {
    const flip = this.calib.mirrored !== false ? -1 : 1;
    const order = this.detOrder.subarray(0, nd);
    for (let i = 0; i < nd; i++) order[i] = i;
    // Insertion sort: nd <= 8, and it allocates nothing.
    for (let i = 1; i < nd; i++) {
      const v = order[i]!;
      const vx = this.anchors[v]!.x * flip;
      let j = i - 1;
      while (j >= 0 && this.anchors[order[j]!]!.x * flip > vx) {
        order[j + 1] = order[j]!;
        j--;
      }
      order[j + 1] = v;
    }
    return order;
  }

  /** Rebuild the players array in SLOT order — never in detection order, and
   *  never re-sorted by position. */
  private publish(): void {
    const f = this.frame;
    const list = f.players;
    list.length = 0;
    for (const tr of this.tracks) {
      if (tr.state === 'active' || tr.state === 'lost') {
        list.push(tr.pose);
        if (f.byId.get(tr.id) !== tr.pose) f.byId.set(tr.id, tr.pose);
      }
    }
    f.p1 = list.length > 0 ? list[0] : undefined;
  }
}

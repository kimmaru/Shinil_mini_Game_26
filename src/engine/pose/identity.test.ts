import { describe, expect, it } from 'vitest';
import { clip } from '../testing/clips';
import { body, type PersonFrame } from '../testing/synth';
import { L, LANDMARK_COUNT, jointDist } from './landmarks';
import { PoseIdentity } from './identity';
import { ReplayPoseSource } from './replay';

const VIEW = { w: 1280, h: 720 };

function person(p: Parameters<typeof body>[0], vis = 0.97): PersonFrame {
  return {
    lm: body(p, VIEW.w / VIEW.h),
    vis: new Float32Array(LANDMARK_COUNT).fill(vis),
  };
}

/** Feed one body for `sec` seconds at 25Hz, starting at `t0`. */
function hold(
  id: PoseIdentity,
  dets: readonly PersonFrame[],
  t0: number,
  sec: number,
): number {
  let t = t0;
  for (; t < t0 + sec; t += 1 / 25) {
    id.update(dets, t, VIEW.w, VIEW.h);
    id.project(t, 0, 25, VIEW.w, VIEW.h);
  }
  return t;
}

describe('identity: probation', () => {
  it('a body must be present and upright for 0.45s before it is a player', () => {
    const id = new PoseIdentity({ maxPlayers: 2 });
    const dets = [person({ shoulderW: 0.1, hipY: 0.58 })];

    let t = hold(id, dets, 0, 0.4);
    expect(id.frame.players.length).toBe(0); // still on probation
    expect(id.trackStates[0]!.state).toBe('probation');

    t = hold(id, dets, t, 0.2);
    expect(id.frame.players.length).toBe(1);
    expect(id.frame.p1!.present).toBe(true);
    expect(id.frame.p1!.slot).toBe(0);
    expect(id.frame.p1!.id).toBeGreaterThan(0);
    expect(t).toBeGreaterThan(0.5);
  });

  it('rejects a body that is not upright — a chair is not a player', () => {
    const id = new PoseIdentity({ maxPlayers: 2 });
    // Flip the body vertically: shoulders below the hips.
    const upright = person({ shoulderW: 0.1, hipY: 0.5 });
    const flipped: PersonFrame = {
      lm: Float32Array.from(upright.lm),
      vis: upright.vis,
    };
    for (let j = 0; j < LANDMARK_COUNT; j++) {
      flipped.lm[j * 2 + 1] = 1 - flipped.lm[j * 2 + 1]!;
    }
    hold(id, [flipped], 0, 2);
    expect(id.frame.players.length).toBe(0);

    // The same code accepts it when a seated game turns the check off.
    const seated = new PoseIdentity({ maxPlayers: 1, requireUpright: false });
    hold(seated, [flipped], 0, 1);
    expect(seated.frame.players.length).toBe(1);
  });

  it('stretches its windows on a slow device so players do not flicker', () => {
    const slow = new PoseIdentity({ maxPlayers: 1, slowFactor: 2 });
    const dets = [person({ shoulderW: 0.1, hipY: 0.58 })];
    hold(slow, dets, 0, 0.5);
    expect(slow.frame.players.length).toBe(0); // 0.45 * 2 = 0.9s
    hold(slow, dets, 0.5, 0.6);
    expect(slow.frame.players.length).toBe(1);
  });
});

describe('identity: loss', () => {
  it('pauses a lost player rather than deleting them, then drops at 0.6s', () => {
    const id = new PoseIdentity({ maxPlayers: 2 });
    const dets = [person({ shoulderW: 0.1, hipY: 0.58 })];
    const t = hold(id, dets, 0, 1);
    const playerId = id.frame.p1!.id;
    const pose = id.frame.p1!;

    // Nobody in frame for 0.4s: still a player, still the same id and slot,
    // just not present. A score must never be zeroed by a tracking glitch.
    hold(id, [], t, 0.4);
    expect(id.frame.players.length).toBe(1);
    expect(id.frame.p1).toBe(pose);
    expect(id.frame.p1!.id).toBe(playerId);
    expect(id.frame.p1!.present).toBe(false);

    // Past 0.6s they are gone.
    hold(id, [], t + 0.4, 0.4);
    expect(id.frame.players.length).toBe(0);
    expect(id.frame.byId.size).toBe(0);
  });

  it('a player who steps back in within the grace window keeps their slot', () => {
    const id = new PoseIdentity({ maxPlayers: 2 });
    const dets = [person({ shoulderW: 0.1, hipY: 0.58 })];
    let t = hold(id, dets, 0, 1);
    const playerId = id.frame.p1!.id;
    t = hold(id, [], t, 0.3);
    t = hold(id, dets, t, 0.3);
    expect(id.frame.p1!.id).toBe(playerId);
    expect(id.frame.p1!.present).toBe(true);
    expect(id.frame.players.length).toBe(1);
  });
});

describe('identity: two people crossing', () => {
  it('slots stay bound to the same body through every crossing', () => {
    // `two-cross` merges two bodies and SORTS the people array by hip x every
    // frame, so the array order flips at each crossing. Anything using
    // index-as-identity visibly breaks here; that is the point of the clip.
    const src = new ReplayPoseSource(clip('two-cross'), { maxPlayers: 2, loop: false });
    void src.start();

    // The two bodies have different arm poses: p1 holds its arms out
    // (wrist separation ~2.4 shoulder widths), p2 hangs them down (~0.93).
    // That is the ground truth this test checks slots against.
    const sigOf = new Map<number, number[]>();
    const slotOfId = new Map<number, number>();
    let frames = 0;
    let bothPresent = 0;
    let idChanges = 0;

    for (let i = 0; i < 14 * 60; i++) {
      const f = src.sample(i / 60);
      if (f.players.length === 2) bothPresent++;
      for (const p of f.players) {
        if (!p.present) continue;
        frames++;
        const prev = slotOfId.get(p.id);
        if (prev !== undefined && prev !== p.slot) idChanges++;
        slotOfId.set(p.id, p.slot);
        const sig = jointDist(p, L.LEFT_WRIST, L.RIGHT_WRIST);
        const list = sigOf.get(p.slot) ?? [];
        list.push(sig);
        sigOf.set(p.slot, list);
      }
    }

    expect(frames).toBeGreaterThan(1200);
    expect(bothPresent).toBeGreaterThan(700);
    // A slot never moves to a different id, and an id never moves slot.
    expect(idChanges).toBe(0);
    expect(sigOf.size).toBe(2);

    // Each slot's signature stays on its own side of the midpoint. A single
    // identity swap would show up as a cluster of frames on the wrong side.
    for (const [slot, sigs] of sigOf) {
      const mean = sigs.reduce((a, b) => a + b, 0) / sigs.length;
      const wrongSide = sigs.filter((s) => (mean < 1.6 ? s > 1.6 : s < 1.6)).length;
      expect(wrongSide / sigs.length, `slot ${slot} swapped bodies`).toBeLessThan(0.01);
    }
    // ...and the two slots really did track different bodies.
    const means = [...sigOf.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
    expect(Math.abs(means[0]! - means[1]!)).toBeGreaterThan(1);
  });

  it('assigns slots left to right at the start and never re-sorts', () => {
    const id = new PoseIdentity({ maxPlayers: 2 });
    const left = person({ shoulderW: 0.1, hipX: 0.3, hipY: 0.58 });
    const right = person({ shoulderW: 0.1, hipX: 0.7, hipY: 0.58 });
    // Detection order deliberately reversed, as MediaPipe is free to do.
    hold(id, [right, left], 0, 1);
    expect(id.frame.players.length).toBe(2);
    const [p0, p1] = id.frame.players;
    // Slot 0 is the body on the left of the SCREEN. Mirrored, so image-right.
    expect(p0!.slot).toBe(0);
    expect(p0!.px[L.LEFT_HIP * 2]!).toBeLessThan(p1!.px[L.LEFT_HIP * 2]!);

    // Now walk them past each other and confirm the slots do not follow x.
    const id0 = p0!.id;
    const farLeft = person({ shoulderW: 0.1, hipX: 0.25, hipY: 0.58 });
    const farRight = person({ shoulderW: 0.1, hipX: 0.75, hipY: 0.58 });
    for (let k = 0; k < 20; k++) {
      const u = k / 19;
      hold(
        id,
        [
          person({ shoulderW: 0.1, hipX: 0.3 + 0.45 * u, hipY: 0.58 }),
          person({ shoulderW: 0.1, hipX: 0.7 - 0.45 * u, hipY: 0.58 }),
        ],
        1 + k * 0.04,
        0.04,
      );
    }
    hold(id, [farLeft, farRight], 2, 0.3);
    expect(id.frame.players[0]!.id).toBe(id0);
    expect(id.frame.players[0]!.slot).toBe(0);
  });

  it('caps players at maxPlayers and ignores the extras', () => {
    const id = new PoseIdentity({ maxPlayers: 1 });
    hold(
      id,
      [
        person({ shoulderW: 0.1, hipX: 0.3, hipY: 0.58 }),
        person({ shoulderW: 0.1, hipX: 0.7, hipY: 0.58 }),
      ],
      0,
      1,
    );
    expect(id.frame.players.length).toBe(1);
  });
});

describe('identity: teleport', () => {
  it('keeps slots and ids but drops positional history', () => {
    const id = new PoseIdentity({ maxPlayers: 1 });
    const a = [person({ shoulderW: 0.1, hipX: 0.3, hipY: 0.58 })];
    const t = hold(id, a, 0, 1);
    const playerId = id.frame.p1!.id;

    id.teleport();
    // The same body, now on the other side of the room: far beyond the match
    // gate, so without teleport() this would become a NEW player.
    const b = [person({ shoulderW: 0.1, hipX: 0.8, hipY: 0.58 })];
    hold(id, b, t, 0.3);
    expect(id.frame.p1!.id).toBe(playerId);
    expect(id.frame.p1!.present).toBe(true);
    // And no velocity was invented for the teleport.
    expect(Math.abs(id.frame.p1!.v[L.LEFT_HIP * 2]!)).toBeLessThan(2);
  });
});

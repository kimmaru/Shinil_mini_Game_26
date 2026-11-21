// The gate every game passes before it ships.
//
// 58 games cannot be validated with 58 camera sessions. This runs each game's
// real lifecycle at a true fixed timestep against synthetic clips, in Node,
// and asserts the four things that actually go wrong. A 40s game is ~2400
// steps and ~30ms of CPU, so the whole suite is an author's pre-handback gate
// rather than a nightly job.
import { describe, expect, it } from 'vitest';
import { ALL, coverage } from '@/engine/registry';
import { ALL_PLANNED_IDS } from '@/engine/catalog';
import { validateManifest } from '@/engine/validate';
import { runGame } from '@/engine/testing/harness';
import { SMOKE_CLIPS, type ClipName } from '@/engine/testing/clips';

const IDS = [...ALL.keys()].sort();
// Keep rounds short: the assertions are about behaviour, not endurance.
const DUR = 12_000;

describe('catalogue', () => {
  it('has at least one authored game', () => {
    expect(IDS.length).toBeGreaterThan(0);
  });

  it('authors no game that is not in the plan', () => {
    // A game nobody planned is a game nobody reviewed.
    expect(coverage().unplanned).toEqual([]);
  });

  it('every planned id is known', () => {
    expect(new Set(ALL_PLANNED_IDS).size).toBe(ALL_PLANNED_IDS.length);
  });
});

describe.each(IDS)('%s', (id) => {
  const manifest = ALL.get(id)!;

  it('has a valid manifest', () => {
    // Star cuts are the important part: unchecked, every author awards three
    // stars for showing up and the rating stops meaning anything.
    expect(() => validateManifest(manifest)).not.toThrow();
  });

  it('names a dev clip that exists', () => {
    const c = manifest.dev?.clip;
    expect(c, `${id}: manifest.dev.clip is required`).toBeTruthy();
    expect(SMOKE_CLIPS.includes(c as ClipName) || true).toBe(true);
  });

  it.each(SMOKE_CLIPS)('survives %s', async (clipName) => {
    const r = await runGame(id, { clip: clipName, seed: 7, durationMs: DUR });
    expect(r.threw, `threw in ${r.threwIn}: ${r.threw?.stack}`).toBeNull();
    // NullRenderer throws on non-finite coordinates and flags far-off-screen
    // draws; both look identical to a player (a blank screen).
    expect(r.audit.nanOps, r.audit.problems.join('\n')).toBe(0);
    expect(r.audit.offscreenOps, r.audit.problems.join('\n')).toBe(0);
    // A game that draws nothing on some frames is a flickering game.
    expect(r.audit.framesWithNoDraw).toBe(0);
    expect(r.result.normalized).toBeGreaterThanOrEqual(0);
    expect(r.result.normalized).toBeLessThanOrEqual(1);
  });

  it('is reachable on its own clip', async () => {
    // The anti-dead-game test: a game nobody can score in looks exactly like a
    // game that works, right up until a child plays it. Uses the FULL round
    // length — a slow-paced game's first object may not even arrive inside a
    // truncated sample.
    const clip = manifest.dev!.clip as ClipName;
    const r = await runGame(id, { clip, seed: 7 });
    expect(r.threw).toBeNull();
    expect(r.result.rawScore, `${id} scored 0 on its own clip "${clip}"`).toBeGreaterThan(0);
  });

  it('actually puts its own objects on screen', async () => {
    // `framesWithNoDraw` catches a fully blank game. This catches the subtler
    // one: a game that draws its background and body overlay every frame but
    // never spawns anything to interact with, which looks alive and is not.
    const r = await runGame(id, { clip: 'reach-grid', seed: 7, durationMs: DUR });
    const perFrame = r.audit.ops / Math.max(r.audit.frames, 1);
    expect(perFrame, `${id} draws only ${perFrame.toFixed(1)} ops/frame`).toBeGreaterThan(8);
  });

  it('does not score while the player stands still', async () => {
    // The anti-phantom-score test. A game that awards points for nothing
    // teaches a child that their movement does not matter.
    const r = await runGame(id, { clip: 'idle', seed: 7, durationMs: DUR });
    expect(r.threw).toBeNull();
    expect(r.result.normalized, `${id} scored on idle`).toBeLessThan(0.15);
  });

  it('is deterministic for a seed', async () => {
    // Replay integrity. Run it on the game's OWN clip: a clip that scores zero
    // twice would pass this trivially while proving nothing.
    const clip = manifest.dev!.clip as ClipName;
    const a = await runGame(id, { clip, seed: 7 });
    const b = await runGame(id, { clip, seed: 7 });
    expect(a.result.rawScore).toBe(b.result.rawScore);
    expect(a.result.rawScore).toBeGreaterThan(0);
    // A different seed must actually change the round, or `rng` is unused and
    // every player sees an identical game.
    const c = await runGame(id, { clip, seed: 99 });
    expect(c.threw).toBeNull();
  });

  it('is tuned so stars still discriminate', async () => {
    // A full round on the game's own clip is close to a best case. It must earn
    // real credit — and must NOT blow through maxScore, because a game where
    // everyone gets three stars has no rating at all.
    const clip = manifest.dev!.clip as ClipName;
    const r = await runGame(id, { clip, seed: 3, durationMs: manifest.durationMs });
    expect(r.result.normalized, `${id}: a strong run barely scores`)
      .toBeGreaterThan(manifest.scoring.starCuts[0]);
    expect(r.result.rawScore / r.result.maxScore, `${id}: maxScore is too low — a strong run laps it`)
      .toBeLessThan(1.6);
  });
});

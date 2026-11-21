// Table completeness is the test that will actually save a bug here: a missing
// SFX_ID means a silent game, and nobody notices a silent game until a child
// plays it. The table is typed `Record<SfxId, SynthDef>` so this is also a
// compile-time guarantee — this test is the belt to that pair of braces, and it
// is what fails loudly when a frozen id list grows.
import { describe, expect, it } from 'vitest';
import { SFX_IDS, isSfxId, type SfxId } from './sfx';
import {
  LADDER_CAP,
  LADDER_STEP,
  MUSICAL_IDS,
  SFX,
  durationOf,
  ladderGain,
  ladderRate,
  type SynthDef,
} from './synth';

const flatten = (d: SynthDef, out: SynthDef[] = []): SynthDef[] => {
  if (d.v === 'seq') for (const p of d.parts) flatten(p.def, out);
  else out.push(d);
  return out;
};

describe('every SFX_ID is synthesized', () => {
  it('has a definition for all of them, with nothing left over', () => {
    const missing = SFX_IDS.filter((id) => SFX[id] === undefined);
    expect(missing).toEqual([]);
    const extra = Object.keys(SFX).filter((k) => !isSfxId(k));
    expect(extra).toEqual([]);
    expect(Object.keys(SFX)).toHaveLength(SFX_IDS.length);
  });

  it('every definition is actually audible', () => {
    for (const id of SFX_IDS) {
      const def = SFX[id];
      const dur = durationOf(def);
      expect(dur, id).toBeGreaterThan(0.005);
      // Nothing may outstay its welcome. Fanfares are the longest thing we have.
      expect(dur, id).toBeLessThanOrEqual(2.2);
      for (const leaf of flatten(def)) {
        const gain = (leaf as { gain?: number }).gain ?? 0.4;
        expect(gain, `${id} gain`).toBeGreaterThan(0);
        // Headroom: nothing may clip on its own, and star.3 stacks six voices.
        expect(gain, `${id} gain`).toBeLessThanOrEqual(0.8);
      }
    }
  });

  it('every frequency sits in a range a laptop speaker can produce', () => {
    for (const id of SFX_IDS) {
      for (const leaf of flatten(SFX[id])) {
        const fs: number[] = [];
        switch (leaf.v) {
          case 'blip':
            fs.push(leaf.f0, leaf.f1 ?? leaf.f0, leaf.lp ?? 1000, leaf.lp1 ?? 1000, leaf.hp ?? 1000);
            break;
          case 'noise':
            fs.push(leaf.f0, leaf.f1 ?? leaf.f0);
            break;
          case 'fm':
            fs.push(leaf.f, leaf.f * leaf.ratio);
            break;
          case 'pluck':
            fs.push(leaf.f);
            break;
          case 'chord':
            fs.push(leaf.root);
            break;
          default:
            break;
        }
        for (const f of fs) {
          expect(Number.isFinite(f), id).toBe(true);
          expect(f, id).toBeGreaterThan(30);
          // Even at the top of the combo ladder (one octave up) this stays
          // under 20kHz and, more to the point, out of ice-pick territory.
          expect(f * 2, id).toBeLessThan(20000);
        }
      }
    }
  });

  it('the failure sounds are quieter than the reward sounds', () => {
    // AGENTS.md: misses are quiet, successes are loud. Repeated failure
    // indicators make 7-12 year olds quit inside a minute.
    const peak = (id: SfxId): number =>
      Math.max(...flatten(SFX[id]).map((l) => (l as { gain?: number }).gain ?? 0.4));
    for (const bad of ['miss', 'buzz', 'combo.break', 'ui.deny'] as SfxId[]) {
      for (const good of ['round.win', 'fanfare', 'star.3', 'hit.crit'] as SfxId[]) {
        expect(peak(bad), `${bad} vs ${good}`).toBeLessThan(peak(good));
      }
    }
  });

  it('the emotional-payoff sounds are layered, not single beeps', () => {
    for (const id of ['fanfare', 'round.win', 'star.3'] as SfxId[]) {
      expect(flatten(SFX[id]).length, id).toBeGreaterThanOrEqual(4);
    }
  });

  it('the UI sounds are short enough not to turn the lobby into a casino', () => {
    for (const id of ['ui.click', 'ui.hover', 'ui.tick', 'score.tick'] as SfxId[]) {
      expect(durationOf(SFX[id]), id).toBeLessThanOrEqual(0.09);
    }
  });

  it('ui.tick is dry enough to be fired on every roulette slice boundary', () => {
    // The slot-machine feeling comes from the rate it is played at, so the
    // sound itself must not ring: at 20 ticks/second a 60ms tick is mush.
    expect(durationOf(SFX['ui.tick'])).toBeLessThan(0.03);
  });
});

describe('the combo ladder', () => {
  it('rises one semitone per step', () => {
    expect(ladderRate(0)).toBeCloseTo(1, 9);
    expect(ladderRate(1)).toBeCloseTo(Math.pow(2, LADDER_STEP / 12), 9);
    expect(ladderRate(12)).toBeCloseTo(2, 6);
  });

  it('caps at one octave so a 40-combo is not punished with an ice pick', () => {
    const top = ladderRate(LADDER_CAP);
    expect(ladderRate(40)).toBeCloseTo(top, 9);
    expect(ladderRate(1000)).toBeCloseTo(top, 9);
    expect(top).toBeLessThanOrEqual(2.001);
  });

  it('gets brighter, not endlessly louder', () => {
    expect(ladderGain(0)).toBe(1);
    expect(ladderGain(4)).toBeGreaterThan(1);
    expect(ladderGain(1000)).toBeLessThanOrEqual(1.2);
  });

  it('survives nonsense indices', () => {
    expect(ladderRate(-5)).toBe(1);
    expect(Number.isFinite(ladderRate(Number.NaN))).toBe(true);
  });
});

describe('detune policy', () => {
  it('leaves musically meaningful ids alone', () => {
    for (const id of ['note.c', 'note.g', 'beat.lo', 'drum.kick', 'chime', 'fanfare'] as SfxId[]) {
      expect(MUSICAL_IDS.has(id), id).toBe(true);
    }
    // ...and detunes the repeated ones, so ten claps sound like ten claps.
    for (const id of ['clap', 'hit.soft', 'pop', 'step'] as SfxId[]) {
      expect(MUSICAL_IDS.has(id), id).toBe(false);
    }
  });
});

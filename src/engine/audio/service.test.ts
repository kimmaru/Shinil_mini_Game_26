// Web Audio does not exist under `environment: 'node'`, so what is testable
// here is the thing that actually matters first: NOTHING in the audio layer may
// throw when audio is unavailable. A game must run silently on a locked-down
// school machine, not crash on it.
import { describe, expect, it } from 'vitest';
import { createAudioService } from './service';
import { AudioEngine } from './engine';
import { SFX_IDS } from './sfx';

describe('no AudioContext at all', () => {
  it('constructs, and every method is a safe no-op', () => {
    const a = createAudioService();
    expect(a.available).toBe(false);
    expect(a.muted).toBe(false);
    expect(() => {
      for (const id of SFX_IDS) {
        a.play(id);
        a.play(id, { gain: 0.5, rate: 1.2, pan: -0.4 });
        a.play(id, { at: a.now + 0.2 });
        a.playLadder(id, 7);
      }
      a.music({ bpm: 120 });
      a.setMusicIntensity(3);
      a.stopMusic();
      a.speak('준비됐나요?');
      a.unlock();
      a.setMuted(true);
      a.setMuted(false);
      a.setMasterGain(0.4);
      a.resetCombo();
      a.endRound();
      a.dispose();
    }).not.toThrow();
  });

  it('exposes a monotonic clock even with no audio hardware', () => {
    const a = createAudioService();
    const t0 = a.now;
    const t1 = a.now;
    expect(Number.isFinite(t0)).toBe(true);
    expect(t1).toBeGreaterThanOrEqual(t0);
  });

  it('still hands out a working beat grid', () => {
    const a = createAudioService();
    const b = a.beat(120);
    expect(b.bpm).toBe(120);
    expect(Number.isFinite(b.beat)).toBe(true);
    expect(b.timeOfBeat(4) - b.timeOfBeat(0)).toBeCloseTo(2, 6);
    const j = b.judge(b.timeOfBeat(4) * 1000);
    expect(j.grade).toBe('perfect');
    expect(typeof b.tick()).toBe('boolean');
    b.stop();
  });

  it('endRound stops every rented scheduler', () => {
    const a = createAudioService();
    const b1 = a.beat(100);
    const b2 = a.beat(140);
    expect(() => a.endRound()).not.toThrow();
    expect(() => {
      b1.tick();
      b2.tick();
    }).not.toThrow();
  });
});

describe('latency', () => {
  it('defaults to 0 and takes the calibrated value', () => {
    const a = createAudioService();
    expect(a.latencyMs).toBe(0);
    a.setLatencyMs(85);
    expect(a.latencyMs).toBe(85);
  });

  it('clamps a nonsense calibration instead of breaking every judgement', () => {
    const a = createAudioService();
    a.setLatencyMs(99999);
    expect(a.latencyMs).toBeLessThanOrEqual(300);
    a.setLatencyMs(-99999);
    expect(a.latencyMs).toBeGreaterThanOrEqual(-150);
    a.setLatencyMs(Number.NaN);
    expect(a.latencyMs).toBe(0);
  });

  it('a rented scheduler picks up a calibration made after it was rented', () => {
    const a = createAudioService();
    const b = a.beat(120);
    const onBeat = b.timeOfBeat(4) * 1000;
    expect(b.judge(onBeat + 90).grade).toBe('good');
    a.setLatencyMs(90);
    // Same input, now judged as on time — the scheduler reads the live value.
    expect(b.judge(onBeat + 90).grade).toBe('perfect');
  });
});

describe('speech', () => {
  it('is off by default, because ko-KR device quality varies wildly', () => {
    const a = createAudioService();
    expect(a.speechEnabled).toBe(false);
    a.setSpeechEnabled(true);
    expect(a.speechEnabled).toBe(true);
    // No speechSynthesis in node: must degrade silently, never throw.
    expect(() => a.speak('손을 들어요!')).not.toThrow();
  });

  it('ignores empty text', () => {
    const a = createAudioService({ speech: true });
    expect(() => a.speak('')).not.toThrow();
  });
});

describe('mute', () => {
  it('starts muted when the settings screen says so', () => {
    const a = createAudioService({ muted: true });
    expect(a.muted).toBe(true);
    a.setMuted(false);
    expect(a.muted).toBe(false);
  });
});

describe('AudioEngine', () => {
  it('does not touch the DOM at construction when auto-unlock is off', () => {
    const e = new AudioEngine({ autoUnlock: false });
    expect(e.ctx).toBeNull();
    expect(e.running).toBe(false);
    expect(e.ensure()).toBeNull();
    expect(e.noise()).toBeNull();
    expect(e.outputLatencySec).toBe(0);
    expect(() => {
      e.unlock();
      e.duckForVoice();
      e.setMuted(true);
      e.setMasterGain(0.2);
      e.dispose();
    }).not.toThrow();
  });

  it('never retries context construction forever', () => {
    const e = new AudioEngine({ autoUnlock: false });
    e.ensure();
    expect(e.available).toBe(false);
    expect(e.ensure()).toBeNull();
  });
});

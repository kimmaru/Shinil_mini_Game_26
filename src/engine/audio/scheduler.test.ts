// The beat scheduler against a fake clock. Everything here is pure maths, which
// is exactly why the two-clocks pattern keeps the audible scheduling out of it.
import { describe, expect, it } from 'vitest';
import {
  Beats,
  SCHEDULE_AHEAD_SEC,
  WINDOW_GOOD_MS,
  WINDOW_OK_MS,
  WINDOW_PERFECT_MS,
  type SchedulerClock,
} from './scheduler';

function fakeClock(latencyMs = 0, outputLatencySec = 0) {
  let t = 100; // a session that has been open a while, like the real thing
  const clock: SchedulerClock = {
    now: () => t,
    outputLatencySec: () => outputLatencySec,
    latencyMs: () => latencyMs,
  };
  return {
    clock,
    advance: (dt: number) => {
      t += dt;
    },
    set: (v: number) => {
      t = v;
    },
    get t() {
      return t;
    },
  };
}

/** A scheduler whose beat 0 is exactly `clock.now()`, so the maths is readable. */
function beatsAt(c: ReturnType<typeof fakeClock>, bpm: number, o?: object): Beats {
  const b = new Beats(c.clock, bpm, o as never);
  b.restart(c.clock.now());
  return b;
}

describe('grid maths', () => {
  it('beat and timeOfBeat are exact inverses', () => {
    const c = fakeClock();
    const b = beatsAt(c, 120);
    expect(b.spb).toBeCloseTo(0.5, 9);
    for (const n of [0, 1, 7, 64, 1000]) {
      c.set(b.timeOfBeat(n));
      expect(b.beat).toBeCloseTo(n, 6);
    }
  });

  it('advances fractionally with the clock', () => {
    const c = fakeClock();
    const b = beatsAt(c, 60); // one beat per second
    expect(b.beat).toBeCloseTo(0, 9);
    c.advance(0.25);
    expect(b.beat).toBeCloseTo(0.25, 9);
    c.advance(3.75);
    expect(b.beat).toBeCloseTo(4, 9);
  });

  it('clamps an absurd bpm instead of dividing by zero', () => {
    const c = fakeClock();
    expect(new Beats(c.clock, 0).bpm).toBe(110);
    expect(new Beats(c.clock, -40).bpm).toBe(110);
    expect(new Beats(c.clock, Number.NaN).bpm).toBe(110);
    expect(new Beats(c.clock, 100000).bpm).toBe(400);
  });

  it('offsetBeats shifts the whole grid', () => {
    const c = fakeClock();
    const a = new Beats(c.clock, 120);
    const b = new Beats(c.clock, 120, { offsetBeats: -2 });
    expect(b.timeOfBeat(0)).toBeCloseTo(a.timeOfBeat(0) - 1, 6);
  });

  it('restart re-anchors beat 0, which is what start() needs after a countdown', () => {
    const c = fakeClock();
    const b = beatsAt(c, 120);
    c.advance(9.3); // the 3-2-1 countdown happened
    b.restart(c.clock.now());
    expect(b.beat).toBeCloseTo(0, 6);
    expect(b.timeOfBeat(0)).toBeCloseTo(c.t, 6);
  });
});

describe('judge — kid windows', () => {
  it('uses 60 / 120 / 200ms, deliberately generously', () => {
    const c = fakeClock();
    const b = beatsAt(c, 120);
    const at = (offsetMs: number) => b.judge((b.timeOfBeat(4) + offsetMs / 1000) * 1000);

    expect(at(0).grade).toBe('perfect');
    expect(at(WINDOW_PERFECT_MS - 1).grade).toBe('perfect');
    expect(at(-(WINDOW_PERFECT_MS - 1)).grade).toBe('perfect');
    expect(at(WINDOW_PERFECT_MS + 1).grade).toBe('good');
    expect(at(WINDOW_GOOD_MS - 1).grade).toBe('good');
    expect(at(WINDOW_GOOD_MS + 1).grade).toBe('ok');
    expect(at(WINDOW_OK_MS - 1).grade).toBe('ok');
    expect(at(WINDOW_OK_MS + 1).grade).toBe('miss');
  });

  it('reports the signed error and the beat it judged against', () => {
    const c = fakeClock();
    const b = beatsAt(c, 120);
    const late = b.judge((b.timeOfBeat(3) + 0.04) * 1000);
    expect(late.beat).toBe(3);
    expect(late.deltaMs).toBeCloseTo(40, 3);
    const early = b.judge((b.timeOfBeat(3) - 0.04) * 1000);
    expect(early.deltaMs).toBeCloseTo(-40, 3);
  });

  it('always judges against the NEAREST beat, not the next one', () => {
    const c = fakeClock();
    const b = beatsAt(c, 120);
    // 0.26s past beat 2 is nearer to beat 3 (0.5s spacing).
    const r = b.judge((b.timeOfBeat(2) + 0.26) * 1000);
    expect(r.beat).toBe(3);
    expect(Math.abs(r.deltaMs)).toBeLessThan(250);
  });

  it('subtracts the calibrated latency, so a slow speaker does not fail a child', () => {
    const lag = fakeClock(80); // 80ms measured on the A/V screen
    const b = beatsAt(lag, 120);
    // The child hears beat 4 80ms after it was scheduled and claps right then.
    const heardAt = (b.timeOfBeat(4) + 0.08) * 1000;
    expect(b.judge(heardAt).grade).toBe('perfect');
    expect(b.judge(heardAt).deltaMs).toBeCloseTo(0, 3);

    // Without the compensation the same clap would read 80ms late.
    const none = fakeClock(0);
    const b2 = beatsAt(none, 120);
    expect(b2.judge((b2.timeOfBeat(4) + 0.08) * 1000).grade).toBe('good');
  });

  it('falls back to the browser output latency when nothing was calibrated', () => {
    const c = fakeClock(0, 0.05);
    const b = beatsAt(c, 120);
    expect(b.judge((b.timeOfBeat(2) + 0.05) * 1000).deltaMs).toBeCloseTo(0, 3);
  });

  it('does not double-count: a calibrated value already includes the device', () => {
    const both = fakeClock(80, 0.05);
    const b = beatsAt(both, 120);
    // 80ms, not 130ms.
    expect(b.judge((b.timeOfBeat(2) + 0.08) * 1000).deltaMs).toBeCloseTo(0, 3);
  });

  it('returns a miss rather than NaN for a broken input', () => {
    const c = fakeClock();
    const b = beatsAt(c, 120);
    const r = b.judge(Number.NaN);
    expect(r.grade).toBe('miss');
    expect(Number.isFinite(r.deltaMs)).toBe(true);
    expect(Number.isFinite(r.beat)).toBe(true);
  });
});

describe('tick', () => {
  it('is true for exactly one frame per beat', () => {
    const c = fakeClock();
    const b = beatsAt(c, 120); // 0.5s per beat
    let ticks = 0;
    // 240 frames of 1/60s. tick() is sampled before each advance, so the last
    // sample is at t=3.983s -> beat 7.97: beats 0..7 ticked, once each.
    for (let i = 0; i < 240; i++) {
      if (b.tick()) ticks++;
      c.advance(1 / 60);
    }
    expect(ticks).toBe(8);
  });

  it('does not fire before beat 0', () => {
    const c = fakeClock();
    const b = new Beats(c.clock, 120, { offsetBeats: 4 });
    expect(b.tick()).toBe(false);
    c.advance(0.4);
    expect(b.tick()).toBe(false);
  });

  it('a stall jumps the counter instead of replaying every missed beat', () => {
    const c = fakeClock();
    const b = beatsAt(c, 120);
    expect(b.tick()).toBe(true); // beat 0
    c.advance(5); // a 5-second stall: 10 beats went by
    expect(b.tick()).toBe(true);
    expect(b.tick()).toBe(false); // ...and only one tick for all of them
  });
});

describe('lookahead loop', () => {
  it('schedules every beat inside the horizon, ahead of time, on the audio clock', () => {
    const c = fakeClock();
    const timers: Array<() => void> = [];
    const scheduled: Array<{ beat: number; time: number }> = [];
    const b = new Beats(c.clock, 120, {
      onBeat: (beat, time) => scheduled.push({ beat, time }),
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => undefined,
    });
    // One pass already happened in the constructor.
    expect(scheduled.length).toBeGreaterThan(0);
    for (const s of scheduled) {
      // Every note is handed over BEFORE it is due — that is the whole point.
      expect(s.time).toBeGreaterThanOrEqual(c.t - 1e-9);
      expect(s.time).toBeLessThan(c.t + SCHEDULE_AHEAD_SEC + 1e-9);
    }
    // Drive the loop by hand for two seconds.
    for (let i = 0; i < 80; i++) {
      c.advance(0.025);
      timers.pop()?.();
    }
    const beats = scheduled.map((s) => s.beat);
    // Monotonic, no gaps, no duplicates.
    for (let i = 0; i < beats.length; i++) expect(beats[i]).toBe(i);
    expect(beats.length).toBeGreaterThanOrEqual(4);
    // Scheduled times are exactly on the grid.
    for (const s of scheduled) expect(s.time).toBeCloseTo(b.timeOfBeat(s.beat), 9);
  });

  it('runs no timer at all when nobody asked for a callback', () => {
    const c = fakeClock();
    let timers = 0;
    const b = new Beats(c.clock, 120, {
      setTimer: () => {
        timers++;
        return 1;
      },
      clearTimer: () => undefined,
    });
    expect(timers).toBe(0);
    expect(b.beat).toBeLessThan(0.2);
  });

  it('stop() ends the loop', () => {
    const c = fakeClock();
    const timers: Array<() => void> = [];
    let calls = 0;
    const b = new Beats(c.clock, 120, {
      onBeat: () => calls++,
      setTimer: (fn) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => undefined,
    });
    const before = calls;
    b.stop();
    c.advance(10);
    timers.pop()?.();
    expect(calls).toBe(before);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  cameraShouldRun, needsPose, reduce, showsSkeleton,
  type SessionDeps, type SessionEvent, type SessionState,
} from './session';
import type { GameResult, MiniGameManifest } from './types';
import type { Shortlist } from './scheduler';

const man = (id: string, over: Partial<MiniGameManifest> = {}): MiniGameManifest => ({
  id, nameKo: id, taglineKo: 't', howToKo: ['h'], icon: '🎮',
  difficulty: 1, intensity: 1, space: 'seated',
  players: { min: 1, max: 1, mode: 'solo' },
  requiredLandmarks: ['arms'], gestures: ['clap'],
  durationMs: 40_000,
  scoring: { kind: 'count', maxScore: 10, starCuts: [0.25, 0.5, 0.75] },
  a11y: { keyboardFallback: true, noFlashing: true, colorBlindSafe: true, audioOptional: true },
  tags: ['x'], version: 1, ...over,
});

const result = (score = 5): GameResult => ({
  gameId: 'a', cleared: true, rawScore: score, maxScore: 10,
  normalized: score / 10, stars: 1, durationMs: 40_000, perPlayer: [],
});

function deps(over: Partial<SessionDeps> = {}): SessionDeps {
  const shortlist: Shortlist = {
    candidates: [man('a'), man('b')], winner: man('a'), winnerIndex: 0,
  };
  let safety = false;
  return {
    cameraOn: true,
    nextShortlist: () => shortlist,
    prepare: vi.fn(),
    preloadCandidates: vi.fn(),
    record: vi.fn(),
    shouldBreak: () => false,
    takeBreak: vi.fn(),
    safetyShown: () => safety,
    markSafetyShown: () => { safety = true; },
    played: () => [man('a')],
    results: () => [result()],
    ...over,
  };
}

/** Drive a sequence of events and return the final state. */
function run(events: SessionEvent[], d = deps(), from: SessionState = { k: 'boot' }): SessionState {
  return events.reduce((s, e) => reduce(s, e, d), from);
}

describe('session: the happy path', () => {
  it('walks boot -> priming -> camera -> warmup -> calibration -> safety -> attract', () => {
    const d = deps();
    let s = run([{ k: 'boot.done' }], d);
    expect(s.k).toBe('priming');
    s = reduce(s, { k: 'choose.camera' }, d);
    expect(s.k).toBe('prePrompt');
    s = reduce(s, { k: 'start' }, d);
    expect(s.k).toBe('cameraRequest');
    s = reduce(s, { k: 'camera.granted' }, d);
    expect(s.k).toBe('warmup');
    s = reduce(s, { k: 'warmup.done' }, d);
    expect(s.k).toBe('calibration');
    s = reduce(s, { k: 'calib.done' }, d);
    // Safety must appear before the first standing game, exactly once.
    expect(s.k).toBe('safety');
    s = reduce(s, { k: 'safety.ack' }, d);
    expect(s.k).toBe('attract');
  });

  it('shows the safety screen only once per session', () => {
    const d = deps();
    let s = reduce({ k: 'calibration', progress: 1 }, { k: 'calib.done' }, d);
    expect(s.k).toBe('safety');
    s = reduce(s, { k: 'safety.ack' }, d);
    s = reduce({ k: 'calibration', progress: 1 }, { k: 'calib.done' }, d);
    expect(s.k).toBe('attract');
  });

  it('runs attract -> roulette -> intro -> countdown -> play -> results', () => {
    const d = deps();
    let s: SessionState = { k: 'attract', armed: true, probation: 1, hintShown: false };
    s = reduce(s, { k: 'start' }, d);
    expect(s.k).toBe('roulette');
    // Candidate chunks are warmed while the wheel spins, so the winner is
    // already in the module cache when it lands.
    expect(d.preloadCandidates).toHaveBeenCalledWith(['a', 'b']);
    s = reduce(s, { k: 'roulette.landed' }, d);
    expect(s).toMatchObject({ k: 'intro', manifest: { id: 'a' } });
    expect(d.prepare).toHaveBeenCalledWith('a');
    s = reduce(s, { k: 'intro.advance' }, d);
    expect(s).toMatchObject({ k: 'countdown', n: 3 });
    s = reduce(s, { k: 'countdown.tick' }, d);
    s = reduce(s, { k: 'countdown.tick' }, d);
    s = reduce(s, { k: 'countdown.tick' }, d);
    expect(s).toMatchObject({ k: 'countdown', n: 0 });
    s = reduce(s, { k: 'countdown.tick' }, d);
    expect(s).toMatchObject({ k: 'play', msLeft: 40_000 });
    s = reduce(s, { k: 'play.end', result: result() }, d);
    expect(s.k).toBe('results');
    expect(d.record).toHaveBeenCalled();
  });
});

describe('session: never a dead end', () => {
  it('offers keyboard mode from every camera failure', () => {
    const d = deps();
    for (const reason of ['denied', 'notFound', 'inUse', 'insecure', 'unsupported'] as const) {
      const help = reduce({ k: 'cameraRequest' }, { k: 'camera.failed', reason }, d);
      expect(help).toMatchObject({ k: 'cameraHelp', reason });
      expect(reduce(help, { k: 'choose.keyboard' }, d).k).toBe('inputFallback');
      // ...and retrying is always possible too.
      expect(reduce(help, { k: 'choose.camera' }, d).k).toBe('cameraRequest');
    }
  });

  it('skips calibration entirely in keyboard mode', () => {
    const d = deps({ cameraOn: false });
    expect(reduce({ k: 'inputFallback' }, { k: 'boot.done' }, d).k).toBe('attract');
  });

  it('lets a slow warmup bail out to keyboard', () => {
    const d = deps();
    const s = reduce({ k: 'warmup', progress: 0.2, message: '' }, { k: 'choose.keyboard' }, d);
    expect(s.k).toBe('inputFallback');
  });

  it('surfaces a real error when no game qualifies, and recovers from it', () => {
    const d = deps({ nextShortlist: () => null });
    const s = reduce({ k: 'attract', armed: true, probation: 1, hintShown: false }, { k: 'start' }, d);
    expect(s).toMatchObject({ k: 'error', recoverable: true });
    expect(reduce(s, { k: 'choose.keyboard' }, d).k).toBe('inputFallback');
  });
});

describe('session: interruptions', () => {
  it('pauses and resumes a round without losing the clock', () => {
    const d = deps();
    const playing: SessionState = { k: 'play', manifest: man('a'), msLeft: 12_345 };
    const paused = reduce(playing, { k: 'pause', why: 'hidden' }, d);
    expect(paused).toMatchObject({ k: 'paused', msLeft: 12_345, why: 'hidden' });
    expect(reduce(paused, { k: 'resume' }, d)).toMatchObject({ k: 'play', msLeft: 12_345 });
  });

  it('ignores a late play.tick that arrives after the round ended', () => {
    const d = deps();
    const results = reduce(
      { k: 'play', manifest: man('a'), msLeft: 0 }, { k: 'play.end', result: result() }, d,
    );
    // A stale tick is normal, not a bug; it must not crash or rewind the round.
    expect(reduce(results, { k: 'play.tick', msLeft: 999 }, d)).toBe(results);
  });

  it('abort returns to attract from anywhere', () => {
    const d = deps();
    for (const s of [
      { k: 'play', manifest: man('a'), msLeft: 1 },
      { k: 'roulette', shortlist: { candidates: [man('a')], winner: man('a'), winnerIndex: 0 } },
      { k: 'results', manifest: man('a'), result: result() },
    ] as SessionState[]) {
      expect(reduce(s, { k: 'abort' }, d).k).toBe('attract');
    }
  });
});

describe('session: breaks', () => {
  it('offers a break instead of the next round when one is due', () => {
    const d = deps({ shouldBreak: () => true });
    const s = reduce({ k: 'results', manifest: man('a'), result: result() }, { k: 'results.next' }, d);
    expect(s.k).toBe('breakPrompt');
    expect(reduce(s, { k: 'break.ack' }, d).k).toBe('attract');
    expect(d.takeBreak).toHaveBeenCalled();
  });

  it('goes straight to attract when no break is due', () => {
    const d = deps();
    const s = reduce({ k: 'results', manifest: man('a'), result: result() }, { k: 'results.next' }, d);
    expect(s.k).toBe('attract');
  });
});

describe('session: camera lifecycle predicates', () => {
  it('needs pose only while a player is being watched', () => {
    expect(needsPose({ k: 'play', manifest: man('a'), msLeft: 1 })).toBe(true);
    expect(needsPose({ k: 'attract', armed: false, probation: 0, hintShown: false })).toBe(true);
    expect(needsPose({ k: 'priming', prefetch: 0 })).toBe(false);
    expect(needsPose({ k: 'partySummary', played: [], results: [] })).toBe(false);
  });

  it('releases the camera in every state that is not using it', () => {
    // This is the property the privacy copy depends on, so assert it directly.
    const idle: SessionState[] = [
      { k: 'boot' }, { k: 'priming', prefetch: 0 }, { k: 'prePrompt' },
      { k: 'cameraHelp', reason: 'denied' }, { k: 'inputFallback' },
      { k: 'breakPrompt', rounds: 1 }, { k: 'partySummary', played: [], results: [] },
    ];
    for (const s of idle) expect(cameraShouldRun(s), s.k).toBe(false);
  });

  it('shows the skeleton on the attract screen', () => {
    // Deliberate: it is the honest demonstration of what the camera extracts.
    expect(showsSkeleton({ k: 'attract', armed: false, probation: 0, hintShown: false })).toBe(true);
  });
});

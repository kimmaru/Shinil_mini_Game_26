// The shell's state machine: the happy path, and — more importantly — that
// every failure state has a way out. "The page looks frozen" is the worst
// outcome in this product, so the escape hatches are tested, not assumed.
import { describe, expect, it } from 'vitest';
import type { GameResult } from '@/engine/types';
import { defaultCalibration } from '@/engine/pose/source';
import {
  BREAK_AFTER_ROUNDS,
  cameraErrorKind,
  initialSession,
  needsBreak,
  sessionReducer,
  type SessionAction,
  type SessionState,
} from './useSession';

const fresh = (): SessionState => initialSession({ seed: 1, now: 0 });

const run = (s: SessionState, ...actions: SessionAction[]): SessionState =>
  actions.reduce(sessionReducer, s);

const result = (stars: 0 | 1 | 2 | 3 = 2): GameResult => ({
  gameId: 'mosquito-clap',
  cleared: true,
  rawScore: 30,
  maxScore: 40,
  normalized: 0.75,
  stars,
  durationMs: 40_000,
  perPlayer: [{ playerId: 0, slot: 0, score: 30, hits: 15, misses: 2, bestCombo: 6 }],
});

const items = [
  { id: 'a', nameKo: '가', icon: '🅰️', hue: 10 },
  { id: 'b', nameKo: '나', icon: '🅱️', hue: 200 },
];

describe('camera path', () => {
  it('walks priming → prePrompt → warmup → calibration → safety → attract', () => {
    const s = run(
      fresh(),
      { type: 'chooseCamera' },
      { type: 'promptNow' },
      { type: 'cameraGranted' },
      { type: 'warmupDone' },
      { type: 'calibrated', profile: defaultCalibration() },
    );
    expect(s.phase).toBe('safety');
    expect(s.cameraLive).toBe(true);
    expect(sessionReducer(s, { type: 'safetyAck' }).phase).toBe('attract');
  });

  it('shows the safety screen only once per session', () => {
    let s = run(
      fresh(),
      { type: 'chooseCamera' },
      { type: 'promptNow' },
      { type: 'cameraGranted' },
      { type: 'warmupDone' },
      { type: 'calibrated', profile: defaultCalibration() },
      { type: 'safetyAck' },
    );
    s = sessionReducer(s, { type: 'calibrated', profile: defaultCalibration() });
    expect(s.phase).toBe('attract');
  });
});

describe('never a dead end', () => {
  it('offers the keyboard from every camera failure', () => {
    for (const error of ['denied', 'notFound', 'inUse', 'insecure', 'unknown'] as const) {
      const s = run(
        fresh(),
        { type: 'chooseCamera' },
        { type: 'promptNow' },
        { type: 'cameraFailed', error },
      );
      expect(s.phase).toBe('cameraHelp');
      expect(s.cameraError).toBe(error);
      expect(s.cameraLive).toBe(false);
      // both ways out work
      expect(sessionReducer(s, { type: 'retryCamera' }).phase).toBe('prePrompt');
      expect(sessionReducer(s, { type: 'chooseKeyboard' }).phase).toBe('safety');
    }
  });

  it('keyboard mode skips the camera, warmup and calibration entirely', () => {
    const s = sessionReducer(fresh(), { type: 'chooseKeyboard' });
    expect(s.inputMode).toBe('keyboard');
    expect(s.cameraLive).toBe(false);
    expect(s.phase).toBe('safety');
  });

  it('turning the camera off mid-party keeps playing on the keyboard', () => {
    const s = run(
      fresh(),
      { type: 'chooseCamera' },
      { type: 'promptNow' },
      { type: 'cameraGranted' },
      { type: 'cameraOff' },
    );
    expect(s.cameraLive).toBe(false);
    expect(s.inputMode).toBe('keyboard');
    // and it does NOT bounce the player back to a setup screen
    expect(s.phase).toBe('warmup');
  });

  it('maps DOMException names to the kind each help screen was written for', () => {
    expect(cameraErrorKind({ name: 'NotAllowedError' })).toBe('denied');
    expect(cameraErrorKind({ name: 'NotFoundError' })).toBe('notFound');
    expect(cameraErrorKind({ name: 'NotReadableError' })).toBe('inUse');
    expect(cameraErrorKind({ name: 'TypeError' })).toBe('insecure');
    expect(cameraErrorKind(null)).toBe('unknown');
    expect(cameraErrorKind(new Error('boom'))).toBe('unknown');
  });
});

describe('round loop', () => {
  const atAttract = () => run(fresh(), { type: 'chooseKeyboard' }, { type: 'safetyAck' });

  it('spin → intro → countdown → play → results → attract', () => {
    let s = sessionReducer(atAttract(), { type: 'spin', shortlist: items, chosenIndex: 1 });
    expect(s.phase).toBe('roulette');
    s = sessionReducer(s, { type: 'spinDone' });
    expect(s.phase).toBe('intro');
    expect(s.currentGame).toBe('b');
    s = run(s, { type: 'introDone' }, { type: 'countdownDone' });
    expect(s.phase).toBe('play');
    s = sessionReducer(s, { type: 'roundEnded', result: result() });
    expect(s.phase).toBe('results');
    expect(s.history).toHaveLength(1);
    expect(s.roundsSinceBreak).toBe(1);
    expect(sessionReducer(s, { type: 'next' }).phase).toBe('attract');
  });

  it('다시 하기 replays the same game without another spin', () => {
    const s = run(
      atAttract(),
      { type: 'spin', shortlist: items, chosenIndex: 0 },
      { type: 'spinDone' },
      { type: 'introDone' },
      { type: 'countdownDone' },
      { type: 'roundEnded', result: result() },
      { type: 'again' },
    );
    expect(s.phase).toBe('countdown');
    expect(s.currentGame).toBe('a');
  });

  it('clamps a chosen index that is out of range instead of landing nowhere', () => {
    const s = sessionReducer(atAttract(), { type: 'spin', shortlist: items, chosenIndex: 9 });
    expect(s.chosenIndex).toBe(1);
    expect(sessionReducer(s, { type: 'spinDone' }).currentGame).toBe('b');
  });

  it('refuses to spin an empty wheel rather than entering a broken screen', () => {
    const s = sessionReducer(atAttract(), { type: 'spin', shortlist: [], chosenIndex: 0 });
    expect(s.phase).toBe('attract');
  });

  it('pause/resume only applies during play', () => {
    const playing = run(
      atAttract(),
      { type: 'spin', shortlist: items, chosenIndex: 0 },
      { type: 'spinDone' },
      { type: 'introDone' },
      { type: 'countdownDone' },
    );
    expect(sessionReducer(playing, { type: 'pause' }).phase).toBe('paused');
    expect(sessionReducer(sessionReducer(playing, { type: 'pause' }), { type: 'resume' }).phase).toBe(
      'play',
    );
    // a pause arriving on the results screen (tab hidden) must not hijack it
    const done = sessionReducer(playing, { type: 'roundEnded', result: result() });
    expect(sessionReducer(done, { type: 'pause' }).phase).toBe('results');
  });
});

describe('rest pacing', () => {
  it('asks for a break after 8 rounds', () => {
    let s = fresh();
    for (let i = 0; i < BREAK_AFTER_ROUNDS; i++) {
      s = sessionReducer(s, { type: 'roundEnded', result: result() });
    }
    expect(needsBreak(s, 0)).toBe(true);
    expect(needsBreak({ ...s, roundsSinceBreak: 1 }, 0)).toBe(false);
  });

  it('asks for a break after 10 minutes even on round two', () => {
    const s = { ...initialSession({ seed: 1, now: 1000 }), roundsSinceBreak: 2 };
    expect(needsBreak(s, 1000 + 9 * 60_000)).toBe(false);
    expect(needsBreak(s, 1000 + 11 * 60_000)).toBe(true);
  });

  it('resets both counters when the break is taken', () => {
    const s = sessionReducer({ ...fresh(), roundsSinceBreak: 9 }, { type: 'breakDone' });
    expect(s.phase).toBe('attract');
    expect(s.roundsSinceBreak).toBe(0);
    expect(needsBreak(s, 10 * 60_000)).toBe(false);
  });
});

describe('overlays', () => {
  it('returns to exactly the phase they were opened from', () => {
    const base = run(fresh(), { type: 'chooseKeyboard' }, { type: 'safetyAck' });
    const open = sessionReducer(base, { type: 'openOverlay', overlay: 'settings' });
    expect(open.phase).toBe('attract');
    expect(open.overlay).toBe('settings');
    const closed = sessionReducer(open, { type: 'closeOverlay' });
    expect(closed.overlay).toBe('none');
    expect(closed.phase).toBe('attract');
  });
});

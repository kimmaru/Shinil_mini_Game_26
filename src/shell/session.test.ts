import { describe, expect, it } from 'vitest';
import {
  initialSession, sessionReducer, WHEEL_SIZE,
  type SessionState, type WheelItem,
} from './useSession';
import type { GameResult } from '@/engine/types';
import { defaultCalibration } from '@/engine/pose/source';

const S = (over: Partial<SessionState> = {}): SessionState => ({
  ...initialSession({ seed: 7, now: 0 }),
  ...over,
});

const WHEEL: WheelItem[] = Array.from({ length: WHEEL_SIZE }, (_, i) => ({
  id: `g${i}`,
  nameKo: `게임${i}`,
  icon: 'circle',
  hue: i * 40,
}));

const result = (rawScore: number): GameResult => ({
  gameId: 'g3',
  cleared: false,
  rawScore,
  maxScore: 100,
  normalized: rawScore / 100,
  stars: 2,
  durationMs: 40_000,
  perPlayer: [],
});

describe('kiosk setup is the operator’s, not the guest’s', () => {
  it('reaches attract in one step from setup', () => {
    // The old flow needed six screens before a first game. For a stranger
    // with no reason to persist, each one was a place to walk away.
    const s = sessionReducer(S({ phase: 'setup' }), { type: 'setupDone' });
    expect(s.phase).toBe('attract');
  });

  it('routes every camera failure to one operator screen with the detail kept', () => {
    const s = sessionReducer(S({ phase: 'setup' }), {
      type: 'cameraFailed', error: 'engine', detail: 'EngineStartError: boom',
    });
    expect(s.phase).toBe('setupHelp');
    expect(s.cameraError).toBe('engine');
    // Without the raw text the help screen is a dead end for whoever has to
    // fix the booth.
    expect(s.cameraErrorDetail).toContain('EngineStartError');
  });

  it('always offers a way to run with no camera', () => {
    for (const phase of ['setup', 'setupHelp'] as const) {
      const s = sessionReducer(S({ phase }), { type: 'chooseKeyboard' });
      expect(s.phase, phase).toBe('attract');
      expect(s.inputMode, phase).toBe('keyboard');
      expect(s.cameraLive, phase).toBe(false);
    }
  });
});

describe('the guest loop', () => {
  it('goes attract → roulette → countdown → play with no intro screen', () => {
    let s = sessionReducer(S({ phase: 'attract' }), {
      type: 'spin', shortlist: WHEEL, chosenIndex: 3,
    });
    expect(s.phase).toBe('roulette');
    // The winner is decided before the wheel moves; the spin cannot disagree.
    expect(s.currentGame).toBe('g3');
    s = sessionReducer(s, { type: 'spinDone' });
    expect(s.phase).toBe('countdown');
    s = sessionReducer(s, { type: 'countdownDone' });
    expect(s.phase).toBe('play');
  });

  it('clears the previous guest’s result when a new round is picked', () => {
    const s = sessionReducer(
      S({ phase: 'attract', lastResult: result(10), beatRecord: true }),
      { type: 'spin', shortlist: WHEEL, chosenIndex: 0 },
    );
    expect(s.lastResult).toBeNull();
    expect(s.beatRecord).toBe(false);
  });

  it('a game picked from 전체 게임 skips the roulette and closes the list', () => {
    let s = sessionReducer(S({ phase: 'attract' }), { type: 'openOverlay', overlay: 'games' });
    expect(s.overlay).toBe('games');
    s = sessionReducer(
      { ...s, lastResult: result(10), beatRecord: true },
      { type: 'pick', item: WHEEL[5]! },
    );
    expect(s.phase).toBe('countdown');
    expect(s.overlay).toBe('none');
    expect(s.currentGame).toBe('g5');
    expect(s.shortlist).toEqual([WHEEL[5]]);
    expect(s.lastResult).toBeNull();
    expect(s.beatRecord).toBe(false);
  });
});

describe('기록', () => {
  it('takes the record on a first play and celebrates it', () => {
    const s = sessionReducer(
      S({ phase: 'play', currentGame: 'g3' }),
      { type: 'roundEnded', result: result(40), nowMs: 1000 },
    );
    expect(s.phase).toBe('results');
    expect(s.beatRecord).toBe(true);
    expect(s.records['g3']?.score).toBe(40);
  });

  it('does not celebrate a score that merely ties today’s best', () => {
    // A tie that counts as a win makes the celebration meaningless.
    let s = sessionReducer(
      S({ phase: 'play', currentGame: 'g3' }),
      { type: 'roundEnded', result: result(40), nowMs: 1000 },
    );
    s = sessionReducer({ ...s, phase: 'play' }, {
      type: 'roundEnded', result: result(40), nowMs: 2000,
    });
    expect(s.beatRecord).toBe(false);
    expect(s.records['g3']?.score).toBe(40);
  });

  it('counts rounds for the operator but keeps no party total', () => {
    const s = sessionReducer(
      S({ phase: 'play', currentGame: 'g3' }),
      { type: 'roundEnded', result: result(1), nowMs: 1 },
    );
    expect(s.roundsPlayed).toBe(1);
    expect('history' in s).toBe(false);
  });
});

describe('resetting for the next stranger', () => {
  it('drops the calibration profile on 처음으로', () => {
    // The next guest is a different body. Carrying a 190cm adult's shoulder
    // width into a child's round mis-sizes every threshold in the game.
    const s = sessionReducer(
      S({ phase: 'results', calib: defaultCalibration(), lastResult: result(5) }),
      { type: 'home' },
    );
    expect(s.phase).toBe('attract');
    expect(s.calib).toBeNull();
    expect(s.lastResult).toBeNull();
  });

  it('treats an abandoned round exactly like 처음으로', () => {
    const home = sessionReducer(S({ phase: 'results' }), { type: 'home' });
    const gone = sessionReducer(S({ phase: 'results' }), { type: 'abandon' });
    expect(gone).toEqual(home);
  });

  it('keeps the profile on 한 판 더 — it is the same person', () => {
    const calib = defaultCalibration();
    const s = sessionReducer(S({ phase: 'results', calib }), { type: 'again' });
    expect(s.phase).toBe('attract');
    expect(s.calib).toBe(calib);
  });

  it('drops the in-memory records on 전체 삭제, without leaving the phase', () => {
    const s = sessionReducer(
      S({ phase: 'attract', records: { 'mosquito-clap': { score: 9, stars: 2, atMs: 1 } }, beatRecord: true }),
      { type: 'clearRecords' },
    );
    expect(s.records).toEqual({});
    expect(s.beatRecord).toBe(false);
    expect(s.phase).toBe('attract');
  });
});

describe('overlays and pausing', () => {
  it('opens and closes 설정 without changing phase', () => {
    const open = sessionReducer(S({ phase: 'attract' }), {
      type: 'openOverlay', overlay: 'settings',
    });
    expect(open.overlay).toBe('settings');
    expect(open.phase).toBe('attract');
    expect(sessionReducer(open, { type: 'closeOverlay' }).overlay).toBe('none');
  });

  it('only pauses an actual round', () => {
    expect(sessionReducer(S({ phase: 'play' }), { type: 'pause' }).phase).toBe('paused');
    expect(sessionReducer(S({ phase: 'attract' }), { type: 'pause' }).phase).toBe('attract');
    expect(sessionReducer(S({ phase: 'paused' }), { type: 'resume' }).phase).toBe('play');
  });

  it('calibrating never changes phase — it fires many times per guest', () => {
    const s = sessionReducer(S({ phase: 'attract' }), {
      type: 'calibrated', profile: defaultCalibration(),
    });
    expect(s.phase).toBe('attract');
    expect(s.calib).not.toBeNull();
  });
});

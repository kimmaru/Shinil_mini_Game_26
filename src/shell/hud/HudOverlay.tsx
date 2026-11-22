// ════════════════════════════════════════════════════════════════════════════
// THE HUD — the DOM implementation of src/engine/hud/index.ts.
//
// In the DOM, not on the canvas, for three reasons that each matter: real
// Korean text shaping (canvas text shaping of Hangul is a different and worse
// engine), `aria-live` for free, and the 10-foot type scale from tokens.css
// applies without reimplementing it in canvas units.
//
// A game SETS state here; it never draws chrome. 58 games must not each lay
// out their own timer.
//
// Write path: the service mutates a plain model object and marks it dirty; one
// rAF coalesces every change in a frame into a single React render, and the
// same tick eases the score count-up. A game calling setScore() 60 times a
// second therefore costs one render per frame, not sixty.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { HudService, Slot } from '@/engine/types';
import { Button } from '../components/Button';
import { SpriteIcon } from '../components/SpriteIcon';

export interface HudBar {
  key: string;
  value: number;
  labelKo?: string;
  color?: string;
}

export interface HudState {
  goalKo: string;
  /** Display values, eased toward the targets the game set. */
  scores: number[];
  combos: number[];
  bars: HudBar[];
  lives: number;
  livesMax: number;
  toastKo: string;
  toastSeq: number;
  toastColor: string | undefined;
  toastBig: boolean;
  announceKo: string;
  announceSeq: number;
  announceAssertive: boolean;
  beatRing: boolean;
  /** Seconds. Null = use the engine's own round timer. */
  timeLeft: number | null;
}

const EMPTY: HudState = {
  goalKo: '',
  scores: [0, 0, 0, 0],
  combos: [0, 0, 0, 0],
  bars: [],
  lives: -1,
  livesMax: 0,
  toastKo: '',
  toastSeq: 0,
  toastColor: undefined,
  toastBig: false,
  announceKo: '',
  announceSeq: 0,
  announceAssertive: false,
  beatRing: false,
  timeLeft: null,
};

export interface HudHandle {
  /** Hand this to the engine as `GameContext.hud`. */
  service: HudService;
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => HudState;
  /** Between rounds. */
  reset: () => void;
  dispose: () => void;
}

/** Score count-up rate, in "fraction of the remaining gap per frame". */
const COUNT_EASE = 0.22;
const TOAST_MS = 1400;

export function createHudService(o?: {
  /** Settings → speechSynthesis. Off unless the player asked for it. */
  speak?: (textKo: string) => void;
  reducedMotion?: boolean;
}): HudHandle {
  let state: HudState = { ...EMPTY };
  const targets = [0, 0, 0, 0];
  const listeners = new Set<() => void>();
  let dirty = false;
  let raf = 0;
  let toastTimer = 0;
  let disposed = false;

  const notify = () => {
    for (const l of listeners) l();
  };

  const tick = () => {
    raf = 0;
    if (disposed) return;
    // Ease the displayed scores. Snap under reduced motion: a counting number
    // is motion, and for some children it is the distracting kind.
    let moving = false;
    const scores = state.scores.slice();
    for (let i = 0; i < 4; i++) {
      const gap = targets[i]! - scores[i]!;
      if (gap === 0) continue;
      if (o?.reducedMotion || Math.abs(gap) < 1) {
        scores[i] = targets[i]!;
      } else {
        scores[i] = scores[i]! + gap * COUNT_EASE;
        moving = true;
      }
    }
    state = { ...state, scores };
    dirty = false;
    notify();
    if (moving) schedule();
  };

  const schedule = () => {
    if (disposed || raf !== 0) return;
    raf = requestAnimationFrame(tick);
  };

  const mark = (patch: Partial<HudState>) => {
    state = { ...state, ...patch };
    dirty = true;
    schedule();
  };

  const service: HudService = {
    setGoal(textKo) {
      if (textKo !== state.goalKo) mark({ goalKo: textKo });
    },
    setScore(n, slot = 0) {
      if (targets[slot] === n) return;
      targets[slot] = n;
      schedule();
    },
    setCombo(n, slot = 0) {
      if (state.combos[slot] === n) return;
      const combos = state.combos.slice();
      combos[slot] = n;
      mark({ combos });
    },
    setBar(key, value, opts) {
      const v = Math.max(0, Math.min(1, value));
      // Games call this every frame: an unchanged bar must cost nothing (no
      // copy, no React render).
      let i = -1;
      for (let k = 0; k < state.bars.length; k++) if (state.bars[k]!.key === key) i = k;
      const old = i >= 0 ? state.bars[i]! : undefined;
      if (
        old && old.value === v &&
        (opts?.labelKo === undefined || opts.labelKo === old.labelKo) &&
        (opts?.color === undefined || opts.color === old.color)
      ) return;
      const bars = state.bars.slice();
      const next: HudBar = {
        key,
        value: v,
        ...(opts?.labelKo !== undefined ? { labelKo: opts.labelKo } : {}),
        ...(opts?.color !== undefined ? { color: opts.color } : {}),
      };
      if (i < 0) bars.push(next);
      else bars[i] = { ...bars[i]!, ...next };
      mark({ bars });
    },
    clearBar(key) {
      if (!state.bars.some((b) => b.key === key)) return;
      mark({ bars: state.bars.filter((b) => b.key !== key) });
    },
    toast(textKo, opts) {
      mark({
        toastKo: textKo,
        toastSeq: state.toastSeq + 1,
        toastColor: opts?.color,
        toastBig: opts?.big ?? false,
      });
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => mark({ toastKo: '' }), TOAST_MS);
    },
    announce(textKo, opts) {
      // The text is the real channel; the voice is garnish. Both go out here so
      // a game cannot accidentally make audio load-bearing.
      mark({
        announceKo: textKo,
        announceSeq: state.announceSeq + 1,
        announceAssertive: opts?.assertive ?? false,
      });
      if (opts?.speak) o?.speak?.(textKo);
    },
    beatRing(on) {
      if (on !== state.beatRing) mark({ beatRing: on });
    },
    setLives(n, max) {
      if (n === state.lives && (max ?? state.livesMax) === state.livesMax) return;
      mark({ lives: n, livesMax: max ?? Math.max(state.livesMax, n) });
    },
    setTime(secondsLeft) {
      const v = Math.max(0, Math.ceil(secondsLeft));
      if (v !== state.timeLeft) mark({ timeLeft: v });
    },
  };

  return {
    service,
    subscribe(cb) {
      // StrictMode (dev) runs App's dispose cleanup once and then keeps the
      // same memoized instance; without re-arming, the HUD never updates again.
      disposed = false;
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSnapshot: () => state,
    reset() {
      targets.fill(0);
      window.clearTimeout(toastTimer);
      state = { ...EMPTY };
      notify();
    },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      window.clearTimeout(toastTimer);
      listeners.clear();
      void dirty;
    },
  };
}

const SLOT_COLORS = ['var(--c-p1)', 'var(--c-p2)', 'var(--c-p3)', 'var(--c-p4)'] as const;

/** Time ring geometry, in SVG user units. */
const RING_R = 42;
const RING_C = 2 * Math.PI * RING_R;
/** A pop restarts at most this often, so a fast count-up reads as one
 *  celebration rather than a vibrating number. */
const POP_GAP_MS = 220;

export interface HudOverlayProps {
  handle: HudHandle;
  /** The engine's round timer, in seconds. A game may override it via setTime. */
  roundSecondsLeft: number | null;
  players: number;
  onPause: () => void;
}

/** The score pill. Pops whenever its integer changes (rate-limited). */
function ScorePill({ value, slot }: { value: number; slot: number }): React.ReactElement {
  const n = Math.round(value);
  const [pop, setPop] = useState(0);
  const last = useRef({ n, at: 0 });
  useEffect(() => {
    if (n === last.current.n) return;
    const now = performance.now();
    last.current.n = n;
    if (n > 0 && now - last.current.at >= POP_GAP_MS) {
      last.current.at = now;
      setPop((p) => p + 1);
    }
  }, [n]);
  return (
    <div className="hud__score" style={{ ['--slot' as string]: SLOT_COLORS[slot as Slot] }}>
      <SpriteIcon id="star" size={44} className="hud__scoreIcon" />
      <span key={pop} className={`hud__scoreNum num${pop ? ' is-pop' : ''}`}>{n}</span>
    </div>
  );
}

export function HudOverlay({
  handle,
  roundSecondsLeft,
  players,
  onPause,
}: HudOverlayProps): React.ReactElement {
  const s = useSyncExternalStore(handle.subscribe, handle.getSnapshot, handle.getSnapshot);
  const seconds = s.timeLeft ?? roundSecondsLeft;
  const urgent = seconds !== null && seconds <= 5;
  // The ring needs a total; the first value the round reports IS the total.
  // HudOverlay mounts once per round, so this resets with it.
  const total = useRef(0);
  if (seconds !== null && seconds > total.current) total.current = seconds;
  const frac = seconds !== null && total.current > 0 ? seconds / total.current : 0;

  return (
    <div className="hud">
      <div className="hud__top">
        <div className="hud__scores">
          {Array.from({ length: Math.max(1, players) }, (_, i) => (
            <div key={i} className="hud__scoreCol">
              <ScorePill value={s.scores[i] ?? 0} slot={i} />
              {(s.combos[i] ?? 0) > 1 ? (
                <span className="hud__combo num" key={s.combos[i]}>
                  {s.combos[i]}연속!
                </span>
              ) : null}
            </div>
          ))}
        </div>

        {s.goalKo ? <p className="hud__goal">{s.goalKo}</p> : <span className="grow" />}

        <div className="hud__right">
          {seconds !== null ? (
            <div
              className={`hud__timer${urgent ? ' is-urgent' : ''}`}
              role="timer"
              aria-label={`남은 시간 ${seconds}초`}
            >
              <svg viewBox="0 0 100 100" className="hud__timerRing" aria-hidden="true">
                <circle cx="50" cy="50" r={RING_R} className="hud__timerTrack" />
                <circle
                  cx="50"
                  cy="50"
                  r={RING_R}
                  className="hud__timerFill"
                  strokeDasharray={RING_C}
                  strokeDashoffset={RING_C * (1 - frac)}
                  transform="rotate(-90 50 50)"
                />
              </svg>
              <span className="hud__timerNum num" key={urgent ? seconds : 'n'} aria-hidden="true">
                {seconds}
              </span>
            </div>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            // Ends the round (App aborts it on 'pause'), so it says so: a
            // pause icon that jumps to results is a broken promise.
            icon="ui-close"
            className="hud__pause"
            sfx="ui.back"
            aria-label="그만하기"
            onClick={onPause}
          />
        </div>
      </div>

      {s.lives >= 0 ? (
        <div className="hud__lives" aria-label={`남은 기회 ${s.lives}개`}>
          {Array.from({ length: Math.max(s.livesMax, s.lives) }, (_, i) => (
            <span key={i} aria-hidden="true">
              <SpriteIcon id={i < s.lives ? 'heart' : 'ui-heart-empty'} size={40} />
            </span>
          ))}
        </div>
      ) : null}

      {s.bars.length > 0 ? (
        <div className="hud__bars">
          {s.bars.map((b) => (
            <div key={b.key} className="hud__bar">
              {b.labelKo ? <span className="hud__barLabel">{b.labelKo}</span> : null}
              <div className="track">
                <div
                  className="fill"
                  style={{
                    width: `${Math.round(b.value * 100)}%`,
                    ...(b.color ? { background: b.color } : {}),
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {/* A visual pulse for every beat cue: audio is never load-bearing. */}
      {s.beatRing ? <div className="hud__beat" aria-hidden="true" /> : null}

      {s.toastKo ? (
        <div
          key={s.toastSeq}
          className={`hud__toast${s.toastBig ? ' is-big' : ''}`}
          style={s.toastColor ? { ['--toast-c' as string]: s.toastColor } : undefined}
          aria-hidden="true"
        >
          {s.toastKo}
        </div>
      ) : null}

      {/* Mirrors every spoken prompt as text. This is the real channel. */}
      <div
        className="hud__announce"
        aria-live={s.announceAssertive ? 'assertive' : 'polite'}
        aria-atomic="true"
      >
        {s.announceKo ? <span key={s.announceSeq} className="hud__announceText">{s.announceKo}</span> : null}
      </div>
    </div>
  );
}

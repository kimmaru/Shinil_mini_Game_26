// ════════════════════════════════════════════════════════════════════════════
// THE ROULETTE WHEEL.
//
// Three-step rule, and the order is the whole point:
//   1. the winner is decided FIRST (secureInt + shuffle bag, in Roulette.tsx)
//   2. the exact target rotation is computed from the winner index
//   3. ONE CSS easing curve animates to it
// The animation is cosmetic and cannot disagree with the result.
//
// CSS `transform: rotate()` rather than canvas: GPU-composited so it costs the
// main thread nothing while the pose pipeline is still warming up, real DOM
// Korean text per slice, and the slices are real elements a keyboard user can
// reach.
//
// Angles are measured CLOCKWISE FROM 12 O'CLOCK, because that is the frame both
// `conic-gradient` and `rotate()` already use — so the CSS needs no offset and
// there is one fewer place to get a sign wrong. POINTER is therefore 0, not
// -π/2 as in docs/RESEARCH-ARCH.md §5; everything else is that formula verbatim.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useRef, useState } from 'react';
import type { WheelItem } from '../useSession';
import { useServices } from '../useSession';

export const TAU = Math.PI * 2;
/** 12 o'clock. See the header. */
export const POINTER = 0;

/** Rotation (radians) that parks slice `i` under the pointer, always FORWARD
 *  of `current` so the wheel never visibly runs backwards. */
export function targetRotation(
  i: number,
  n: number,
  current: number,
  spins = 6,
  rng: () => number = Math.random,
  nearMiss = false,
): number {
  const slice = TAU / n;
  const centre = i * slice + slice / 2;
  // Organic, still safely inside the slice. A near-miss parks just past the
  // boundary it crossed last, so the wheel decelerates THROUGH it: kids gasp.
  const jitter = nearMiss
    ? slice * (0.38 + rng() * 0.08)
    : (rng() - 0.5) * slice * 0.62;
  const base = (((POINTER - centre - jitter) % TAU) + TAU) % TAU;
  const k = Math.ceil((current - base) / TAU) + spins;
  return base + k * TAU;
}

/** The inverse. Dev asserts that this equals the intended index — a wheel that
 *  lands on the wrong game destroys trust in one spin. */
export function sliceUnderPointer(rotation: number, n: number): number {
  const slice = TAU / n;
  return Math.floor(((((POINTER - rotation) % TAU) + TAU) % TAU) / slice);
}

/** Solve a CSS cubic-bezier(x1,y1,x2,y2) for y at a given x. Used ONLY to time
 *  the tick SFX to the same curve the compositor is running, without reading
 *  the transform back from the DOM every frame (which would force layout). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = (t: number) => ((1 - t) ** 3 * 0 + 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3);
  const cy = (t: number) => (3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3);
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let t = x;
    for (let k = 0; k < 24; k++) {
      const err = cx(t) - x;
      if (Math.abs(err) < 1e-4) break;
      if (err > 0) hi = t;
      else lo = t;
      t = (lo + hi) / 2;
    }
    return cy(t);
  };
}

const easeWheel = cubicBezier(0.12, 0.76, 0.06, 1);

/** Bounce past the target and settle back — a physical pawn. Chosen so that
 *  even the widest jitter keeps the overshoot inside the winning slice. */
export const SETTLE_FRACTION = 0.18;
const SETTLE_MS = 170;
const NEAR_MISS_CHANCE = 0.25;

/** Survives the Roulette screen unmounting between rounds so `--rot` only ever
 *  grows and the wheel always spins forward. */
let liveRotation = 0;

export interface WheelProps {
  items: WheelItem[];
  /** Decided before the spin. The animation lands here or it is a bug. */
  chosenIndex: number;
  /** 450ms crossfade instead of a 3.4s spin. */
  reducedMotion: boolean;
  /** Fires once, after the settle bounce (or the crossfade). */
  onLanded: () => void;
  /** A child who wants a specific game can press its slice. */
  onPick?: (index: number) => void;
  durationMs?: number;
}

export function Wheel({
  items,
  chosenIndex,
  reducedMotion,
  onLanded,
  onPick,
  durationMs = 3400,
}: WheelProps): React.ReactElement {
  const n = items.length;
  const slice = TAU / Math.max(1, n);
  const wheelRef = useRef<HTMLUListElement>(null);
  const [landed, setLanded] = useState(reducedMotion);
  const services = useServices();
  const landedCb = useRef(onLanded);
  landedCb.current = onLanded;

  // Step 2 of the three-step rule, computed during the FIRST render rather than
  // in the effect, because the label orientation below depends on where the
  // wheel will come to rest. A ref, not useState: StrictMode double-invokes a
  // state initializer, which would advance `liveRotation` twice.
  const planRef = useRef<{ from: number; final: number; overshoot: number } | null>(null);
  if (planRef.current === null && n > 0) {
    const nearMiss = !reducedMotion && Math.random() < NEAR_MISS_CHANCE;
    // Reduced motion still PARKS the wheel on the winner (spins = 0): the
    // crossfade must not leave the pointer sitting over the wrong game.
    const final = targetRotation(
      chosenIndex,
      n,
      liveRotation,
      reducedMotion ? 0 : 6,
      Math.random,
      nearMiss,
    );
    if (import.meta.env.DEV) {
      const got = sliceUnderPointer(final, n);
      if (got !== chosenIndex) {
        // Loud on purpose: a wheel that lands on the wrong game is the one bug
        // in this screen that users would never forgive.
        console.error(
          `[wheel] INVERSE ASSERTION FAILED: pointer is over ${got}, chose ${chosenIndex}`,
        );
      }
    }
    planRef.current = { from: liveRotation, final, overshoot: final + slice * SETTLE_FRACTION };
    liveRotation = final;
  }
  const plan = planRef.current;
  /** Where each slice ends up on screen, for the upright-label rule below. */
  const restDeg = plan ? ((((plan.final * 180) / Math.PI) % 360) + 360) % 360 : 0;

  useEffect(() => {
    if (n === 0 || !plan) return;
    const el = wheelRef.current;

    if (reducedMotion || !el) {
      // Skip the spin entirely: one chime, a crossfade, a polite announcement.
      el?.style.setProperty('--rot', `${plan.final}rad`);
      services.audio?.play('chime');
      const id = window.setTimeout(() => {
        setLanded(true);
        landedCb.current();
      }, 450);
      return () => window.clearTimeout(id);
    }

    const { from, final, overshoot } = plan;

    // One curve, one transition. The compositor does the rest.
    el.style.transition = `transform ${durationMs}ms var(--ease-wheel)`;
    el.style.setProperty('--rot', `${overshoot}rad`);
    // Force a style flush so the transition starts from `from`, not `overshoot`.
    void el.offsetWidth;

    let raf = 0;
    let settleTimer = 0;
    let doneTimer = 0;
    const t0 = performance.now();
    let prevRot = from;

    // Tick SFX on every slice-boundary crossing, pitch rising over the spin —
    // this ~10 lines is the entire slot-machine feeling.
    const tickLoop = () => {
      const p = Math.min(1, (performance.now() - t0) / durationMs);
      const rot = from + (overshoot - from) * easeWheel(p);
      const b0 = Math.floor(prevRot / slice);
      const b1 = Math.floor(rot / slice);
      for (let k = b0 + 1, c = 0; k <= b1 && c < 4; k++, c++) {
        services.audio?.play('ui.tick', { rate: 0.9 + 0.6 * p, gain: 0.5 });
      }
      prevRot = rot;
      if (p < 1) raf = requestAnimationFrame(tickLoop);
    };
    raf = requestAnimationFrame(tickLoop);

    // transitionend does not fire in a hidden tab, so the timer is the real
    // clock and transitionend is only an early-out.
    const settle = () => {
      if (settleTimer === -1) return;
      settleTimer = -1;
      el.style.transition = `transform ${SETTLE_MS}ms var(--ease-out-back)`;
      el.style.setProperty('--rot', `${final}rad`);
      services.audio?.play('round.start');
      doneTimer = window.setTimeout(() => {
        setLanded(true);
        landedCb.current();
      }, SETTLE_MS + 60);
    };
    const onEnd = (ev: TransitionEvent) => {
      if (ev.propertyName === 'transform') settle();
    };
    el.addEventListener('transitionend', onEnd, { once: true });
    settleTimer = window.setTimeout(settle, durationMs + 80);

    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('transitionend', onEnd);
      if (settleTimer > 0) window.clearTimeout(settleTimer);
      window.clearTimeout(doneTimer);
    };
    // One spin per mount: chosenIndex is fixed for the life of this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (n === 0) return <div className="wheel wheel--empty" />;

  // Hard-stop conic gradient: slice i owns [i*slice, (i+1)*slice] clockwise
  // from 12 o'clock, which is exactly conic-gradient's own frame.
  const stops = items
    .map((it, i) => {
      const a0 = (i * 360) / n;
      const a1 = ((i + 1) * 360) / n;
      const l = i % 2 === 0 ? 58 : 46;
      return `hsl(${it.hue} 72% ${l}%) ${a0}deg ${a1}deg`;
    })
    .join(', ');

  return (
    <div className={`wheel${landed ? ' is-landed' : ''}`}>
      <div className="wheel__pointer" aria-hidden="true">
        ▼
      </div>
      <ul
        ref={wheelRef}
        className="wheel__disc"
        style={{ backgroundImage: `conic-gradient(from 0deg, ${stops})` }}
        aria-label={`게임 ${n}개 중에서 뽑고 있어요: ${items.map((i) => i.nameKo).join(', ')}`}
      >
        {items.map((it, i) => {
          const deg = (i * 360) / n + 180 / n;
          // Upside-down Korean is unreadable for a 7-year-old. The flip is
          // computed against the RESTING rotation, not against zero, so every
          // name is upright at the moment the wheel actually stops — which is
          // the only moment anyone reads it.
          const onScreen = (deg + restDeg) % 360;
          const flipped = onScreen > 90 && onScreen < 270;
          return (
          <li
            key={it.id}
            className={`wheel__slice${flipped ? ' is-flipped' : ''}`}
            style={{ ['--a' as string]: `${deg}deg` }}
          >
            <button
              type="button"
              className="wheel__label"
              disabled={landed || !onPick}
              onClick={() => onPick?.(i)}
            >
              <span className="wheel__icon" aria-hidden="true">
                {it.icon}
              </span>
              <span className="wheel__name">{it.nameKo}</span>
            </button>
          </li>
          );
        })}
      </ul>
      <div className="wheel__hub" aria-hidden="true">
        🎲
      </div>
    </div>
  );
}

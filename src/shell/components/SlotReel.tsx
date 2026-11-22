// ════════════════════════════════════════════════════════════════════════════
// THE SLOT REEL — one big casual slot-machine window. A vertical strip of game
// cards (icon + upright name, ≥ 40 px) rattles down past a gold centre band,
// slows to single ticks, bounces onto the winner and pops.
//
// It replaced a Mario-Party board of 8 tiles. Three-step rule, unchanged:
//   1. the winner is decided FIRST (`decideRound` in ../rounds.ts)
//   2. the reel's whole journey is computed from that index
//      (`reelPlan`, pure, unit-tested in ../roulette.test.ts)
//   3. one rAF loop samples it against the clock
// The animation is cosmetic and cannot disagree with the result: it ends at
// exactly the winner's card, by construction, and a skip jumps straight there.
//
// Cost on the 2015 MacBook: the strip is ONE lap of cards painted once, and
// the loop writes only `transform` and `opacity` (composited, no layout, no
// repaint). Speed is faked without `filter: blur()`: the strip stretches
// vertically and fades a little, and a static speed-line layer fades in.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { WheelItem } from '../useSession';
import { useServices } from '../useSession';
import { SpriteIcon } from './SpriteIcon';
import {
  SILENCE_MS, TICK_MAX_HZ, reelPlan, reelPos, reelSlotAt, reelSpeed, reelSpinMs, reelStrip,
} from '../reel';

/** Pop + flash on the winner, before the reveal counts as landed. */
const POP_MS = 280;

export type ReelStage = 'spin' | 'pop' | 'landed';

export interface SlotReelProps {
  items: WheelItem[];
  /** Decided before the spin. The reel stops here or it is a bug. */
  chosenIndex: number;
  reducedMotion: boolean;
  /** Flip to true to jump straight to the landed reel (the skip button). */
  skip: boolean;
  /** Fires once, when the winner has popped. */
  onLanded: () => void;
}

/** The centre-band pointers: ink-outlined gold arrows on the bezel. */
function Pointer({ side }: { side: 'l' | 'r' }): React.ReactElement {
  return (
    <svg className={`slot__ptr slot__ptr--${side}`} viewBox="0 0 40 52" aria-hidden="true">
      <path
        d={side === 'l' ? 'M5 5 L35 26 L5 47 Z' : 'M35 5 L5 26 L35 47 Z'}
        fill="#ffc21a"
        stroke="#1d1442"
        strokeWidth="5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SlotReel({
  items,
  chosenIndex,
  reducedMotion,
  skip,
  onLanded,
}: SlotReelProps): React.ReactElement {
  const n = items.length;
  const winner = Math.min(Math.max(0, chosenIndex), Math.max(0, n - 1));
  const services = useServices();
  const plan = useMemo(() => reelPlan(n, winner), [n, winner]);
  const strip = useMemo(() => reelStrip(n), [n]);
  const [stage, setStage] = useState<ReelStage>(reducedMotion ? 'landed' : 'spin');
  const landedCb = useRef(onLanded);
  landedCb.current = onLanded;
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const stripRef = useRef<HTMLOListElement>(null);
  const speedRef = useRef<HTMLDivElement>(null);

  /** Put the strip where the reel is. Transform + opacity only. */
  const place = useRef((pos: number, speed: number): void => {
    const el = stripRef.current;
    if (!el) return;
    // 0 = sharp; 1 = full speed. Below ~4 cards/s the eye can read the
    // names, so nothing is faked there.
    const v = Math.abs(speed);
    const b = v <= 4 ? 0 : v >= 24 ? 1 : (v - 4) / 20;
    const sy = 1 + 0.45 * b;
    // The strip hangs from the window's centre line (top: 50%) with its
    // origin at its own top, so this centres slot `c` and stretches about
    // the centre line. % of the strip's own height: no layout reads.
    const c = reelSlotAt(plan, pos) + 0.5;
    el.style.transform = `translate3d(0,${(-sy * c * 100) / strip.length}%,0) scaleY(${sy})`;
    el.style.opacity = String(1 - 0.3 * b);
    if (speedRef.current) speedRef.current.style.opacity = String(b);
  });

  // First paint already shows the start card (or the winner, reduced motion).
  useLayoutEffect(() => {
    place.current(reducedMotion ? plan.cards : 0, 0);
    // One reel per mount: chosenIndex is fixed for the life of this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 3. play the plan ─────────────────────────────────────────────────────
  useEffect(() => {
    if (n === 0 || reducedMotion) return;
    const spinMs = reelSpinMs(plan);
    const t0 = performance.now();
    let crossed = 0;
    let lastTick = -Infinity;
    let raf = 0;
    const loop = (): void => {
      if (stageRef.current !== 'spin') return; // skipped
      const now = performance.now();
      const t = now - t0;
      const pos = reelPos(plan, t);
      place.current(pos, reelSpeed(plan, t));
      // A tick per card reaching the centre line, capped: at full speed the
      // crossings merge into one 촤라라락, then separate as the reel slows.
      // At most one per frame, so a tab that comes back from the background
      // does not fire a burst.
      const k = Math.floor(pos + 1e-6);
      if (k > crossed) {
        crossed = k;
        if (now - lastTick >= 1000 / TICK_MAX_HZ) {
          lastTick = now;
          services.audio?.play('ui.tick', { gain: 0.55, rate: 1 + 0.22 * (k / plan.cards) });
        }
      }
      if (t >= spinMs + SILENCE_MS) {
        setStage('pop');
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The skip button: the reel at rest on the same winner, then the pop.
  useEffect(() => {
    if (!skip || stageRef.current !== 'spin') return;
    place.current(plan.cards, 0);
    setStage('pop');
  }, [skip, plan]);

  // Pop → landed. The fanfare goes on the pop: the sound should arrive with
  // the first thing that changes on screen.
  useEffect(() => {
    if (stage === 'pop') {
      services.audio?.play('fanfare');
      const id = window.setTimeout(() => setStage('landed'), POP_MS);
      return () => window.clearTimeout(id);
    }
    if (stage === 'landed') {
      if (reducedMotion) services.audio?.play('fanfare');
      landedCb.current();
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const w = items[winner];

  return (
    <div
      className={`slot is-${stage}`}
      role="img"
      aria-label={`게임 ${n}개 중에서 고르고 있어요: ${items.map((i) => i.nameKo).join(', ')}`}
    >
      <div className="slot__cabinet">
        <div className="slot__lights" aria-hidden="true" />
        <div className="slot__window" aria-hidden="true">
          <ol ref={stripRef} className={`slot__strip${reducedMotion ? ' rm-fade' : ''}`}>
            {strip.map((i, d) => {
              const it = items[i]!;
              return (
                <li key={d} className="slot__cell">
                  <div className="slot__card" style={{ ['--hue' as string]: it.hue }}>
                    <span className="slot__badge">
                      <SpriteIcon id={it.icon} size={96} hue={it.hue} />
                    </span>
                    <span className="slot__name">{it.nameKo}</span>
                  </div>
                </li>
              );
            })}
          </ol>
          <div ref={speedRef} className="slot__speed" />
          <div className="slot__shade" />
        </div>
        <div className="slot__band" aria-hidden="true">
          <Pointer side="l" />
          <Pointer side="r" />
        </div>
        {stage !== 'spin' && w ? (
          <div
            className={`slot__card slot__winner${reducedMotion ? ' rm-fade' : ''}`}
            style={{ ['--hue' as string]: w.hue }}
            aria-hidden="true"
          >
            <span className="slot__badge">
              <SpriteIcon id={w.icon} size={96} hue={w.hue} />
            </span>
            <span className="slot__name slam-in">{w.nameKo}</span>
            {/* The 80 ms flash. One card, once, white — inside WCAG 2.3.1
                (< 25 % of the viewport, < 3 a second). */}
            {stage === 'pop' && !reducedMotion ? (
              <span className="slot__flash" aria-hidden="true" />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

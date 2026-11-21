// ════════════════════════════════════════════════════════════════════════════
// THE ROULETTE BOARD — a Mario-Party-style ring of upright tiles.
//
// It replaced a spinning wheel whose radial labels were upside down for half
// the slices: unreadable at 2 m, which is the only distance that matters.
// Here every name is upright, ≥ 34 px, all the time.
//
// Three-step rule, unchanged from the wheel, and the order is the whole point:
//   1. the winner is decided FIRST (`decideRound` in ../rounds.ts)
//   2. the exact hop schedule is computed from the winner index
//      (`hopSchedule`, pure, unit-tested in ../roulette.test.ts)
//   3. one rAF loop plays that schedule back against the clock
// The animation is cosmetic and cannot disagree with the result: its last hop
// IS the winner, by construction, and a skip jumps straight to that state.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WheelItem } from '../useSession';
import { useServices } from '../useSession';
import { SpriteIcon } from './SpriteIcon';
import { BOARD_SLOTS, SILENCE_MS, TRAVEL_MS, hopSchedule } from '../hops';

// ─── Layout ─────────────────────────────────────────────────────────────────

/** Ring index → [row, col] on a 3×3 board, clockwise from top-left. The centre
 *  cell is the hub where the winner lands. */
const RING: ReadonlyArray<readonly [number, number]> = [
  [1, 1], [1, 2], [1, 3], [2, 3], [3, 3], [3, 2], [3, 1], [2, 1],
];

/** Pop + flash on the winner tile, before the centre card slams in. */
const POP_MS = 280;

export type BoardStage = 'spin' | 'pop' | 'landed';

export interface RouletteBoardProps {
  items: WheelItem[];
  /** Decided before the spin. The last hop lands here or it is a bug. */
  chosenIndex: number;
  reducedMotion: boolean;
  /** Flip to true to jump straight to the landed state (the skip button). */
  skip: boolean;
  /** Fires once, when the winner card is in the centre. */
  onLanded: () => void;
}

export function RouletteBoard({
  items,
  chosenIndex,
  reducedMotion,
  skip,
  onLanded,
}: RouletteBoardProps): React.ReactElement {
  const n = Math.min(items.length, BOARD_SLOTS);
  const winner = Math.min(Math.max(0, chosenIndex), Math.max(0, n - 1));
  const services = useServices();
  const [lit, setLit] = useState(reducedMotion ? winner : 0);
  const [stage, setStage] = useState<BoardStage>(reducedMotion ? 'landed' : 'spin');
  const landedCb = useRef(onLanded);
  landedCb.current = onLanded;
  const stageRef = useRef(stage);
  stageRef.current = stage;

  // ── 3. play the schedule ──────────────────────────────────────────────
  useEffect(() => {
    if (n === 0 || reducedMotion) return;
    const plan = hopSchedule(n, winner);
    const t0 = performance.now();
    let applied = -1;
    let raf = 0;
    const loop = () => {
      if (stageRef.current !== 'spin') return; // skipped
      const t = performance.now() - t0;
      let next = applied;
      while (next + 1 < plan.length && plan[next + 1]!.at <= t) next++;
      if (next !== applied) {
        applied = next;
        setLit(plan[next]!.tile);
        // One tick per frame at most: a tab that comes back from the
        // background must not fire a burst of twenty.
        services.audio?.play('ui.tick', { gain: 0.55 });
      }
      if (t >= TRAVEL_MS + SILENCE_MS) {
        setStage('pop');
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // One spin per mount: chosenIndex is fixed for the life of this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The skip button: straight to the pop, on the same winner.
  useEffect(() => {
    if (!skip || stageRef.current !== 'spin') return;
    setLit(winner);
    setStage('pop');
  }, [skip, winner]);

  // Pop → landed. The fanfare goes on the pop, not the slam: the sound should
  // arrive with the first thing that changes on screen.
  useEffect(() => {
    if (stage === 'pop') {
      setLit(winner);
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

  // The winner card "slams to centre" FROM its tile: measure both boxes once
  // and hand the offset to the keyframe. One read, no per-frame layout.
  const tileRefs = useRef<(HTMLLIElement | null)[]>([]);
  const cardRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (stage !== 'landed' || reducedMotion) return;
    const card = cardRef.current;
    const tile = tileRefs.current[winner];
    if (!card || !tile) return;
    const a = tile.getBoundingClientRect();
    const b = card.getBoundingClientRect();
    card.style.setProperty('--from-x', `${a.left + a.width / 2 - (b.left + b.width / 2)}px`);
    card.style.setProperty('--from-y', `${a.top + a.height / 2 - (b.top + b.height / 2)}px`);
    card.classList.add('is-flying');
  }, [stage, winner, reducedMotion]);

  const w = items[winner];
  const spinning = stage === 'spin';

  return (
    <div className={`board is-${stage}`}>
      <ul
        className="board__ring"
        aria-label={`게임 ${n}개 중에서 고르고 있어요: ${items.slice(0, n).map((i) => i.nameKo).join(', ')}`}
      >
        {RING.map(([row, col], i) => {
          const it = i < n ? items[i] : undefined;
          const cls = [
            'tile',
            it ? '' : 'tile--blank',
            spinning && i === lit ? 'is-lit' : '',
            !spinning && i === winner && it ? 'is-winner' : '',
          ].filter(Boolean).join(' ');
          return (
            <li
              key={it?.id ?? `blank-${i}`}
              ref={(el) => { tileRefs.current[i] = el; }}
              className={cls}
              style={{
                gridRow: row,
                gridColumn: col,
                ...(it ? { ['--hue' as string]: it.hue } : {}),
              }}
              aria-hidden={it ? undefined : true}
            >
              {it ? (
                <>
                  <span className="tile__badge" aria-hidden="true">
                    <SpriteIcon id={it.icon} size={72} hue={it.hue} />
                  </span>
                  <span className="tile__name">{it.nameKo}</span>
                  {/* The 80 ms flash. One tile, one flash, white — well
                      inside WCAG 2.3.1 (< 25 % of the viewport, < 3/s). */}
                  {stage === 'pop' && i === winner ? (
                    <span className="tile__flash" aria-hidden="true" />
                  ) : null}
                </>
              ) : (
                <span className="tile__q" aria-hidden="true">?</span>
              )}
            </li>
          );
        })}
      </ul>

      <div className="board__hub">
        {stage === 'landed' && w ? (
          <div
            ref={cardRef}
            className={`board__card${reducedMotion ? ' rm-fade' : ''}`}
            style={{ ['--hue' as string]: w.hue }}
          >
            <SpriteIcon id={w.icon} size={112} hue={w.hue} className="board__cardIcon" />
            <p className="board__cardName">{w.nameKo}</p>
          </div>
        ) : (
          <div className="board__dice" aria-hidden="true">
            <SpriteIcon id="ui-dice" size={96} />
          </div>
        )}
      </div>
    </div>
  );
}

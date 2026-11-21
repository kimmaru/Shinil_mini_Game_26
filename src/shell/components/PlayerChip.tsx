// A player's identity, shown the Kahoot way: colour AND shape AND number.
//
// Hue is never the only cue. That serves colour-blind players and it makes the
// instruction sayable across a classroom — "2번, 주황 네모!" works, "the orange
// one" does not.
import type { Slot } from '@/engine/types';

const SLOT_COLORS = ['var(--c-p1)', 'var(--c-p2)', 'var(--c-p3)', 'var(--c-p4)'] as const;
/** Mirrors C.slotShape in src/engine/render/palette.ts. */
const SLOT_SHAPES = ['▲', '◆', '●', '■'] as const;
const SLOT_SHAPE_KO = ['세모', '마름모', '동그라미', '네모'] as const;

export interface PlayerChipProps {
  slot: Slot;
  nameKo?: string;
  /** Dim the chip while this player is not being tracked. */
  present?: boolean;
  score?: number;
  mvp?: boolean;
  size?: 'sm' | 'md';
}

export function PlayerChip({
  slot,
  nameKo,
  present = true,
  score,
  mvp,
  size = 'md',
}: PlayerChipProps): React.ReactElement {
  const label = nameKo?.trim() || `${slot + 1}번`;
  return (
    <div
      className={`pchip pchip--${size}${present ? '' : ' is-away'}${mvp ? ' is-mvp' : ''}`}
      style={{ ['--slot' as string]: SLOT_COLORS[slot] }}
      aria-label={`${slot + 1}번 ${SLOT_SHAPE_KO[slot]} ${label}${
        score !== undefined ? ` ${score}점` : ''
      }${mvp ? ' 최고 선수' : ''}${present ? '' : ' (안 보여요)'}`}
    >
      <span className="pchip__badge" aria-hidden="true">
        <span className="pchip__shape">{SLOT_SHAPES[slot]}</span>
        <span className="pchip__num num">{slot + 1}</span>
      </span>
      <span className="pchip__name">{label}</span>
      {score !== undefined ? <span className="pchip__score num">{score}</span> : null}
      {mvp ? (
        <span className="pchip__mvp" aria-hidden="true">
          👑
        </span>
      ) : null}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ROULETTE.
//
// `decideRound()` picks the winner BEFORE this screen ever mounts: unbiased
// `secureInt` (rejection sampling, not `% n`) wrapped in a shuffle bag so
// nothing repeats until the bag empties — children notice a repeat within two
// minutes ("또 이거야?"). The wheel then animates to a rotation computed from
// that index. The animation is cosmetic and cannot disagree with the result.
//
// Eight slices, never 58. A 58-slice wheel is illegible and the "저거 싫어"
// rate goes up.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import type { GameId } from '@/engine/types';
import type { PoolFilter } from '@/engine/registry';
import { Button } from '../components/Button';
import { Wheel } from '../components/Wheel';
import { WHEEL_SIZE, type WheelItem } from '../useSession';
import { SpriteIcon } from '../components/SpriteIcon';

// Round selection lives in ../rounds.ts, which wraps RoundScheduler — the one
// implementation of the no-repeat bag, mechanic variety and the child-safety
// intensity pacing. Re-exported here so this screen stays the obvious place to
// look for it.
export { decideRound, type RoundPick } from '../rounds';

export interface RouletteProps {
  shortlist: WheelItem[];
  chosenIndex: number;
  reducedMotion: boolean;
  /** Proceed to the intro. */
  onDone: () => void;
  /** No games at all — the only honest thing is to say so. */
  onBack: () => void;
}

/** How long the winner stays on screen before the intro takes over. */
const SHOWCASE_MS = 1100;

export function Roulette({
  shortlist,
  chosenIndex,
  reducedMotion,
  onDone,
  onBack,
}: RouletteProps): React.ReactElement {
  const [landed, setLanded] = useState(false);
  const winner = shortlist[chosenIndex];

  useEffect(() => {
    if (!landed) return;
    const id = window.setTimeout(onDone, reducedMotion ? 250 : SHOWCASE_MS);
    return () => window.clearTimeout(id);
  }, [landed, onDone, reducedMotion]);

  if (shortlist.length === 0 || !winner) {
    return (
      <main className="screen">
        <h1 className="h1 center">아직 놀 수 있는 게임이 없어요 😅</h1>
        <p className="body-lg center dim">조금만 기다려 주세요. 곧 게임이 들어와요!</p>
        <Button variant="primary" size="huge" onClick={onBack}>
          돌아가기
        </Button>
      </main>
    );
  }

  return (
    <main className="screen screen--full roulette">
      <h1 className="h2 center roulette__title">
        {landed ? '이거 하자!' : '어떤 게임일까?'}
      </h1>

      <Wheel
        items={shortlist}
        chosenIndex={chosenIndex}
        reducedMotion={reducedMotion}
        onLanded={() => setLanded(true)}
      />

      {/* polite, not assertive: the wheel is already shouting visually. */}
      <div className="roulette__result" aria-live="polite" aria-atomic="true">
        {landed ? (
          <div className="card card--tinted slam-in" style={{ ['--hue' as string]: winner.hue }}>
            <span className="display-2" aria-hidden="true">
              <SpriteIcon id={winner.icon} size={96} hue={winner.hue} on="dark" />
            </span>
            <p className="h1">{winner.nameKo}</p>
          </div>
        ) : null}
      </div>

      {/* Children will mash this. Always allow skipping to the result. */}
      {!landed ? (
        <Button variant="ghost" onClick={onDone} className="roulette__skip">
          건너뛰기 ⏭
        </Button>
      ) : null}
    </main>
  );
}

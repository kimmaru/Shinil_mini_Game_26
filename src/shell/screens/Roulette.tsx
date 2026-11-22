// ════════════════════════════════════════════════════════════════════════════
// ROULETTE.
//
// `decideRound()` picks the winner BEFORE this screen ever mounts: unbiased
// `secureInt` (rejection sampling, not `% n`) wrapped in a shuffle bag so
// nothing repeats until the bag empties. The slot reel then plays a journey
// computed from that index (../reel.ts). The animation is cosmetic and cannot
// disagree with the result.
//
// Eight games, never 58: a guest who sees 58 options starts shopping instead
// of playing. No "near miss" theatre either — the plan forbids teasing a child
// with the game they almost got.
// ════════════════════════════════════════════════════════════════════════════
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../components/Button';
import { SlotReel } from '../components/SlotReel';
import type { WheelItem } from '../useSession';

// Round selection lives in ../rounds.ts, which wraps RoundScheduler — the one
// implementation of the no-repeat bag and mechanic variety. Re-exported here
// so this screen stays the obvious place to look for it.
export { decideRound, type RoundPick } from '../rounds';

export interface RouletteProps {
  shortlist: WheelItem[];
  chosenIndex: number;
  reducedMotion: boolean;
  /** Proceed to the countdown. */
  onDone: () => void;
  /** No games at all — the only honest thing is to say so. */
  onBack: () => void;
}

/** How long the winner sits in the centre before the countdown takes over. */
const SHOWCASE_MS = 1500;

export function Roulette({
  shortlist,
  chosenIndex,
  reducedMotion,
  onDone,
  onBack,
}: RouletteProps): React.ReactElement {
  const [landed, setLanded] = useState(false);
  const [skip, setSkip] = useState(false);
  const winner = shortlist[chosenIndex];
  const onLanded = useCallback(() => setLanded(true), []);

  useEffect(() => {
    if (!landed) return;
    const id = window.setTimeout(onDone, SHOWCASE_MS);
    return () => window.clearTimeout(id);
  }, [landed, onDone]);

  if (shortlist.length === 0 || !winner) {
    return (
      <main className="screen">
        <h1 className="h1 center">아직 놀 수 있는 게임이 없어요</h1>
        <p className="body-lg center slab-note">조금만 기다려 주세요. 곧 게임이 들어와요!</p>
        <Button variant="go" size="huge" icon="ui-home" onClick={onBack}>
          돌아가기
        </Button>
      </main>
    );
  }

  return (
    <main className="screen screen--full roulette">
      <h1 className="display-2 center roulette__title" key={landed ? 'y' : 'n'}>
        {landed ? '이거 하자!' : '어떤 게임일까?'}
      </h1>

      <SlotReel
        items={shortlist}
        chosenIndex={chosenIndex}
        reducedMotion={reducedMotion}
        skip={skip}
        onLanded={onLanded}
      />

      {/* polite, not assertive: the reel is already shouting visually. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {landed ? `${winner.nameKo}! 이 게임을 해요.` : ''}
      </p>

      {/* Children will mash this. It jumps to the landed state on the SAME
          winner and then disappears, so mashing cannot skip the reveal. */}
      <div className="roulette__foot">
        {!landed && !skip ? (
          <Button variant="ghost" icon="ui-next" onClick={() => setSkip(true)}>
            건너뛰기
          </Button>
        ) : null}
      </div>
    </main>
  );
}

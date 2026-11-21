// Results. Loud, and never a scolding.
//
// Zero stars gets "다음엔 더 잘할 수 있어요!", not "실패". Repeated failure
// indicators make 7-to-12-year-olds quit inside a minute, so the only thing
// this screen ranks is the child against their own last try.
import { useEffect, useState } from 'react';
import type { GameResult } from '@/engine/types';
import { Button } from '../components/Button';
import { PlayerChip } from '../components/PlayerChip';
import { StarRow } from '../components/StarRow';
import { useServices } from '../useSession';

export interface ResultsProps {
  result: GameResult;
  gameNameKo: string;
  /** Previous best for this game, from localStorage. -1 when there is none. */
  bestScore: number;
  reducedMotion: boolean;
  onAgain: () => void;
  onNext: () => void;
  onStop: () => void;
}

const PRAISE: Record<0 | 1 | 2 | 3, string> = {
  0: '다음엔 더 잘할 수 있어요!',
  1: '잘했어요! 한 판 더?',
  2: '아주 잘했어요! 👏',
  3: '최고예요! 별 세 개! 🎉',
};

const COUNT_MS = 700;

export function Results({
  result,
  gameNameKo,
  bestScore,
  reducedMotion,
  onAgain,
  onNext,
  onStop,
}: ResultsProps): React.ReactElement {
  const [shown, setShown] = useState(reducedMotion ? result.rawScore : 0);
  const services = useServices();
  const isBest = bestScore >= 0 && result.rawScore > bestScore;

  useEffect(() => {
    services.audio?.play(result.stars > 0 ? 'round.win' : 'round.lose');
    if (reducedMotion) {
      setShown(result.rawScore);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / COUNT_MS);
      setShown(Math.round(result.rawScore * (1 - (1 - p) ** 3)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="screen results">
      {/* The score counts up over 700ms; announcing the final value once is
          the useful thing, announcing every intermediate number is not. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {`${gameNameKo} 끝! 별 ${result.stars}개, ${result.rawScore}점. ${PRAISE[result.stars]}`}
      </p>
      <p className="label dim center">{gameNameKo}</p>
      <StarRow stars={result.stars} animate={!reducedMotion} />
      <h1 className="h1 center">{PRAISE[result.stars]}</h1>

      <div className="card results__score center">
        <p className="caption">점수</p>
        <p className="display-1 num">{shown}</p>
        {isBest ? <p className="chip results__best pop-in">🏆 최고 기록!</p> : null}
      </div>

      {result.highlightsKo?.length ? (
        <ul className="bullets card card--flat">
          {result.highlightsKo.map((h) => (
            <li key={h}>
              <span className="mark" aria-hidden="true">
                ✨
              </span>
              <span>{h}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {result.perPlayer.length > 1 ? (
        <div className="row">
          {result.perPlayer.map((p) => (
            <PlayerChip
              key={p.playerId}
              slot={p.slot}
              score={p.score}
              {...(p.mvp ? { mvp: true } : {})}
            />
          ))}
        </div>
      ) : null}

      <div className="actions">
        <Button variant="primary" size="huge" icon="🎲" sfx="ui.confirm" onClick={onNext}>
          다음 게임!
        </Button>
        <Button variant="ghost" size="huge" icon="🔄" onClick={onAgain}>
          다시 하기
        </Button>
      </div>
      <Button variant="link" icon="🏁" sfx="ui.back" onClick={onStop}>
        그만하기
      </Button>
    </main>
  );
}

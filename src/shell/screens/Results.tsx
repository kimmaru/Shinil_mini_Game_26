// Results. Loud, and never a scolding.
//
// Zero stars gets "다음엔 더 잘할 수 있어요!", not "실패". Repeated failure
// indicators make 7-to-12-year-olds quit inside a minute, so the only thing
// this screen ranks is the child against today's best.
//
// Order of the reveal, and why: stars first (400 ms apart, the rising chime is
// the drum roll), the score counting up alongside them over 1.2 s, then the
// record banner, then confetti if it was a 3-star or record round. The auto-
// home timer (RESULTS_AUTO_HOME_SEC) lives in App.
import { useEffect, useState } from 'react';
import type { GameResult } from '@/engine/types';
import { Button } from '../components/Button';
import { PlayerChip } from '../components/PlayerChip';
import { StarRow } from '../components/StarRow';
import { useServices } from '../useSession';
import { SpriteIcon } from '../components/SpriteIcon';

import type { GameRecord } from '../records';

export interface ResultsProps {
  result: GameResult;
  gameNameKo: string;
  /** The game's hue, so the screen belongs to the game just played. */
  hue: number;
  /** Today's best for this game — null when this is the first play today. */
  record: GameRecord | null;
  /** Whether THIS round took the record. Computed in the reducer so the
   *  screen never has to diff tables. */
  beatRecord: boolean;
  reducedMotion: boolean;
  /** 처음으로 — back to the attract screen for the next guest. */
  onHome: () => void;
  /** Same guest wants another go. */
  onAgain: () => void;
}

const PRAISE: Record<0 | 1 | 2 | 3, string> = {
  0: '다음엔 더 잘할 수 있어요!',
  1: '잘했어요!',
  2: '아주 잘했어요!',
  3: '최고예요! 별 세 개!',
};

/** Score count-up. */
const COUNT_MS = 1200;
/** Stars land 400 ms apart starting at 400 ms; the banner follows the last. */
const STAR_STEP_MS = 400;

/** 28 pieces, laid out once. Index-derived, not random: the same round always
 *  throws the same confetti, and nothing is allocated per frame. */
const CONFETTI = Array.from({ length: 28 }, (_, i) => ({
  x: (i * 37) % 100,
  /** Resting height for the reduced-motion still burst, % of the screen. */
  y: 4 + ((i * 29) % 42),
  delay: (i * 113) % 900,
  dur: 1800 + ((i * 71) % 900),
  drift: ((i * 53) % 120) - 60,
  spin: 240 + ((i * 97) % 480),
  hue: [48, 18, 335, 195, 265, 150][i % 6]!,
  wide: i % 3 === 0,
}));

export function Results({
  result,
  gameNameKo,
  hue,
  record,
  beatRecord,
  reducedMotion,
  onAgain,
  onHome,
}: ResultsProps): React.ReactElement {
  const [shown, setShown] = useState(reducedMotion ? result.rawScore : 0);
  const services = useServices();
  const stars = result.stars;
  // A first play of the day "beats" an empty table; a zero score must not get
  // a crown for it.
  const isRecord = beatRecord && result.rawScore > 0;
  const party = stars === 3 || isRecord;
  /** When the banner / confetti may appear: after the last star has landed. */
  const settleMs = reducedMotion ? 0 : (Math.max(1, stars) + 1) * STAR_STEP_MS;
  const [settled, setSettled] = useState(reducedMotion);

  useEffect(() => {
    services.audio?.play(stars > 0 ? 'round.win' : 'round.lose');
    const t = window.setTimeout(() => {
      setSettled(true);
      if (isRecord) services.audio?.play('fanfare');
    }, settleMs);
    if (reducedMotion) {
      setShown(result.rawScore);
      return () => window.clearTimeout(t);
    }
    const t0 = performance.now();
    let raf = 0;
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / COUNT_MS);
      setShown(Math.round(result.rawScore * (1 - (1 - p) ** 3)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="screen results" style={{ ['--hue' as string]: hue }}>
      {/* The score counts up; announcing the final value once is the useful
          thing, announcing every intermediate number is not. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {`${gameNameKo} 끝! 별 ${stars}개, ${result.rawScore}점. ${PRAISE[stars]}${
          isRecord ? ' 오늘 최고 기록!' : ''
        }`}
      </p>

      {party && settled ? (
        <div className={`confetti${reducedMotion ? ' is-still' : ''}`} aria-hidden="true">
          {CONFETTI.map((c, i) => (
            <i
              key={i}
              style={{
                ['--x' as string]: `${c.x}%`,
                ['--y' as string]: `${c.y}%`,
                ['--delay' as string]: `${c.delay}ms`,
                ['--dur' as string]: `${c.dur}ms`,
                ['--drift' as string]: `${c.drift}px`,
                ['--spin' as string]: `${c.spin}deg`,
                ['--c' as string]: `hsl(${c.hue} 95% 58%)`,
              }}
              className={c.wide ? 'is-wide' : undefined}
            />
          ))}
        </div>
      ) : null}

      <p className="results__game">{gameNameKo}</p>

      <div className="results__card">
        <StarRow stars={stars} animate={!reducedMotion} />
        <h1 className="h1 center results__praise">{PRAISE[stars]}</h1>

        <div className="results__score">
          <span className="results__scoreLabel">점수</span>
          <span className="results__scoreNum num">{shown}</span>
        </div>

        {isRecord && settled ? (
          <p className="results__record slam-in">
            <SpriteIcon id="ui-crown" size={52} />
            오늘 최고 기록!
          </p>
        ) : record && !beatRecord ? (
          <p className="results__best">
            <SpriteIcon id="ui-trophy" size={30} />
            오늘 최고 <span className="num">{record.score}</span>점
          </p>
        ) : null}

        {result.highlightsKo?.length ? (
          <ul className="results__highlights">
            {result.highlightsKo.map((h) => (
              <li key={h}>
                <SpriteIcon id="sparkle" size={28} />
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
      </div>

      <div className="actions">
        <Button variant="go" size="huge" icon="ui-refresh" sfx="ui.confirm" onClick={onAgain}>
          다시 하기
        </Button>
        <Button variant="ghost" size="huge" icon="ui-home" sfx="ui.back" onClick={onHome}>
          처음으로
        </Button>
      </div>
    </main>
  );
}

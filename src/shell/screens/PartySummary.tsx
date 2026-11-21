// The end of a party. Everyone gets a title.
//
// The silly title is picked from what they actually did, so it is earned
// without being a ranking: a child who scored nothing but played eight rounds
// is "끝까지 달린 사람", which is true and is a compliment.
import type { GameResult } from '@/engine/types';
import { Button } from '../components/Button';
import { Screen } from '../components/Screen';
import { StarRow } from '../components/StarRow';
import { describeGame } from '../useSession';

export interface PartySummaryProps {
  history: GameResult[];
  nicknameKo: string;
  onAgain: () => void;
  onHome: () => void;
}

/** Deliberately not a leaderboard. */
function titleFor(h: GameResult[]): readonly [string, string] {
  const stars = h.reduce((n, r) => n + r.stars, 0);
  const threes = h.filter((r) => r.stars === 3).length;
  const combo = Math.max(0, ...h.map((r) => Math.max(0, ...r.perPlayer.map((p) => p.bestCombo))));
  if (threes >= 3) return ['🏅', '별 수집가'];
  if (combo >= 12) return ['🔥', '콤보 장인'];
  if (h.length >= 8) return ['🏃', '끝까지 달린 사람'];
  if (stars >= 6) return ['🌟', '반짝반짝 선수'];
  return ['🎉', '오늘의 놀이왕'];
}

export function PartySummary({
  history,
  nicknameKo,
  onAgain,
  onHome,
}: PartySummaryProps): React.ReactElement {
  const stars = history.reduce((n, r) => n + r.stars, 0);
  const [icon, title] = titleFor(history);
  const name = nicknameKo.trim() || '너';

  return (
    <Screen
      icon={icon}
      kickerKo="오늘의 파티 결과"
      titleKo={`${name}는 «${title}»!`}
      leadKo={`${history.length}판 놀고 별 ${stars}개를 모았어요.`}
      actions={
        <>
          <Button variant="primary" size="huge" icon="🎲" sfx="ui.confirm" onClick={onAgain}>
            한 판 더!
          </Button>
          <Button variant="ghost" size="huge" icon="🏠" sfx="ui.back" onClick={onHome}>
            처음으로
          </Button>
        </>
      }
    >
      {history.length > 0 ? (
        <ul className="stack stack--sm summary__list">
          {history.map((r, i) => {
            const g = describeGame(r.gameId);
            return (
              <li
                key={`${r.gameId}-${i}`}
                className="card card--flat row row--between summary__row"
                style={{ ['--hue' as string]: g.hue }}
              >
                <span className="label row summary__name">
                  <span aria-hidden="true">{g.icon}</span>
                  <span>{g.nameKo}</span>
                </span>
                <span className="row">
                  <span className="num label">{r.rawScore}점</span>
                  <StarRow stars={r.stars} animate={false} size="md" />
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="body-lg center dim">아직 한 판도 안 놀았어요!</p>
      )}
      <p className="caption center">
        기록은 이 브라우저에만 저장돼요. 설정에서 언제든 모두 지울 수 있어요.
      </p>
    </Screen>
  );
}

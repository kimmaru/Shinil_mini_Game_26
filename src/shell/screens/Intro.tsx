// The game's name slams in, then the two or three things you do.
//
// This is also where `registry.load(id)` resolves: the chunk for the chosen
// game downloads while the child reads howToKo, so the countdown never has to
// wait for the network. The next two candidates are warmed too.
//
// Auto-advance is a setting, not a rule: a child who reads slowly must not be
// pushed into a round they have not understood ("자동 넘기기 끄기").
import { useEffect, useState } from 'react';
import { preload } from '@/engine/registry';
import { Button } from '../components/Button';
import { describeGame, type GameInfo } from '../useSession';
import type { GameId } from '@/engine/types';

export const INTRO_AUTO_MS = 4500;

/** Gesture → the demo badge shown while the chunk loads. Mirrors GestureKind. */
const GESTURE_HINTS: Record<string, readonly [string, string]> = {
  jump: ['🙋', '점프!'],
  squat: ['🧎', '앉기!'],
  clap: ['👏', '손뼉!'],
  swing: ['💫', '팔 휘두르기'],
  raise: ['🙌', '손 들기'],
  lean: ['↔️', '몸 기울이기'],
  step: ['👣', '발 옮기기'],
  reach: ['🫳', '손 뻗기'],
  limbAngle: ['📐', '팔 각도 맞추기'],
  zone: ['🎯', '그 자리에 서기'],
  holdPose: ['🗿', '자세 유지'],
  rep: ['🔁', '반복 동작'],
  stillness: ['🤫', '가만히!'],
  balance: ['🦩', '한 발로 서기'],
  stroke: ['✍️', '손으로 그리기'],
  poseMatch: ['🪞', '자세 따라하기'],
  jointTargets: ['⭐', '점 짚기'],
};

export interface IntroProps {
  gameId: GameId;
  /** Warmed so the next round has no load pause. */
  nextIds: GameId[];
  autoAdvance: boolean;
  onReady: () => void;
  onBack: () => void;
}

export function Intro({
  gameId,
  nextIds,
  autoAdvance,
  onReady,
  onBack,
}: IntroProps): React.ReactElement {
  const game: GameInfo = describeGame(gameId);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    preload(gameId);
    for (const id of nextIds.slice(0, 2)) preload(id);
  }, [gameId, nextIds]);

  useEffect(() => {
    if (!autoAdvance) return;
    const t0 = performance.now();
    const id = window.setInterval(() => {
      const p = (performance.now() - t0) / INTRO_AUTO_MS;
      setElapsed(Math.min(1, p));
      if (p >= 1) {
        window.clearInterval(id);
        onReady();
      }
    }, 80);
    return () => window.clearInterval(id);
  }, [autoAdvance, onReady]);

  return (
    <main
      className="screen intro"
      style={{ ['--hue' as string]: game.hue }}
    >
      {/* One announcement on arrival; the rest of this screen is static. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {`${game.nameKo}. ${game.taglineKo}. ${game.howToKo.join('. ')}`}
      </p>
      <div className="intro__badge slam-in" aria-hidden="true">
        {game.icon}
      </div>
      <h1 className="display-2 center slam-in">{game.nameKo}</h1>
      {game.taglineKo ? <p className="h3 center dim">{game.taglineKo}</p> : null}

      <ol className="bullets card card--tinted intro__how">
        {game.howToKo.map((line, i) => (
          <li key={line} style={{ animationDelay: `${i * 60}ms` }} className="pop-in">
            <span className="mark num" aria-hidden="true">
              {i + 1}.
            </span>
            <span>{line}</span>
          </li>
        ))}
      </ol>

      {/* shortcut: static badges stand in for the looping gesture demo. Replace
          with VirtualPoseSource driving g.skeleton once the engine loop lands —
          the manifest already declares exactly which gestures to demonstrate. */}
      <div className="row intro__gestures">
        {game.gestures.map((g) => {
          const hint = GESTURE_HINTS[g];
          if (!hint) return null;
          return (
            <span key={g} className="chip breathe">
              <span aria-hidden="true">{hint[0]}</span> {hint[1]}
            </span>
          );
        })}
      </div>

      <div className="actions">
        <Button variant="primary" size="huge" icon="▶" sfx="ui.confirm" onClick={onReady}>
          바로 시작!
        </Button>
        <Button variant="ghost" icon="🎲" sfx="ui.back" onClick={onBack}>
          다른 게임
        </Button>
      </div>

      {autoAdvance ? (
        <div className="track intro__auto" aria-hidden="true">
          <div className="fill" style={{ width: `${Math.round(elapsed * 100)}%` }} />
        </div>
      ) : (
        <p className="caption center">준비되면 &ldquo;바로 시작!&rdquo;을 눌러 주세요.</p>
      )}
    </main>
  );
}

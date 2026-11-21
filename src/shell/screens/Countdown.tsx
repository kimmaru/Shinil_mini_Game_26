// 설명 + 3 · 2 · 1 · 시작!
//
// There is no intro screen: a stranger does not read one. Instead the
// countdown IS the how-to — the game's icon and name slam in, ONE command
// word says what to do ("짝!", "점프!"), a looping demo shows the move, the
// live skeleton shows they are in frame, and the howToKo lines sit underneath
// for whoever reads. Then 3·2·1 at 700 ms a number.
//
// `aria-live="assertive"` is correct here and almost nowhere else: this is the
// one moment where interrupting whatever the screen reader was saying is the
// helpful thing to do.
//
// shortcut: the ticks run on performance.now() timers. docs/PLAN.md wants the
// audio clock (`AudioService.now`) so the beep and the number land together on
// a device with Bluetooth latency. The visual number is the authoritative
// channel, so being early is safe; swap if a wireless speaker is ever used.
import { useEffect, useState } from 'react';
import type { GestureKind } from '@/engine/types';
import type { PoseSource } from '@/engine/pose/source';
import type { AutoCalibrator } from '@/engine/pose/calibration';
import { SkeletonPreview } from '../components/SkeletonPreview';
import { SpriteIcon } from '../components/SpriteIcon';
import { useServices, type GameInfo } from '../useSession';
import { DISTANCE_KO, distanceOf, type Distance } from '../distance';

/** Icon + name + command + demo, before the first number. */
export const INTRO_MS = 2400;
/** One number. 3 · 2 · 1 is therefore 2.1 s. */
export const COUNT_STEP_MS = 700;
/** "시작!" holds this long before the round mounts. */
const GO_MS = 600;
const PRESENCE_POLL_MS = 250;

const STEPS = ['3', '2', '1', '시작!'] as const;

/** One word, the first gesture's, shouted. WarioWare's rule: the whole brief
 *  of a microgame is one picture and one verb. */
const COMMAND: Record<GestureKind, string> = {
  clap: '짝!',
  jump: '점프!',
  reach: '뻗어!',
  jointTargets: '뻗어!',
  limbAngle: '뻗어!',
  swing: '휘둘러!',
  raise: '손 들어!',
  squat: '앉아!',
  lean: '기울여!',
  step: '옆으로!',
  zone: '이동해!',
  rep: '반복!',
  holdPose: '멈춰!',
  stillness: '멈춰!',
  poseMatch: '따라 해!',
  balance: '버텨!',
  stroke: '그려!',
};

/** The g-* gesture sprite for the demo, animated per kind in base.css. */
const DEMO: Record<GestureKind, string> = {
  clap: 'g-clap',
  jump: 'g-jump',
  reach: 'g-reach',
  jointTargets: 'g-target',
  limbAngle: 'g-angle',
  swing: 'g-swing',
  raise: 'g-raise',
  squat: 'g-squat',
  lean: 'g-lean',
  step: 'g-step',
  zone: 'g-step',
  rep: 'g-rep',
  holdPose: 'g-hold',
  stillness: 'g-still',
  poseMatch: 'g-mirror',
  balance: 'g-balance',
  stroke: 'g-draw',
};

export interface CountdownProps {
  onDone: () => void;
  /** The game about to start. Its gesture demo plays during the count. */
  game: GameInfo | null;
  pose: PoseSource | null;
  /** The engine's continuous calibrator: drives the distance hint. */
  calibration?: AutoCalibrator | null;
  reducedMotion: boolean;
}

export function Countdown({
  onDone, game, pose, calibration = null,
}: CountdownProps): React.ReactElement {
  /** -1 = intro, 0..3 = index into STEPS. */
  const [step, setStep] = useState(-1);
  const [present, setPresent] = useState(true);
  const [distance, setDistance] = useState<Distance>(null);
  const services = useServices();

  useEffect(() => {
    services.audio?.play('whoosh');
    const timers: number[] = [];
    STEPS.forEach((_, i) => {
      timers.push(window.setTimeout(() => {
        setStep(i);
        services.audio?.play(i === STEPS.length - 1 ? 'count.go' : 'count.beep', {
          rate: 1 + i * 0.08,
        });
      }, INTRO_MS + i * COUNT_STEP_MS));
    });
    timers.push(window.setTimeout(onDone, INTRO_MS + (STEPS.length - 1) * COUNT_STEP_MS + GO_MS));
    return () => timers.forEach(window.clearTimeout);
    // One count per mount; onDone is stable (App memoises it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "화면 안에 서 줘!" and the distance hint — polled, not per-frame: they only
  // have to be right within a quarter second, and the skeleton already draws
  // every frame.
  useEffect(() => {
    if (!pose) return;
    const t0 = performance.now();
    const id = window.setInterval(() => {
      const f = pose.sample((performance.now() - t0) / 1000);
      setPresent(f.players.some((p) => p.present));
      setDistance(distanceOf(calibration));
    }, PRESENCE_POLL_MS);
    return () => window.clearInterval(id);
  }, [pose, calibration]);

  const kind = (game?.gestures[0] ?? 'reach') as GestureKind;
  const command = COMMAND[kind] ?? '준비!';
  const label = step >= 0 ? STEPS[step]! : '';
  const isGo = step === STEPS.length - 1;

  return (
    <main
      className="screen screen--full countdown"
      style={game ? { ['--hue' as string]: game.hue } : undefined}
    >
      <p className="sr-only" aria-live="assertive" aria-atomic="true">
        {step < 0 ? `${game?.nameKo ?? ''}. ${command}` : label}
      </p>

      {game ? (
        <header className="cd__title slam-in">
          <span className="cd__titleIcon">
            <SpriteIcon id={game.icon} size={84} hue={game.hue} />
          </span>
          <h1 className="h1">{game.nameKo}</h1>
        </header>
      ) : null}

      <div className="cd__row">
        <figure className="cd__card cd__demo" aria-hidden="true">
          <span className={`demo demo--${kind}`}>
            <SpriteIcon id={DEMO[kind] ?? 'g-points'} size={176} />
          </span>
          <figcaption className="cd__cmdSmall">{command}</figcaption>
        </figure>

        <div className="cd__center" aria-hidden="true">
          {step < 0 ? (
            <span key="cmd" className="cd__word slam-in">{command}</span>
          ) : (
            <span key={label} className={`cd__num${isGo ? ' is-go' : ''}`}>{label}</span>
          )}
        </div>

        <figure className={`cd__card cd__me${present ? '' : ' is-absent'}`}>
          <SkeletonPreview
            pose={pose}
            alpha={0.95}
            fill={0.8}
            color="var(--c-grape)"
            className="cd__skeleton"
          />
          <figcaption className="cd__meLabel">
            {present ? '나' : <span className="cd__absent pop-in">화면 안에 서 줘!</span>}
          </figcaption>
        </figure>
      </div>

      <div className="cd__foot">
        {present && distance ? (
          <p className="cd__hint pop-in" role="status">{DISTANCE_KO[distance]}</p>
        ) : null}
        {game?.howToKo.length ? (
          <ul className="cd__how">
            {game.howToKo.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </main>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ATTRACT — "점프하면 시작!"
//
// The centrepiece. Four things are load-bearing here:
//
//  1. THE SAME JUMP DETECTOR THE GAMES USE, on a stricter preset. There is no
//     bespoke jump code in the shell, so this screen is a permanent end-to-end
//     test of the detector that every single user runs. If the start button
//     false-fires on a 12fps Chromebook, six games were already broken.
//  2. PROBATION BEFORE ARMING. A person must be present and upright for ~0.45s
//     before 시작 arms, shown as a filling ring, so a passing teacher or an
//     empty chair cannot launch a game.
//  3. NEVER A DEAD END. Space, Enter, click and tap always work; after 25s with
//     no jump the keyboard hint surfaces itself.
//  4. THE LIVE SKELETON AT LOW ALPHA. The honest "the camera sees only this"
//     demonstration — the only thing that makes the privacy copy credible to
//     the guardian standing behind the child.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { DwellRing, DWELL_MS } from '../components/DwellRing';
import { SkeletonPreview } from '../components/SkeletonPreview';
import { PlayerChip } from '../components/PlayerChip';
import type { PoseSource } from '@/engine/pose/source';
import type { Detector, GestureService, PlayerPose } from '@/engine/types';
import { L, ny, visible } from '@/engine/pose/landmarks';
import { SpriteIcon } from '../components/SpriteIcon';

/** After this long with no jump, tell them about the spacebar. */
export const KEYBOARD_HINT_MS = 25_000;

/** Shoulder centre at least this far above the hip, in shoulder widths. */
const UPRIGHT_N = -0.6;

export interface AttractProps {
  pose: PoseSource | null | undefined;
  gestures: GestureService | null | undefined;
  inputMode: 'camera' | 'keyboard';
  nicknameKo: string;
  players: number;
  onStart: () => void;
  onSettings: () => void;
  onPrivacy: () => void;
  onFinish: () => void;
  /** True once at least one round has been played — changes the copy. */
  returning: boolean;
  fakePose?: boolean;
}

function isUpright(p: PlayerPose | undefined): boolean {
  if (!p || !p.present) return false;
  if (!visible(p, L.LEFT_SHOULDER, L.RIGHT_SHOULDER, L.LEFT_HIP, L.RIGHT_HIP)) return false;
  return (ny(p, L.LEFT_SHOULDER) + ny(p, L.RIGHT_SHOULDER)) / 2 < UPRIGHT_N;
}

export function Attract({
  pose,
  gestures,
  inputMode,
  nicknameKo,
  players,
  onStart,
  onSettings,
  onPrivacy,
  onFinish,
  returning,
  fakePose,
}: AttractProps): React.ReactElement {
  const [dwell, setDwell] = useState(0);
  const [armed, setArmed] = useState(false);
  const [hint, setHint] = useState(false);
  const started = useRef(false);
  const startCb = useRef(onStart);
  startCb.current = onStart;

  const jump: Detector<'jump'> | null = useMemo(
    () =>
      // The stricter preset: a false start is more annoying than a missed one.
      gestures?.use('jump', {
        enter: 1.9,
        exit: 0.6,
        cooldownMs: 900,
        confirmFrames: 2,
        requireFeetVisible: false,
      }) ?? null,
    [gestures],
  );

  const fire = () => {
    if (started.current) return;
    started.current = true;
    startCb.current();
  };

  // Keyboard and pointer are peers of the jump, not a fallback: they work from
  // the first frame, armed or not.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        fire();
      }
    };
    window.addEventListener('keydown', onKey);
    const id = window.setTimeout(() => setHint(true), KEYBOARD_HINT_MS);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Probation + jump polling. One rAF loop, state pushed only when the ring
  // visibly moves, so a 60fps ring is ~50 renders instead of 1500.
  useEffect(() => {
    if (!pose) return;
    let raf = 0;
    const t0 = performance.now();
    let held = 0;
    let last = t0;
    let shown = 0;
    let isArmed = false;

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(100, now - last);
      last = now;
      const frame = pose.sample((now - t0) / 1000);
      const up = isUpright(frame.p1);
      held = up ? Math.min(DWELL_MS, held + dt) : 0;

      const v = held / DWELL_MS;
      if (Math.abs(v - shown) > 0.02 || (v === 0 && shown !== 0) || v === 1) {
        shown = v;
        setDwell(v);
      }
      const nextArmed = held >= DWELL_MS;
      if (nextArmed !== isArmed) {
        isArmed = nextArmed;
        setArmed(nextArmed);
      }
      // Only read the detector once the person has been standing there: it
      // stops a chair being dragged past the camera from starting a round.
      if (isArmed && jump?.read(frame).fired) fire();
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pose, jump]);

  const cameraMode = inputMode === 'camera';
  const showHint = hint || !cameraMode;

  return (
    <main className="screen screen--full attract">
      <SkeletonPreview
        pose={pose}
        alpha={0.26}
        fill={0.46}
        anchorY={0.58}
        className="attract__skeleton"
        {...(fakePose ? { fake: true } : {})}
      />

      <div className="attract__body">
        <p className="label dim">{returning ? '한 판 더?' : '몸으로 놀자!'}</p>
        <h1 className="display-1 attract__title">
          {cameraMode ? '점프하면 시작!' : '눌러서 시작!'}
        </h1>

        <DwellRing value={dwell} armed={armed || !cameraMode} size={300}>
          <Button
            variant={armed || !cameraMode ? 'primary' : 'ghost'}
            size="huge"
            sfx="round.start"
            className="attract__go"
            onClick={fire}
          >
            {cameraMode ? '점프!' : '시작'}
          </Button>
        </DwellRing>

        <p className="body-lg attract__status" aria-live="polite">
          {!cameraMode
            ? '스페이스바를 누르거나 버튼을 눌러 주세요.'
            : armed
              ? '좋아요! 이제 점프해 보세요!'
              : dwell > 0
                ? '보이고 있어요… 그대로 서 주세요'
                : '카메라 앞에 서 볼까요?'}
        </p>

        {showHint ? (
          <p className="chip pop-in attract__kbd">
            <SpriteIcon id="ui-keyboard" size={20} on="dark" /> 스페이스바를 눌러도 돼요
          </p>
        ) : null}

        {players > 1 ? (
          <div className="row attract__players">
            {Array.from({ length: players }, (_, i) => (
              <PlayerChip key={i} slot={i as 0 | 1 | 2 | 3} size="sm" nameKo={i === 0 ? nicknameKo : ''} />
            ))}
          </div>
        ) : null}
      </div>

      <div className="attract__foot">
        {cameraMode ? (
          <p className="caption attract__honest">
            <SpriteIcon id="ui-joints" size={20} on="dark" /> 카메라가 보는 건 이 점과 선뿐이에요. 녹화하지 않아요.
          </p>
        ) : null}
        <div className="row">
          <Button variant="link" icon="ui-gear" onClick={onSettings}>
            설정
          </Button>
          <Button variant="link" onClick={onPrivacy}>
            개인정보 안내
          </Button>
          {returning ? (
            <Button variant="link" icon="ui-flag-finish" onClick={onFinish}>
              그만하기
            </Button>
          ) : null}
        </div>
      </div>
    </main>
  );
}

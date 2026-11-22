// ════════════════════════════════════════════════════════════════════════════
// ATTRACT — the booth's resting state, all day.
//
// Five things are load-bearing here:
//
//  1. THE REEL. Real games, driven by synthetic pose clips, switching every
//     3 s (components/GameReel.tsx). A passer-by sees two or three games in
//     the time it takes to walk past, which is this screen's whole job.
//  2. START IS THE MAIN WAY IN. A big pulsing button; Space and Enter work
//     from the first frame. A stranger has no way to know jumping does
//     anything, so the jump is a second way in, never the only one.
//  3. THE SAME JUMP DETECTOR THE GAMES USE, on a stricter preset, armed only
//     after a person has been present and upright for ~0.45 s (the ring), so
//     a passing adult or a dragged chair cannot launch a round.
//  4. THE LIVE SKELETON in the "나" mirror — the honest "the camera sees only
//     this" demonstration that makes the privacy line credible to the
//     guardian standing behind the child.
//  5. NEVER A DEAD END. After 25 s with no jump the keyboard hint surfaces.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { DwellRing, DWELL_MS } from '../components/DwellRing';
import { GameReel } from '../components/GameReel';
import { SkeletonPreview } from '../components/SkeletonPreview';
import type { PoseSource } from '@/engine/pose/source';
import type { AutoCalibrator } from '@/engine/pose/calibration';
import type { Detector, GestureService, PlayerPose } from '@/engine/types';
import { ATTRACT_JUMP_OPTS } from '@/engine/session';
import { isUprightPose } from '@/engine/pose/identity';
import { SpriteIcon } from '../components/SpriteIcon';
import type { GameInfo } from '../useSession';
import { DISTANCE_KO, distanceOf, type Distance } from '../distance';

const ATTRACT_JUMPS = new WeakMap<GestureService, Detector<'jump'>>();

/** After this long with no jump, tell them about the spacebar. */
export const KEYBOARD_HINT_MS = 25_000;

export interface AttractProps {
  pose: PoseSource | null | undefined;
  /** The engine's continuous calibrator: drives the distance hint. */
  calibration?: AutoCalibrator | null;
  gestures: GestureService | null | undefined;
  inputMode: 'camera' | 'keyboard';
  /** Games the background reel cycles through. There are no video files in
   *  this project; the reel runs the real games. */
  reel: GameInfo[];
  reducedMotion: boolean;
  onStart: () => void;
  onSettings: () => void;
  /** True while 설정 is open over this screen: nothing behind a dialog may
   *  start a round (not Space, not a jump). */
  blocked?: boolean;

  fakePose?: boolean;
}

// Hips visible and below the shoulders, OR — a child close to the laptop with
// the hips off the bottom edge — a head above level shoulders. Requiring hips
// here kept the ring empty until the child backed off ~2m.
function isUpright(p: PlayerPose | undefined): boolean {
  return p !== undefined && isUprightPose(p);
}

export function Attract({
  pose,
  calibration = null,
  gestures,
  inputMode,
  reel,
  reducedMotion,
  onStart,
  onSettings,
  blocked = false,
  fakePose,
}: AttractProps): React.ReactElement {
  const [dwell, setDwell] = useState(0);
  const [armed, setArmed] = useState(false);
  const [hint, setHint] = useState(false);
  const [distance, setDistance] = useState<Distance>(null);
  const calRef = useRef(calibration);
  calRef.current = calibration;
  const started = useRef(false);
  const startCb = useRef(onStart);
  startCb.current = onStart;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;

  const jump: Detector<'jump'> | null = useMemo(() => {
    if (!gestures) return null;
    // One detector per gesture service for the page's life: the service never
    // releases a rental, so renting per mount grew by one every guest.
    // Re-armed on each mount so it behaves exactly like a fresh one.
    let d = ATTRACT_JUMPS.get(gestures);
    if (!d) {
      // The stricter preset: a false start is more annoying than a missed one.
      d = gestures.use('jump', { ...ATTRACT_JUMP_OPTS });
      ATTRACT_JUMPS.set(gestures, d);
    }
    d.reset();
    return d;
  }, [gestures]);

  const fire = () => {
    if (started.current || blockedRef.current) return;
    started.current = true;
    startCb.current();
  };

  // Keyboard and pointer are peers of the jump, not a fallback: they work from
  // the first frame, armed or not.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') {
        // Enter on a focused button (the gear) is that button's business.
        if (e.target instanceof HTMLButtonElement && !e.target.classList.contains('attract__start')) return;
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
    let dist: Distance = null;

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

      const d = distanceOf(calRef.current);
      if (d !== dist) {
        dist = d;
        setDistance(d);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pose, jump]);

  const cameraMode = inputMode === 'camera';
  const ready = armed || !cameraMode;

  return (
    <main className="screen screen--full attract">
      <h1 className="attract__logo">
        <span className="logo__top">몸으로 놀자!</span>
        <span className="logo__ribbon">미니게임 파티</span>
        <span className="logo__star logo__star--a" aria-hidden="true">
          <SpriteIcon id="star" size={64} />
        </span>
        <span className="logo__star logo__star--b" aria-hidden="true">
          <SpriteIcon id="sparkle" size={52} />
        </span>
      </h1>

      <Button
        variant="ghost"
        icon="ui-gear"
        className="attract__gear"
        aria-label="설정"
        onClick={onSettings}
      />

      <div className="attract__stage">
        <GameReel games={reel} reducedMotion={reducedMotion} />

        <section className="attract__me" aria-label="내 모습">
          <DwellRing value={dwell} armed={ready} size={248}>
            <div className="me">
              <SkeletonPreview
                pose={pose}
                alpha={0.95}
                fill={0.78}
                anchorY={0.5}
                color="var(--c-grape)"
                className="me__skeleton"
                {...(fakePose ? { fake: true } : {})}
              />
              <span className="me__label">나</span>
            </div>
          </DwellRing>
          <p className="attract__status" aria-live="polite">
            {!cameraMode
              ? '스페이스바를 눌러도 시작해요!'
              : distance
                ? DISTANCE_KO[distance]
                : armed
                ? '좋아요! 점프하면 시작!'
                : dwell > 0
                  ? '보여요! 그대로 서 주세요'
                  : '카메라 앞에 서 볼까요?'}
          </p>
        </section>
      </div>

      <div className="attract__cta">
        <Button
          variant="go"
          size="huge"
          icon="ui-play"
          sfx="round.start"
          className={`attract__start${ready ? ' is-ready' : ''}`}
          onClick={fire}
        >
          시작!
        </Button>
        {hint && cameraMode ? (
          <p className="chip chip--hint pop-in">
            <SpriteIcon id="ui-keyboard" size={28} /> 스페이스바를 눌러도 돼요
          </p>
        ) : null}
      </div>

      {cameraMode ? (
        <p className="attract__honest">
          <SpriteIcon id="ui-joints" size={28} /> 카메라 화면은 이 컴퓨터에서만 보여요. 녹화하지 않아요.
        </p>
      ) : null}
    </main>
  );
}

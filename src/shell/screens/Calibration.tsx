// Calibration, framed as a game rather than as setup.
//
// Four seconds of standing in a frame buys every later game its fairness:
// thresholds are measured in shoulder widths against THIS child's own body, so
// a short 7-year-old and a tall 12-year-old score the same. The hint ("발이
// 보이게 뒤로 가 볼까요?") is the only moment we ever ask a child to move for
// the camera's convenience, so it is phrased as an invitation.
import { ProgressRing } from '../components/ProgressRing';
import { Screen } from '../components/Screen';
import { SkeletonPreview } from '../components/SkeletonPreview';
import { Button } from '../components/Button';
import type { PoseSource } from '@/engine/pose/source';

export const CALIBRATION_MS = 4000;

export interface CalibrationProps {
  pose: PoseSource | null | undefined;
  /** 0..1 over CALIBRATION_MS. */
  progress: number;
  hintKo: string | null;
  onSkip: () => void;
  fakePose?: boolean;
}

export function Calibration({
  pose,
  progress,
  hintKo,
  onSkip,
  fakePose,
}: CalibrationProps): React.ReactElement {
  const secondsLeft = Math.max(1, Math.ceil((1 - progress) * (CALIBRATION_MS / 1000)));

  return (
    <Screen
      titleKo="선을 맞춰 서 볼까요?"
      leadKo="팔을 옆으로 쫙 펴고, 발이 다 보이게 서 주세요."
      footer={
        <Button variant="link" onClick={onSkip}>
          건너뛰기
        </Button>
      }
    >
      <div className="calib">
        <div className="calib__frame" aria-hidden="true" />
        <SkeletonPreview pose={pose} alpha={0.75} {...(fakePose ? { fake: true } : {})} />
        <div className="calib__ring">
          <ProgressRing
            value={progress}
            size={140}
            thickness={12}
            color="var(--c-success-500)"
            labelKo="맞춰보는 중"
          >
            <span className="h2 num" aria-hidden="true">
              {secondsLeft}
            </span>
          </ProgressRing>
        </div>
      </div>
      <p className="body-lg center" aria-live="polite">
        {hintKo ?? '좋아요! 그대로 있어 주세요.'}
      </p>
    </Screen>
  );
}

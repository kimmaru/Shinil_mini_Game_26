// Stage B warmup: creating the landmarker and running three inferences on a
// real photo, which is what compiles the landmark-stage shaders. A blank frame
// does not. On a cold cache this has been measured at ~20 seconds.
//
// Two rules for this screen: it is NEVER a still image (a frozen screen reads
// as a crash), and after the timeout it offers the keyboard rather than
// insisting. The countdown is honest about the wait instead of lying with a
// fake 99%.
import { useEffect, useState } from 'react';
import { Button } from '../components/Button';
import { ProgressRing } from '../components/ProgressRing';
import { Screen } from '../components/Screen';

export const WARMUP_TIMEOUT_MS = 60_000;
/** Offer the keyboard this early — long before the hard timeout. */
const PATIENCE_MS = 20_000;

export interface WarmupProps {
  progress: number;
  labelKo: string;
  onKeyboard: () => void;
}

const FACES = ['🏃', '🤸', '🕺', '💃', '🤾', '🧘'];

export function Warmup({ progress, labelKo, onKeyboard }: WarmupProps): React.ReactElement {
  const [tick, setTick] = useState(0);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const spin = window.setInterval(() => setTick((t) => t + 1), 700);
    const patience = window.setTimeout(() => setSlow(true), PATIENCE_MS);
    return () => {
      window.clearInterval(spin);
      window.clearTimeout(patience);
    };
  }, []);

  return (
    <Screen
      kickerKo="거의 다 됐어요"
      titleKo="게임을 깨우고 있어요"
      footer={
        slow ? (
          <Button variant="link" icon="⌨️" onClick={onKeyboard}>
            기다리기 싫어요 — 키보드로 놀래요
          </Button>
        ) : null
      }
    >
      <ProgressRing
        value={progress}
        size={260}
        color="var(--c-primary-500)"
        labelKo="준비 중"
      >
        <span className="display-2" aria-hidden="true">
          {FACES[tick % FACES.length]}
        </span>
      </ProgressRing>
      <p className="body-lg center dim">{labelKo}</p>
      {slow ? (
        <p className="caption center">
          처음 한 번만 조금 오래 걸려요. 다음부터는 바로 시작해요!
        </p>
      ) : null}
    </Screen>
  );
}

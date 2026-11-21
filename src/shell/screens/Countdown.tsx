// 3 · 2 · 1 · 시작!
//
// `aria-live="assertive"` is correct here and almost nowhere else: this is the
// one moment where interrupting whatever the screen reader was saying is the
// helpful thing to do.
//
// shortcut: the ticks run on performance.now(). docs/PLAN.md wants the audio
// clock (`AudioService.now`) so the beep and the number land together on a
// device with 200ms of Bluetooth latency. Swap when audio lands; the visual
// numbers are already the authoritative channel, so being early is safe.
import { useEffect, useState } from 'react';
import { useServices } from '../useSession';

export const COUNT_STEP_MS = 800;

export interface CountdownProps {
  onDone: () => void;
  /** Shown faintly behind the number, so they know what they are about to play. */
  gameNameKo?: string;
}

const STEPS = ['3', '2', '1', '시작!'] as const;

export function Countdown({ onDone, gameNameKo }: CountdownProps): React.ReactElement {
  const [i, setI] = useState(0);
  const services = useServices();

  useEffect(() => {
    let step = 0;
    services.audio?.play('count.beep');
    const id = window.setInterval(() => {
      step += 1;
      if (step >= STEPS.length) {
        window.clearInterval(id);
        onDone();
        return;
      }
      setI(step);
      services.audio?.play(step === STEPS.length - 1 ? 'count.go' : 'count.beep', {
        rate: 1 + step * 0.08,
      });
    }, COUNT_STEP_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const label = STEPS[i] ?? '시작!';
  return (
    <main className="screen screen--full countdown">
      {gameNameKo ? <p className="h3 dim center">{gameNameKo}</p> : null}
      <p className="sr-only" aria-live="assertive" aria-atomic="true">
        {label}
      </p>
      <div
        key={label}
        className={`countdown__num display-1 slam-in${i === STEPS.length - 1 ? ' is-go' : ''}`}
        aria-hidden="true"
      >
        {label}
      </div>
    </main>
  );
}

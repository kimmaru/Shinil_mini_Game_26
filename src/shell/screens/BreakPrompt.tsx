// Mandatory rest, every 8 games or 10 minutes.
//
// The 30-60 second round limit is already the main safety device; this is the
// backstop for the child who would otherwise play for forty minutes straight.
// It counts DOWN rather than blocking, and 계속하기 is available throughout —
// a locked screen gets closed, a timer gets waited out.
import { useEffect, useState } from 'react';
import { Button } from '../components/Button';
import { ProgressRing } from '../components/ProgressRing';
import { Screen } from '../components/Screen';

export const BREAK_MS = 60_000;

export interface BreakPromptProps {
  /** How many rounds they just played, for the praise line. */
  rounds: number;
  onContinue: () => void;
  onStop: () => void;
}

const TIPS: readonly string[] = [
  '💧 물 한 잔 마시고 올까요?',
  '🪟 창문 밖 먼 곳을 20초만 바라봐요. 눈이 쉬어요.',
  '🤸 팔과 다리를 쭉 펴고 기지개를 켜요.',
  '🧦 바닥에 떨어진 물건이 없는지 다시 봐요.',
];

export function BreakPrompt({ rounds, onContinue, onStop }: BreakPromptProps): React.ReactElement {
  const [left, setLeft] = useState(BREAK_MS);

  useEffect(() => {
    const t0 = performance.now();
    const id = window.setInterval(() => {
      const ms = Math.max(0, BREAK_MS - (performance.now() - t0));
      setLeft(ms);
      if (ms === 0) window.clearInterval(id);
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  const secs = Math.ceil(left / 1000);
  const tip = TIPS[Math.min(TIPS.length - 1, Math.floor(rounds / 8)) % TIPS.length]!;

  return (
    <Screen
      icon="🧃"
      titleKo="잠깐 쉬는 시간!"
      leadKo={`${rounds}판이나 했어요. 정말 잘했어요!`}
      actions={
        <>
          <Button
            variant={secs === 0 ? 'primary' : 'ghost'}
            size="huge"
            icon="▶"
            sfx="ui.confirm"
            onClick={onContinue}
          >
            {secs === 0 ? '다시 놀자!' : '그래도 계속하기'}
          </Button>
          <Button variant="ghost" size="huge" icon="🏁" sfx="ui.back" onClick={onStop}>
            오늘은 그만
          </Button>
        </>
      }
    >
      <ProgressRing value={1 - left / BREAK_MS} size={200} color="var(--c-success-500)">
        <span className="h1 num" aria-hidden="true">
          {secs}
        </span>
      </ProgressRing>
      <p className="body-lg center">{tip}</p>
    </Screen>
  );
}

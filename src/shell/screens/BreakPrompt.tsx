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
import { SpriteIcon } from '../components/SpriteIcon';

export const BREAK_MS = 60_000;

export interface BreakPromptProps {
  /** How many rounds they just played, for the praise line. */
  rounds: number;
  onContinue: () => void;
  onStop: () => void;
}

/** A picture and two words. The sentences these replaced were read by nobody:
 *  this screen appears when a child has been jumping for ten minutes. */
const TIPS: ReadonlyArray<readonly [string, string]> = [
  ['s-cup', '물 한 잔'],
  ['s-window', '창밖 20초'],
  ['s-stretch', '기지개'],
  ['s-shoe', '바닥 정리'],
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
  const [tipIcon, tipText] = TIPS[Math.min(TIPS.length - 1, Math.floor(rounds / 8)) % TIPS.length]!;

  return (
    <Screen
      icon="s-cup"
      titleKo="잠깐 쉬는 시간!"
      leadKo={`${rounds}판이나 했어요. 정말 잘했어요!`}
      actions={
        <>
          <Button
            variant={secs === 0 ? 'primary' : 'ghost'}
            size="huge"
            icon="ui-play"
            sfx="ui.confirm"
            onClick={onContinue}
          >
            {secs === 0 ? '다시 놀자!' : '그래도 계속하기'}
          </Button>
          <Button variant="ghost" size="huge" icon="ui-flag-finish" sfx="ui.back" onClick={onStop}>
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
      <div className="promises" style={{ gridTemplateColumns: '1fr', maxWidth: '14rem' }}>
        <span className="promise">
          <SpriteIcon id={tipIcon} size={88} label={tipText} />
          <span className="promise__label">{tipText}</span>
        </span>
      </div>
    </Screen>
  );
}

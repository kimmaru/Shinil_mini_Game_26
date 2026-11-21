// The 15-second safety screen, once per session, before the first standing game.
//
// This is the one screen a grown-up should read, so it is the one screen with a
// minimum dwell time: the 계속하기 button stays disabled for a few seconds so it
// cannot be mashed past. The timer is visible, which turns a block into a
// countdown — children wait for a countdown and fight a disabled button.
import { useEffect, useState } from 'react';
import { Button } from '../components/Button';
import { Screen } from '../components/Screen';
import { SpriteIcon } from '../components/SpriteIcon';

export const SAFETY_MS = 15_000;
/** 계속하기 arms after this. Short enough not to be a punishment. */
const MIN_DWELL_MS = 4000;

export interface SafetyProps {
  onAck: () => void;
}

const RULES: ReadonlyArray<readonly [string, string]> = [
  ['s-ruler', '팔을 쫙 펴도 안 닿는 2m 공간을 만들어요.'],
  ['s-chair', '의자, 책가방, 컵은 뒤로 치워요.'],
  ['s-shoe', '미끄러운 바닥은 조심! 양말보다 운동화가 좋아요.'],
  ['s-dog', '동생이나 강아지가 뒤에 없는지 봐요.'],
  ['droplet', '목 마르면 언제든 쉬어도 돼요.'],
];

export function Safety({ onAck }: SafetyProps): React.ReactElement {
  const [left, setLeft] = useState(Math.ceil(MIN_DWELL_MS / 1000));

  useEffect(() => {
    const id = window.setInterval(() => setLeft((n) => (n <= 1 ? 0 : n - 1)), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <Screen
      icon="g-raise"
      titleKo="놀 준비!"
      leadKo="다치지 않게 딱 다섯 가지만 확인해요."
      actions={
        <Button
          variant="success"
          size="huge"
          icon="ui-thumb-up"
          sfx="ui.confirm"
          disabled={left > 0}
          onClick={onAck}
        >
          {left > 0 ? `확인했어요 (${left})` : '확인했어요!'}
        </Button>
      }
    >
      <ul className="bullets card">
        {RULES.map(([mark, text]) => (
          <li key={mark}>
            <span className="mark">
              <SpriteIcon id={mark} size={30} />
            </span>
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </Screen>
  );
}

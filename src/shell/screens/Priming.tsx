// Permission priming. The first thing anyone sees.
//
// `getUserMedia` is never called on load — it cannot be (it needs a gesture)
// and a prompt with no context gets blocked or ignored. Explaining the benefit
// first pushes grant rates near 100%, and there is always a route that does not
// need the camera at all, so the page can never look like a wall.
//
// Copy is docs/RESEARCH-ARCH.md §7.1 close to verbatim: it is written at a
// 초등 3-4학년 reading level on purpose, which 개인정보보호법 제22조의2 ③
// requires for notices aimed at under-14s.
import { Button } from '../components/Button';
import { Screen } from '../components/Screen';
import { SpriteIcon } from '../components/SpriteIcon';

export interface PrimingProps {
  onCamera: () => void;
  onKeyboard: () => void;
  onPrivacy: () => void;
  onSettings: () => void;
  /** Stage A prefetch of the wasm + model, 0..1. Overlaps with reading this. */
  progress: number;
  progressLabelKo: string;
}

/**
 * Four promises, as pictures.
 *
 * These were four sentences. A seven-year-old does not read four sentences
 * before a game, and an adult does not need them spelled out twice — the full
 * notice is one tap away under 보호자님께 안내, where it belongs. The icon
 * carries the meaning; the word underneath only names it.
 */
const POINTS: ReadonlyArray<readonly [string, string]> = [
  ['ui-lock', '이 컴퓨터 안에서만'],
  ['ui-ban', '녹화 안 해요'],
  ['ui-joints', '점과 선만 봐요'],
  ['ui-keyboard', '키보드로도 OK'],
];

export function Priming({
  onCamera,
  onKeyboard,
  onPrivacy,
  onSettings,
  progress,
  progressLabelKo,
}: PrimingProps): React.ReactElement {
  return (
    <Screen
      icon="s-dance"
      titleKo="카메라를 켜면 몸으로 게임할 수 있어요!"
      actions={
        <>
          <Button variant="primary" size="huge" icon="ui-camera" sfx="ui.confirm" onClick={onCamera}>
            카메라 켜고 시작하기
          </Button>
          <Button variant="ghost" size="huge" icon="ui-keyboard" onClick={onKeyboard}>
            카메라 없이 하기
          </Button>
        </>
      }
      footer={
        <>
          <Button variant="link" onClick={onPrivacy}>
            보호자님께 안내 ▸
          </Button>
          <Button variant="link" icon="ui-gear" onClick={onSettings}>
            설정
          </Button>
        </>
      }
    >
      <ul className="promises">
        {POINTS.map(([mark, label]) => (
          <li key={mark} className="promise">
            <SpriteIcon id={mark} size={76} label={label} />
            <span className="promise__label">{label}</span>
          </li>
        ))}
      </ul>

      {/* The 20MB of wasm + model is the slowest thing in the app. It downloads
          while the child reads, and it is honest about doing so. */}
      <div className="stack stack--sm" aria-hidden={progress >= 1}>
        <div className="track">
          <div className="fill" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <p className="caption center">
          {progress >= 1 ? '준비 끝! 언제든 시작할 수 있어요.' : progressLabelKo}
        </p>
      </div>
    </Screen>
  );
}

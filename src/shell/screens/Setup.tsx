// 부스 준비 — the operator's screen, seen once when the booth opens.
//
// This replaced the old guest-facing chain (개인정보 안내 → 곧 물어봐요 →
// 권한 요청 → 워밍업 → 보정 → 안전 안내). That chain existed for a classroom,
// where one adult sets up for a known group and everybody has a reason to
// wait. A walk-up stranger has neither, and six screens before the first game
// is simply a wall.
//
// So all of it collapsed into one screen that the guest never sees: the
// operator presses 시작, the 20MB of wasm and model prefetch, permission is
// requested once, the shader warmup runs on a real photo, and the booth drops
// into attract mode for the rest of the day.
import { ProgressRing } from '../components/ProgressRing';
import { Button } from '../components/Button';
import { SpriteIcon } from '../components/SpriteIcon';

export interface SetupProps {
  /** 0..1 across both prefetch and warmup. */
  progress: number;
  labelKo: string;
  /** False until the operator presses 시작 — permission dialogs need a
   *  user gesture, and an auto-fired one is dismissed by the browser. */
  started: boolean;
  onStart: () => void;
  onKeyboard: () => void;
}

export function Setup({
  progress, labelKo, started, onStart, onKeyboard,
}: SetupProps): React.ReactElement {
  return (
    <main className="screen screen--setup" aria-labelledby="setup-h">
      <div className="setup__card">
        <SpriteIcon id="ui-camera" size={96} hue={212} />
        <h1 id="setup-h" className="setup__title">부스 준비</h1>

        {started ? (
          <>
            <ProgressRing value={progress} size={160} />
            <p className="setup__label" aria-live="polite">{labelKo}</p>
          </>
        ) : (
          <>
            {/* The only text on any screen that is addressed to the operator
                rather than a guest, which is why it is allowed to be a
                sentence instead of a graphic. */}
            <p className="setup__label">
              카메라를 켜고 준비를 마치면 하루 종일 그대로 두면 돼요.
            </p>
            <Button variant="primary" size="huge" onClick={onStart}>시작</Button>
          </>
        )}

        <button type="button" className="setup__alt" onClick={onKeyboard}>
          카메라 없이 쓰기
        </button>
      </div>
    </main>
  );
}

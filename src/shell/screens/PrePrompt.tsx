// The 1.2s nudge before the browser's own permission dialog appears.
//
// The dialog is unstyled, in the browser's chrome, and says nothing about why.
// Telling a 7-year-old what is about to happen and which button to press turns
// "a scary box appeared" into "I know what to do".
import { useEffect } from 'react';
import { Button } from '../components/Button';
import { Screen } from '../components/Screen';
import { SpriteIcon } from '../components/SpriteIcon';

export const PREPROMPT_MS = 1200;

export interface PrePromptProps {
  /** Fires getUserMedia. Called automatically after PREPROMPT_MS. */
  onReady: () => void;
  onKeyboard: () => void;
}

export function PrePrompt({ onReady, onKeyboard }: PrePromptProps): React.ReactElement {
  useEffect(() => {
    const id = window.setTimeout(onReady, PREPROMPT_MS);
    return () => window.clearTimeout(id);
  }, [onReady]);

  return (
    <Screen
      icon="ui-point-up"
      titleKo="곧 브라우저가 물어봐요"
      live="assertive"
      footer={
        <Button variant="link" icon="ui-keyboard" onClick={onKeyboard}>
          그냥 키보드로 놀래요
        </Button>
      }
    >
      <div className="card center stack">
        <p className="body-lg">
          잠시 후 브라우저가 <strong>&ldquo;카메라를 사용하도록 허용하시겠습니까?&rdquo;</strong>{' '}
          라고 물어봐요.
        </p>
        <p className="h2 breathe">
          <strong>[허용]</strong> 을 눌러 주세요! <SpriteIcon id="ui-point-up" size={22} on="dark" />
        </p>
      </div>
    </Screen>
  );
}

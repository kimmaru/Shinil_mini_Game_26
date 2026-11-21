// Camera failed. This screen's only job is to not be a dead end.
//
// Distinct copy per error, because the fix is different every time and
// "카메라를 못 켰어요" sends a parent to the wrong setting. The keyboard route
// is always the FIRST button: it works right now, with no settings, and the
// game is genuinely the same game.
import { useState } from 'react';
import { Button } from '../components/Button';
import { Screen } from '../components/Screen';
import type { CameraErrorKind } from '../useSession';
import { SpriteIcon } from '../components/SpriteIcon';

export interface CameraHelpProps {
  error: CameraErrorKind | null;
  onKeyboard: () => void;
  onRetry: () => void;
}

interface Copy {
  icon: string;
  titleKo: string;
  leadKo: string;
  /** Steps shown behind 카메라 허용 방법 보기. */
  howKo: string[];
  /** Hide 다시 시도하기 when retrying provably cannot help. */
  retry: boolean;
}

const COPY: Record<CameraErrorKind, Copy> = {
  denied: {
    icon: 'ui-camera',
    titleKo: '카메라를 못 쓰게 되어 있어요',
    leadKo: '괜찮아요! 키보드로도 똑같이 재미있게 할 수 있어요.',
    howKo: [
      '주소창 왼쪽의 카메라 또는 자물쇠 아이콘을 눌러요.',
      '"카메라"를 "허용"으로 바꿔요.',
      '새로고침하고 다시 시작해요.',
    ],
    retry: true,
  },
  notFound: {
    icon: 'ui-camera',
    titleKo: '카메라를 못 찾았어요',
    leadKo: '괜찮아요! 키보드로도 똑같이 재미있게 할 수 있어요.',
    howKo: [
      '웹캠이 USB로 잘 꽂혀 있는지 보여 주세요.',
      '노트북이면 카메라 덮개가 닫혀 있는지 확인해요.',
      '꽂은 다음 새로고침하면 바로 돼요.',
    ],
    retry: true,
  },
  inUse: {
    icon: 'ui-camera',
    titleKo: '다른 앱이 카메라를 쓰고 있어요',
    leadKo: '화상회의 앱(줌, 팀즈 같은 것)을 닫고 다시 해 볼까요?',
    howKo: [
      '카메라를 쓰는 다른 앱이나 탭을 모두 닫아요.',
      '닫은 다음 아래 "다시 시도하기"를 눌러요.',
    ],
    retry: true,
  },
  insecure: {
    icon: 'ui-lock',
    titleKo: '이 주소에서는 카메라를 쓸 수 없어요',
    leadKo: '선생님이나 보호자님께 알려 주세요. 그동안 키보드로 놀 수 있어요!',
    howKo: [
      '카메라는 https:// 주소 또는 localhost 에서만 켤 수 있어요.',
      '주소를 https:// 로 바꿔서 다시 열어 주세요.',
    ],
    retry: false,
  },
  unknown: {
    icon: 'ui-camera',
    titleKo: '카메라를 켜지 못했어요',
    leadKo: '괜찮아요! 키보드로도 똑같이 재미있게 할 수 있어요.',
    howKo: ['새로고침하고 다시 해 보세요.', '그래도 안 되면 키보드로 놀아요. 재미는 똑같아요!'],
    retry: true,
  },
};

export function CameraHelp({ error, onKeyboard, onRetry }: CameraHelpProps): React.ReactElement {
  const c = COPY[error ?? 'unknown'];
  const [open, setOpen] = useState(false);

  return (
    <Screen
      icon={c.icon}
      titleKo={c.titleKo}
      leadKo={c.leadKo}
      live="assertive"
      actions={
        <>
          <Button variant="primary" size="huge" icon="ui-keyboard" sfx="ui.confirm" onClick={onKeyboard}>
            키보드로 놀기
          </Button>
          {c.retry ? (
            <Button variant="ghost" size="huge" icon="ui-refresh" onClick={onRetry}>
              다시 시도하기
            </Button>
          ) : null}
        </>
      }
      footer={
        <Button variant="link" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          카메라 허용 방법 보기 {open ? '▾' : '▸'}
        </Button>
      }
    >
      {open ? (
        <ol className="bullets card pop-in">
          {c.howKo.map((step, i) => (
            <li key={step}>
              <span className="mark num" aria-hidden="true">
                {i + 1}.
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </Screen>
  );
}

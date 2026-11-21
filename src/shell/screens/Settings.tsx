// Settings, which is mostly an accessibility panel.
//
// Every one of these exists because the OS setting cannot be relied on for this
// audience: a shared classroom Chromebook almost never has
// prefers-reduced-motion on, and the child who needs it most is the least
// likely to be able to change it. Same for 글자 크게 and 자동 넘기기 끄기.
import { useState } from 'react';
import { Button } from '../components/Button';
import { Screen } from '../components/Screen';
import type { Settings as S } from '../useSession';

export interface SettingsProps {
  settings: S;
  set: <K extends keyof S>(k: K, v: S[K]) => void;
  onReset: () => void;
  onClose: () => void;
  onPrivacy: () => void;
}

function Group<T extends string | number>({
  labelKo,
  hintKo,
  value,
  options,
  onChange,
}: {
  labelKo: string;
  hintKo?: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (v: T) => void;
}): React.ReactElement {
  return (
    <fieldset className="setrow">
      <legend className="label">{labelKo}</legend>
      {hintKo ? <p className="caption setrow__hint">{hintKo}</p> : null}
      <div className="row setrow__opts" role="group">
        {options.map(([v, text]) => (
          <Button
            key={String(v)}
            variant={v === value ? 'primary' : 'ghost'}
            size="sm"
            aria-pressed={v === value}
            onClick={() => onChange(v)}
          >
            {text}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}

export function Settings({
  settings,
  set,
  onReset,
  onClose,
  onPrivacy,
}: SettingsProps): React.ReactElement {
  // Two presses, because it cannot be undone and the button sits next to
  // things a child is encouraged to poke at.
  const [confirmWipe, setConfirmWipe] = useState(false);
  return (
    <Screen
      variant="read"
      icon="ui-gear"
      titleKo="설정"
      actions={
        <Button variant="primary" size="huge" icon="ui-check-circle" sfx="ui.confirm" onClick={onClose}>
          다 했어요
        </Button>
      }
      footer={
        <Button variant="link" onClick={onPrivacy}>
          개인정보 안내 ▸
        </Button>
      }
    >
      <div className="stack card">
        <label className="setrow">
          <span className="label">별명</span>
          <p className="caption setrow__hint">
            결과 화면에만 보여요. 이 브라우저에만 저장되고 아무 데도 보내지 않아요.
          </p>
          <input
            className="field"
            type="text"
            inputMode="text"
            maxLength={10}
            placeholder="예: 번개"
            value={settings.nickname}
            onChange={(e) => set('nickname', e.target.value)}
          />
        </label>

        <Group
          labelKo="같이 노는 사람"
          value={settings.players}
          options={[
            [1, '혼자'],
            [2, '2명'],
            [3, '3명'],
            [4, '4명'],
          ]}
          onChange={(v) => set('players', v)}
        />

        <Group
          labelKo="화면 효과 줄이기"
          hintKo="흔들림과 반짝임을 없애고, 룰렛은 바로 결과만 보여줘요."
          value={settings.motion}
          options={[
            ['system', '기기 설정 따르기'],
            ['reduced', '줄이기'],
            ['full', '그대로'],
          ]}
          onChange={(v) => set('motion', v)}
        />

        <Group
          labelKo="글자 크게"
          value={settings.textSize}
          options={[
            ['normal', '보통'],
            ['large', '크게'],
          ]}
          onChange={(v) => set('textSize', v)}
        />

        <Group
          labelKo="진하게 보기"
          hintKo="글자와 선을 더 또렷하게 해요."
          value={settings.contrast}
          options={[
            ['system', '기기 설정'],
            ['more', '진하게'],
          ]}
          onChange={(v) => set('contrast', v)}
        />

        <Group
          labelKo="소리"
          value={settings.sound ? 'on' : 'off'}
          options={[
            ['on', '켜기'],
            ['off', '끄기'],
          ]}
          onChange={(v) => set('sound', v === 'on')}
        />

        <Group
          labelKo="말로 읽어주기"
          hintKo="기기마다 목소리 품질이 많이 달라요. 설명은 늘 큰 글자로도 보여줘요."
          value={settings.speak ? 'on' : 'off'}
          options={[
            ['off', '끄기'],
            ['on', '켜기'],
          ]}
          onChange={(v) => set('speak', v === 'on')}
        />

        <Group
          labelKo="자동 넘기기"
          hintKo="끄면 설명을 다 읽고 직접 눌러서 시작해요. 천천히 읽어도 괜찮아요."
          value={settings.autoAdvance ? 'on' : 'off'}
          options={[
            ['on', '켜기'],
            ['off', '끄기'],
          ]}
          onChange={(v) => set('autoAdvance', v === 'on')}
        />
      </div>

      <div className="stack card">
        <p className="label">저장된 것 모두 지우기</p>
        <p className="caption">
          별명, 최고 점수, 설정을 이 브라우저에서 모두 지워요. 되돌릴 수 없어요.
        </p>
        {confirmWipe ? (
          <div className="row">
            <Button
              variant="danger"
              icon="ui-trash"
              sfx="ui.deny"
              onClick={() => {
                setConfirmWipe(false);
                onReset();
              }}
            >
              네, 모두 지워요
            </Button>
            <Button variant="ghost" sfx="ui.back" onClick={() => setConfirmWipe(false)}>
              아니요
            </Button>
          </div>
        ) : (
          <Button variant="ghost" icon="ui-trash" onClick={() => setConfirmWipe(true)}>
            전체 삭제
          </Button>
        )}
      </div>
    </Screen>
  );
}

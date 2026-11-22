// 설정 — the operator's / guardian's panel, opened from the gear on attract.
//
// Kiosk-sized: only what one booth actually needs. Sound, 화면 효과 줄이기,
// 글자 크게, 배경에 내 모습 보이기, 진하게 보기, the privacy notice, and
// wiping the stored records.
// (별명 / 인원 / 말로 읽어주기 / 자동 넘기기 belonged to the classroom flow:
// one stranger plays one round, nobody types a nickname, and nothing in the
// kiosk flow read the other two.)
//
// The privacy notice lives here now (it was a separate screen). Its copy is
// docs/RESEARCH-ARCH.md §7.2, close to verbatim, at a 초등 3–4학년 reading level
// on purpose: 개인정보보호법 제22조의2 ③ requires notices aimed at under-14s to
// use plain language. Do not "improve" it. Every claim in it is enforced by a
// build step (connect-src 'self', self-hosted assets, scripts/check-privacy.mjs);
// if a claim stops being true the build fails, which is the only reason it is
// honest to print it. 16 px is correct for this block: it is read up close.
import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { SpriteIcon } from '../components/SpriteIcon';
import type { Settings as S } from '../useSession';

/** Keep in step with real edits to the privacy copy below. */
export const PRIVACY_UPDATED = '2026-11-21';

const GLANCE: readonly string[] = [
  '이 사이트는 회원가입이 없습니다. 이름, 이메일, 전화번호를 묻지 않습니다.',
  '카메라 영상은 기기 안(브라우저 내부)에서만 처리되며, 서버로 전송되거나 저장되지 않습니다.',
  '"배경에 내 모습 보이기"를 켜면 카메라 화면이 이 컴퓨터 화면에만 흐리게 보입니다. 화면에 보여 주기만 할 뿐, 저장하거나 보내지 않습니다.',
  '영상을 녹화·캡처하지 않으며, 얼굴을 인식하거나 누구인지 알아내지 않습니다.',
  '게임은 영상에서 관절 위치 좌표(숫자)만 실시간으로 계산해 바로 사용하고 즉시 버립니다.',
  '이 모든 계산은 여러분의 기기에서 동작하는 자세 인식 모델(MediaPipe)이 수행합니다. 인터넷 연결이 끊겨도 게임은 동작합니다.',
];

/** The nickname row is gone because the kiosk no longer asks for one. */
const STORED: ReadonlyArray<readonly [string, string, string, string]> = [
  ['최고 점수·별 개수', '게임 기록', '이 브라우저(localStorage)', '설정 → 전체 삭제'],
  ['화면/소리 설정', '효과 줄이기 등', '이 브라우저(localStorage)', '설정 → 전체 삭제'],
];

export interface SettingsProps {
  settings: S;
  set: <K extends keyof S>(k: K, v: S[K]) => void;
  onReset: () => void;
  onClose: () => void;
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
      <legend className="setrow__label">{labelKo}</legend>
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
}: SettingsProps): React.ReactElement {
  // Two presses, because it cannot be undone and the button sits next to
  // things a child is encouraged to poke at.
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [wiped, setWiped] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus moves into the dialog so the keyboard lands somewhere sensible;
  // Esc (handled in App) closes it.
  useEffect(() => panelRef.current?.focus({ preventScroll: true }), []);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="settings-h">
      <div className="overlay__panel" ref={panelRef} tabIndex={-1}>
        <header className="overlay__head">
          <SpriteIcon id="ui-gear" size={64} />
          <h1 id="settings-h" className="h1">설정</h1>
        </header>

        <div className="panel stack">
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
            labelKo="배경에 내 모습 보이기"
            hintKo="카메라 화면을 흐리게 깔아 줘요. 이 컴퓨터 화면에만 보이고, 저장하거나 보내지 않아요."
            value={settings.cameraBackdrop ? 'on' : 'off'}
            options={[
              ['on', '보이기'],
              ['off', '숨기기'],
            ]}
            onChange={(v) => set('cameraBackdrop', v === 'on')}
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
        </div>

        <section className="panel stack legal" aria-labelledby="privacy-h">
          <h2 id="privacy-h" className="h3 ink">개인정보 안내</h2>
          <ul className="bullets bullets--legal">
            {GLANCE.map((line) => (
              <li key={line}>
                <span className="mark">
                  <SpriteIcon id="ui-check-circle" size={24} />
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <h3 className="setrow__label">기기에 남는 정보 (이 브라우저에만 저장)</h3>
          <div className="table-wrap">
            <table className="legal-table">
              <thead>
                <tr>
                  <th scope="col">항목</th>
                  <th scope="col">내용</th>
                  <th scope="col">저장 위치</th>
                  <th scope="col">삭제 방법</th>
                </tr>
              </thead>
              <tbody>
                {STORED.map((row) => (
                  <tr key={row[0]}>
                    <th scope="row">{row[0]}</th>
                    <td>{row[1]}</td>
                    <td>{row[2]}</td>
                    <td>{row[3]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            위 정보는 <strong>이 브라우저에만 저장되고 외부로 전송되지 않습니다.</strong> 브라우저의
            방문 기록 삭제로도 함께 지워집니다.
          </p>
          <h3 className="setrow__label">수집하지 않는 것</h3>
          <p>
            카메라 영상 · 사진 · 음성 · 얼굴 정보(생체정보) · 위치 · 연락처 · 광고 식별자 —{' '}
            <strong>하나도 수집하지 않습니다.</strong> 외부 광고나 분석 도구(트래커)를 심지
            않았습니다.
          </p>
          <h3 className="setrow__label">보호자님께</h3>
          <p>
            이 사이트는 개인정보를 수집·전송·저장하지 않으므로 별도의 동의 절차가 없습니다. 자녀의
            카메라 영상은 네트워크를 통해 전송되지 않으며, 브라우저를 닫으면 즉시 사라집니다. 안전을
            위해 <strong>주변에 사람이나 물건이 없는 2m 이상의 공간</strong>에서 놀도록 지도해 주세요.
          </p>
          <p className="faint">최종 수정일: {PRIVACY_UPDATED}</p>
        </section>

        <section className="panel stack">
          <h2 className="setrow__label">기록 지우기</h2>
          <p className="caption">
            오늘의 최고 기록과 설정을 이 브라우저에서 모두 지워요. 되돌릴 수 없어요.
          </p>
          {wiped ? (
            <p className="chip chip--ok pop-in" role="status">
              <SpriteIcon id="ui-check-circle" size={28} /> 모두 지웠어요
            </p>
          ) : confirmWipe ? (
            <div className="row setrow__opts">
              <Button
                variant="danger"
                icon="ui-trash"
                sfx="ui.deny"
                onClick={() => {
                  setConfirmWipe(false);
                  setWiped(true);
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
            <div className="row setrow__opts">
              <Button variant="ghost" icon="ui-trash" onClick={() => setConfirmWipe(true)}>
                전체 삭제
              </Button>
            </div>
          )}
        </section>

        <div className="actions">
          <Button variant="go" size="huge" icon="ui-check-circle" sfx="ui.confirm" onClick={onClose}>
            다 했어요
          </Button>
        </div>
      </div>
    </div>
  );
}

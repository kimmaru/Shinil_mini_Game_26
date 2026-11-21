// 개인정보 안내 — docs/RESEARCH-ARCH.md §7.2, close to verbatim.
//
// Do not "improve" this copy. It is written at a 초등 3-4학년 reading level on
// purpose: 개인정보보호법 제22조의2 ③ requires notices aimed at under-14s to use
// "이해하기 쉬운 양식과 명확하고 알기 쉬운 언어", and that applies even in the
// no-collection case this app is in.
//
// Every claim here is enforced by a build step, not by good intentions:
// `connect-src 'self'` in the CSP, self-hosted fonts/wasm/model, and
// scripts/check-privacy.mjs grepping dist/ for toDataURL, toBlob,
// MediaRecorder and cross-origin fetch. If a claim below stops being true, the
// build fails — which is the only reason it is honest to print it.
//
// This is the ONE screen where 16px type is correct: it is read up close, by a
// guardian, on purpose.
import { Button } from '../components/Button';
import { Screen } from '../components/Screen';
import { SpriteIcon } from '../components/SpriteIcon';

/** Keep in step with real edits to the copy below. */
export const PRIVACY_UPDATED = '2026-11-21';

export interface PrivacyProps {
  onClose: () => void;
  onSettings: () => void;
}

const STORED: ReadonlyArray<readonly [string, string, string, string]> = [
  ['별명', '결과 화면에 표시할 이름', '이 브라우저(localStorage)', '설정 → 전체 삭제'],
  ['최고 점수·별 개수', '게임 기록', '이 브라우저(localStorage)', '설정 → 전체 삭제'],
  ['화면/소리 설정', '밝기, 효과 줄이기 등', '이 브라우저(localStorage)', '설정 → 전체 삭제'],
];

const GLANCE: readonly string[] = [
  '이 사이트는 회원가입이 없습니다. 이름, 이메일, 전화번호를 묻지 않습니다.',
  '카메라 영상은 기기 안(브라우저 내부)에서만 처리되며, 서버로 전송되거나 저장되지 않습니다.',
  '영상을 녹화·캡처하지 않으며, 얼굴을 인식하거나 누구인지 알아내지 않습니다.',
  '게임은 영상에서 관절 위치 좌표(숫자)만 실시간으로 계산해 바로 사용하고 즉시 버립니다.',
  '이 모든 계산은 여러분의 기기에서 동작하는 자세 인식 모델(MediaPipe)이 수행합니다. 인터넷 연결이 끊겨도 게임은 동작합니다.',
];

export function Privacy({ onClose, onSettings }: PrivacyProps): React.ReactElement {
  return (
    <Screen
      variant="read"
      titleKo="개인정보 안내"
      leadKo="아이와 보호자 모두를 위한 안내"
      actions={
        <Button variant="primary" size="huge" icon="ui-back" sfx="ui.back" onClick={onClose}>
          돌아가기
        </Button>
      }
      footer={
        <Button variant="link" icon="ui-gear" onClick={onSettings}>
          설정에서 저장된 기록 지우기 ▸
        </Button>
      }
    >
      <section className="card stack legal">
        <h2 className="h3">한눈에 보기</h2>
        <ul className="bullets">
          {GLANCE.map((line) => (
            <li key={line} className="legal">
              <span className="mark">
                <SpriteIcon id="ui-check-circle" size={22} on="dark" />
              </span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card stack legal">
        <h2 className="h3">기기에 남는 정보 (이 브라우저에만 저장)</h2>
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
      </section>

      <section className="card stack legal">
        <h2 className="h3">수집하지 않는 것</h2>
        <p>
          카메라 영상 · 사진 · 음성 · 얼굴 정보(생체정보) · 위치 · 연락처 · 광고 식별자 —{' '}
          <strong>하나도 수집하지 않습니다.</strong> 외부 광고나 분석 도구(트래커)를 심지
          않았습니다.
        </p>
      </section>

      <section className="card stack legal">
        <h2 className="h3">보호자님께</h2>
        <p>
          이 사이트는 개인정보를 수집·전송·저장하지 않으므로 별도의 동의 절차가 없습니다. 자녀의
          카메라 영상은 네트워크를 통해 전송되지 않으며, 브라우저를 닫으면 즉시 사라집니다. 안전을
          위해 <strong>주변에 사람이나 물건이 없는 2m 이상의 공간</strong>에서 놀도록 지도해 주세요.
        </p>
        <p className="caption">최종 수정일: {PRIVACY_UPDATED}</p>
      </section>
    </Screen>
  );
}

# 진행 상황 — 2026-11-21 중단 시점

## 지금 돌아가는 것

```bash
npm install && npm run play     # 빌드 후 Chrome 앱 창으로 실행
npm run gate                    # tsc + 경계/동결/자산 검사 + 전체 테스트
```

**플레이어에게 도달하는 게임은 3종뿐입니다** (`enabled: true`):
`mosquito-clap` · `candy-rain-catch` · `wave-jump` — 세 가지 update 루프 형태의 기준 구현.

나머지 21종은 전부 `enabled: false` 입니다. 코드는 컴파일되고 룰렛 풀에만 안 들어갑니다.

## 제품 방향 전환 (이번 세션의 큰 변경)

교실용 파티 게임 → **전시 부스 키오스크**로 바뀌었습니다. 손님은 지나가다 멈춘
무작위 행인이고, 같은 사람이 두 번 하지 않습니다. 근거와 각 단계가 사라진 이유는
`src/engine/session.ts` 상단 주석에 전부 적혀 있습니다.

손님용 흐름이 **17개 화면 → 6개**로 접혔습니다:

```
boot → setup ⇄ setupHelp         운영자용. 아침에 한 번. 손님은 못 봄
attract ⇄ settings               메인. START 버튼 + 우상단 기어. 그 외 UI 없음
  └ START → roulette → countdown → play → results → attract
```

삭제된 단계: `priming` `prePrompt` `cameraRequest` `calibration` `safety` `intro`
`breakPrompt` `partySummary`. 내용이 사라진 게 아니라 자리를 옮겼습니다 —
동작 시범과 안전 안내는 **카운트다운 안으로**, 개인정보 문안은 **설정 안으로**,
보정은 **attract 배경에서 연속 자동**으로.

### 배경 "게임 영상"에 대한 결정
사용자 요구는 "배경은 게임 화면 영상들이 3초마다 전환"이었습니다.
이 프로젝트에는 이미지·영상·음원 파일이 0개이고 그건 의도된 제약입니다
(`check-no-assets.mjs` 가 강제하고, CSP `connect-src 'self'` 로 외부 전송이
구조적으로 불가능한 상태의 근거). 그래서 **영상 파일을 추가하지 않고, 합성 포즈
클립이 조종하는 실제 게임을 배경에서 돌리는 릴**로 설계했습니다. 용량 0이고,
게임을 추가하면 릴에 자동으로 들어옵니다. 이 릴은 **아직 구현되지 않았습니다**(아래).

## 이번 세션에 완료된 것

| 영역 | 상태 |
|---|---|
| 키오스크 상태기계 (`engine/session.ts`) | 완료, 테스트 10개 통과 |
| 리듀서·상태·액션 (`shell/useSession.ts`) | 완료. 엔진과 중복됐던 단계 어휘를 한 벌로 합침 |
| 라우터 (`shell/App.tsx`) | 완료. setup 3단계를 한 체인으로 병합 |
| 기록 저장소 (`shell/records.ts`) | 완료. **오늘** 기준 최고 기록(전체 기간이 아님 — 행인이 깰 수 있어야 기록) |
| 운영자 세팅 화면 (`shell/screens/Setup.tsx`) | 완료 |
| 라운드 선택 (`shell/rounds.ts`) | 강도 페이싱 제거(손님이 한 판씩만 함), 중복 방지는 유지 |
| SVG 렌더러 + `npm run shot` | 렌더러 완료, CLI는 레지스트리 오류로 **미검증** |
| Wave 2 게임 21종 | 작성됨, **전부 미검수** |
| 자동 보정 `AutoCalibrator` | 작성됨, 테스트 1개 실패 |

### 시각 검수 수단 (`src/engine/testing/svgRenderer.ts`)
58종을 브라우저 없이 눈으로 보기 위한 도구입니다. 브라우저 스크린샷은 pane이 숨겨지면
rAF가 멈춰서 못 쓰고, `canvas.toDataURL` 은 개인정보 검사가 금지합니다(그 금지는
의도적으로 유지). 같은 draw call 을 SVG로 다시 그리면 둘 다 피하면서 결과가 **텍스트**라
grep·diff가 됩니다. `harness.ts` 에 렌더러 주입 한 줄을 추가하고 재동결했습니다.

## 남은 일 (우선순위 순)

### 1. 카메라가 아직 검증되지 않았습니다 ⚠️
마지막 확인된 증상은 "카메라는 켜졌는데 준비에 실패했어요"(= 엔진 시작 실패)였습니다.
워밍업 실패를 비치명적으로 바꾸는 수정을 넣었지만 **실기기에서 다시 확인되지 않았습니다.**
이게 안 되면 나머지 전부가 의미가 없습니다. `npm run play` 후 `?debug=1` 의
추론 fps / `inferenceAgeMs` 를 확인해야 합니다.

### 2. 쉘 화면 4개가 미구현 (prop 계약만 고정됨)
`App.tsx` 가 호출하는 계약은 확정됐고 화면 내용만 비어 있습니다:
- `Attract.tsx` — 3초 게임 릴 + START + 기어. **가장 중요한 화면**
- `Results.tsx` — 기록 + 처음으로 버튼
- `Settings.tsx` — 키오스크용으로 축소 + 개인정보 문안 흡수 (`Privacy.tsx` 삭제 예정)
- `Roulette.tsx` / `Countdown.tsx` — 빠른 회전(1.2~1.8초), 카운트다운 안에 동작 시범

### 3. Wave 2 게임 21종 검수 — 테스트 29건 실패
전부 `enabled: false` 라 플레이어에게 도달하지 않습니다. 실패 내역:
- **크래시**: `bike-pedal`, `run-in-place-sprint` (8클립 전부 — 중단 시점에 미완성)
- **점수 불가/비결정적**: `shooting-star-grab`, `wrist-aim-target`
- **별 컷이 변별력 없음**: `arm-pump-inflate` `blue-flag-white-flag` `cheer-combo`
  `connect-dots-order` `web-cut` `wrist-maze`
- `_wip-koko-ko-touch`, `_wip-max-reach-stretch` — 중단으로 미완성. `_` 접두사라
  레지스트리 글롭에서 제외되어 빌드를 깨지 않습니다. 이어서 하려면 접두사를 떼세요.

### 4. `NEEDS.md` 승격 패스
7개 게임이 없는 엔진 기능을 요청했습니다: `bike-pedal` `castle-defense`
`connect-dots-order` `fruit-slash` `wrist-aim-target` `wrist-maze` `_wip-koko-ko-touch`.
**2명 이상이 요청한 것만** 엔진 서비스로 올리고 로컬 우회 코드를 지우는 게 원칙입니다.

### 5. Wave 3~5 (34종)
`src/engine/catalog.ts` 의 `w3`/`w4`/`w5`. Wave 3은 `scroller` 와 `cue` 서비스가
먼저 필요합니다 — **아직 없습니다**. 나머지 제스처 디텍터 17종은 이미 구현돼 있습니다.

## 알아두면 좋은 함정 (이미 당한 것들)

- `npm install` 은 `.npmrc` 의 `legacy-peer-deps=true` 가 필요합니다 (npm 10.8.2 arborist 버그).
- vitest는 4.1.12 고정. 5.x 는 Node 20에서 리포터가 터집니다 (`Map.groupBy`).
- 로그인 셸이 Node 18을 주는 경우가 있어서 `scripts/preflight.mjs` 가 막아 줍니다.
- **측정이 리뷰를 이깁니다.** 이 프로젝트의 심각한 버그는 거의 전부 코드에서는 안 보이고
  측정하거나 스크린샷을 보면 바로 보였습니다 (대비 1.08:1, 빈 아이콘, 투명 버튼,
  합성 클립의 발목이 프레임 밖이라 점프가 전부 미검출 등).
- 임계값은 **전부 어깨너비 단위**입니다. 픽셀 임계값은 키 큰 사람에게 유리/불리를 만듭니다.

# 신일 모션 미니게임 파티 — 구현 계획

## Context

빈 디렉터리(`/Users/newuser/Github_kimmaru/Shinil_mini_Game_26`)에서 시작하는 신규 프로젝트다. 초등학생(7–12세)이 웹캠 앞에 서서 **몸(스켈레톤) 하나만으로** 즐기는 30–60초 미니게임 파티 사이트를 만든다. 화면 중앙 스타트 버튼은 **인식된 사람이 점프하면** 발동하고, 룰렛이 게임 하나를 뽑아 바로 시작한다.

이 세션에서 리서치를 끝냈다: ① 브라우저 포즈 추적 스택(MediaPipe Tasks Vision 1.2.3), ② 58종 미니게임 카탈로그(Kinect/Switch/Wii/브레인월/전래놀이/기존 OSS 웹 포즈게임 조사), ③ 엔진 아키텍처·디자인 토큰·개인정보 문구. 계획의 핵심 난제는 "게임을 50개 이상 만드는 것"이 아니라 **50개를 병렬 에이전트가 서로 충돌 없이 만들 수 있게 계약(contract)을 먼저 고정하고, 카메라 없이 전부 자동 검증하는 것**이다.

**확정된 결정 (사용자 승인)**
| 항목 | 결정 |
|---|---|
| 게임 수 | **58종 전부 구현.** 품질 확인된 것만 `enabled:true`로 룰렛 풀에 노출 |
| 인원 | **1인 기본.** 2인 대결 4종은 좌우 ROI 분할 방식, 실기기 검증 전까지 `enabled:false` |
| 테스트 데이터 | **합성(synthetic) 전용.** 카메라 녹화 클립 없음 — 관절 스트림을 코드로 생성 + 노이즈 주입 |
| 오디오 | **Web Audio 코드 합성음 + 화면 한글 텍스트.** 외부 음원 파일 0개, 한국어 TTS는 옵션 토글 |

---

## 기술 스택 (버전 고정)

```
vite@8.3.8   typescript@5.9.x (ts7 플러그인 호환 확인 후 승격)
react@19.3.1 + @vitejs/plugin-react@6.3.0   ← 쉘(로비/룰렛/결과)만. 게임 런타임은 React 없음
@mediapipe/tasks-vision@1.2.3  (캐럿 없이 정확히 고정)
vitest@5.1.1   zod@4.6.7 (devDep)   pretendard@1.3.9   vite-plugin-pwa@2.0.0
```

**렌더러: 공용 Canvas2D 하나.** Phaser/Pixi/게임별 React를 모두 배제한다 — 30초짜리 "원 6개와 숫자 하나"에 프레임워크 생애주기를 학습시키는 비용이 순수 낭비이고, 포즈 입력 레이어가 Phaser의 입력 시스템과 싸우게 된다. `MiniGame` 인터페이스(`update(dt, poseFrame)` + `render(g)`)는 타입 시그니처만 보고도 에이전트가 정확히 작성할 수 있다.

**포즈 파이프라인:** `pose_landmarker_lite.task`, `delegate:'GPU'`(WebGL2), `runningMode:'VIDEO'`, `numPoses:1`. 메인 스레드에서 `video.requestVideoFrameCallback`으로 ~25–30Hz 추론, **렌더는 별도 rAF 루프로 60fps 고정 + 외삽 보간**. 이 디커플링이 가장 가치 높은 설계 결정이다(추론이 12fps여도 게임은 매끄럽게 느껴진다).

**자체 호스팅 필수:** `wasm/`(14.7MB) + `.task`(5.5MB) + 폰트. CSP `connect-src 'self'`로 외부 전송이 **구조적으로 불가능**함을 보장해야 개인정보 문구가 사실이 된다.

---

## Phase 0 — 뼈대와 "동결 계약" (단독 작업, 병렬화 금지)

### 0A. 설정과 자산 배관
```
package.json  tsconfig.json(strict, noUncheckedIndexedAccess, paths @/*→src/*)
vite.config.ts   manualChunks(vision|engine|react), worker.format 'es'
vitest.config.ts environment 'node'   ← 게임은 헤드리스로 돌아야 한다
index.html       <html lang="ko">, 자체 호스팅 @font-face, CDN 링크 0개
vercel.json      CSP + Permissions-Policy: camera=(self), microphone=()
.claude/launch.json  { name:"mini-game", runtimeExecutable:"npm", runtimeArgs:["run","dev"], port:5173 }
scripts/copy-vision-assets.mjs   prebuild: tasks-vision/wasm/* → public/wasm/, .task 다운로드 → public/models/
public/warmup/person.jpg         256×256 사람 그림 — 셰이더 워밍업용 (아래 참조)
docs/RESEARCH-POSE.md  docs/RESEARCH-ARCH.md   ← 세션 스크래치패드의 리서치 브리프를 레포로 복사
                                                  (병렬 에이전트가 읽어야 하므로 레포에 있어야 한다)
```
`git init`. 이후 모든 웨이브는 브랜치.

### 0B. 동결 계약 파일 (시그니처만, 본문은 `throw new Error('TODO')`)

50개 이상의 게임 모듈이 import하므로 **먼저 전부 쓰고, 동결하고, 그 다음에 펼친다.** 각 파일 헤더:
```ts
// ══ FROZEN CONTRACT ══ 50+ 게임 모듈이 import한다.
// 변경에는 리드 승인 + 전체 리플레이 재실행이 필요하다.
```

| # | 파일 | 내용 |
|---|---|---|
| F1 | `src/engine/types.ts` | `MiniGameManifest`, `MiniGame`, `GameContext`, `PoseFrame`, `PlayerPose`, `GameResult`, `CalibrationProfile`, `GestureKind`, `EndReason`, `dev?:{clip?}` |
| F2 | `src/engine/pose/landmarks.ts` | `L` 상수(33개), `palm(p,side)`, `jointPx`, `mid`, `visible` |
| F3 | `src/engine/math.ts` | `clamp lerp smoothstep easeOutBack easeOutQuint`, `hitCircle/hitRect`, `angleDeg`, `limbAngle` |
| F4 | `src/engine/render/renderer.ts` | **`Renderer` 인터페이스** — 도형+이모지만, `ctx` 노출 금지 |
| F5 | `src/engine/gestures/index.ts` | `GestureService.use()` (init에서 임대, update에서 읽기) + 모든 Signal 타입 |
| F6 | `src/engine/fx/index.ts` | `burst confetti shake flash pop trail hitstop squash` |
| F7 | `src/engine/hud/index.ts` | `setGoal setScore setCombo setBar toast announce beatRing` |
| F8 | `src/engine/audio/index.ts` + `sfx.ts` | `AudioService` + **`SFX_IDS` 닫힌 유니온 타입** |
| F9 | `src/engine/entities.ts` + `spawn.ts` | 풀링된 엔티티 배열, 시드 기반 `Spawner`, 속도 게이트 히트테스트 (~22개 게임이 동일 루프) |
| F10 | `src/engine/registry.ts` + `validate.ts` + `catalog.ts` | glob 레지스트리, zod 스키마, 58개 id = 완결성 기준 |
| F11 | `src/engine/testing/harness.ts` + `nullRenderer.ts` + `synth.ts` | `runGame()`, `PoseClip` 포맷 |

**반드시 첫 작성에 맞아야 하는 두 가지:**

```ts
// F10 — _template 폴더는 globbing 대상에서 제외
const manifests = import.meta.glob<MiniGameManifest>(
  ['../games/*/manifest.ts', '!../games/_*/**'], { eager: true, import: 'manifest' });
const loaders = import.meta.glob<MiniGameFactory>(
  ['../games/*/index.ts', '!../games/_*/**'], { import: 'default' });   // lazy = 게임별 청크
```

```ts
// F4 — 도형과 이모지만. ctx 탈출구가 없는 것이 핵심:
// 58개 게임이 하나의 제품처럼 보이고, 자산 머지 충돌이 구조적으로 0이 된다.
export interface Renderer {
  readonly w: number; readonly h: number; readonly t: number;
  save(): void; restore(): void;
  translate(x,y): void; rotate(r): void; scale(x,y): void; alpha(a): void;
  clear(hue?: number): void;                        // --c-game-bg를 manifest.theme.hue로 틴팅
  circle(x,y,r,c: Paint): void;  roundRect(x,y,w,h,r,c): void;
  line(x0,y0,x1,y1,width,c): void;  poly(pts: Float32Array, n, c, close?): void;
  star(x,y,r,spikes,c): void;  chevron(x,y,r,dir,c): void;
  text(s,x,y,o?: TextOpts): void;                   // keep-all, tabular-nums
  emoji(s,x,y,size,rot?): void;                     // 모든 "아트"는 이모지 + 도형
  skeleton(p: PlayerPose, o?): void;                // 미러링·외곽선은 엔진 소유
  ghostBody(p: PlayerPose, alpha): void;
  // ctx getter는 의도적으로 없다. 필요하다고 느끼면 엔진 기능이 필요한 것이다.
}
```

```ts
// F5 — 디텍터는 init()에서 임대, update()에서 읽기. 프레임당 할당 0.
export interface GestureService { use<K extends GestureKind>(kind: K, opts?: GestureOpts[K]): Detector<K>; }
export interface Detector<K> { read(f: PoseFrame): SignalOf<K>; }
type JumpSignal = { fired: boolean; power: number; airborne: boolean };
type ClapSignal = { fired: boolean; at: Pt };
type HoldSignal = { inPose: boolean; progress: number; done: boolean; error: number };
type RepSignal  = { reps: number; phase: number; justCounted: boolean };
type ZoneSignal = { inside: boolean; entered: boolean; dwellMs: number };
```
리셋은 엔진이 소유한다(게임은 `reset()`을 호출하지 않는다). 이것이 "update에서 절대 할당하지 않는다"를 리뷰로 강제 가능하게 만든다.

### 0C. 엔진 본문 — 4 에이전트 병렬, 디렉터리 완전 분리

| 에이전트 | 소유 | 파일 |
|---|---|---|
| **E1 pose** | `src/engine/pose/**` | `source.ts`(PoseSource iface), `mediapipe.ts`, `oneEuro.ts`, `normalize.ts`, `identity.ts`, `calibration.ts`, **`virtual.ts`(VirtualPoseSource)**, `replay.ts`, `capability.ts`(WebGL2/SwiftShader 티어), `warmup.ts` |
| **E2 gestures** | `src/engine/gestures/**` | `trigger.ts`, `detectors.ts`(jump squat clap swing raise lean step angle zone), `reps.ts`, `stillness.ts`, `balance.ts`, `service.ts` |
| **E3 juice** | `src/engine/fx/**`, `src/engine/audio/**`, `src/engine/render/canvas2d.ts` | `particles.ts`, `shake.ts`, `flash.ts`(초당 3회 플래시 상한 강제), `audio/engine.ts`, **`audio/synth.ts`(오실레이터 기반 SFX)**, `audio/scheduler.ts` |
| **E4 shell** | `src/shell/**`, `src/styles/**` | `tokens.css`+`base.css`, `App.tsx`, `screens/*.tsx`, `Roulette.tsx`, `HudOverlay.tsx`, `DebugOverlay.tsx` |

리드가 병렬로: `loop.ts`, `session.ts`(상태기계), `rng.ts`, `shuffleBag.ts`, `scheduler.ts`(강도 페이싱), `registry.ts` 본문, `testing/**` 본문.

**핵심 구현 디테일 (리서치에서 확정됨):**
- 정규화: 원점 = 엉덩이 중점, 단위 = **어깨너비**. 스케일과 중심은 위치보다 **훨씬 강하게** 시간 스무딩(`s = s*0.3 + calib.shoulderW*0.7`) — 스케일이 흔들리면 모든 임계값이 흔들린다.
- 필터 순서: **median(3) → One Euro → 히스테리시스 임계값.** boolean을 스무딩하지 말고 연속값을 스무딩한 뒤 임계값에 히스테리시스를 걸 것. One Euro 시작값 `minCutoff 1.5, beta 0.08, dCutoff 1.0`. `velocity` 게터를 노출하면 디텍터가 공짜로 속도를 얻는다.
- 가시성 게이트: `visibility >= 0.5`. **추측하지 말고 게이트할 것** — 필요한 랜드마크가 안 보이면 `undefined`를 반환하고 상태기계를 건드리지 않는다. 0.3초 유예 후 부위 숨김, 0.6초 후 플레이어 드롭.
- 점프: 엉덩이 y **상향 속도의 첫 프레임**에 발화(정점을 기다리면 100–150ms 체감 지연). 착지 시 재장전. `worldLandmarks`로 점프를 측정하면 안 된다(원점이 엉덩이라 항상 0).
- 모든 임계값은 어깨너비/몸통 길이 단위. **절대 픽셀 임계값 금지** — 키 큰 아이에게 유리/불리를 만든다.

### 0D. 가드레일 (게임 에이전트 투입 전)
```
scripts/check-boundaries.mjs  src/games/*/** 가 @/engine/* 와 ./* 외의 것을 import하면 실패
                              manifest.ts 가 @/engine/types 외를 import하면 실패
                              게임 파일이 CanvasRenderingContext2D/document/window를 쓰면 실패
scripts/check-frozen.mjs      F1..F11의 sha256을 .frozen.json과 비교 — 드리프트 시 빌드 실패
scripts/check-privacy.mjs     dist/ 에서 toDataURL|toBlob|MediaRecorder|fetch(http 검색 → 실패
scripts/check-no-assets.mjs   src/games/** 에 png/jpg/svg/mp3/wav 가 있으면 실패
npm run gate                  tsc --noEmit && check-* && vitest run
```
+ `AGENTS.md`(모든 에이전트가 첫 번째로 읽음), `docs/GAME_AUTHORING.md`, `src/games/_template/`.

---

## Phase 1 — 기준 게임 3종 (리드가 직접)

카탈로그의 58종은 **update 루프 형태가 정확히 3가지**다. 에이전트가 형태를 넘나들며 복사할 때 오류가 난다. 각 형태의 정본을 손으로 만든다.

| 기준 게임 | 형태 | 파생 게임 수 |
|---|---|---|
| **`mosquito-clap` 모기 박수** | 이산 트리거(박수) × 화면좌표 관절 위치 × 히트테스트 | ~22 |
| **`candy-rain-catch` 사탕비 받아요** | 연속 겹침 + 낙하 물리 + 놓침 페널티 | ~12 |
| **`wave-jump` 파도 넘기** | 이동 제스처 vs 스크롤 월드 + 생존 점수 | ~10 |

`mosquito-clap`을 1번으로 고르는 이유: 물리적으로는 자명(중력·스크롤·비트·포즈 라이브러리 없음)하면서 엔진 표면을 **정확히 한 번씩** 모두 통과한다 — 쿨다운 있는 `Trigger` 디텍터, px 단위 손바닥 좌표(22개 게임이 필요), 콤보 점수, HUD 4종, fx 5종, 시드 결정성, 그리고 키보드 폴백이 **게임 코드 0줄**로 동작함(전부 `VirtualPoseSource`).

```ts
// src/games/mosquito-clap/manifest.ts
export const manifest: MiniGameManifest = {
  id: 'mosquito-clap',            // 폴더명과 반드시 동일 — 다르면 레지스트리가 throw
  nameKo: '모기 박수', taglineKo: '모기를 박수로 잡아요!',
  howToKo: ['모기가 두 손 사이로 오면', '손뼉을 짝! 치세요'],
  icon: '🦟', theme: { hue: 142 },
  difficulty: 1, intensity: 1, space: 'seated',    // 앉아서 가능 → 스케줄러의 "휴식 게임"
  players: { min: 1, max: 1, mode: 'solo' },
  requiredLandmarks: ['arms','hands','torso'], gestures: ['clap'],
  durationMs: 40_000,
  scoring: { kind: 'count', maxScore: 24, starCuts: [0.25, 0.5, 0.75] },
  a11y: { keyboardFallback: true, noFlashing: true, colorBlindSafe: true, audioOptional: true },
  tags: ['반사신경','파티','앉아서'], version: 1,
  enabled: true, dev: { clip: 'clap-x12' },
};
```

---

## Phase 2–5 — 게임 웨이브 (병렬 서브에이전트)

### 배치 규칙
1. **공유 *신호*로 묶는다** — 메커닉 패밀리나 난이도가 아니다. 같은 디텍터를 쓰는 3종을 한 에이전트에게 주면 임계값 감각을 한 번만 익히고 재사용한다. 점프 게임 하나 + 리듬 하나 + 포즈매치 하나를 받은 에이전트는 세 서브시스템을 배워야 하고 셋 다 엉성해진다.
2. **웨이브 경계 = 엔진 기능 경계.** 필요한 서비스가 이전 웨이브에서 머지·테스트된 게임만 포함할 수 있다. 이것이 유일한 하드 스케줄 제약.
3. **에이전트 1명이 폴더 N개를 독점.** 공유 파일은 동결된 엔진뿐이고 아무도 못 건드린다. 공유 자산 디렉터리가 없다(모든 비주얼은 도형+이모지, 모든 소리는 닫힌 `SFX_IDS`). **머지 표면이 문자 그대로 0.**

**에이전트당 3종, 웨이브당 6–7 에이전트.** 게임 1개당 150–350줄. 2개는 셋업 오버헤드 낭비, 4개는 뒤의 두 개가 급해진다.

### Wave 2 — 7 에이전트 × 3 = 21종 (새 엔진 작업 0)
| | 공유 신호 | 게임 |
|---|---|---|
| A1 | 손바닥 존 히트 + 속도 게이트 | `air-whack-mole` `balloon-pop-party` `castle-defense` |
| A2 | 낙하/이동 캐치 (중력 스포너) | `shooting-star-grab` `snowball-fight` `goalkeeper-save` |
| A3 | 스윙 방향 + 경로 | `fruit-slash` `web-cut` `color-shield-block` |
| A4 | 조준/트레이스 (`steady` 필터 프리셋) | `wrist-aim-target` `wrist-maze` `connect-dots-order` |
| A5 | 뻗기 범위 + 관절간 거리 | `spider-touch` `koko-ko-touch` `max-reach-stretch` |
| A6 | 좌/우/양손 들기 + 지시 큐 | `cheer-combo` `blue-flag-white-flag` `ox-quiz-zone` |
| A7 | 스칼라 반복 카운터 | `arm-pump-inflate` `run-in-place-sprint` `bike-pedal` |

### Wave 3 — 6 × 3 = 18종 (리드가 Wave 2 리뷰 중에 `scroller` `cue` `zones` `stillness` `balance` 구현)
| | 공유 신호 | 게임 |
|---|---|---|
| B1 | 스크롤러 + 점프/스텝 | `lane-runner` `jump-rope-king` `hopscotch-zones` |
| B2 | 스크롤러 + 숙이기/기울기 | `limbo-king` `laser-corridor` `airplane-lean` |
| B3 | 큐 → 반응 윈도우 | `reflex-ridge` `ice-tag-freeze` `red-light-green-light` |
| B4 | 정지/홀드 타이머 | `statue-hold` `scan-hold-still` `flamingo-balance` |
| B5 | 균형 + 흔들림 + 무릎 들기 | `tightrope-walk` `tree-pose-yoga` `stair-climb-tower` |
| B6 | 사지 사이클 위상 + 스트로크 경로 | `swim-crawl` `sky-draw` `body-simon` |

### Wave 4 — 4 에이전트 × ~3 = 11종 (`poseSimilarity`, `jointTargets`, `audio.beat` + A/V 지연 보정 화면 선행)
| | 공유 신호 | 게임 |
|---|---|---|
| C1 | 코사인 포즈 유사도 | `pose-match-shadow` `animal-mimic` `constellation-pose` |
| C2 | 관절 타깃 커버리지 | `human-tetris` `body-hangul` `body-number` |
| C3 | 비트 스케줄러 + 판정 윈도우 | `beat-clap` `step-rhythm` `air-drums` |
| C4 | 순서 기억 + 안무 타임라인 | `move-memory-chain` `cover-dance` |

> `human-tetris`는 **세그멘테이션이 아니라 관절 타깃 변형**으로 구현한다(8개 타깃 관절의 정규화 거리합). 체감은 거의 같고 배경·조명 민감도가 사라진다.
> 포즈 타깃 라이브러리는 숨은 일정 리스크다. **아이를 녹화하지 않는다** — `synth.ts`의 `armAt(side,deg)`/`legAt`/`leanBy`로 **파라메트릭 생성**하면 타깃 포즈 하나가 선언적 기하 10줄이고, diff로 리뷰되고, 카메라 없이 튜닝된다.

### Wave 5 — 리드 + 2 에이전트, 5종, 전부 `enabled:false` 출발
전용 엔진 기능이 **그 게임에만** 필요한 것들. 그래서 마지막이다.

| 게임 | 전용 의존성 |
|---|---|
| `high-touch-jump` `mirror-the-leader` `body-rock-paper-scissors` | 2인 신원 추적 — 미러링된 프레임의 좌/우 절반을 각각 ROI 크롭해 **별도 추론 2회**(자유 `numPoses:2`가 아니라). 끈끈한 슬롯, 라운드 중 재정렬 금지, 추적 상실 시 점수 0 처리 금지(일시정지) |
| `shadow-puppet-theater` | `poseRig` — 본 가중 퍼펫 렌더러 ~200줄을 게임 1개가 쓴다. **1순위 컷 후보** |
| `photo-pose-booth` | 프레임 캡처 = 개인정보 보장과 정면충돌(`check-privacy.mjs`가 `toDataURL`/`toBlob`을 금지). **"저장되지 않는 실시간 프레임 위 스티커"로 재설계**하거나 드롭. 캡처 경로를 몰래 추가하지 말 것 |

**합계: 3 + 21 + 18 + 11 + 5 = 58종, 카탈로그의 모든 id가 정확히 한 번 배치됨.**

### 게임 에이전트 프롬프트 (모든 항목이 필수)
```
읽을 것 (순서대로, 건너뛰지 말 것):
  1. AGENTS.md
  2. src/engine/types.ts, render/renderer.ts, gestures/index.ts
  3. 당신 형태의 기준 게임: src/games/<mosquito-clap|candy-rain-catch|wave-jump>/ 전체
  4. docs/GAME_AUTHORING.md (임계값, 한글 문안 규칙, SFX_IDS 목록, 별 컷 가이드)

당신이 소유한 폴더 (이것 외엔 아무것도):
  src/games/<id-1>/  <id-2>/  <id-3>/     각각 manifest.ts, index.ts, locale.ts 만

절대 금지 (위반 시 배치 전체 반려):
  - 자기 폴더 밖 파일을 생성/수정/재포맷하지 말 것. 엔진은 동결 계약이고 sha256으로 검증된다.
  - @/engine/* 와 ./* 외 import 금지. manifest.ts는 @/engine/types 만.
  - Math.random() 금지 → ctx.rng(). Date.now() 금지 → 주어진 dt.
  - update()/render() 안에서 할당 금지. init()에서 할당할 것.
  - 원시 ctx, document, window, 이미지/음원/폰트 파일 금지. 새 사운드 id 금지.
  - 원시 랜드마크 픽셀로 임계값 잡지 말 것 — 정규화 단위(어깨너비)만.
  - 한 프레임으로 점수 이벤트를 발화하지 말 것. 임대한 Detector + 최소 250ms 쿨다운.
  - 모든 manifest는 enabled:false 로 제출. 리드가 직접 해보고 켠다.

없는 엔진 기능이 필요하면: 멈추고, 엔진에 추가하지 말고, 300줄 로컬 복사로 우회하지도 말 것.
src/games/<id>/NEEDS.md 에 필요한 신호와 이유를 쓰고, 그것 없이 가능한 가장 솔직한 버전을
구현하고, 핸드백에 명시할 것. 2명 이상이 요청한 NEEDS는 다음 웨이브에 엔진 서비스로 승격된다.

핸드백 전 검증 (4개 전부):
  npx tsc --noEmit
  npm run gate
  npx vitest run src/games/__tests__ -t "<id-1>|<id-2>|<id-3>"
  npm run shot -- <id-1> <id-2> <id-3>        # t=5s 헤드리스 스크린샷 — PNG를 직접 볼 것
```

### 웨이브별 리뷰 게이트
1. **자동**(핸드백 시점에 이미 green): tsc, boundary/frozen/asset/privacy, manifest zod, `catalog.ts` 대비 레지스트리 완결성, 게임별 리플레이 스모크 × 6클립, NaN 드로우 0, **별 컷 상식 검사**(`cuts[0]∈[0.2,0.4]`, `cuts[1]∈[0.45,0.7]`, `cuts[2]∈[0.7,0.95]` — 안 걸면 모든 에이전트가 "존재하면 3별"을 준다).
2. **diff 게이트**: `git diff --stat`에 그 에이전트 폴더만 나와야 한다. 다른 경로 → 배치 반려, 협상 없음.
3. **육안 게이트**(리드, Browser pane): id당 `?game=<id>&pose=virtual&seed=7&debug=1&skip=calib`, 키 6–10개, 스크린샷, 콘솔 에러 확인. 게임당 ~90초.
4. **승격 패스**: 모든 `NEEDS.md`를 읽고 ≥2명이 요청한 것을 엔진 서비스로 올리고 로컬 우회 코드를 삭제.
5. **활성화 패스**: 실제로 재미있고 난이도가 맞는 것만 `enabled:true`. 이것이 품질 밸브다.

### 엔진 기능 → 게임 의존 순서 (위에서 아래로 구현)
```
Renderer · fx · hud · audio.sfx · entities/spawn · rng · pose(정규화/OneEuro/외삽/보정) ──→ 58종 전부
VirtualPoseSource ───────────────────────────────────────────────────────────────────→ 58종 전부
  (카메라 없이 50개를 검증하는 수단이자, keyboardFallback:true 를 공짜로 만드는 수단)
palm + hitCircle + 속도게이트 → Wave 1~2 (22종)      clap → 4종      swing → 5종
jump → attract 상태(점프로 시작!) + 6종              squat → 4종     lean/step → 6종
raise + cue → 3종                                    repCounter → 8종
zones → 5종          scroller → Wave 3 B1,B2 (6종)   cue → Wave 3 B3,B6 (6종)
stillness → 4종      balance → 3종                   strokeMatch → 2종
poseSimilarity + PoseTarget → Wave 4 C1,C4 (5종)     jointTargets → Wave 4 C2 (4종)
audio.beat + hud.beatRing + A/V 지연 보정 → Wave 4 C3,C4 (6종)
multiPlayer 신원(2-ROI) → Wave 5 (4종)               poseRig → 1종      프레임 캡처 → 금지
```

---

## 쉘 흐름 (`src/engine/session.ts` 상태기계)

```
boot
 └─> priming        개인정보 문구. ⚑ 워밍업 A단계 시작: /wasm/* + .task 를 Cache API로
     │              프리페치(진행바). 카메라 불필요, 사용자 제스처 불필요. ~20MB —
     │              앱에서 가장 느린 작업이고, 아이가 안내문을 읽는 동안 겹쳐야 한다.
     ├─"⌨️ 카메라 없이"─> inputFallback ─> attract        (VirtualPoseSource)
     └─"🎥 카메라 켜고 시작"
          └─> prePrompt  1.2초 "곧 브라우저가 물어봐요. [허용]을 눌러 주세요 👆"
               └─> cameraRequest
                    ├─ NotAllowed/NotFound/NotReadable ─> cameraHelp ─> (재시도 | 키보드)
                    └─> warmup   ⚑ B단계 — 절대 건너뛸 수 없는 것:
                        │  capability.ts 로 티어 결정(WebGL2? SwiftShader? hardwareConcurrency)
                        │  PoseLandmarker 생성(GPU, CPU 폴백), /warmup/person.jpg 로 3회 추론
                        │  ← 랜드마크 단계 셰이더를 컴파일한다. 빈 프레임으로는 안 된다.
                        │    콜드 캐시에서 ~20초가 측정된 사례가 있다. 60초 타임아웃, 애니메이션 화면.
                        │  병렬로: SFX 합성 그래프 준비, document.fonts.ready
                        └─> calibration  4초, 게임처럼: "선을 맞춰 서 볼까요?"
                            │  첫 10프레임 폐기, ~60프레임 중앙값 → CalibrationProfile
                            │  (shoulderW, standHipY, reachUpY, squatHipY, floorY, armSpan)
                            │  발목 가시성 < 0.5 → "발이 보이게 뒤로 가 볼까요?"
                            └─> safety  15초, 첫 기립 게임 전: 2m 공간, 물건 치우기
                                 └─> attract ◀──────────────────────────────────┐
                                      │  "점프하면 시작!"                      │
                                      └─> roulette                             │
                                           │  당첨을 먼저 결정, pickPool()에서  │
                                           │  8개 숏리스트, CSS 휠 3.4초,       │
                                           │  경계 통과마다 틱 SFX, 25% near-miss│
                                           └─> intro                           │
                                                │  nameKo 슬램인 + howToKo +    │
                                                │  VirtualPoseSource가 구동하는  │
                                                │  제스처 시범 루프(영상 자산 0) │
                                                │  ⚑ registry.load(id) 해결 지점 │
                                                └─> countdown 3·2·1 (오디오 클럭)│
                                                     └─> play ⇄ paused          │
                                                          └─> results ★ ────────┘
                                                               ├─> breakPrompt (8게임/10분)
                                                               └─> partySummary
```

**점프로 시작 — 게임과 같은 디텍터, 더 엄격한 프리셋.** 쉘에 별도 점프 코드는 없다.
```ts
const jump = gestures.use('jump', {
  enter: 1.9,        // 게임의 1.5보다 높게: 오발이 미검출보다 짜증난다
  exit: 0.6, cooldownMs: 900, confirmFrames: 2,
  requireFeetVisible: false,    // 노트북 앞에선 발이 잘려 있는 게 보통이다
});
```
사람이 **0.45초** 동안 존재·기립해야 버튼이 장전되고(채워지는 링으로 표시), 지나가는 교사나 의자가 게임을 시작시키지 않는다. 막다른 길은 없다 — `Space`, 클릭/탭, 25초 후 "스페이스바를 눌러도 돼요". `attract` 화면은 스켈레톤 오버레이를 낮은 알파로 띄워 **"카메라가 보는 건 정확히 이것뿐"**을 보여준다 — 아이 뒤에 선 보호자에게 개인정보 문구를 믿게 만드는 유일한 수단이다.

롤렛: `crypto.getRandomValues` + rejection sampling으로 **당첨을 먼저 뽑고**, 셔플백으로 반복을 막고, 그 다음 CSS `transform: rotate()` 한 줄로 애니메이션한다. `sliceUnderPointer(targetRotation(i,n,cur)) === i` 역검증 assert를 dev에 넣는다. 58개를 다 올리지 않고 **8개만 숏리스트**한다(40칸 휠은 읽을 수 없고 "저거 싫어" 비율이 올라간다). `prefers-reduced-motion`이면 450ms 크로스페이드.

---

## 검증 전략 — 카메라 없이 58종

프로젝트가 여기서 결정된다. 50개 게임을 50번의 카메라 세션으로 검증할 수는 없다.

| 층 | 도구 | 잡아내는 것 |
|---|---|---|
| L1 디텍터 단위 | Vitest + `synth.ts` | 잘못된 임계값, 이중 발화, 스케일·fps 비불변성 |
| L2 정적/매니페스트 | Vitest + zod + scripts | id 드리프트, index 누락, 경계 위반, 별 컷 인플레, 게임 누락 |
| L3 리플레이 스모크 | Vitest + 합성 클립 | 크래시, NaN, 도달 불가 점수, 유령 점수, 누수 |
| L4 시각/조작 | Browser pane + `VirtualPoseSource` | 실제로 재미있는가, 레이아웃, 한글, HUD, 연출 |

### 합성 관절 스트림 (`src/engine/testing/synth.ts`)
사용자 결정에 따라 **녹화 없이** 전량 생성한다. 파라메트릭 기립 스켈레톤을 만들고 선언적 키프레임으로 포즈를 잡는다:
```
idle · fidget · reach-grid(양손이 화면 전체를 래스터 스윕 ← 마법의 클립: 리치/캐치/조준/존
계열 ~25개 게임이 도달성 테스트를 공짜로 얻는다) · jump-x8 · squat-x8 · clap-x12 ·
swing-wide · step-lr · knee-run · hold-poses · two-cross(신원 스왑 회귀) · far-small(어깨너비
0.07 — 스케일 회귀)
```
합성의 약점(실제 사람의 떨림·가림)은 **노이즈 주입**으로 보완한다: 가우시안 지터, 랜덤 가시성 하락, 프레임 드롭아웃, 가변 fps(12/25/60). 이것 없이 통과한 디텍터는 교실에서 터진다. 남는 리스크는 실제 플레이로만 확인 가능하므로 Wave 3 이후 실기기 세션에서 메운다.

### 전 게임 스모크 (`src/games/__tests__/all-games.smoke.test.ts`)
게임당 4종 검사: ① 6개 클립에서 crash/NaN/빈 화면/할당 증가 없음, ② **자기 클립에서 점수 > 0**(죽은 게임 방지), ③ **idle에서 점수 < 0.15**(유령 점수 방지), ④ 같은 시드 → 같은 점수(결정성). `runGame`이 진짜 생애주기를 고정 타임스텝으로 돌린다(40초 게임 = 2400스텝 ≈ 30ms CPU). **58게임 × 9 assertion이 1분 미만** — 그래서 야간 작업이 아니라 에이전트의 핸드백 전 게이트가 될 수 있다.

`NullRenderer`는 테스트 스위트에서 가치 대비 가장 높은 80줄이다: `Renderer`를 구현하고, 비유한 좌표에서 throw하고, 프레임당 op를 세고, `[-w,2w]×[-h,2h]` 밖 드로우를 잡는다(화면 밖으로 영원히 나간 버그는 "빈 게임"처럼 보인다).

### Browser pane 검증
`?game=<id>&pose=virtual&seed=7&debug=1&skip=calib&dur=12&replay=<clip>`
```
mcp__Claude_Browser__preview_start({ name: 'mini-game' })
mcp__Claude_Browser__browser_batch([ navigate, key 'space', key 'z x z x c' ×4, screenshot ])
mcp__Claude_Browser__read_console_messages({ onlyErrors: true })
mcp__Claude_Browser__javascript_tool({ text: "window.__mg.debug()" })
```
`window.__mg`(DEV 전용)가 `debug()`, `setState()`, `forceGesture()`, `screenshotAt(ms)`를 노출해서 `npm run shot -- <ids>`를 에이전트가 직접 돌릴 수 있게 한다. `?debug=1` 오버레이는 선택이 아니다 — 디텍터별 바에 enter/exit 선과 발화 플래시, 추론 fps/렌더 fps/`inferenceAgeMs`, 보정값, 시드를 띄운다. 이것 없이는 아무도 임계값을 튜닝할 수 없고, 교실 PC 진단도 이걸로 한다. 웨이브마다 `resize_window({preset:'tablet'})`과 `colorScheme:'dark'`를 한 번씩 확인한다(10-foot 타입 스케일과 다크 캔버스가 조용히 깨지는 두 지점).

### 실기기로만 가능한 것 (Wave 3 이후 반일)
가장 오래된 학교 크롬북 / 베이스 iPad Safari / 하드웨어 가속을 **끈** 윈도우 노트북(SwiftShader 경로를 의도적으로 타기). 측정: 학교 와이파이 콜드 로드, 워밍업 정지 시간, `lite×1` 정상 fps, `numPoses:2` vs 2-ROI 크롭 승자, 리듬 게임 기본 오프셋을 정하는 A/V+포즈 지연값.

---

## 디자인 시스템

프로젝트에 `DESIGN.md`가 없으므로 Phase 0에서 `DESIGN.md` + `src/styles/tokens.css`를 생성한다. 방향: **중성 쿨톤 서피스 + 채도 높은 색은 (a)주요 액션과 (b)보상에만 + 거대한 타입 + 눌리는 입체 버튼 + 100ms 내 피드백 + 모든 성공을 과장.** 게임마다 `manifest.theme.hue` 하나만 받아 카드와 인게임 액센트를 틴팅한다 — 58개 게임이 58개 팔레트 없이 서로 달라 보이는 방법이다.

- **컬러**: primary `#4C6FFF`(일렉트릭 블루, 액션/포커스), secondary `#A259FF`, accent `#FFB300`(별·보상, 픽셀의 5% 미만, **흰 글자 절대 금지** → `--c-on-accent: #3A2600`), success `#16C47F`, danger `#FF4D4D`. 라이트 캔버스 `#F5F7FD` / 서피스 `#FFFFFF` / 텍스트 `#131A33`(16.1:1). 다크 캔버스 `#0B0F20` / 서피스 `#151B33` / 텍스트 `#F2F5FF`. **인게임 캔버스는 두 모드 모두 다크(`#101733`)** — 파티클·글로우·스켈레톤이 일관되게 읽히고 카메라 프리뷰가 UI를 날려버리지 않는다.
- **플레이어 색**(P1 `#2FA8FF` / P2 `#FF7A45` / P3 `#39D98A` / P4 `#C77DFF`)은 **색만으로 구분하지 않는다** — Kahoot 규칙대로 색 + 도형 배지(▲◆●■) + 슬롯 번호 + 3px 외곽선.
- **타입**: Pretendard Variable 1.3.9(OFL, 자체 호스팅) + 디스플레이는 Gmarket Sans Bold. `html { font-size: clamp(16px, 0.55vw + 0.45vh + 9px, 28px) }`로 13인치 노트북 0.6m와 거실 TV 3m를 한 스케일로 커버. **2m 거리 가독성 하한 24px**, 아이가 반응해야 하는 것은 ≥34px/700. 한국어 전용 규칙 두 가지가 폰트 선택보다 중요하다: `word-break: keep-all`(기본값은 어절을 쪼개 깨져 보인다), 본문 `line-height ≥ 1.5`. 모든 카운터에 `tabular-nums`.
- **눌림 깊이**: Duolingo 트릭 — `box-shadow: 0 6px 0 <darker>` + `:active { transform: translateY(6px) }`. 6줄로 "아이용 게임 UI 느낌"의 대부분이 나온다.
- 터치 타깃 56px(주요 72px, 로비 카드 96px). `prefers-reduced-motion`은 토큰으로 처리하고 **인앱 토글 "화면 효과 줄이기"도 제공**한다(아이들 기기에 OS 설정이 켜져 있는 경우는 거의 없는데, 이 설정이 가장 필요한 대상이다). WCAG 2.3.1 — 전체 화면 플래시는 초당 3회 상한을 **엔진의 `fx.flash()`가 강제**해서 58명의 저자가 각자 틀릴 수 없게 한다.

**오디오(결정됨): 코드 합성.** `audio/synth.ts`가 오실레이터+노이즈로 틱/팝/박수/팡파레/삑을 만든다 — 외부 파일 0개, 라이선스 문제 0개, 번들 증가 0. 음성 안내는 **모두 큰 한글 텍스트로 미러링**하고 `speechSynthesis` ko-KR은 설정에서 켤 수 있는 보조 기능으로만 둔다(기기별 품질 편차가 크다). 리듬 게임은 Web Audio `currentTime` 기준 lookahead 스케줄러로 노트를 예약한다 — **rAF에 의존하면 안 된다**. 오디오는 절대 필수 경로가 아니다: 모든 비트 큐에 시각 펄스 링이 있다.

---

## 개인정보·안전 (문구가 사실이 되게 만드는 엔지니어링)

- CSP `connect-src 'self'` — 외부 유출이 **증명 가능하게 불가능**. 그래서 폰트·wasm·모델을 자체 호스팅해야 한다.
- `Permissions-Policy: camera=(self), microphone=()`. 서드파티 스크립트 0개, 분석 도구 0개.
- `MediaRecorder` / `canvas.toBlob` / `toDataURL`이 번들에 나타나면 CI 실패. **랜드마크 배열을 어디에도 저장하지 않는다**(개정 COPPA에서 생체 식별자는 명시적으로 개인정보이고, 한국 개인정보보호법상 얼굴·생체인식정보는 민감정보다 — 그래서 **FaceLandmarker를 쓰지 않고 포즈 랜드마크만** 쓴다. 논쟁이 시작되기 전에 제거한다).
- `track.stop()`을 모든 종료 경로에서. 항상 보이는 `🔴 카메라 켜짐 · [끄기]` 칩.
- `localStorage`는 `mg:` 네임스페이스(별명·최고점수·설정만)와 "전체 삭제" 버튼 하나.
- 아이용/보호자용 한글 안내문을 초등 3–4학년 수준으로 작성(개인정보보호법 제22조의2 ③이 만 14세 미만 대상 고지에 "이해하기 쉬운 양식과 명확하고 알기 쉬운 언어"를 요구한다). 계정·업로드·분석 도구가 하나도 없으므로 별도 동의 절차가 발생하지 않지만, 이 자세는 **설계상 깨지기 쉽다** — 온라인 리더보드, 스크린샷 공유, 지속 식별자를 쓰는 분석 도구 중 하나만 추가해도 무너진다. 위키 문서가 아니라 lint 규칙으로 박아둔다.
- 안전: 첫 기립 게임 전 15초 안내(2m 공간, 물건 치우기, 미끄러운 바닥). 스케줄러 제약 — `intensity:3`을 3연속 금지, 고강도 2개마다 `seated`/`intensity:1` 하나 삽입, 8게임 또는 10분마다 휴식 프롬프트. 30–60초 세션 제한 자체가 최고의 안전장치다.

---

## 리스크와 컷 라인

| 리스크 | 완화 | 그래도 터지면 |
|---|---|---|
| **20MB 콜드 로드**(14.7MB wasm + 5.8MB 모델) | 자체 호스팅 + Brotli + immutable + Cache API + 개인정보 화면 중 프리페치, PWA 프리캐시로 2회차 즉시 | 20초 초과 시 키보드 모드를 제안하고 백그라운드 로딩 계속 |
| **지연 셰이더 컴파일이 첫 라운드를 멈춤**(콜드 캐시 ~20초 측정 사례) | `warmup` 상태에서 사람 이미지로 3회 추론, 60초 타임아웃, **절대 멈춘 화면이 아닌** 애니메이션 | 워밍업 해결 전에 카운트다운을 시작하지 않는다 |
| **하드웨어 가속 OFF → SwiftShader → ~10fps** (잠긴 학교 PC에서 흔함) | `capability.ts`가 `UNMASKED_RENDERER_WEBGL`을 읽어 480×360 + `numPoses:1` 강제 | 5초간 fps<12면 원터치 키보드 모드, `intensity:3` 전부 비활성 |
| **2인 신원 스왑** (모델 카드가 다중 인물을 out of scope로 명시) | 1인 기본, 대결은 좌우 ROI 2회 추론, 끈끈한 슬롯, 추적 상실 시 점수 0 대신 일시정지 | 대결 4종 `enabled:false` 유지 |
| **리듬 게임이 깨진 느낌** (포즈 지연 + 블루투스 스피커 지연 + 7살) | 아이용 윈도우 ±60/120/200ms, 모든 동작 판정에서 `inferenceAgeMs`+필터 지연을 차감, A/V 보정 화면, 항상 시각 비트 링 | 보정 화면이 늦어지면 리듬 6종 `enabled:false` — 보정 안 된 리듬 게임은 없는 것보다 나쁘다 |
| **iPad 홈화면 PWA 카메라 데드락** (WebKit #252465, iOS 18.5까지 보고) | 일반 Safari 탭으로 배포, 설치 프롬프트 억제, `visibilitychange`에서 재획득, `track.muted` 감시 | 교사용 안내문에 미지원으로 명기 |
| **에이전트가 엔진을 수정** (조용히 20개 게임을 깨뜨림) | `check-frozen.mjs` sha256 + diff 경로 게이트 + 명시적 `NEEDS.md` 탈출구 | 배치 전체 반려. 고고학보다 싸다 |
| **모두가 3별을 준다** (저자 58명, 난이도 곡선 58개) | 엔진이 `starCuts`로 별을 계산, 테스트가 컷 범위를 검증, 리플레이가 평범한 클립의 점수를 보고 | 활성화 패스에서 리드가 컷만 재조정 — 매니페스트 1줄, 코드 변경 없음 |
| **58개는 다듬을 수 있는 양을 넘는다** (진짜 리스크) | 출시 시점 **~34개 활성** 목표, 나머지는 레포에 `enabled:false` | 아래 컷 순서 |

**컷 순서** (삭제가 아니라 `enabled:false`. 코드는 계속 컴파일되고 리플레이를 통과하고 룰렛 풀에서만 빠지며 `?all=1`로 나중에 튜닝 가능하다):
1. **게임 1개를 위한 전용 엔진**: `shadow-puppet-theater`(poseRig), `photo-pose-booth`(금지된 캡처), `cover-dance`(안무 타임라인)
2. **대결 4종**: `high-touch-jump`, `mirror-the-leader`, `body-rock-paper-scissors`, `snowball-fight` 2P
3. **리듬 6종** (비트 스케줄러나 지연 보정이 늦어지면)
4. **글리프 3종**: `body-hangul`, `body-number`, `human-tetris` (글자/숫자별 타깃 라이브러리 비용이 재미 대비 높다)
5. **유사도 계열**: `pose-match-shadow`, `animal-mimic`, `constellation-pose`, `tree-pose-yoga`
6. **게임보다 오디오 폴리시를 먼저 컷.** 무음은 생존 가능하다(모든 음성이 화면 텍스트로 미러링, 모든 비트 큐에 시각 펄스). 빠진 시각 큐는 생존 불가능하다.

**어떤 경우에도 컷하지 않는 12종** (좌식/기립, 4개 메커닉 패밀리, 강도 1–3을 커버하고 Wave 2 이상의 서비스가 필요 없음):
`mosquito-clap` · `candy-rain-catch` · `air-whack-mole` · `balloon-pop-party` · `fruit-slash` · `wrist-aim-target` · `spider-touch` · `max-reach-stretch` · `cheer-combo` · `wave-jump` · `limbo-king` · `scan-hold-still`

---

## 검증 (엔드투엔드 수동 확인 절차)

1. `npm install && npm run dev` → `mcp__Claude_Browser__preview_start({ name: 'mini-game' })`
2. **카메라 없는 전체 흐름**: `?pose=virtual` 로 priming → attract → 룰렛 → 인트로 → 카운트다운 → 플레이 → 결과까지 키보드로 완주. 콘솔 에러 0.
3. **점프로 시작**: `?pose=virtual`에서 `Space`가 `attract`의 jump 디텍터를 발화시켜 룰렛으로 넘어가는지. `?debug=1`로 jump 디텍터 바가 enter 선을 넘는 순간 발화 플래시가 뜨는지.
4. **룰렛 정합성**: dev assert `sliceUnderPointer(targetRotation(i,n,cur)) === i`가 100회 랜덤 입력에서 통과. 휠이 멈춘 칸의 게임이 실제로 로드되는 게임과 같은지.
5. **자동 테스트**: `npm run gate` — tsc, 4개 경계/동결/자산/개인정보 스크립트, 58게임 × 9 assertion 리플레이 스모크가 1분 미만에 green.
6. **반응형·테마**: `resize_window({preset:'tablet'})`, `colorScheme:'dark'`에서 10-foot 타입 스케일과 다크 인게임 캔버스 확인.
7. **실제 카메라**(사용자 기기): priming → 권한 허용 → 워밍업(사람 이미지 3회 추론) → 4초 보정 → attract에서 실제 점프로 시작 → 게임 3종 플레이. `?debug=1`의 추론 fps / 렌더 fps / `inferenceAgeMs`를 기록해 리듬 게임 기본 오프셋을 정한다.
8. **개인정보 감사**: `npm run build` 후 `check-privacy.mjs`가 `dist/`에서 `toDataURL|toBlob|MediaRecorder|fetch(http`를 0건으로 보고. 네트워크 탭에 자기 오리진 외 요청 0건.

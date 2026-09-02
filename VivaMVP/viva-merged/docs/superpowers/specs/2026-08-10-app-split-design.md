# 앱 분리 — 폰 단독판 / 디바이스 연동판 (App Split)

- 날짜: 2026-08-10
- 상태: 설계 확정, 구현 계획 대기
- 선행 지도: 이 문서의 수치는 2026-08-10 모드 얽힘 실측 조사 기준 (branch tip `1f534fb`)

## 결정된 제품 정의

**스마트폰 앱 2개.** 하나의 앱이 런타임 토글로 두 모드를 오가는 현 구조를 버린다.

| | 폰 단독판 (체험판) | 디바이스 연동판 |
|---|---|---|
| 정체 | 폰 혼자 서비스 체험. 폰이 곧 비바 | 라즈베리파이 "비바"와 연동해 체험 |
| 눈 | 폰 화면 (`EyeAnimation`) | 파이 HDMI 패널 (`eyes.py`) — **앱 내 눈 삭제** |
| 마이크/스피커 | 폰 | 파이 전용. **음성 폰 폴백 없음** |
| 카메라 | 폰 | 파이 우선, **촬영만 폰 폴백** (재촬영·크롭 포함) |
| 파이 끊김 시 | 개념 없음 | 재연결 대기 + 세션 종료만. **앱 모드 탈출구 삭제** |
| 모드 토글 | 없음 | 없음 |

미리 답해둔 정책:
- 파이 끊김 중 디바이스 앱은 잠금 — 폰 마이크·스피커로 이어가지 않는다(기존 D-46 정책 유지). `DisconnectOverlay` 는 "앱 모드로 계속" 버튼만 제거하고 유지.
- 원형 MVP(`comparison_repos/leeyunseok_viva`)의 mic-first 흐름(IntentScreen, 사진 없는 개념 질문)은 **이번 범위 아님** — 분리 완료 후 폰 앱 전용 기능으로 별도 사이클. 그 저장소는 현 저장소 initial commit 의 사본이라(45/57 파일 바이트 동일, 323커밋 뒤처짐) 코드 재사용은 불가, 설계 참조만 가능하다.

## 왜 이 구조인가 — 실측 요약

- 튜터링 두뇌(FSM 2,170·Gemini 743·판서 1,185·TTS 394·세션기록 2,008·utils 등) ≈ **8,400줄, 전체의 60%가 공용**이다. 두 벌 관리는 FSM 버그를 두 번 고치는 짓이라 기각. → **한 저장소, 공용 코어 + 앱 셸 2개.**
- "폰 전용" 코드는 사실상 2파일(~400줄): `EyeAnimation`, `MicLevelIndicator`. `CameraScreen`(957줄)·`useVoiceInput`·웨이크워드 ONNX 는 디바이스 모드도 쓴다.
- 진짜 작업은 삭제가 아니라 **라우팅 풀기**: `App.tsx`(441줄, 분기 10+드릴 6)와 `ConversationScreen.tsx`(1,130줄, 분기 12)에 mode 분기가 뭉치지 않고 흩어져 있다.
- FSM 은 안 쪼갠다. `photoSource === 'pi'` 9군데는 이미 주입 prop(`fetchPiPhotoFn` 등)으로 게이팅돼 있다 — 폰 앱은 안 넘기면 분기가 죽고, 디바이스 앱은 촬영 폰 폴백을 유지하므로 그대로 쓴다.

"아예 삭제해도 된다"의 성립 방식: **Metro 는 엔트리에서 import 그래프를 탄다.** 폰 엔트리가 `src/device/` 를 한 번도 import 하지 않으면 그 코드는 폰 번들에 물리적으로 없다. 파일 삭제가 아니라 그래프 절단으로 달성한다 — 공용 코어를 복제하지 않는 대가다.

## 디렉터리 구조

이동은 **배타 파일만** (13파일 + 신규 엔트리). 공용 8,400줄은 제자리 — 대량 이동은 병렬 세션과의 충돌만 키운다.

```
viva-merged/
  App.phone.tsx            신규 - 폰 셸 (현 App.tsx 에서 device 경로 제거)
  App.device.tsx           신규 - 디바이스 셸 (현 App.tsx 에서 app 경로 제거)
  index.js                 APP_VARIANT 로 엔트리 선택 (babel alias, 아래 참조)
  app.config.js            app.json 대체 - APP_VARIANT 로 이름·bundleId·권한 분기
  src/
    phone/                 폰 전용: EyeAnimation, MicLevelIndicator,
                           screens/HomeScreen.tsx, screens/ConversationScreen.tsx
    device/                디바이스 전용: piBridge, connectionMonitor, eyeSync,
                           piWakeStream, usePiConnection, DeviceVitals,
                           ConnectionGuideCard, ConnectionStatusChip, DisconnectOverlay,
                           screens/HomeScreen.tsx, screens/ConversationScreen.tsx
    screens/               공용 화면: CameraScreen, HistoryScreen, SessionDetailScreen
    components/ services/ hooks/ utils/ …  공용 그대로
  pi-server/               디바이스 전용 (변화 없음)
```

`ModeToggle` 삭제 (양쪽 다 불필요). `useAppMode` 삭제.

엔트리 선택: `babel.config.js` 가 `process.env.APP_VARIANT` 를 읽어 module-resolver alias 로 `App.phone`/`App.device` 를 잇는다. 런타임 분기가 아니라 transform 시점 분기라 죽은 그래프가 번들에 안 들어간다. 변형 전환 시 번들러 재시작 필요(캐시 주의). 검증은 프로덕션 번들 출력에서 `piBridge` 문자열 부재 확인으로 한다.

## 단계 — 각 단계가 끝나도 동작하는 앱이 남는다

### 1단계: 의존성 뒤집기 + 배타 파일 이동

단일 앱·모드 토글 그대로. 기존 테스트가 그대로 통과해야 한다.

공용 파일이 디바이스 모듈을 정적 import 하는 곳을 전부 주입으로 뒤집는다 (FSM 이 이미 쓰는 패턴):

| 파일 | 현재 | 전환 |
|---|---|---|
| `useAppState.ts:67` | `eyeSyncService.sendEyeState` 직접 호출 | 상태 전이 리스너 콜백 — 디바이스 셸이 등록 |
| `tts.service.ts` | 모듈 전역 `robotSpeaker` + `playAudioOnPi` import | `setAudioSink({play, stop})` 주입 — 디바이스 셸이 파이 싱크 등록, 폰은 안 부름 |
| `useVoiceInput.ts` | `robotMic` 분기가 piBridge 직접 import | 파이 녹음 함수들을 옵션 주입 (FSM 의 `fetchPiPhotoFn` 패턴) |
| `useWakeWord.ts` | 이미 `piStream` 파라미터 주입 | 그대로 |

그 후 배타 13파일을 `src/phone/`·`src/device/` 로 이동, import 경로 갱신.

완료 판정: 전체 스위트 통과 + 공용 코드(`src/` 에서 phone/device 밖)에 `src/device` import 0건 (`grep` 으로 확인, 이후 eslint `no-restricted-imports` 로 고정).

### 2단계: 셸 가르기 — 가장 위험한 단계

`App.tsx` → `App.phone.tsx` + `App.device.tsx`, `ConversationScreen`·`HomeScreen` → 변종 2개. 여기서 소멸하는 개념: `mode`·`appMode`·`modeRef`·`robotAudio`·`robotMic`·`robotSpeaker`·`disconnected`(폰 쪽)·`showEyes` prop(값이 상수가 되므로 prop 자체 제거).

| 갈래 | 폰 셸 | 디바이스 셸 |
|---|---|---|
| App 의 mode 효과(152), wake 라우팅(170,350), beginCapture 파이 경로(263-317) | 삭제 | 상수화 |
| ConversationScreen `disconnected`(114,207,337,378,919,951) | 삭제 | 유지, `onSwitchToAppMode` 만 제거 |
| HomeScreen | 눈 + PTT (원형 MVP 레이아웃) | **`DeviceVitals` 배선** — 여기서 F1(연결 엣지 오탐) 디바운스 필수, device-vitals 스펙 정정 절 참조 |
| DisconnectOverlay | — | "앱 모드로 계속" 버튼 제거 |

공용 화면(`CameraScreen`·`BoardView`·`ProcessingView`·`CharacterView`)의 `showEyes` prop 은 유지하되 셸이 상수로 넘긴다 — 화면 포크를 피하는 최소 변경.

세션 페이로드·기록 포맷은 안 건드린다 (`photoSource` 필드 포함 — 디바이스 앱이 계속 쓴다).

### 3단계: 빌드 갈래

- `app.json` → `app.config.js`. `APP_VARIANT=phone|device` 로:
  - 이름/slug/아이콘 분리, **bundleId: 디바이스 = `com.vivamvp.app`(기존 유지), 폰 = `com.vivamvp.phone`** — 두 앱 동시 설치 가능
  - 폰 빌드에서 로컬넷 권한 삭제: `NSLocalNetworkUsageDescription`·`NSBonjourServices`·`viva.local` ATS 예외·`usesCleartextTraffic`
- 커밋된 `android/`·`ios/`(82파일)를 버리고 prebuild 로 전환. **선행 필수: `npx expo prebuild` 재생성본과 커밋본을 diff 해 수동 네이티브 수정이 있는지 확인** — 있으면 config plugin 으로 옮긴 후에야 삭제. `patches/` 3개는 node_modules 패치라 prebuild 와 무관.
- `.env` 는 공용 유지 — `EXPO_PUBLIC_PI_*` 3개는 디바이스 그래프만 참조하므로 폰 번들에 안 들어간다.

## 테스트

- 한 jest 스위트로 양쪽 다 돈다(파일은 전부 존재하므로).
- 소멸: `useAppMode.test.ts`, `HomeScreen.modes.test.tsx`, `connectionUi.test.tsx` 의 ModeToggle 블록.
- 분리: `ConversationScreen.test.tsx`(538줄, 1/3 이 디바이스 조건부) → 변종별 파일. `useVoiceInput`·`tts.service` 의 robot 케이스 → 주입 계약 테스트로 전환.
- 신규: 폰 셸이 `src/device` 를 그래프에 안 들이는 것(번들 검증 스크립트 또는 eslint), 디바이스 홈의 DeviceVitals 렌더.

## 열어둔 것 (이번 범위 아님)

- mic-first(IntentScreen) 재구현 — 폰 앱 전용, 분리 후.
- F1 실수정(wake.py 가 서비스 수명 동안 마이크를 쥐게) — 디바이스 셸 배선에서 디바운스로 우선 대응.
- `tools/e2e-loop` 의 piBridge 직접 import — 디바이스 전용 하네스로 남는다. 분리 후 폰 전용 E2E 는 별도 판단.
- 스토어 배포 체계(EAS 등) — 두 앱이 실기기에서 동시 설치·구동되는 것까지가 이번 목표.

## 위험

- **병렬 세션.** 1단계의 파일 이동·import 갱신은 미커밋 작업과 충돌한다. 시작 전 다른 세션 커밋 상태 확인 필수 (지금도 `HomeScreen.tsx` 미커밋 변경이 있고, 그 세션이 호출어 문구를 바꾸는 중 — `HomeScreen.modes.test.tsx` 실패 1건도 그쪽 몫).
- **prebuild.** 커밋된 네이티브에 수동 수정이 숨어 있으면 날아간다. 3단계 선행 diff 가 안전판.
- **셸 가르기 회귀.** 2단계는 1,780줄을 두 변종으로 찢는다. 변종별 스모크(웨이크→촬영→대화 한 턴)를 실기기에서 각각 돌려야 한다.

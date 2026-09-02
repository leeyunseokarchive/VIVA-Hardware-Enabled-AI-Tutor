# 디바이스 모드 홈 — 마이크·스피커 상태 표면화 (Device Vitals)

- 날짜: 2026-08-10
- 상태: 설계 확정, 구현 계획 대기

## 문제

디바이스 모드 홈에서 사용자가 알 수 있는 건 "비바와 연결됐다"뿐이다. 연결은 됐는데
마이크 배선이 빠졌거나 `viva-silence`(앰프 무음 스트림)가 죽어 스피커 경로가 끊긴
경우, 화면은 초록 점을 띄운 채 정상인 척한다. 사용자는 "비바야"를 여러 번 부르고
나서야 뭔가 잘못됐다는 걸 안다.

부차적으로, 상단 알약 3개(ModeToggle · ConnectionStatusChip · SolveModeToggle)가
전부 같은 서피스·테두리·반경이라 **누르는 것**과 **읽는 것**이 시각적으로 구분되지
않는다. ConnectionStatusChip 은 `left: 132` 하드코딩이라 라벨이 길어지면 ModeToggle
과 겹친다. 여기에 칩 2개를 더 얹으면 문제가 커진다.

## 범위

- 대상: **디바이스 모드 홈 화면**(`HomeScreen`, `mode === 'device'`)과 그 데이터 경로.
- 대상: 상단 `ModeToggle` 의 `SolveModeToggle` 문법 통일 (아래 "상단 컨트롤 통일").
  `ModeToggle` 은 APP 모드 홈에도 뜨므로 이 변경은 두 모드에 함께 걸린다.
- 비대상: APP 모드 홈의 나머지, ConversationScreen, 하단 컨트롤(마이크·기록 버튼)
  디자인, 전역 타이포/컬러 시스템 개편.

## 판정 방식 — 왜 얕은 체크인가

능동 프로브(짧게 녹음해 RMS 확인)는 **불가능**하다. `asound.conf` 의 `micboost` 는
`plughw:0` 직결(softvol)이라 **캡처가 배타적**이고, 유휴 상태에서 그 장치는
`wake.py` 의 `arecord` 가 쥐고 있다. 프로브를 시도하면 `-EBUSY` 로 실패해 멀쩡한
마이크를 고장으로 오판하거나, 마이크를 뺏어 호출어 감지를 죽인다.

반면 재생은 `dmixout`(dmix, `ipc_key 1024`)이라 공유 가능하고, `viva-silence.service`
의 `aplay -D dmixout /dev/zero` 가 영구히 한 스트림을 물고 있다.

> **정정(구현 후 재검토):** 아래 표의 "`viva-wake` 죽음" 근거 설명은 원래 "유휴
> 상태의 캡처는 wake.py 가 영구히 쥐고 있다"고 적었으나, 이는 사실이 아니다.
> `wake.py` 의 `_start_capture()` 는 `subscribe()` 안에서만 불리고, 마지막 WS
> 클라이언트가 나가면 `disconnect()` 가, 일시정지 때는 `pause()` 가 캡처를
> 놓는다 - 즉 캡처 서브스트림은 **폰이 wake 릴레이를 구독 중일 때만** 열려
> 있다. `mic_ok` 가 실제로 증명하는 건 "wake 릴레이가 지금 마이크를 쥐고
> 있다"이지 "마이크가 살아있다"가 아니다. 둘은 폰이 idle 화면에서 구독 중일
> 때만 같다.

따라서 판정은 **장치를 열지 않고 `/proc/asound` 를 읽는 것만으로** 한다. 부작용 0,
subprocess 0, 5초마다 쳐도 부담 없음.

| 신호 | 근거 | 잡아내는 고장 |
|---|---|---|
| 사운드카드 존재 | `/proc/asound/card{N}` 디렉터리 | I2S 오버레이 미적용, 카드 인식 실패 |
| 캡처 서브스트림 열림 | `pcm*c/sub0/hw_params` 내용이 `closed` 아님 | `viva-wake` 죽음, `arecord` 즉시 사망(마이크 모듈·배선 불량) |
| 재생 서브스트림 열림 | `pcm*p/sub0/hw_params` 내용이 `closed` 아님 | `viva-silence` 죽음, 앰프 경로 단절 |

> 이 판정은 "마이크에서 실제로 소리가 들어온다"를 증명하지 않는다. 게인 리셋이나
> 마이크 모듈이 살아있되 무음인 경우는 못 잡는다. 그건 실측 셀프테스트가 필요하고,
> 배타 캡처 제약 때문에 이번 범위에서 제외했다.

### 캡처 핸드오프 공백 — sticky 10초

호출어 감지 후 폰은 `pause`(wake.py 의 `arecord` 종료 후 `paused` 응답) → `/record/start`
(app.py 의 `arecord` 시작) 순으로 진행한다. 그 사이에 **아무도 마이크를 쥐지 않는
순간**이 있다. 5초 폴링이 그 틈에 떨어지면 정상 마이크가 고장으로 뜬다.

해결: Pi 가 캡처가 열린 것을 마지막으로 관측한 시각을 기억하고, 10초 안이면 정상으로
본다.

```
mic_ok = card_present and (capture_open or _rec_state["recording"] or (now - last_capture_open) < 10)
```

## A. Pi — `/health` 확장

`app.py` 의 `/health` 응답에 필드 2개를 추가한다. 기존 필드·의미는 그대로.

```json
{
  "status": "ok",
  "recording": false,
  "record_device": "micboost",
  "play_device": "dmixout",
  "mic_ok": true,
  "speaker_ok": true
}
```

구현 메모:

- 카드 인덱스는 `VIVA_SOUND_CARD`(기본 `0`) 환경변수로 덮어쓸 수 있게 한다. 오디오
  구성이 바뀌면(USB 동글 등) 카드 번호가 달라진다 — 기존 `VIVA_RECORD_DEVICE`/
  `VIVA_PLAY_DEVICE` 와 같은 성격의 캘리브레이션 노브.
- 서브스트림 경로는 `pcm0c` / `pcm0p` 로 고정하지 말고 `card{N}/pcm*c/sub*/hw_params`
  글롭으로 찾는다. 하나라도 열려 있으면 열린 것으로 본다.
- "열림"의 정의: `hw_params` 파일을 읽어 내용이 정확히 `closed`(개행 포함)가 **아니면**
  열림. 아무도 안 열었을 때 ALSA 는 이 파일에 `closed\n` 을 쓴다. 열려 있으면
  `format:`, `rate:` 등 파라미터 덤프가 들어온다.
- 읽기 실패(파일 없음·권한·IOError)는 예외를 삼키고 "닫힘"으로 취급한다. `/health`
  는 절대 500 을 내면 안 된다 — 연결 판정 자체가 이 엔드포인트에 걸려 있다.
- `last_capture_open` 은 모듈 전역 float. `/health` 가 캡처 열림을 관측할 때마다 갱신.

`pi-server/README.md` 에 새 필드와 `VIVA_SOUND_CARD` 를 한 문단으로 기록한다.

## B. 앱 — 상태 전달 경로

기존 5초 폴링에 업는다. **새 폴러·새 타이머 없음.**

1. `piBridge.service.ts`: `checkPiConnection(): Promise<boolean>` 을
   `fetchPiHealth(): Promise<PiHealth | null>` 로 넓힌다(실패 시 `null`, 절대 throw 안 함).
   호출처는 `connectionMonitor` 한 곳뿐이다.

   ```ts
   export interface PiHealth {
     /** Pi 가 필드를 안 보내는 구버전이면 undefined - "모름"이지 "정상"이 아니다. */
     micOk?: boolean;
     speakerOk?: boolean;
   }
   ```

   Pi 는 snake_case(`mic_ok`), 앱은 camelCase(`micOk`)다. 변환은 `fetchPiHealth()`
   안에서 한 번만 하고, 그 밖으로는 camelCase 만 나간다. 값이 불리언이 아니면
   (문자열·null 등) `undefined` 로 떨군다 — 오래된/이상한 응답을 정상으로 오독하지
   않기 위해서다.

2. `connectionMonitor.service.ts`: `_health: PiHealth | null` 을 들고, `health` 게터를
   노출한다. 기존 `onStatusChange` 구독자에게 같이 통지한다(새 구독 채널 없음).
   `stop()` / 연결 실패 시 `_health = null`.

3. `usePiConnection.ts`: 기존 `usePiConnection(): PiConnectionStatus` **반환 타입은 그대로**
   둔다(App.tsx·ConversationScreen 이 문자열로 쓴다). 같은 파일에
   `usePiDeviceHealth(): PiHealth | null` 을 추가한다 — 새 파일 없음.

4. `probeNow(): Promise<boolean>` 은 시그니처 유지. `fetchPiHealth() !== null` 로 유도.

## C. UI — 계기판 한 줄 (Device Vitals)

### 레이아웃

```
 safe top
┌────────────────────────────────────────┐
│  [디바이스 모드]              [문제풀이]  │  ← 누르는 것만 남는다
│                                        │
│                                        │
│           "비바야"라고 불러봐             │  ← 28/700 INK
│       풀고 싶은 문제를 보여주면 돼          │  ← 15 INK_MUTED
│                                        │
│   ● 연결됨  │  ● 마이크  │  ● 스피커      │  ← 12/600 INK, 헤어라인 구분
│                                        │
│                                        │
│              (마이크)   (기록)            │  ← 기존 그대로
└────────────────────────────────────────┘
```

히어로·서브 **문구는 이 작업에서 바꾸지 않는다.** 위 도식의 "비바야"는 예시일 뿐,
구현 시점의 `HomeScreen` 문구를 그대로 쓴다(2026-08-10 현재 다른 작업에서 호출어를
`"헤이, 비바"` 로 바꾸는 중이다). 이 작업이 건드리는 건 크기(24→28)와 배치뿐이다.

핵심 변경: `ConnectionStatusChip` 을 **상단에서 걷어내 중앙 히어로 아래 한 줄로 통합**
한다. 셋 다 한 물건(비바)의 상태이므로 한 덩어리로 묶는 게 구조적으로 정직하고,
`left: 132` 절대배치 하드코딩이 사라진다. 상단은 "왼쪽 컨트롤 / 오른쪽 컨트롤"로
깨끗해진다.

구분선(폭 1, 높이 12, `SURFACE_BORDER_COLOR`)은 장식이 아니다 — 세 항목이 서로
대등한, 같은 장치의 단면임을 인코딩한다.

### 상태별 렌더

| piStatus | 중앙 |
|---|---|
| `connected` | 히어로 + 서브 + 계기판 3칸(연결/마이크/스피커) |
| `connecting` | `LoadingDots` + "비바를 찾는 중이야" (기존 그대로, 계기판 없음) |
| `disconnected` | "비바와 연결이 안 돼" + `ConnectionGuideCard` (기존 그대로, 계기판 없음) |

`micOk`/`speakerOk` 가 `undefined`(구버전 Pi)면 해당 칸을 **렌더하지 않는다**. 모르는
정보를 초록으로 칠하지 않는다. 둘 다 undefined 면 계기판은 연결 칸 하나만 남는다.

### 항목 사양

| 상태 | 점 | 라벨 |
|---|---|---|
| 연결 정상 | `GREEN` | `연결됨` |
| 마이크 정상 | `GREEN` | `마이크` |
| 마이크 고장 | `ORANGE` | `마이크 안 들려` |
| 스피커 정상 | `GREEN` | `스피커` |
| 스피커 고장 | `ORANGE` | `소리가 안 나와` |

계기판은 `connected` 일 때만 뜨므로 연결 칸은 사실상 항상 초록이다. 그래도 남기는
이유는 셋을 한 덩어리로 읽히게 하는 앵커이기 때문이다 — 마이크·스피커만 떠 있으면
"무엇의 상태인지"가 모호해진다.

- 점: 7×7, radius 3.5. 라벨: 12/600 `FONT`, 색은 **항상 `INK`**.
- 라벨 색을 상태에 따라 바꾸지 않는 이유(WCAG 실측, 배경 `#FAF7F0`):
  `ORANGE`(#D66A4D) 약 3.3:1, `INK_MUTED`(50% → 합성 #928F8B) 약 3.0:1 로 둘 다 12px
  소형 텍스트 기준 4.5:1 미달이다. `INK`(#2B2926)는 약 13.6:1. 의미는 **문구**가 지고
  색은 보강만 한다(`color-not-only`).
- 고장 시 문구가 길어져도 항목 폭만 늘고 세로 레이아웃은 안 흔들린다.

### 접근성

계기판 컨테이너 하나에 합쳐진 `accessibilityLabel` 을 건다 — 스크린리더가 파편 3개
대신 한 문장을 읽는다.

```
"비바 상태: 연결됨, 마이크 정상, 스피커 정상"
"비바 상태: 연결됨, 마이크 안 들려, 스피커 정상"
```

개별 항목·구분선은 `accessibilityElementsHidden` / `importantForAccessibility="no-hide-descendants"`.

### 애니메이션

**없다.** 5초에 한 번 갱신되는 값의 상태 전환에 모션을 붙이면 장식이다. 이 코드베이스
에는 reduced-motion 처리가 아직 없어서, 새 애니메이션은 그 부채까지 끌고 온다.

### 상단 컨트롤 통일 (2026-08-10 추가)

칩을 걷어내면 상단에는 좌측 `ModeToggle` 과 우측 `SolveModeToggle` 만 남는데, 둘의
문법이 갈려 있다 — 우측은 애니메이션 슬라이딩 스위치, 좌측은 정적 알약. `ModeToggle`
을 `SolveModeToggle` 문법으로 맞춘다: 트랙 높이 36 / 반경 18 / 테두리 1.5 / 그림자,
원형 노브 28 슬라이드, 스프링 `friction: 6, tension: 50`, 라벨 13/700 크로스페이드,
`transparent` prop. 라벨은 노브 반대편(같은 문법). 트랙 폭만 76 → 104 — `정답`/`힌트`
는 2자지만 `디바이스`는 4자다.

**그린 채움은 가져오지 않는다.** `SolveModeToggle` 의 그린은 "정답 모드 ON" 이라는
불리언 상태다. 모드 전환은 on/off 가 아니라 A/B 선택이라, 한쪽을 그린으로 칠하면 APP
모드(디바이스 없이 쓰는 축소 모드)가 "켜진 좋은 상태"로 읽힌다. 그린은 상단 줄에서
**"정답 모드 켜짐" 한 가지 의미만** 지게 남긴다.

`testID="mode-toggle"`, `accessibilityRole="switch"`, `accessibilityState={{ checked: isApp }}`
는 그대로 둔다 — 기존 테스트가 이 계약에 걸려 있다.

HomeScreen 은 `SolveModeToggle` 에 이미 `transparent` 를 주고 있으므로 `ModeToggle` 에도
준다. 그래야 상단 두 컨트롤이 같은 재질로 읽힌다.

### 컴포넌트

- 신규 `src/components/DeviceVitals.tsx` — 행 전체를 담당. props
  `{ status: PiConnectionStatus; health: PiHealth | null }`. 항목·구분선을 내부에서 조립.
- `src/components/ConnectionStatusChip.tsx` — **삭제**. 유일한 사용처가 HomeScreen 이고,
  그 역할을 `DeviceVitals` 가 흡수한다. 관련 테스트도 새 컴포넌트 기준으로 이전.
- `HomeScreen.tsx` — 칩 렌더 제거, 중앙 블록에 `DeviceVitals` 추가, 히어로 24→28.

## D. 테스트

기존 스위트(jest + jest-expo)에 붙인다. 새 러너·새 픽스처 없음.

Pi (`pi-server/test_*.py` 패턴):
- 카드 디렉터리 없음 → `mic_ok`, `speaker_ok` 둘 다 false
- `hw_params` 내용이 `closed` → 해당 항목 false
- 캡처 닫힘 + `recording=True` → `mic_ok` true (녹음 중 공백 흡수)
- 캡처 닫힘 + 마지막 열림 3초 전 → `mic_ok` true / 12초 전 → false (sticky 경계)
- `hw_params` 읽기 예외 → 500 아니고 false

앱:
- `connectionMonitor`: `/health` 의 `mic_ok`/`speaker_ok` 파싱, 필드 없으면 `undefined`
  유지, `stop()` 후 `health === null`
- `HomeScreen`: `connected` + 헬스 정상 → 3칸 렌더 / `micOk: false` → 라벨 `마이크 안 들려`
  / `micOk: undefined` → 마이크 칸 미렌더 / `connecting`·`disconnected` → 계기판 미렌더
- `HomeScreen`: APP 모드에서는 계기판 미렌더

## 열어둔 것 (이번 범위 아님)

- **연결 엣지 오탐(알려진 한계).** App.tsx 는 비유휴 구간 내내 wake 스트림을
  pause 해 두고, `piStatus` 가 `'connected'` 로 바뀐 **뒤**에야 `piWakeStream.resume()`
  을 부른다. `connectionMonitor` 는 연결 즉시 프로브하므로, `resume()` 이 아직
  안 돈 그 찰나에 `/health` 를 치면 캡처 서브스트림이 닫혀 있어 `mic_ok: false`
  가 뜬다 - 최대 5초 폴링 한 틱. sticky 10초도 이걸 못 막는다: Pi 부팅 시
  `last_capture_open` 이 `0.0` 이라 `now - 0.0` 이 항상 10초를 훌쩍 넘는다.
  세션에서 idle 홈으로 돌아올 때마다 재발한다. `DeviceVitals` 를 실제로 화면에
  붙이는 작업이 이걸 흡수해야 한다 - 연결 엣지에서 잠깐 debounce 하거나,
  Pi 가 부팅 시 `last_capture_open` 을 시드해 sticky 창을 채우는 방법이 있다.
- 실측 마이크 셀프테스트(RMS 확인). 배타 캡처 제약 때문에 `pause` 협상 없이는 불가.
  필요해지면 `wake.py` 에 "진단용 잠깐 양보" 프로토콜을 추가해야 한다.
- 하단 컨트롤(마이크·기록) 디자인. 아이콘 온리 44px 원 2개가 동일 위계라
  `nav-label-icon` 위반이지만, APP 모드와 공유하는 컴포넌트라 손대면 범위가 앱 전체로
  번진다.
- 계기판 탭 → 즉시 재검사. 5초 폴링으로 충분한지 실기기에서 보고 판단.

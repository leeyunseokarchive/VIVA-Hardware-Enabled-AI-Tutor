# 발화 종료 피드백 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 로봇 마이크 모드에서 학생이 말하는 동안 로봇 눈이 끄덕이고, 말이 끝나면 1초 남짓 안에 끄덕임이 멈추며 눈꺼풀이 내려가 "다 들었다"를 알린다. 침묵 마감은 3초 → 2초.

**Architecture:** Pi 녹음 스레드가 침묵 경과(`silent_ms`)를 상태에 노출하고, 앱이 기존 500ms `/record/status` 폴링에서 그 값을 읽어 `isSettling` 을 만든다. `ConversationScreen.getEyeState()` 가 `isListening`/`isSettling` 을 눈 상태(`listening`/`processing`)로 매핑하고, 기존 `eyeSyncService` WS 경로 하나로 로봇에 전달된다. **눈 상태 writer 는 계속 앱 하나뿐이다** — Pi 는 자기 눈을 직접 건드리지 않는다.

**Tech Stack:** Python 3 (Flask, pygame, `/dev/fb0` 직접 기록), React Native (Expo), TypeScript, Jest

**Spec:** `docs/superpowers/specs/2026-08-07-turn-end-feedback-design.md`

## Global Constraints

- 모든 경로는 `viva-merged/` 기준이다.
- 눈 상태 프로토콜 값은 **정확히** `idle` / `calling` / `processing` / `conversation` / `listening` 다섯이다. Pi(`eyes.py` `VALID_STATES`)와 앱(`EyeAnimation.tsx` `EyeState`) 양쪽이 같은 집합을 가져야 한다.
- Pi `/record/status` 응답 필드명은 `silent_ms`(snake_case). 앱 `PiRecordStatus` 타입도 같은 이름을 쓴다.
- 침묵 마감 값은 Pi `SILENCE_MS` 와 앱 `VOICE_SILENCE_FINALIZE_MS` 둘 다 **2000**. 의도적으로 같은 값이다.
- `app.py` 는 `picamera2` 를 모듈 최상단에서 import 하므로 **Pi 밖에서는 import 자체가 안 된다**. Task 1 에 유닛 테스트를 두지 않는 이유가 이것이다.
- 기존 파일의 한국어 주석 톤·밀도를 그대로 따른다. 왜 그렇게 했는지가 적혀 있어야 한다.
- 커밋은 **하지 않는다**. 각 Task 는 변경만 남기고, 메인 세션이 파일을 명시 지정해 커밋한다(공유 체크아웃에 다른 세션의 미커밋 파일이 있을 수 있어 `git add -A` 금지).

## Task 병렬성

Task 1 / 2 / 3 은 **파일이 서로 겹치지 않아** 동시에 진행할 수 있다.

| Task | 파일 |
|---|---|
| 1 | `pi-server/app.py` |
| 2 | `pi-server/eyes.py` |
| 3 | `src/hooks/useVoiceInput.ts`, `src/services/piBridge.service.ts`, `src/components/EyeAnimation.tsx`, `src/screens/ConversationScreen.tsx`, `src/hooks/__tests__/useVoiceInput.test.ts` |

Task 3 은 Task 1 이 만드는 `silent_ms` 필드명에만 의존하고, 그 이름은 이 문서에 고정돼 있어 대기할 필요가 없다.

Task 4(문서)는 1~3 이 끝난 뒤 메인 세션이 한다.

---

### Task 1: Pi 녹음 — 침묵 2초, `silent_ms` 노출, `max_pause` 계측

**Files:**
- Modify: `pi-server/app.py:103` (`SILENCE_MS`), `pi-server/app.py:323` (`_rec_state`), `pi-server/app.py:345-382` (`_record_loop`), `pi-server/app.py:416` (`record_start` 리셋)

**Interfaces:**
- Consumes: 없음
- Produces: `GET /record/status` 응답에 `silent_ms: int` 추가 — 발화가 한 번이라도 감지된 뒤 마지막 발화로부터 경과한 밀리초. 발화 전이거나 녹음이 끝난 뒤엔 `0`. Task 3 이 이 필드를 읽는다.

- [ ] **Step 1: `SILENCE_MS` 기본값을 2000 으로 내리고 주석에 내력을 남긴다**

`pi-server/app.py` 의 해당 블록을 아래로 교체:

```python
# 서버 측 발화 종료(침묵) 감지 - 로봇 마이크 모드에서 앱은 스트리밍 PCM 이
# 없어 침묵을 못 본다. 앱 useVoiceInput 과 같은 의미론: 말이 한 번이라도
# 감지된 뒤 SILENCE_MS 동안 조용하면 자동 종료, 무발화면 MAX_RECORDING_SECONDS
# 까지 대기. 임계값은 폰(0.015)과 달리 INMP441+MicBoost 실측으로 조정한다 -
# /record/status 의 rms 필드를 보면서 잡음 바닥과 발화 사이 값으로.
#
# 1500 -> 3000 (뜸 들이는 학생을 끊었다) -> 2000 (2026-08-07). 3000 은 무신호
# 대기가 지루하다는 피드백에서 왔는데, 실제 해법의 대부분은 이 숫자가 아니라
# 듣는 중/다 들었다를 알리는 로봇 눈 신호다(eyes.py 의 listening 상태).
# 여기 값은 그 신호를 붙인 뒤 남은 체감만 깎는 몫이다. 되돌리려면 env 로.
SILENCE_MS = int(os.environ.get("VIVA_SILENCE_MS", "2000"))
```

- [ ] **Step 2: `_rec_state` 에 `silent_ms` 를 추가한다**

```python
_rec_state = {"recording": False, "had_speech": False, "rms": 0.0, "silent_ms": 0}
```

`/record/status` 는 `jsonify(_rec_state)` 로 상태를 통째로 내보내므로 **엔드포인트 코드는 건드리지 않는다.**

- [ ] **Step 3: `record_start` 의 리셋에 `silent_ms` 를 넣는다**

`record_start()` 안의 `_rec_state.update(...)` 를 교체:

```python
    _rec_state.update(recording=True, had_speech=False, rms=0.0, silent_ms=0)
```

- [ ] **Step 4: `_record_loop` 에 `silent_ms` 갱신과 `max_pause` 계측을 넣는다**

`_record_loop` 전체를 아래로 교체(docstring 포함):

```python
def _record_loop(proc):
    """arecord stdout 을 읽어 WAV 로 쓰면서 침묵을 감지한다. 종료 조건은
    앱 useVoiceInput 과 동일: ① stop 요청 ② 발화 시작 후 SILENCE_MS 침묵
    ③ MAX_RECORDING_SECONDS 상한(무발화 포함).

    silent_ms 는 앱이 폴링으로 읽어 "말이 멈춘 것 같다"(눈 신호 전환)를
    판정하는 값이다 - 종료 판정(SILENCE_MS)보다 훨씬 짧은 문턱을 쓴다.
    max_pause 는 발화 중간에 관찰된 최장 침묵 - 학생이 그 뒤 말을 이었으니
    SILENCE_MS 가 그보다 작았다면 끊었을 값이다. 임계값을 감이 아니라
    분포로 정하려고 남긴다."""
    started = time.monotonic()
    last_voice = started
    max_pause = 0.0
    data_size = 0
    try:
        with open(RECORDING_PATH, "wb") as f:
            f.write(_wav_header(0))
            while True:
                chunk = proc.stdout.read(RECORD_CHUNK_BYTES)
                if not chunk:
                    break
                f.write(chunk)
                data_size += len(chunk)
                now = time.monotonic()
                rms = _chunk_rms(chunk)
                _rec_state["rms"] = round(rms, 4)
                if rms >= SILENCE_RMS_THRESHOLD:
                    # had_speech 를 세우기 **전에** 잰다 - 첫 발화까지의 간격은
                    # 녹음 시작부터의 대기 시간이라 '중간 침묵' 이 아니다.
                    if _rec_state["had_speech"]:
                        max_pause = max(max_pause, now - last_voice)
                    _rec_state["had_speech"] = True
                    last_voice = now
                _rec_state["silent_ms"] = (
                    int((now - last_voice) * 1000) if _rec_state["had_speech"] else 0
                )
                if _rec_stop.is_set():
                    break
                if _rec_state["had_speech"] and (now - last_voice) * 1000 >= SILENCE_MS:
                    break
                if now - started >= MAX_RECORDING_SECONDS:
                    break
            f.seek(0)
            f.write(_wav_header(data_size))
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait()
        _rec_state["recording"] = False
        _rec_state["rms"] = 0.0
        _rec_state["silent_ms"] = 0
        print(f"[viva-server] record done dur={time.monotonic() - started:.1f}s "
              f"had_speech={_rec_state['had_speech']} "
              f"max_pause={int(max_pause * 1000)}ms bytes={data_size}")
```

- [ ] **Step 5: 문법만 검증한다**

Run: `python3 -m py_compile pi-server/app.py`
Expected: 출력 없음(성공).

**유닛 테스트를 두지 않는 이유**: `app.py` 는 `from picamera2 import Picamera2` 를 모듈 최상단에서 하므로 Pi 밖에서는 import 가 실패한다(개발 머신에 `flask` 조차 없다). `_record_loop` 의 추가분은 I/O 루프 안 산술 몇 줄이고, **`record done` 로그가 실행 검증**이다 — 다음 실기기 세션의 `journalctl -fu viva-server` 에 `max_pause=` 가 0 이 아닌 합리적 값으로 찍히면 배선이 맞은 것이다.

- [ ] **Step 6: 변경 요약을 보고한다 (커밋하지 않는다)**

Run: `git diff --stat pi-server/app.py`
Expected: `pi-server/app.py` 한 파일만 변경.

---

### Task 2: Pi 눈 — `listening` 상태와 끄덕임

**Files:**
- Modify: `pi-server/eyes.py:78-90` (기하 상수 / `VALID_STATES` / `KEY_STATES`), `pi-server/eyes.py:331-366` (`Renderer.draw`)

**Interfaces:**
- Consumes: 앱이 WS 로 보내는 `{"eyeState": "listening"}` (Task 3 이 보낸다)
- Produces: 없음

**설계 의도 — 반드시 읽을 것:** 이 상태의 주된 메시지는 **"너를 보고 있다"** 이고, 끄덕임은 살아있음 표시 수준이다. 튜터링 맥락에서 큰 끄덕임은 학생이 **오답을 말하는 중에** "맞아"라는 평가 신호로 읽힌다. 그래서 진폭은 작게, 주기는 느리게, 그리고 **사케이드(시선 방황)를 꺼서 정면 고정**한다.

- [ ] **Step 1: 끄덕임 상수와 새 상태를 등록한다**

`BREATH = 3` 줄 바로 아래에 추가:

```python
# listening 끄덕임. 크게 하면 안 된다 - 튜터링에서 큰 끄덕임은 "듣고 있어"가
# 아니라 "맞아"(정답 승인)로 읽힌다. 학생이 오답을 말하는 중일 수도 있다.
# 살아있음 표시 수준으로만 두고, 주된 메시지는 사케이드를 끈 정면 고정이
# 담당한다. 동의처럼 보인다는 인상이 나오면 NOD_AMP = 0 으로 끈다.
NOD_AMP = 3       # 끄덕임 진폭(px)
NOD_PERIOD = 1.2  # 한 번 끄덕이는 데 걸리는 시간(초)
```

`VALID_STATES` 와 `KEY_STATES` 를 교체:

```python
VALID_STATES = {"idle", "calling", "processing", "conversation", "listening"}
KEY_STATES = {  # --window 모드 전용
    pygame.K_1: "idle",
    pygame.K_2: "calling",
    pygame.K_3: "processing",
    pygame.K_4: "conversation",
    pygame.K_5: "listening",
}
```

- [ ] **Step 2: `draw()` 의 `else` 가지에 `listening` 을 넣는다**

`Renderer.draw` 의 `else:` 블록(현재 `conversing = state == "conversation"` 으로 시작하는 부분)을 아래로 교체:

```python
        else:
            listening = state == "listening"
            conversing = state == "conversation" or listening
            variant = "wide" if conversing else "normal"
            blink = self.blinker.scale_y(now)
            # 대화 중엔 시선 폭 절반 / 빈도 2배 - 사람을 주시하는 느낌
            k = 0.5 if conversing else 1.0
            interval = (0.75, 2.0) if conversing else (1.5, 4.0)
            dx, dy = self.gaze.offset(now, GAZE * k, GAZE * 2 / 3 * k, interval)
            breathe = BREATH * ease(tri(now / 3.6))  # 1.8s 내려갔다 1.8s 복귀
            if listening:
                # 듣는 중: 시선을 정면에 고정하고(사케이드 off) 미세하게
                # 끄덕인다. 주된 메시지는 "너를 보고 있다" 쪽이다.
                dx = 0.0
                dy = 0.0
                breathe += NOD_AMP * (2 * ease(tri(now / NOD_PERIOD)) - 1)
```

`self.gaze.offset(...)` 호출은 `listening` 에서도 **그대로 둔다** — 사케이드 상태 머신이 계속 돌아야 `conversation` 으로 돌아왔을 때 시선이 튀지 않는다. 값만 버린다.

- [ ] **Step 3: 셀프테스트로 렌더 경로를 검증한다**

Run: `python3 pi-server/eyes.py --selftest`
Expected: 셀프테스트가 통과한다(마지막 줄이 성공 메시지, 종료코드 0). 이 테스트는 `for state in VALID_STATES` 로 모든 상태를 그려 패널 원(`SAFE_R`) 밖으로 픽셀이 안 나가는지 본다 — `listening` 이 자동으로 커버된다.

`pygame` 이 없어서 실패하면(`ModuleNotFoundError: No module named 'pygame'`) 문법 검증으로 대체하고 그 사실을 보고한다:
Run: `python3 -m py_compile pi-server/eyes.py`

- [ ] **Step 4: 눈으로 확인한다 (가능하면)**

Run: `python3 pi-server/eyes.py --window`
`5` 키로 `listening` 진입, `4` 로 `conversation`, `3` 으로 `processing`. 확인할 것: ① `listening` 에서 시선이 방황하지 않고 정면에 있는지 ② 끄덕임이 "동의"가 아니라 "살아있음"으로 보일 만큼 작은지 ③ `listening → processing` 전환에서 끄덕임이 멈추고 눈꺼풀이 내려가는 대비가 보이는지.

헤드리스라 창을 못 띄우면 건너뛰고 보고한다.

- [ ] **Step 5: 변경 요약을 보고한다 (커밋하지 않는다)**

Run: `git diff --stat pi-server/eyes.py`
Expected: `pi-server/eyes.py` 한 파일만 변경.

---

### Task 3: 앱 — `isSettling` 상태와 눈 매핑

**Files:**
- Modify: `src/services/piBridge.service.ts:89-92` (`PiRecordStatus`)
- Modify: `src/hooks/useVoiceInput.ts` (상수, `UseVoiceInputResult`, `startRobotListening` 폴링 루프, `handleChunk`, 반환값)
- Modify: `src/components/EyeAnimation.tsx:4` (`EyeState`), 그리고 상태 분기들
- Modify: `src/screens/ConversationScreen.tsx` (`getEyeState`)
- Test: `src/hooks/__tests__/useVoiceInput.test.ts`

**Interfaces:**
- Consumes: `GET /record/status` 의 `silent_ms: number` (Task 1)
- Produces:
  - `useVoiceInput` 반환값에 `isSettling: boolean` 추가
  - `export const SETTLING_SILENCE_MS = 600`
  - `EyeState` 유니온에 `'listening'` 추가
  - WS 로 나가는 `eyeState` 값에 `'listening'` 추가 (Task 2 가 받는다)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/hooks/__tests__/useVoiceInput.test.ts` 의 import 에 `SETTLING_SILENCE_MS` 를 추가하고, 폰 마이크 테스트가 모인 `describe` 안에 아래 두 케이스를 넣는다. 큰 소리 청크 상수는 파일 상단에 이미 있는 것을 재사용한다(`SILENT` 옆에 있는 큰 진폭 상수 — 이름이 다르면 그 이름을 쓴다).

```ts
    it('말이 멈추고 SETTLING_SILENCE_MS 가 지나면 isSettling 이 true 가 된다', async () => {
      const stream = makeFakeStream();
      const hook = renderVoiceInput({ onResult: jest.fn(), stream });
      await act(async () => {
        await hook.current.startListening();
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(400);
      });

      act(() => {
        stream.emit(LOUD);
      });
      expect(hook.current.isSettling).toBe(false);

      await act(async () => {
        await jest.advanceTimersByTimeAsync(SETTLING_SILENCE_MS + 50);
      });
      act(() => {
        stream.emit(SILENT);
      });
      expect(hook.current.isSettling).toBe(true);
    });

    it('발화가 재개되면 isSettling 이 false 로 돌아온다', async () => {
      const stream = makeFakeStream();
      const hook = renderVoiceInput({ onResult: jest.fn(), stream });
      await act(async () => {
        await hook.current.startListening();
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(400);
      });

      act(() => {
        stream.emit(LOUD);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(SETTLING_SILENCE_MS + 50);
      });
      act(() => {
        stream.emit(SILENT);
      });
      expect(hook.current.isSettling).toBe(true);

      act(() => {
        stream.emit(LOUD);
      });
      expect(hook.current.isSettling).toBe(false);
    });
```

주의: 침묵 마감(2000ms)보다 짧은 시간만 흘려야 한다 — 마감이 걸리면 청취가 끝나고 `isSettling` 은 게이트 때문에 `false` 로 보인다. `SETTLING_SILENCE_MS + 50 = 650ms` 는 안전하다.

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `npx jest src/hooks/__tests__/useVoiceInput.test.ts -t isSettling`
Expected: FAIL — `Property 'isSettling' does not exist on type 'UseVoiceInputResult'` 또는 `expect(undefined).toBe(false)`.

- [ ] **Step 3: `PiRecordStatus` 에 필드를 더한다**

`src/services/piBridge.service.ts`:

```ts
export interface PiRecordStatus {
  recording: boolean;
  had_speech: boolean;
  /** 발화가 한 번이라도 감지된 뒤 마지막 발화로부터 경과한 밀리초. 발화 전
   * 이거나 녹음 종료 후엔 0. 앱은 이 값으로 "말이 멈춘 것 같다"(눈 신호
   * 전환)를 판정한다 - 종료 판정은 서버가 SILENCE_MS 로 따로 한다. */
  silent_ms: number;
  /** 임계값(VIVA_SILENCE_THRESHOLD) 캘리브레이션용 실측 RMS(0~1). */
  rms: number;
}
```

- [ ] **Step 4: `useVoiceInput` 에 `isSettling` 을 구현한다**

**(a) 상수.** `VOICE_SILENCE_FINALIZE_MS` 블록을 교체:

```ts
/** 말 시작 후 이 시간 동안 침묵이면 발화 종료로 판단해 최종 제출.
 * 1500ms 는 "생각하며 뜸 들이는" 학생을 중간에 끊었다(실기기 피드백
 * 2026-07-30) - 3000ms 로 올렸다가 2000ms 로 내렸다(2026-08-07). 3000 을
 * 지루하게 만든 건 길이보다 **무신호**였고, 그건 isSettling → 로봇 눈
 * 신호로 따로 푼다. 이 값은 그 뒤 남은 체감만 깎는 몫이다.
 * Pi 쪽 SILENCE_MS 와 같은 값을 유지한다(로봇 마이크 경로의 대응물). */
export const VOICE_SILENCE_FINALIZE_MS = 2000;
/** 이만큼 조용하면 "말이 끝난 것 같다"로 보고 신호를 낸다(마이크는 아직
 * 열려 있다). 마감(2000)보다 훨씬 짧아 신호 후에도 이어 말할 여유가 남는다. */
export const SETTLING_SILENCE_MS = 600;
```

**(b) 인터페이스.** `UseVoiceInputResult` 의 `isProcessing` 아래에 추가:

```ts
  /** 말이 멈춘 것으로 보이나 마이크는 아직 열려 있는 구간. 로봇 눈을
   * '다 들었다'(processing)로 바꿔 턴 교대를 유도하는 용도다 - 학생이
   * 그걸 보고 스스로 말을 멈추면 마감 대기의 체감이 사라진다. 이어 말하면
   * 다시 false 가 되고 마감 타이머도 리셋된다.
   * 청취 중이 아니면 항상 false (내부 플래그와 무관하게 게이트된다). */
  isSettling: boolean;
```

**(c) 상태.** `const [isProcessing, setIsProcessing] = useState(false);` 아래에 추가:

```ts
  // 내부 플래그. 밖으로는 isListening 으로 게이트해서 내보내므로(반환문 참고)
  // 종료 경로마다 리셋을 심을 필요가 없다 - 그렇게 하면 나중에 생기는
  // 여섯 번째 종료 경로에서 반드시 새어나간다.
  const [settled, setSettled] = useState(false);
```

`debugChunkCountRef` 선언 아래에 ref 와 갱신 헬퍼를 추가:

```ts
  const settledRef = useRef(false); // 청크마다(초당 ~20회) setState 하지 않기 위한 게이트

  const updateSettled = useCallback((value: boolean) => {
    if (settledRef.current === value) return;
    settledRef.current = value;
    setSettled(value);
  }, []);
```

**(d) 폰 경로.** `handleChunk` 안, `setMicLevel(rms)` 이후의 `if (rms >= SPEECH_RMS_THRESHOLD) { ... }` 블록 **바로 다음** 줄에 추가:

```ts
      updateSettled(
        hasSpeechRef.current &&
          now - lastVoiceAtRef.current >= SETTLING_SILENCE_MS,
      );
```

`handleChunk` 의 `useCallback` 의존성 배열에 `updateSettled` 를 더한다.

**(e) 로봇 경로.** `startRobotListening` 의 폴링 루프에서 `fails = 0;` 바로 다음 줄에 추가:

```ts
          updateSettled((status.silent_ms ?? 0) >= SETTLING_SILENCE_MS);
```

`startRobotListening` 의 `useCallback` 의존성 배열에 `updateSettled` 를 더한다.

**(f) 시작 시 리셋 (두 곳뿐이다).** `startRobotListening` 의 `hasFiredRef.current = false;` 근처, 그리고 `startListening` 의 `hasSpeechRef.current = false;` 근처에 각각 추가:

```ts
      updateSettled(false);
```

**`finalizeResult` / `finalizeRobotResult` / `stopListening` 에는 아무것도 추가하지 않는다.** 게이트가 처리한다.

**(g) 반환.** 반환 객체의 `isProcessing` 다음 줄에 추가:

```ts
    isSettling: isListening && settled,
```

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `npx jest src/hooks/__tests__/useVoiceInput.test.ts`
Expected: 전부 PASS. `VOICE_SILENCE_FINALIZE_MS` 를 상수로 참조하는 기존 테스트들은 2000 으로 바뀌어도 그대로 통과해야 한다 — **하드코딩된 `3000` 기대값이 있으면** 상수 참조로 바꾼다(값을 3000 으로 되돌리지 말 것).

- [ ] **Step 6: `EyeState` 에 `listening` 을 더한다**

`src/components/EyeAnimation.tsx`:

```ts
export type EyeState = 'idle' | 'calling' | 'processing' | 'conversation' | 'listening';
```

컴포넌트 본문 맨 위(기존 `renderedState` 크로스페이드 로직이 `state` 를 처음 읽는 지점 **앞**)에 정규화를 넣고, 그 아래의 기존 `state` 사용처를 `effectiveState` 로 바꾼다. **다른 렌더 분기는 손대지 않는다.**

```ts
  // 폰 화면의 눈은 이 기능의 대상이 아니다 - 로봇 마이크 모드에서 학생은
  // 로봇 얼굴을 보지 폰을 안 본다(2026-08-07 확인). listening 은 타입만
  // 통과시키고 conversation 과 같게 그린다. 실제 끄덕임은 로봇이 그린다
  // (pi-server/eyes.py 의 listening 상태).
  const effectiveState: EyeState = state === 'listening' ? 'conversation' : state;
```

- [ ] **Step 7: `getEyeState()` 를 고친다**

`src/screens/ConversationScreen.tsx` 의 `getEyeState` 전체를 교체:

```tsx
  // Map FSM status and phase to custom eye shapes
  const getEyeState = (): EyeState => {
    // 앱의 '생각 중' 로딩 닷과 같은 구간(전사·채점·판서 생성)은 전부
    // processing 눈 - 디스플레이 보드도 이 값으로 같은 표정을 튼다.
    // isSettling(말이 멈춘 것 같은데 마이크는 아직 열려 있음)도 여기 붙는다:
    // 끄덕임이 멈추고 눈꺼풀이 내려가는 것이 "다 들었다" 신호이고, 그걸 본
    // 학생이 스스로 말을 멈추면 마감 대기의 체감이 사라진다.
    if (voice.isProcessing || voice.isSettling || phase === 'evaluating' || isBoardLoading) {
      return 'processing';
    }
    if (session.fsmState === 'ERROR') {
      return 'idle'; // error shows retry screen, eyes are idle / resting
    }
    // 듣는 중 - 로봇이 정면을 보며 미세하게 끄덕인다("너를 보고 있다").
    if (voice.isListening) {
      return 'listening';
    }
    return 'conversation';
  };
```

- [ ] **Step 8: 타입 검사와 전체 테스트를 돌린다**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

Run: `npm test`
Expected: 전부 PASS. **실패가 남으면 고치고 다시 돌린다** — 통과 못 한 채로 보고하지 말 것.

- [ ] **Step 9: 변경 요약을 보고한다 (커밋하지 않는다)**

Run: `git diff --stat src/`
Expected: 위 5개 파일만 변경.

---

### Task 4: 문서 (메인 세션이 1~3 완료 후 수행)

**Files:**
- Modify: `docs/process.md`

- [ ] **Step 1: 튜닝 노브 표를 갱신한다**

- `침묵 마무리 대기` 행: 현재값 **3000 → 2000**
- 새 행 `말 멈춤 신호 문턱` | `useVoiceInput.ts` `SETTLING_SILENCE_MS` | **600** | 눈 신호가 너무 성급하면 올림
- 새 행 `끄덕임 진폭` | `pi-server/eyes.py` `NOD_AMP` | **3** | "동의"처럼 보이면 내림(0 이면 정면 고정만)

- [ ] **Step 2: 녹음(D-33) 항목을 갱신한다**

`VIVA_SILENCE_MS` 기본값 3000 → 2000, `/record/status` 페이로드에 `silent_ms` 추가, `record done` 로그에 `max_pause` 추가를 반영한다.

- [ ] **Step 3: 눈 상태 프로토콜을 4종 → 5종으로 갱신한다**

`listening`(정면 고정 + 미세 끄덕임) 추가.

- [ ] **Step 4: 미해결 / 다음 후보에 등재한다**

> **전사~응답 구간에 마이크가 닫혀 있어 조기 종료가 파괴적이다.** `ConversationScreen` 의 자동 재청취가 `!voice.isProcessing` 으로 게이트돼 있어 전사·EVAL·TTS 구간 내내 마이크가 꺼진다. 잘린 뒷말은 복구되지 않고 VIVA 는 조각에 대답한다. 침묵 마감을 3000 까지 올리게 만든 근본 원인이며, 조기 종료가 복구 가능해지면(뒷말 이어붙여 재전사 / 처리 중 barge-in) 마감을 1200ms 까지 내려도 안전해진다.

- [ ] **Step 5: 커밋한다**

```bash
git add pi-server/app.py pi-server/eyes.py \
  src/hooks/useVoiceInput.ts src/hooks/__tests__/useVoiceInput.test.ts \
  src/services/piBridge.service.ts src/components/EyeAnimation.tsx \
  src/screens/ConversationScreen.tsx docs/process.md
git commit -m "feat: 발화 종료 피드백 - 듣는 중 끄덕임, 침묵 마감 2초"
```

`git add -A` 금지 — 공유 체크아웃이라 다른 세션의 미커밋 파일이 섞인다.

---

## Self-Review

**스펙 커버리지**

| 스펙 항목 | Task |
|---|---|
| Pi `SILENCE_MS` 2000 | 1 / Step 1 |
| Pi `silent_ms` 노출 | 1 / Step 2·3·4 |
| Pi `max_pause` 계측 + 로그 | 1 / Step 4 |
| `VOICE_SILENCE_FINALIZE_MS` 2000 | 3 / Step 4(a) |
| `SETTLING_SILENCE_MS` + `isSettling` (양 경로) | 3 / Step 4(b~g) |
| 리셋은 시작 한 곳뿐 (게이트 파생) | 3 / Step 4(f)(g) |
| `PiRecordStatus` 타입 | 3 / Step 3 |
| 눈 `listening` 상태 + 끄덕임 | 2 / Step 1·2 |
| 앱 `EyeState` 유니온 | 3 / Step 6 |
| `getEyeState()` 매핑 | 3 / Step 7 |
| 테스트 2건 | 3 / Step 1 |
| 상태 슬롯(`getStatusSlot`) 불변 | 어느 Task 도 건드리지 않음 ✓ |
| `micLevel ← status.rms` **기각** | 어느 Task 도 하지 않음 ✓ |
| 문서 갱신 | 4 |

**타입 일관성**: `silent_ms`(Python dict 키 / TS 필드) · `isSettling`(훅 반환) · `settled`(훅 내부) · `SETTLING_SILENCE_MS`(export) · `'listening'`(양쪽 상태 집합) — Task 1↔3, Task 2↔3 사이에서 이름이 일치한다.

**의도한 미구현**: 없음. `micLevel` 복구와 rms 연동 끄덕임은 스펙에서 명시적으로 기각됐고, 계획에도 없다.

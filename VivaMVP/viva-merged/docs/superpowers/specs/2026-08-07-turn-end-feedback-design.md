# 발화 종료 피드백 — "마이크가 아직 열려 있다"는 체감 제거

작성: 2026-08-07

## 문제

로봇 마이크 모드에서 학생이 답을 마치면 마이크가 3초 더 열려 있다가 닫힌다. 그 3초 동안 **로봇이 아무 신호를 주지 않는다** — 눈이 `conversation` 그대로다. 학생은 로봇 얼굴을 보며 말하므로(2026-08-07 확인) 그 얼굴이 유일한 채널인데, 거기서 아무 일도 일어나지 않는다. 말을 다 했는데 알아들었는지 알 수 없고, 더 말해야 하는지 헷갈린다.

사용자 표현: "말 다 했는데 계속 마이크가 열려있는 게 신경 쓰인다."

### 3초는 원인의 일부일 뿐

학생이 말을 멈춘 뒤 VIVA가 입을 열기까지의 죽은 시간:

| 구간 | 값 | 위치 |
|---|---|---|
| Pi 침묵 판정 | 3000ms | `pi-server/app.py` `SILENCE_MS` |
| 앱 폴링 지연 | 0~500ms | `useVoiceInput.ts` `ROBOT_POLL_INTERVAL_MS` |
| WAV 수신 + Gemini 전사 | ~1~2초 | `fetchPiAudioBase64` → `transcribeFn` |
| EVAL 턴 | ~3.0초 | `docs/process.md` 실측 |
| TTS 합성 + 재생 시작 | ~1초 | |

3초는 전체 ~8초 중 한 조각이다. 그런데 나머지 구간에는 이미 로딩 닷과 `processing` 눈이라는 "일하는 중" 신호가 붙어 있고, 이 3초에만 없다. 그래서 길이보다 **무신호**가 문제다.

### 3000 의 내력

원래 1500 이었고, "생각하며 뜸 들이는 학생을 중간에 끊었다"는 실기기 피드백(2026-07-30)으로 3000 이 됐다. 근거는 관찰 한 줄이 전부다. 지금 2000 으로 내리는 근거도 마찬가지로 관찰 한 줄이므로, 이 스펙은 **다음번엔 감이 아니라 분포로 정할 수 있도록 계측을 같이 넣는다**.

## 설계 원칙

**신호가 먼저, 숫자가 나중이다.** 사람 대화에서 턴 교대는 시간이 아니라 신호로 돈다 — 듣는 쪽 표정이 "알아들었어"를 보내면 말하는 쪽이 스스로 멈춘다. 로봇 눈을 붙이면 신호가 정보 전달을 넘어 **턴 교대를 유도**하고, 그러면 남은 대기 시간의 체감이 사라진다. 숫자만 깎으면 그 효과는 못 얻고 끊김 회귀만 얻는다.

## 기각한 대안

**Pi 가 자기 눈을 직접 제어** — `_record_loop` 이 침묵을 감지하는 즉시 로컬 WS(`:8787`)로 눈 상태를 밀면 폴링 지연 0.5초가 사라진다. 기각: 눈 상태 writer 가 폰과 Pi 둘로 갈라진다. 지금은 `ConversationScreen` 의 `eyeSyncService.sendEyeState` 하나뿐이고, 그 단일 writer 구조를 0.5초와 바꾸지 않는다.

**시간만 2000 으로** — 한 줄이지만 무신호 문제가 그대로 남는다. 2초도 신호가 없으면 애매한 건 같다.

**앱 마이크 미터 살리기** — 로봇 모드에서 `micLevel` 이 0 으로 얼어 있고, 폴링이 이미 받아오는 `status.rms` 를 흘리면 한 줄로 미터가 산다. 기각: **로봇 마이크로 대답할 때 학생은 로봇 얼굴을 본다**(2026-08-07 확인). 아무도 안 보는 화면을 살리는 건 한 줄이어도 죽은 코드다. 로봇 모드 `micLevel = 0` 은 그대로 둔다 — `rms` 는 캘리브레이션용으로 `/record/status` 에서 직접 읽으면 된다.

## 변경 내역

### 1. Pi — `viva-merged/pi-server/app.py`

**(a) `SILENCE_MS` 기본값 3000 → 2000.** `VIVA_SILENCE_MS` env 오버라이드는 그대로 — 실기기에서 재배포 없이 되돌릴 수 있어야 한다.

**(b) `_rec_state` 에 `silent_ms` 추가.** `/record/status` 는 `_rec_state` 를 통째로 `jsonify` 하므로 엔드포인트 코드 변경은 없다.

- 초기값 / `record/start` 리셋: `0`
- `_record_loop` 매 청크: 발화가 한 번이라도 있었으면 `int((now - last_voice) * 1000)`, 아니면 `0`
- `finally` 정리에서 `rms` 와 함께 `0` 으로 되돌린다

**(c) `max_pause` 계측 + 로그.** 발화 중간에 관찰된 **가장 긴 침묵 간격**(그 뒤 학생이 말을 이어서 턴이 안 끝난 경우)을 추적한다. 이 값이 임계값 선택의 직접 근거다 — `max_pause` 가 상시 ~1800ms 면 2000 은 아슬아슬한 것이고, ~400ms 면 더 내려도 된다.

`_record_loop` 안에서 임계 초과 청크를 만났을 때, **`had_speech` 를 True 로 세우기 전에** 직전 발화와의 간격을 잰다(첫 발화에서는 `started` 기준 간격이 나와 의미가 없으므로 `had_speech` 가 이미 True 인 경우만 집계).

`record done` 로그에 `max_pause=..ms` 를 덧붙인다.

### 2. 앱 — `viva-merged/src/hooks/useVoiceInput.ts`

**(a) `VOICE_SILENCE_FINALIZE_MS` 3000 → 2000.** 폰 마이크 경로. Pi 값과 일치시키는 건 의도된 것이다(파일 주석·`_record_loop` docstring 둘 다 "종료 조건은 앱과 동일"을 명시). 주석의 내력 설명도 2000 기준으로 갱신한다.

**(b) 새 상수 `SETTLING_SILENCE_MS = 600`.** 이만큼 조용하면 "말이 끝난 것 같다"로 보고 신호를 낸다. 마감(2000ms)보다 훨씬 짧아, 신호가 뜬 뒤에도 이어 말할 여유가 ~1.4초 남는다.

**(c) 새 공개 상태 `isSettling: boolean`** — `UseVoiceInputResult` 에 추가. "말이 멈춘 것으로 보이나 마이크는 아직 열려 있다"는 뜻.

- **로봇 경로**: 폴링 루프에서 `status.silent_ms >= SETTLING_SILENCE_MS` 로 판정. 신호는 침묵 시작 후 0.6~1.1초에 뜬다(폴링 granularity 500ms 포함).
- **폰 경로**: `handleChunk` 에서 `hasSpeechRef.current && now - lastVoiceAtRef.current >= SETTLING_SILENCE_MS` 로 판정. 청크 타이밍이 정확해 폴링 지연이 없다.
- **주의**: `handleChunk` 는 초당 ~20회 도는 네이티브 콜백이다. 값이 **바뀔 때만** `setIsSettling` 을 부르도록 ref 로 게이트한다(그러지 않으면 청크마다 리렌더가 돈다). 이 앱은 legacy root 라 네이티브 콜백 안 setState 가 배치되지 않는다는 기존 주의사항이 그대로 적용된다.
- **리셋은 청취 시작 한 곳뿐이다.** 훅이 내보낼 때 `isListening && settled` 로 게이트하므로, 청취가 끝난 뒤 내부 플래그가 true 로 남아 있어도 소비자에겐 `false` 로 보인다. `finalizeResult` / `finalizeRobotResult` / `stopListening` 에는 손대지 않는다 — 종료 경로마다 리셋을 심으면 여섯 번째 경로가 생겼을 때 반드시 새어나간다.

### 3. 앱 — `viva-merged/src/services/piBridge.service.ts`

`PiRecordStatus` 타입에 `silent_ms: number` 추가. `rms` 가 타입에 없으면 함께 추가한다.

### 4. 새 눈 상태 `listening` — 듣는 동안 끄덕임

끝점 신호(`processing`) 하나만으로는 변화가 미묘하다. 듣는 내내 "너를 보고 있다"를 표시하는 상태를 하나 더 두면, 마감 순간의 **끄덕임 정지 + 눈꺼풀 내려감**이라는 대비가 생겨 끝점 신호가 확실해진다.

**`pi-server/eyes.py`**
- `VALID_STATES` 에 `"listening"` 추가. [eyes.py:434](../../../pi-server/eyes.py) 의 `for state in VALID_STATES` 셀프테스트가 자동으로 커버한다.
- `draw()` 는 이미 `center = (cx + ... + dx, cy + dy + breathe)` 로 세로 오프셋을 합치므로, `listening` 일 때 사인 항 하나를 더한다.
- **사케이드(시선 방황)는 끈다** — 시선을 정면 고정하고 미세하게만 끄덕인다.
- 진폭·주기는 상수로 뺀다: `NOD_AMP` 2~3px(눈 크기 대비 미세), `NOD_PERIOD` ~1.2초.

**앱**
- `EyeAnimation.tsx` 의 `EyeState` 유니온에 `'listening'` 추가. 렌더는 `'conversation'` 과 같은 분기로 묶는다 — 폰 화면 눈은 이 기능의 대상이 아니다(학생은 로봇을 본다). 타입만 통과시키면 된다.
- `ConversationScreen.getEyeState()`: `processing` 분기 다음, `conversation` 폴백 앞에 `if (voice.isListening) return 'listening';`.

**rms 연동은 하지 않는다.** "음성이 들어올 때만 끄덕인다"를 진폭으로 표현하려면 rms 가 실시간으로 눈에 닿아야 하는데, 앱 폴링은 500ms 격자라 랙 걸린 끄덕임이 된다. 대신 **상태 기반**으로 같은 의미를 낸다: 말하는 중(`isListening && !isSettling`)엔 끄덕이고, 침묵 600ms(`isSettling`)면 멈추고 `processing` 으로 넘어간다. 이미 계산하는 값이라 배선 추가가 없고, 움직임은 순정 사인이라 매끄럽다.

### 5. 앱 — `viva-merged/src/screens/ConversationScreen.tsx`

`getEyeState()` 의 `processing` 분기에 `voice.isSettling` 을 더한다. 이미 `voice.isProcessing || phase === 'evaluating' || isBoardLoading` 이 `processing` 을 반환하므로 조건 하나 추가로 끝이다. 그 아래에 위 `listening` 분기가 붙는다. 눈 상태 writer 는 기존 `useEffect([eyeState])` 하나 그대로 — 새 전송 경로를 만들지 않는다.

**화면 하단 상태 슬롯(`getStatusSlot`)은 건드리지 않는다.** `isSettling` 중에도 `listening` 슬롯을 유지한다 — 마이크는 실제로 아직 열려 있고, 여기서 로딩 닷으로 바꾸면 "닫혔다"는 거짓말이 된다. 신호는 전적으로 로봇 눈이 담당한다(학생이 보고 있는 쪽).

## 데이터 흐름

```
청취 시작
  │  눈 = 'listening'  → 정면 고정 + 미세 끄덕임 (듣고 있다)
  │
학생 말 멈춤
  │
  ├─ Pi _record_loop: 청크마다 silent_ms 갱신
  │
  ├─ (+0~500ms) 앱 폴링: silent_ms >= 600  →  isSettling = true
  │
  ├─ ConversationScreen: getEyeState() → 'processing'
  │                      eyeSyncService.sendEyeState → WS → eyes.py
  │                      (120ms 아웃 / 180ms 인 크로스페이드)
  │  눈 = 끄덕임 멈춤 + 눈꺼풀 내려감 (다 들었다)
  │
  │  ── 학생이 이어 말하면: silent_ms 가 0 으로 떨어짐 → isSettling=false
  │     → 눈이 'listening' 으로 복귀(끄덕임 재개), 마감 타이머도 리셋
  │
  └─ (침묵 2000ms) Pi 자동 종료 → recording=false
       → 앱이 WAV 수신 → 전사 → isProcessing=true (눈은 이미 processing, 전환 없음)
```

눈이 `processing` 으로 한 번 넘어간 뒤 전사·EVAL 구간에서도 계속 `processing` 이므로, 학생이 이어 말하지 않는 정상 경로에서는 **눈 전환이 턴당 정확히 한 번**(`listening → processing`)이다.

## 위험

- **끄덕임이 "동의"로 읽힐 수 있다.** 튜터링 맥락에서 학생이 **오답을 말하는 중에** 로봇이 끄덕이면 "맞아"라는 평가 신호로 받아들인다. 이게 이 기능의 가장 큰 위험이다. 완화: ① 진폭을 아주 작게(`NOD_AMP` 2~3px) ② 주기를 느리게(~1.2초) ③ 사케이드를 멈추고 정면 고정을 함께 넣어 **주된 메시지가 "너를 보고 있다"** 가 되게 한다. 실기기에서 "동의처럼 보인다"는 인상이 나오면 끄덕임을 빼고 정면 고정만 남긴다(`NOD_AMP = 0` 한 줄).
- **눈이 "생각 중"인데 마이크는 아직 열려 있다.** 의미상 어긋나지만 이게 의도한 효과다 — 학생이 그 표정을 보고 말을 멈추는 것이 목표(턴 교대 유도). 이어 말해도 오디오는 정상 수집되고 마감 타이머만 리셋된다.
- **눈 왔다갔다 깜빡임.** 뜸 들이는 학생이 600ms 경계를 여러 번 넘나들면 `listening ↔ processing` 이 반복된다. `eyes.py` 의 120/180ms 크로스페이드가 완화하지만, 거슬리면 `SETTLING_SILENCE_MS` 를 올린다(신호가 늦어지는 대가).
- **Pi Zero W 는 싱글코어 ARMv6 다.** 끄덕임은 미리 구운 스프라이트의 blit y 오프셋에 사인 항 하나를 더하는 것이라 프레임 비용이 사실상 그대로다(스프라이트를 다시 그리지 않는다). 촬영 인코딩과 코어를 다투는 구간은 청취 중이 아니므로 겹치지도 않는다.
- **2000 이 여전히 짧을 수 있다.** 되돌림은 Pi 는 `VIVA_SILENCE_MS` env 한 줄, 앱은 상수 한 줄. `max_pause` 로그가 쌓이면 근거를 갖고 재조정한다.

## 검증

- **앱**: `useVoiceInput.test.ts` 에 케이스 **2개**만 추가 — ① 침묵이 `SETTLING_SILENCE_MS` 를 넘으면 `isSettling` 이 true 가 된다 ② 발화가 재개되면 false 로 돌아온다. 청취 종료 후 false 는 `isListening` 게이트로 구조적으로 보장되므로 테스트를 두지 않는다. 기존 테스트의 침묵 마감 시간 기대값(3000 기준)이 있으면 2000 으로 갱신한다.
- **눈**: `python3 eyes.py --selftest` — `VALID_STATES` 를 순회하므로 `listening` 추가만으로 렌더 경로가 커버된다. 움직임은 `python3 eyes.py --window` 로 눈으로 본다(진폭·주기 조율은 어차피 육안 판정이다).
- **Pi**: `max_pause` 계측은 I/O 루프 안의 산술 4줄이라 별도 테스트를 두지 않는다. **`record done` 로그 자체가 검증**이다 — 다음 실기기 세션의 `journalctl -fu viva-server` 에서 `max_pause=` 가 0 이 아닌 합리적 값으로 찍히면 배선이 맞은 것이다.
- **실기기 체감**: 로봇 앞에서 한 턴 — ① 말하는 동안 끄덕이는지 ② 말이 끝난 뒤 1초 남짓 안에 끄덕임이 멈추고 눈꺼풀이 내려가는지 ③ 이어 말했을 때 끄덕임이 돌아오고 발화가 안 잘리는지 ④ **오답을 말할 때 끄덕임이 "맞다"처럼 느껴지지 않는지**.

## 문서

`docs/process.md` 갱신:
- 튜닝 노브 표: `VOICE_SILENCE_FINALIZE_MS` 현재값 3000 → 2000, `SETTLING_SILENCE_MS`·`NOD_AMP` 행 추가
- 녹음(D-33) 항목: `VIVA_SILENCE_MS` 기본 3000 → 2000, `/record/status` 페이로드에 `silent_ms` 추가
- 눈 상태 프로토콜: `listening` 추가(4종 → 5종)
- **미해결 / 다음 후보에 아래 항목 신규 등재**

## 범위 밖 — 미해결 항목으로 남길 것

**전사~응답 구간에 마이크가 닫혀 있어 조기 종료가 파괴적이다.** `ConversationScreen` 의 자동 재청취가 `!voice.isProcessing` 으로 게이트돼 있어(약 337행), 전사·EVAL·TTS 구간 내내 마이크가 꺼져 있다. 그래서 마감이 조금이라도 이르면 **잘린 뒷말이 영영 사라지고 VIVA는 조각에 대답한다**. 임계값을 3000 까지 올리게 만든 근본 원인이 이것이다.

조기 종료가 복구 가능해지면(잘린 뒷말을 이어붙여 재전사 / 처리 중 barge-in) 임계값을 1200ms 까지 내려도 안전해지고, "몇 초가 맞나" 라는 질문 자체가 없어진다. MVP 범위 밖 — 이 스펙에서는 손대지 않고 후보로만 기록한다.

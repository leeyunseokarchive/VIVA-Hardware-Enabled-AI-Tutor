# 웨이크 15초 정체 + 개념 자막 문장분할 + done 의도 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 세션 종료 후 ~15초 웨이크 무반응 제거, IntentScreen 개념 설명 자막을 문장 단위로 분할 표시, "이해했어" 류 발화를 `done` 의도로 분류해 고정 문구로 종료.

**Architecture:** (1) Pi `wake.py` 의 arecord 재기동 백오프를 지수화하고 포기 한도를 올려 세션 종료 직후 마이크 경합을 흡수. (2) 앱의 ONNX 웨이크 엔진을 세션 간 파괴하지 않고 유지(버퍼만 리셋)해 재구축 비용(JSI 수리 + 모델 3개 로드 + 2초 버퍼 재충전 중 앞 두 개)을 제거. (3) ConversationScreen 의 문장분할 자막 로직을 공유 유틸로 추출해 useIntentLoop 의 개념 설명 발화에 적용. (4) STT 분류기에 `done` 의도 추가.

**Tech Stack:** React Native (Expo), TypeScript, Jest, Python 3 (unittest), onnxruntime-react-native.

## Global Constraints

- 고정 문구는 글자 그대로 유지: 종료 문구 `또 궁금한 거 있으면 언제든 불러줘!` (기존 `CONCEPT_EXIT_PHRASE` 재사용, 새 문구 만들지 않는다).
- 새 npm/pip 의존성 금지.
- RN 테스트: `cd viva-merged && npx jest <파일>` / Pi 테스트: `cd viva-merged/pi-server && python3 -m unittest test_wake.py -v` (개발 Mac 에 websockets 없음 — wake.py 는 지연 임포트라 임포트만으로 깨지면 안 된다).
- 커밋은 파일 명시 (`git add <경로>...`). `git add -A` 금지 (병렬 세션이 같은 체크아웃 공유).
- 주석·문구는 기존 파일의 한국어 톤을 따른다.
- `docs/process.md` 갱신은 컨트롤러(마지막)가 한다 — 각 태스크는 건드리지 않는다.

---

### Task 1: wake.py — arecord 재기동 지수 백오프 (마이크 경합 흡수)

**배경:** 세션 종료 시 앱이 `resume` 을 보내는 시점에 viva-server 의 `/record` 가 아직 `micboost`(exclusive) 를 쥐고 있을 수 있다. 새 arecord 가 즉사하면 현재 1초 고정 백오프 × 5회 후 **영구 포기**한다 — `/record/stop` 의 스레드 join 이 최대 5초라 경합이 5회를 넘길 수 있고, 포기하면 다음 resume 까지 웨이크가 죽는다.

**Files:**
- Modify: `pi-server/wake.py`
- Test: `pi-server/test_wake.py`

**Interfaces:**
- Produces: `RESPAWN_MAX_BACKOFF_S = 5.0` (새 상수), `MAX_QUICK_DEATHS = 8` (5→8). `_pump` 시그니처 불변.

- [ ] **Step 1: 실패하는 테스트 작성** — `test_wake.py` 에 추가:

```python
    async def test_pump_backoff_grows_exponentially_and_caps(self):
        # 세션 종료 직후 viva-server 가 아직 마이크를 쥐고 있으면 arecord 가
        # 연속 즉사한다 - 고정 1초 백오프 5회는 /record/stop join(최대 5초)을
        # 못 버티고 영구 포기했다. 백오프를 지수로 늘리고 한도를 올린다.
        relay = WakeRelay()
        relay.process = Mock()
        relay.process.stdout.read = Mock(return_value=b'')  # 항상 즉사
        ws = AsyncMock()
        relay.clients.add(ws)
        sleeps = []

        async def fake_sleep(s):
            sleeps.append(s)

        respawn = Mock()
        respawn.stdout.read = Mock(return_value=b'')
        with patch('wake.subprocess.Popen', return_value=respawn), \
             patch('wake.asyncio.sleep', side_effect=fake_sleep):
            await relay._pump()

        # MAX_QUICK_DEATHS=8 회 재시도, 백오프 1,2,4,5,5,5,5,5 (5초 캡)
        self.assertEqual(sleeps, [1.0, 2.0, 4.0, 5.0, 5.0, 5.0, 5.0, 5.0])
```

- [ ] **Step 2: 실패 확인**

Run: `cd viva-merged/pi-server && python3 -m unittest test_wake.WakeRelayTest.test_pump_backoff_grows_exponentially_and_caps -v`
Expected: FAIL — sleeps 가 `[1.0, 1.0, 1.0, 1.0, 1.0]` (기존 고정 백오프 5회).

- [ ] **Step 3: 구현** — `wake.py` 수정.

상수 (기존 `RESPAWN_BACKOFF_S = 1.0` 아래):

```python
RESPAWN_BACKOFF_S = 1.0
RESPAWN_MAX_BACKOFF_S = 5.0  # 지수 백오프 상한 - /record/stop join(최대 5초)과 맞춘다
# ponytail: 연속 급사 8회(백오프 합 ~32초)면 하드웨어가 진짜 죽은 것으로 보고
# 포기한다 - 세션 종료 직후 viva-server 와의 마이크 경합(최대 ~5초)은 이 안에서
# 자연 흡수된다. 업그레이드 경로: 포기를 /health 에 노출해 "재시작 필요" 표시.
MAX_QUICK_DEATHS = 8
```

`_pump` 의 EOF 처리 (기존 `await asyncio.sleep(RESPAWN_BACKOFF_S)` 부분):

```python
            deaths += 1
            if deaths > MAX_QUICK_DEATHS:
                print("[viva-wake] capture keeps dying - giving up")
                break
            backoff = min(RESPAWN_BACKOFF_S * (2 ** (deaths - 1)), RESPAWN_MAX_BACKOFF_S)
            print(f"[viva-wake] capture died (EOF) - respawning ({deaths}, backoff {backoff}s)")
            await asyncio.sleep(backoff)
```

- [ ] **Step 4: 전체 테스트 통과 확인**

Run: `cd viva-merged/pi-server && python3 -m unittest test_wake.py -v`
Expected: 전부 PASS (기존 5개는 `MAX_QUICK_DEATHS` 를 patch 하므로 값 변경에 안 깨진다).

- [ ] **Step 5: Commit**

```bash
git add pi-server/wake.py pi-server/test_wake.py
git commit -m "fix: wake.py arecord 재기동 지수 백오프 - 세션 종료 직후 마이크 경합 영구 포기 방지"
```

---

### Task 2: 웨이크 엔진 세션 간 유지 (ONNX 재구축 제거)

**배경:** 홈 복귀마다 `useWakeWord.startListening` 이 엔진을 새로 만든다 — JSI 수리(≤1.5초) + ONNX 세션 3개 로드(3.2MB, 수 초) + 2초 버퍼 재충전이 매번 든다. 엔진을 앱 수명 동안 1개로 유지하고, 세션 시작 시 `stop()`(판정 중단)만, 복귀 시 `reset()`(이전 세션 오디오 버림 — **직전 "비바야" 가 버퍼에 남아 재발화 없이 재트리거되는 것 방지**) + `start()` 만 한다.

**Files:**
- Modify: `src/lib/openWakeWord.ts` (reset 메서드 추가)
- Modify: `src/hooks/useWakeWord.ts` (엔진 유지)

**Interfaces:**
- Produces: `OpenWakeWordEngine.reset(): void` — 링 버퍼 비움 (`filled = 0`, `newSince = 0`).
- `useWakeWord` 외부 API (`startListening`/`stopListening`) 불변 — `App.device.tsx` 수정 없음.

- [ ] **Step 1: `openWakeWord.ts` 에 reset 추가** — `stop()` 아래:

```ts
  /** 링 버퍼를 비운다. 세션 간 엔진을 재사용할 때 이전 세션 오디오(직전
   * "비바야" 포함)가 남아 복귀 즉시 재트리거되는 것을 막는다. */
  reset() {
    this.filled = 0;
    this.newSince = 0;
  }
```

- [ ] **Step 2: `useWakeWord.ts` 수정** — 핵심 변경 3곳.

(a) `teardown` 을 두 단계로 분리 — 기존 `teardown` 을 `suspend`(엔진 유지)로 바꾸고, 완전 해제는 언마운트 전용 `destroy` 로:

```ts
  /** 오디오 피드만 내리고 엔진은 유지한다(세션 간 재사용).
   *
   * 예전엔 매번 엔진을 파괴하고 startListening 이 새로 만들었다 - JSI 수리
   * (≤1.5초) + ONNX 세션 3개 로드(3.2MB) + 2초 버퍼 재충전이 홈 복귀마다
   * 들어 "비바야" 가 ~15초 무반응이었다 (실기기 2026-08-12). 엔진은 앱 수명
   * 동안 1개, 세션 중엔 running=false 로 판정만 끊는다.
   */
  const suspend = useCallback(() => {
    try {
      LiveAudioStream?.stop?.();
    } catch {
      /* ignore */
    }
    try {
      engineRef.current?.stop?.();
    } catch {
      /* ignore */
    }
  }, []);

  /** 완전 해제 - 언마운트 전용. ONNX 세션 해제를 기다리지 않는 이유는 기존
   * 주석과 동일(추론 중 release 는 onnxruntime 이 멈춘다 - 2026-07-29). */
  const destroy = useCallback(() => {
    suspend();
    const engine = engineRef.current;
    engineRef.current = null;
    engine?.release?.().catch(() => {
      /* ignore */
    });
  }, [suspend]);

  useEffect(() => {
    return () => {
      activeRef.current = false;
      destroy();
    };
  }, [destroy]);
```

(b) `startListening` — 엔진이 있으면 재사용 (권한 체크 블록과 native-module 체크 블록 사이가 아니라, **엔진 생성 블록을 대체**):

```ts
      // 엔진 재사용: 있으면 버퍼만 비우고 재시작, 없으면(첫 기동) 생성+로드.
      let engine = engineRef.current;
      if (engine) {
        engine.reset();
      } else {
        engine = new OpenWakeWordEngine({
          onDetected: () => onDetectedRef.current(),
          onError: (err: unknown) => console.warn('[WakeWord] openWakeWord runtime error:', err),
        });
        await engine.load(OWW_ASSETS.mel, OWW_ASSETS.emb, OWW_ASSETS.ww);
        engineRef.current = engine;
      }
      engine.start();
```

이후의 Pi 스트림/폰 마이크 배선은 기존 그대로 (`engineRef.current` 를 읽는 클로저라 재사용 엔진에도 그대로 붙는다).

(c) `stopListening` 과 `startListening` 의 catch — `teardown` 호출을 각각 `suspend()` 로 교체 (실패 시에도 엔진은 살려둔다; 로드 자체가 실패한 경우 `engineRef` 는 애초에 안 채워져 있어 다음 start 가 새로 만든다).

주의: `engine.load()` 실패가 예외로 빠지면 기존 catch 가 잡는다 — `engineRef.current` 대입은 load 성공 후에만 한다 (위 코드 순서 그대로).

- [ ] **Step 3: 타입체크 + 기존 테스트**

Run: `cd viva-merged && npx tsc --noEmit && npx jest src/device/hooks/__tests__/useIntentLoop.test.ts`
Expected: 에러 0, 테스트 PASS (useWakeWord 는 기존 테스트 없음 — 실기기 검증 항목).

- [ ] **Step 4: Commit**

```bash
git add src/lib/openWakeWord.ts src/hooks/useWakeWord.ts
git commit -m "perf: 웨이크 ONNX 엔진 세션 간 유지 - 홈 복귀 후 ~15초 무반응 제거"
```

---

### Task 3: 개념 설명 자막 문장 단위 분할 (IntentScreen "..." 잘림 해소)

**배경:** `useIntentLoop.runConceptTurn` 이 3~6문장 설명 전체를 `setSubtitle` 한 방에 넣고, `IntentScreen` 이 `numberOfLines={3}` 으로 자르니 끝이 "..." 가 된다. ConversationScreen 은 이미 문장 분할 + 재생 길이 비례 타이밍으로 푼다 — 그 로직을 공유 유틸로 추출해 양쪽이 쓴다.

**Files:**
- Create: `src/utils/subtitleSchedule.ts`
- Create: `src/utils/__tests__/subtitleSchedule.test.ts`
- Modify: `src/device/hooks/useIntentLoop.ts` (runConceptTurn 발화 경로)
- Modify: `src/device/screens/ConversationScreen.tsx` (로컬 splitIntoSentences/비례 계산을 유틸 호출로 교체)
- Test: `src/device/hooks/__tests__/useIntentLoop.test.ts` (케이스 추가)

**Interfaces:**
- Produces:

```ts
// src/utils/subtitleSchedule.ts
export function splitIntoSentences(text: string): string[];
export interface SubtitleCue { sentence: string; showAtMs: number }
/** durationMs 를 문장 길이 비례로 배분한 표시 스케줄. 빈 텍스트면 []. */
export function buildSubtitleSchedule(text: string, durationMs: number): SubtitleCue[];
export const SUBTITLE_MS_PER_CHAR = 150; // durationMillis 가 0(파이 스피커 경로)일 때 추정치
```

- [ ] **Step 1: 유틸 + 실패하는 테스트 작성**

`src/utils/subtitleSchedule.ts`:

```ts
/**
 * TTS 자막 문장분할 + 표시 타이밍. ConversationScreen 에 있던 로직을
 * IntentScreen(개념 설명)과 공유하려고 추출했다 (2026-08-12).
 * 마지막 문장을 지우는 cue 는 일부러 없다 - 재생 길이 추정이 실제보다 짧게
 * 나와도 오디오가 끝날 때까지 자막이 화면을 덮어야 한다 (기존 주석 유지).
 */
export function splitIntoSentences(text: string): string[] {
  const matches = text.match(/[^.!?\n]+[.!?\n]*/g);
  if (!matches) return [text];
  return matches.map((s) => s.trim()).filter(Boolean);
}

export interface SubtitleCue {
  sentence: string;
  showAtMs: number;
}

// durationMillis 가 0으로 오는 경로(파이 스피커 sink)의 추정치.
export const SUBTITLE_MS_PER_CHAR = 150;

/** durationMs 를 문장 길이 비례로 배분한 표시 스케줄. durationMs 가 0 이하면
 * SUBTITLE_MS_PER_CHAR 로 전체 길이를 추정한다. */
export function buildSubtitleSchedule(text: string, durationMs: number): SubtitleCue[] {
  const sentences = splitIntoSentences(text);
  const totalLength = sentences.reduce((sum, s) => sum + s.length, 0);
  if (totalLength === 0) return [];
  const total = durationMs > 0 ? durationMs : totalLength * SUBTITLE_MS_PER_CHAR;
  const cues: SubtitleCue[] = [];
  let accumulated = 0;
  for (const sentence of sentences) {
    cues.push({ sentence, showAtMs: accumulated });
    accumulated += total * (sentence.length / totalLength);
  }
  return cues;
}
```

`src/utils/__tests__/subtitleSchedule.test.ts`:

```ts
import {
  splitIntoSentences,
  buildSubtitleSchedule,
  SUBTITLE_MS_PER_CHAR,
} from '../subtitleSchedule';

describe('splitIntoSentences', () => {
  it('마침표·물음표·느낌표·줄바꿈 단위로 나눈다', () => {
    expect(splitIntoSentences('약분은 분모와 분자를 같은 수로 나누는 거야. 쉽지? 해보자!')).toEqual([
      '약분은 분모와 분자를 같은 수로 나누는 거야.',
      '쉽지?',
      '해보자!',
    ]);
  });

  it('구두점이 없으면 통째로 한 문장', () => {
    expect(splitIntoSentences('안녕')).toEqual(['안녕']);
  });
});

describe('buildSubtitleSchedule', () => {
  it('duration 을 문장 길이 비례로 배분한다', () => {
    // 길이 5("가나다다.")와 5("라마바사.") - 각 50%씩
    const cues = buildSubtitleSchedule('가나다다. 라마바사.', 1000);
    expect(cues).toHaveLength(2);
    expect(cues[0].showAtMs).toBe(0);
    expect(cues[1].showAtMs).toBeCloseTo(500);
  });

  it('duration 0 이면 글자수 × SUBTITLE_MS_PER_CHAR 로 추정한다', () => {
    const cues = buildSubtitleSchedule('가나다다. 라마바사.', 0);
    expect(cues[1].showAtMs).toBeCloseTo(5 * SUBTITLE_MS_PER_CHAR);
  });

  it('빈 텍스트면 빈 배열', () => {
    expect(buildSubtitleSchedule('', 1000)).toEqual([]);
  });
});
```

- [ ] **Step 2: 유틸 테스트 실행**

Run: `cd viva-merged && npx jest src/utils/__tests__/subtitleSchedule.test.ts`
Expected: PASS (유틸은 새 파일이라 즉시 통과 — 실패 확인 단계는 훅 테스트 쪽에서).

- [ ] **Step 3: useIntentLoop 테스트 추가 (실패 확인)** — `useIntentLoop.test.ts` 에:

```ts
  it('concept 설명 자막: 문장 단위로 나눠 onPlay 시점부터 순차 표시한다', async () => {
    jest.useFakeTimers();
    const speak = jest.fn(
      async (_text: string, onPlay?: (d: number) => void) => {
        onPlay?.(1000);
      },
    ) as unknown as IntentLoopDeps['speak'];
    const { deps } = makeDeps({
      speak,
      classify: jest
        .fn()
        .mockResolvedValueOnce({ transcript: '약분이 뭐야', intent: 'concept' })
        .mockResolvedValue({ transcript: '', intent: 'unclear' }),
      explain: jest.fn().mockResolvedValue({
        message: '첫 문장이다. 둘째 문장이다.',
        board_prompt: '',
        usage: USAGE,
      }),
      fetchRecordStatus: jest
        .fn()
        .mockResolvedValueOnce({ recording: false, had_speech: true, rms: 0 })
        .mockResolvedValue({ recording: false, had_speech: false, rms: 0 }),
    });
    const { result } = await renderIntentLoop(deps); // 파일의 기존 렌더 헬퍼 사용
    await act(async () => {
      await result.current.begin();
    });
    // onPlay(1000) 직후 첫 문장, 절반 지나면 둘째 문장
    expect(result.current.subtitle).toBe('첫 문장이다.');
    await act(async () => {
      jest.advanceTimersByTime(600);
    });
    expect(result.current.subtitle).toBe('둘째 문장이다.');
    jest.useRealTimers();
  });
```

(주의: 파일의 실제 렌더 헬퍼/패턴에 맞춰 조정 — 기존 12개 케이스가 쓰는 방식 그대로. `explain` 반환 타입도 기존 케이스와 동일 형태 유지.)

Run: `cd viva-merged && npx jest src/device/hooks/__tests__/useIntentLoop.test.ts -t "concept 설명 자막"`
Expected: FAIL — 현재는 전체 텍스트가 한 방에 subtitle 로 들어간다.

- [ ] **Step 4: useIntentLoop 구현** — `runConceptTurn` 의 자막+발화 경로 교체.

임포트 추가:

```ts
import { buildSubtitleSchedule } from '../../utils/subtitleSchedule';
```

훅 안에 타이머 관리 (기존 ref 들 옆):

```ts
  const subtitleTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearSubtitleTimers = useCallback(() => {
    subtitleTimersRef.current.forEach(clearTimeout);
    subtitleTimersRef.current = [];
  }, []);
  // 언마운트 후 setSubtitle 이 돌지 않게 타이머를 걷는다.
  useEffect(() => clearSubtitleTimers, [clearSubtitleTimers]);
```

(`useEffect` 임포트 추가 필요: `import { useCallback, useEffect, useRef, useState } from 'react';`)

`runConceptTurn` 의 기존 두 줄

```ts
    setSubtitle(cleanMathForSubtitle(res.message));
    ...
    await deps.speak(cleanMathForTTS(res.message)).catch(() => {});
```

을 다음으로 교체 (`setSubtitle(...)` 한 방 표시는 삭제, board 병렬 생성 등 나머지는 그대로):

```ts
    const subtitleText = cleanMathForSubtitle(res.message);
    ...
    setPhase('speaking');
    // 전체 텍스트 한 방 표시는 numberOfLines 에 잘려 "..." 가 됐다 - 문장
    // 단위로 나눠 재생 길이 비례로 순차 표시한다 (ConversationScreen 과 동일
    // 문법, 2026-08-12 피드백). onPlay 는 재생 시작 시점에 불린다 - 파이
    // 스피커 경로는 duration 0 으로 오고 유틸이 글자수로 추정한다.
    await deps
      .speak(cleanMathForTTS(res.message), (durationMillis) => {
        clearSubtitleTimers();
        buildSubtitleSchedule(subtitleText, durationMillis).forEach(({ sentence, showAtMs }) => {
          if (showAtMs <= 0) {
            setSubtitle(sentence);
            return;
          }
          subtitleTimersRef.current.push(setTimeout(() => setSubtitle(sentence), showAtMs));
        });
      })
      .catch(() => {});
```

`exitWith` 첫 줄에 `clearSubtitleTimers();` 추가 (설명 자막 타이머가 종료 문구를 덮어쓰지 않게). `runSolve` 진입부(`setPhase('analyzing')` 옆)에도 `clearSubtitleTimers();` 추가.

고정 문구(인사/필러/종료/다문제)는 한 문장이라 기존 `setSubtitle` 한 방 유지.

- [ ] **Step 5: 테스트 통과 확인**

Run: `cd viva-merged && npx jest src/device/hooks/__tests__/useIntentLoop.test.ts`
Expected: 전부 PASS (기존 케이스 포함 — 기존 fake speak 는 onPlay 를 안 부르므로 자막이 안 바뀔 뿐 깨지지 않는다).

- [ ] **Step 6: ConversationScreen 을 유틸로 교체** — 로컬 `splitIntoSentences`(176-180행) 삭제, `startSubtitles` 내부의 비례 계산을 `buildSubtitleSchedule` 호출로 교체:

```ts
import { buildSubtitleSchedule, SUBTITLE_MS_PER_CHAR } from '../../utils/subtitleSchedule';
```

```ts
  const startSubtitles = useCallback(
    (text: string, durationMs: number) => {
      clearSubtitleTimeouts();
      const cues = buildSubtitleSchedule(text, durationMs);
      if (cues.length === 0) {
        setCurrentSubtitle('');
        return;
      }
      // Intentionally no final "clear" timeout here: (기존 주석 그대로 유지)
      cues.forEach(({ sentence, showAtMs }) => {
        const id = setTimeout(() => {
          setCurrentSubtitle(sentence);
        }, showAtMs);
        subtitleTimeouts.current.push(id);
      });
    },
    [clearSubtitleTimeouts],
  );
```

`customSpeak` 의 로컬 `const MS_PER_CHAR = 150;` 은 `SUBTITLE_MS_PER_CHAR` 로 교체.

- [ ] **Step 7: 전체 검증**

Run: `cd viva-merged && npx tsc --noEmit && npx jest src/utils/__tests__/subtitleSchedule.test.ts src/device/hooks/__tests__/useIntentLoop.test.ts src/device/screens/__tests__/IntentScreen.test.tsx`
Expected: 에러 0, 전부 PASS.

- [ ] **Step 8: Commit**

```bash
git add src/utils/subtitleSchedule.ts src/utils/__tests__/subtitleSchedule.test.ts src/device/hooks/useIntentLoop.ts src/device/screens/ConversationScreen.tsx src/device/hooks/__tests__/useIntentLoop.test.ts
git commit -m "feat: 개념 설명 자막 문장 단위 분할 표시 - IntentScreen '...' 잘림 해소"
```

---

### Task 4: `done` 의도 추가 ("이해했어" → 고정 종료 문구)

**배경:** 개념 설명 후 "이제 됐어/이해했어" 는 현재 `unclear` 로 분류돼 엉뚱한 문구(`수학 개념이나 문제가 궁금하면 다시 불러줘!`)로 종료된다. `done` 의도를 추가해 `또 궁금한 거 있으면 언제든 불러줘!`(기존 `CONCEPT_EXIT_PHRASE`)로 종료한다. 무응답 경로는 이미 맞는 문구로 나간다 — 건드리지 않는다.

**Files:**
- Modify: `src/services/geminiStt.service.ts`
- Modify: `src/device/hooks/useIntentLoop.ts` (begin 루프 분기 1개)
- Test: `src/device/hooks/__tests__/useIntentLoop.test.ts`

**Interfaces:**
- Produces: `StudentIntent = 'solve' | 'concept' | 'unclear' | 'done'`.

- [ ] **Step 1: 실패하는 테스트 작성** — `useIntentLoop.test.ts` 에 (파일의 기존 concept→무응답 케이스와 같은 패턴):

```ts
  it('concept 후 done("이해했어"): CONCEPT_EXIT_PHRASE 를 말하고 종료한다', async () => {
    const { deps, spoken } = makeDeps({
      classify: jest
        .fn()
        .mockResolvedValueOnce({ transcript: '약분이 뭐야', intent: 'concept' })
        .mockResolvedValueOnce({ transcript: '이제 이해했어', intent: 'done' }),
      explain: jest.fn().mockResolvedValue({
        message: '약분은 분모와 분자를 같은 수로 나누는 거야.',
        board_prompt: '',
        usage: USAGE,
      }),
      fetchRecordStatus: jest
        .fn()
        .mockResolvedValue({ recording: false, had_speech: true, rms: 0 }),
    });
    const onExit = jest.fn();
    // ... 파일의 기존 렌더/실행 패턴 그대로 begin() 실행 ...
    expect(spoken).toContain(CONCEPT_EXIT_PHRASE);
    expect(spoken).not.toContain(UNCLEAR_EXIT_PHRASE);
    expect(onExit).toHaveBeenCalled();
  });
```

Run: `cd viva-merged && npx jest src/device/hooks/__tests__/useIntentLoop.test.ts -t "done"`
Expected: FAIL — `done` 이 `StudentIntent` 에 없어 타입 에러거나, unclear 취급돼 UNCLEAR_EXIT_PHRASE 가 나온다.

- [ ] **Step 2: geminiStt.service.ts 구현**

```ts
export type StudentIntent = 'solve' | 'concept' | 'unclear' | 'done';
```

`CLASSIFY_PROMPT` 의 intent 분류 절에 unclear 줄 **앞**에 추가:

```ts
  '- "done": 직전 설명을 이해했다/그만하겠다는 짧은 마무리 대답. 예: "이제 됐어", "이해했어", "알겠어", "응 고마워".',
```

`CLASSIFY_SCHEMA` 의 enum 과 출력 형식 줄 갱신:

```ts
    intent: { type: SchemaType.STRING, enum: ['solve', 'concept', 'unclear', 'done'] },
```

```ts
  '출력은 JSON 만: {"transcript": "...", "intent": "solve|concept|unclear|done"}',
```

```ts
const INTENTS: StudentIntent[] = ['solve', 'concept', 'unclear', 'done'];
```

- [ ] **Step 3: useIntentLoop 분기 추가** — `begin` 루프의 unclear 분기 **앞**에:

```ts
        if (intent === 'done') {
          // "이해했어/이제 됐어" - 개념 대화의 정상 마무리 (2026-08-12 스펙).
          await exitWith(CONCEPT_EXIT_PHRASE);
          return;
        }
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd viva-merged && npx tsc --noEmit && npx jest src/device/hooks/__tests__/useIntentLoop.test.ts`
Expected: 에러 0, 전부 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/geminiStt.service.ts src/device/hooks/useIntentLoop.ts src/device/hooks/__tests__/useIntentLoop.test.ts
git commit -m "feat: done 의도 추가 - '이해했어' 를 고정 종료 문구로 마무리"
```

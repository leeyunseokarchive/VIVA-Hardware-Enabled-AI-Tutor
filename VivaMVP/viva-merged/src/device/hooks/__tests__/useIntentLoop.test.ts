/**
 * Unit tests for useIntentLoop (의도파악 상태기계).
 *
 * 전부 fake deps 주입으로 돈다 (모듈 mock 없음) - useVoiceInput.test.ts 와
 * 동일한 패턴. `sleep` fake 는 즉시 resolve 해 타이머 없이 진행하고,
 * `fetchRecordStatus` 는 시나리오별 시퀀스로 스텁한다.
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import {
  useIntentLoop,
  UseIntentLoopResult,
  IntentLoopDeps,
  GREETING_PHRASE,
  FILLER_PHRASE,
  MULTI_PROBLEM_QUESTION,
  buildRecheckPhrase,
  NO_SPEECH_EXIT_PHRASE,
  UNCLEAR_EXIT_PHRASE,
  CONCEPT_EXIT_PHRASE,
} from '../useIntentLoop';
import type { GeminiTutoringResponse, TutoringSession } from '../../../types/Tutoring';
import type { TokenUsage } from '../../../types/ApiUsage';
import { cleanMathForTTS } from '../../../utils/mathTextProcessor';

// --- fixtures ----------------------------------------------------------------

const USAGE: TokenUsage = { promptTokens: 0, candidateTokens: 0, totalTokens: 0 };

const SESSION: TutoringSession = {
  sessionId: 'intent-test',
  problemImageBase64: '',
  fsmState: 'HINT_STAGE',
  hintCount: 0,
  wrongStreak: 0,
  boardRegenerationCount: 0,
};

function makeAnalysis(
  overrides: Partial<GeminiTutoringResponse> = {},
): GeminiTutoringResponse & { usage: TokenUsage } {
  return {
    fsm_state: 'HINT_STAGE',
    explicit_answer_request: false,
    is_on_correct_path: null,
    requires_board: false,
    board_update_needed: false,
    message: '자 풀어보자',
    board_prompt: '',
    confidence: 1,
    error_type: 'NONE',
    topic: '이차방정식',
    title: '문제',
    usage: USAGE,
    ...overrides,
  };
}

// --- fake deps -----------------------------------------------------------------

/** 매 테스트가 최소 하나는 오버라이드하는 필드만 파라미터로 받고, 나머지는
 * 부작용 없는 기본값(빈 문제, unclear 분류)으로 채운다. */
function makeDeps(overrides: Partial<IntentLoopDeps> = {}): {
  deps: IntentLoopDeps;
  spoken: string[];
} {
  const spoken: string[] = [];
  const base: IntentLoopDeps = {
    speak: jest.fn(async (text: string) => {
      spoken.push(text);
    }) as unknown as IntentLoopDeps['speak'],
    startRecording: jest.fn().mockResolvedValue(undefined),
    stopRecording: jest.fn().mockResolvedValue(undefined),
    fetchRecordStatus: jest.fn().mockResolvedValue({ recording: false, had_speech: false }),
    fetchAudio: jest.fn().mockResolvedValue('wav-base64'),
    capturePhoto: jest.fn().mockResolvedValue(undefined),
    fetchPhoto: jest.fn().mockResolvedValue('photo-base64'),
    fetchCrop: jest.fn().mockResolvedValue('crop-base64'),
    detect: jest.fn().mockResolvedValue({ problems: [], usage: USAGE }),
    classify: jest.fn().mockResolvedValue({ transcript: '', intent: 'unclear' }),
    classifyText: jest.fn().mockResolvedValue({ transcript: '', intent: 'unclear' }),
    explain: jest.fn().mockResolvedValue({ message: '', board_prompt: '', usage: USAGE }),
    fetchConcepts: jest.fn().mockResolvedValue([]),
    analyze: jest.fn().mockResolvedValue(makeAnalysis()),
    generateBoard: jest.fn().mockResolvedValue({ imageBase64: 'board-base64' }),
    probeNow: jest.fn().mockResolvedValue(true),
    sendEyeState: jest.fn(),
    sleep: jest.fn().mockResolvedValue(undefined),
  };
  return { deps: { ...base, ...overrides }, spoken };
}

function renderIntentLoop(deps: IntentLoopDeps, sessionOverrides: Partial<TutoringSession> = {}) {
  const onAnalyzed = jest.fn();
  const onPhoneCamera = jest.fn();
  const onExit = jest.fn();
  const ref: { current: UseIntentLoopResult | null } = { current: null };

  function Harness() {
    ref.current = useIntentLoop({
      session: { ...SESSION, ...sessionOverrides },
      solveMode: false,
      onAnalyzed,
      onPhoneCamera,
      onExit,
      deps,
      pollIntervalMs: 0,
      noSpeechTimeoutMs: 8000,
    });
    return null;
  }

  act(() => {
    ReactTestRenderer.create(React.createElement(Harness));
  });

  return { ref: ref as { current: UseIntentLoopResult }, onAnalyzed, onPhoneCamera, onExit };
}

/** 마이크로태스크 큐를 전부 비운다 (실제 타이머는 안 씀 - sleep 이
 * Promise.resolve() 로 페이크돼 있어 setImmediate 매크로태스크 진입 전에
 * 체인 전체가 이미 다 풀린다). */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** recording 상태 시퀀스를 순서대로 반환하는 fetchRecordStatus 스텁. */
function statusSequence(...statuses: { recording: boolean; had_speech: boolean }[]) {
  const fn = jest.fn();
  statuses.forEach((s) => fn.mockResolvedValueOnce(s));
  return fn;
}

// --- scenarios -----------------------------------------------------------------

describe('useIntentLoop', () => {
  // 1. solve 단일 문제
  it('solve 단일 문제: 사전분석 완료 상태에서 크롭 후 분석해 onAnalyzed 로 핸드오프한다 (detect usage 합산 포함, M1)', async () => {
    const box = [100, 100, 400, 400];
    const detectUsage: TokenUsage = { promptTokens: 50, candidateTokens: 10, totalTokens: 60 };
    const analyzeUsage: TokenUsage = { promptTokens: 200, candidateTokens: 80, totalTokens: 280 };
    const { deps, spoken } = makeDeps({
      fetchRecordStatus: statusSequence(
        { recording: true, had_speech: true },
        { recording: false, had_speech: true },
      ),
      classify: jest.fn().mockResolvedValue({ transcript: '이 문제 풀어줘', intent: 'solve' }),
      detect: jest
        .fn()
        .mockResolvedValue({ problems: [{ label: '3번', box_2d: box }], usage: detectUsage }),
      analyze: jest.fn().mockResolvedValue({
        ...makeAnalysis({ problems: [{ label: '3번', box_2d: box }] }),
        usage: analyzeUsage,
      }),
    });
    const { ref, onAnalyzed } = renderIntentLoop(deps);

    await act(async () => {
      await ref.current.begin();
    });

    expect(spoken[0]).toBe(GREETING_PHRASE);
    expect(deps.fetchCrop).toHaveBeenCalledWith(box);
    expect(onAnalyzed).toHaveBeenCalledTimes(1);
    const [analysis, image, question] = onAnalyzed.mock.calls[0];
    expect(question).toBe('이 문제 풀어줘');
    expect(image).toBe('crop-base64');
    expect(analysis.problems).toBeUndefined(); // 크롭본이라 벗겨진다
    // 사전분석(detect) 토큰이 풀분석 usage 에 접힌다 (M1 스펙).
    expect(analysis.usage).toEqual({
      promptTokens: detectUsage.promptTokens + analyzeUsage.promptTokens,
      candidateTokens: detectUsage.candidateTokens + analyzeUsage.candidateTokens,
      totalTokens: detectUsage.totalTokens + analyzeUsage.totalTokens,
    });
  });

  // 2. solve 다문제 - 번호 매칭 성공
  it('solve 다문제: 되묻고 "60번" 대답을 매칭해 해당 bbox 를 크롭한다', async () => {
    const box59 = [0, 0, 100, 100];
    const box60 = [200, 200, 300, 300];
    const { deps, spoken } = makeDeps({
      fetchRecordStatus: statusSequence(
        { recording: true, had_speech: true },
        { recording: false, had_speech: true },
        { recording: true, had_speech: true },
        { recording: false, had_speech: true },
      ),
      classify: jest
        .fn()
        .mockResolvedValueOnce({ transcript: '이 문제 풀어줘', intent: 'solve' })
        .mockResolvedValueOnce({ transcript: '60번', intent: 'solve' }),
      detect: jest.fn().mockResolvedValue({
        problems: [
          { label: '59번', box_2d: box59 },
          { label: '60번', box_2d: box60 },
        ],
        usage: USAGE,
      }),
    });
    const { ref, onAnalyzed } = renderIntentLoop(deps);

    await act(async () => {
      await ref.current.begin();
    });

    expect(spoken).toContain(MULTI_PROBLEM_QUESTION);
    expect(deps.fetchCrop).toHaveBeenCalledWith(box60);
    expect(onAnalyzed).toHaveBeenCalledTimes(1);
  });

  // 3. solve 다문제 - 번호 추출 실패
  it('solve 다문제 + 번호 추출 실패: 재질문 없이 풀프레임으로 분석한다', async () => {
    const box1 = [0, 0, 100, 100];
    const box2 = [200, 200, 300, 300];
    const problems = [
      { label: '59번', box_2d: box1 },
      { label: '60번', box_2d: box2 },
    ];
    const { deps } = makeDeps({
      fetchRecordStatus: statusSequence(
        { recording: true, had_speech: true },
        { recording: false, had_speech: true },
        { recording: true, had_speech: true },
        { recording: false, had_speech: true },
      ),
      classify: jest
        .fn()
        .mockResolvedValueOnce({ transcript: '이 문제 풀어줘', intent: 'solve' })
        .mockResolvedValueOnce({ transcript: '몰라', intent: 'solve' }),
      detect: jest.fn().mockResolvedValue({ problems, usage: USAGE }),
      analyze: jest.fn().mockResolvedValue(makeAnalysis({ problems })),
    });
    const { ref, onAnalyzed } = renderIntentLoop(deps);

    await act(async () => {
      await ref.current.begin();
    });

    expect(deps.fetchCrop).not.toHaveBeenCalled();
    expect(onAnalyzed).toHaveBeenCalledTimes(1);
    const [analysis, image] = onAnalyzed.mock.calls[0];
    expect(image).toBe('photo-base64'); // scan.photo 그대로
    expect(analysis.problems).toEqual(problems); // 풀프레임이라 벗기지 않는다
  });

  // 3.5. 발화 번호 즉시 매칭 - 되묻기 생략 (2026-08-14)
  it('첫 발화에 번호("524번")가 있고 감지에 매칭되면 되묻기 없이 바로 크롭·분석한다', async () => {
    const box523 = [0, 0, 100, 100];
    const box524 = [200, 200, 300, 300];
    const { deps, spoken } = makeDeps({
      fetchRecordStatus: statusSequence(
        { recording: true, had_speech: true },
        { recording: false, had_speech: true },
      ),
      classify: jest
        .fn()
        .mockResolvedValue({ transcript: '524번 문제 어떻게 풀어?', intent: 'solve' }),
      detect: jest.fn().mockResolvedValue({
        problems: [
          { label: '523번', box_2d: box523 },
          { label: '524번', box_2d: box524 },
        ],
        usage: USAGE,
      }),
    });
    const { ref, onAnalyzed } = renderIntentLoop(deps);

    await act(async () => {
      await ref.current.begin();
    });

    expect(spoken).not.toContain(MULTI_PROBLEM_QUESTION);
    expect(deps.fetchCrop).toHaveBeenCalledWith(box524);
    expect(onAnalyzed).toHaveBeenCalledTimes(1);
    expect(onAnalyzed.mock.calls[0][2]).toBe('524번 문제 어떻게 풀어?');
  });

  // 3.6. 발화 번호 미감지 - 재촬영 1회 후 매칭 성공
  it('발화 번호가 감지에 없으면 재확인 문구 후 재촬영+재감지 1회로 재매칭한다', async () => {
    const box524 = [200, 200, 300, 300];
    const { deps, spoken } = makeDeps({
      fetchRecordStatus: statusSequence(
        { recording: true, had_speech: true },
        { recording: false, had_speech: true },
      ),
      classify: jest
        .fn()
        .mockResolvedValue({ transcript: '524번 문제 어떻게 풀어?', intent: 'solve' }),
      detect: jest
        .fn()
        .mockResolvedValueOnce({ problems: [{ label: '300번', box_2d: [0, 0, 9, 9] }], usage: USAGE })
        .mockResolvedValueOnce({ problems: [{ label: '524번', box_2d: box524 }], usage: USAGE }),
    });
    const { ref, onAnalyzed } = renderIntentLoop(deps);

    await act(async () => {
      await ref.current.begin();
    });

    expect(spoken).toContain(buildRecheckPhrase(524));
    expect(spoken).not.toContain(MULTI_PROBLEM_QUESTION);
    expect(deps.capturePhoto).toHaveBeenCalledTimes(2);
    expect(deps.fetchCrop).toHaveBeenCalledWith(box524);
    expect(onAnalyzed).toHaveBeenCalledTimes(1);
  });

  // 3.6.1 재확인 문구 자막도 onPlay 이후에만 뜬다 (Finding 1, 2026-08-14 리뷰
  // - speak 호출 전 선표시는 TTS 합성 왕복만큼 자막이 나레이션을 앞섰다).
  it('재확인 문구는 speak 전엔 자막이 안 뜨고 onPlay 시점에 뜬다', async () => {
    const box524 = [200, 200, 300, 300];
    const recheck = buildRecheckPhrase(524);
    const holder: { subtitleAtSpeakStart: string | null } = { subtitleAtSpeakStart: null };
    let ref: { current: UseIntentLoopResult };
    const speak = jest.fn(async (text: string, onPlay?: (d: number) => void) => {
      if (text === recheck) {
        holder.subtitleAtSpeakStart = ref.current.subtitle;
      }
      onPlay?.(0);
    }) as unknown as IntentLoopDeps['speak'];
    const { deps } = makeDeps({
      speak,
      fetchRecordStatus: statusSequence(
        { recording: true, had_speech: true },
        { recording: false, had_speech: true },
      ),
      classify: jest
        .fn()
        .mockResolvedValue({ transcript: '524번 문제 어떻게 풀어?', intent: 'solve' }),
      detect: jest
        .fn()
        .mockResolvedValueOnce({ problems: [{ label: '300번', box_2d: [0, 0, 9, 9] }], usage: USAGE })
        .mockResolvedValueOnce({ problems: [{ label: '524번', box_2d: box524 }], usage: USAGE }),
    });
    ({ ref } = renderIntentLoop(deps));

    await act(async () => {
      await ref.current.begin();
    });

    // speak 가 불린 시점엔 아직 재확인 문구가 떠 있으면 안 된다(선표시 금지).
    expect(holder.subtitleAtSpeakStart).not.toBe(recheck);
  });

  // 3.7. 재촬영 후에도 미감지 - 풀프레임 + problems 제거 (FSM 2차 되묻기 방지)
  it('재촬영 후에도 발화 번호가 없으면 풀프레임으로 분석하고 problems 를 벗긴다', async () => {
    const others = [{ label: '300번', box_2d: [0, 0, 9, 9] }];
    const { deps, spoken } = makeDeps({
      fetchRecordStatus: statusSequence(
        { recording: true, had_speech: true },
        { recording: false, had_speech: true },
      ),
      classify: jest
        .fn()
        .mockResolvedValue({ transcript: '524번 문제 어떻게 풀어?', intent: 'solve' }),
      detect: jest.fn().mockResolvedValue({ problems: others, usage: USAGE }),
      analyze: jest.fn().mockResolvedValue(makeAnalysis({ problems: others })),
    });
    const { ref, onAnalyzed } = renderIntentLoop(deps);

    await act(async () => {
      await ref.current.begin();
    });

    expect(spoken).toContain(buildRecheckPhrase(524));
    expect(deps.capturePhoto).toHaveBeenCalledTimes(2);
    expect(deps.fetchCrop).not.toHaveBeenCalled();
    expect(onAnalyzed).toHaveBeenCalledTimes(1);
    const [analysis, image] = onAnalyzed.mock.calls[0];
    expect(image).toBe('photo-base64'); // 풀프레임
    expect(analysis.problems).toBeUndefined(); // 번호를 이미 말했으니 FSM 되묻기 차단
  });

  // 4. 무응답
  it('무응답: noSpeechTimeoutMs 도달 시 stopRecording 후 NO_SPEECH_EXIT_PHRASE 를 말하고 종료한다', async () => {
    const { deps, spoken } = makeDeps({
      fetchRecordStatus: jest.fn().mockResolvedValue({ recording: true, had_speech: false }),
    });
    const onAnalyzed = jest.fn();
    const onPhoneCamera = jest.fn();
    const onExit = jest.fn();
    const ref: { current: UseIntentLoopResult | null } = { current: null };
    function Harness() {
      ref.current = useIntentLoop({
        session: SESSION,
        solveMode: false,
        onAnalyzed,
        onPhoneCamera,
        onExit,
        deps,
        pollIntervalMs: 0,
        noSpeechTimeoutMs: 0,
      });
      return null;
    }
    act(() => {
      ReactTestRenderer.create(React.createElement(Harness));
    });

    await act(async () => {
      await ref.current!.begin();
    });

    expect(deps.stopRecording).toHaveBeenCalled();
    expect(spoken).toContain(NO_SPEECH_EXIT_PHRASE);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  // 5. unclear
  it('unclear: UNCLEAR_EXIT_PHRASE 를 말하고 종료한다', async () => {
    const { deps, spoken } = makeDeps({
      fetchRecordStatus: statusSequence(
        { recording: true, had_speech: true },
        { recording: false, had_speech: true },
      ),
      classify: jest.fn().mockResolvedValue({ transcript: '오늘 날씨 어때', intent: 'unclear' }),
    });
    const { ref, onExit } = renderIntentLoop(deps);

    await act(async () => {
      await ref.current.begin();
    });

    expect(spoken).toContain(UNCLEAR_EXIT_PHRASE);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  // 6. concept 1턴 후 solve 전환
  it('concept 1턴 후 solve 로 전환: explain 호출 후 두 번째 classify(solve) 로 runSolve 진입한다', async () => {
    const { deps, spoken } = makeDeps({
      fetchRecordStatus: statusSequence(
        { recording: true, had_speech: true },
        { recording: false, had_speech: true },
        { recording: true, had_speech: true },
        { recording: false, had_speech: true },
      ),
      classify: jest
        .fn()
        .mockResolvedValueOnce({ transcript: 'sin이 뭐야', intent: 'concept' })
        .mockResolvedValueOnce({ transcript: '이 문제 풀어줘', intent: 'solve' }),
      explain: jest
        .fn()
        .mockResolvedValue({ message: 'sin은 사인이야', board_prompt: '', usage: USAGE }),
    });
    const { ref, onAnalyzed } = renderIntentLoop(deps);

    await act(async () => {
      await ref.current.begin();
    });

    expect(deps.explain).toHaveBeenCalledTimes(1);
    // historyRef.current 는 이후 push 로 계속 변하는 같은 배열 참조라
    // mock.calls 에 남는 건 "호출 당시" 가 아니라 "최종" 상태다 - 내용 대신
    // 첫 인자(질문)와 세 번째 인자(직전 판서)만 단언한다.
    expect(deps.explain).toHaveBeenCalledWith(
      'sin이 뭐야',
      expect.any(Array),
      undefined,
      expect.any(Array),
    );
    expect(spoken).toContain(cleanMathForTTS('sin은 사인이야')); // TTS 는 수식 정규화를 거친다
    expect(onAnalyzed).toHaveBeenCalledTimes(1);
  });

  // 7. concept 후 무응답
  it('concept 후 무응답: CONCEPT_EXIT_PHRASE 를 말하고 종료한다', async () => {
    const { deps, spoken } = makeDeps({
      fetchRecordStatus: jest
        .fn()
        .mockResolvedValueOnce({ recording: true, had_speech: true })
        .mockResolvedValueOnce({ recording: false, had_speech: true })
        .mockResolvedValue({ recording: true, had_speech: false }),
      classify: jest.fn().mockResolvedValue({ transcript: 'sin이 뭐야', intent: 'concept' }),
      explain: jest
        .fn()
        .mockResolvedValue({ message: 'sin은 사인이야', board_prompt: '', usage: USAGE }),
    });
    const onAnalyzed = jest.fn();
    const onPhoneCamera = jest.fn();
    const onExit = jest.fn();
    const ref: { current: UseIntentLoopResult | null } = { current: null };
    function Harness() {
      ref.current = useIntentLoop({
        session: SESSION,
        solveMode: false,
        onAnalyzed,
        onPhoneCamera,
        onExit,
        deps,
        pollIntervalMs: 0,
        noSpeechTimeoutMs: 0,
      });
      return null;
    }
    act(() => {
      ReactTestRenderer.create(React.createElement(Harness));
    });

    await act(async () => {
      await ref.current!.begin();
    });

    expect(spoken).toContain(CONCEPT_EXIT_PHRASE);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  // 7.5. concept 후 done("이해했어")
  it('concept 후 done("이해했어"): CONCEPT_EXIT_PHRASE 를 말하고 종료한다', async () => {
    const { deps, spoken } = makeDeps({
      classify: jest
        .fn()
        .mockResolvedValueOnce({ transcript: '약분이 뭐야', intent: 'concept' })
        .mockResolvedValueOnce({ transcript: '이제 이해했어', intent: 'done' })
        // done 이 즉시 종료하지 않고 계속 청취하면 여기 걸린다 - classify
        // 실패는 resolveInput 이 unclear 로 접어 UNCLEAR_EXIT_PHRASE 로 새는
        // 회귀를 잡기 위한 파수꾼(sentinel) 값.
        .mockRejectedValueOnce(new Error('done 후 추가 턴이 있으면 안 됨')),
      explain: jest.fn().mockResolvedValue({
        message: '약분은 분모와 분자를 같은 수로 나누는 거야.',
        board_prompt: '',
        usage: USAGE,
      }),
      fetchRecordStatus: jest
        .fn()
        .mockResolvedValue({ recording: false, had_speech: true, rms: 0 }),
    });
    const { ref, onExit } = renderIntentLoop(deps);

    await act(async () => {
      await ref.current.begin();
    });

    expect(spoken).toContain(CONCEPT_EXIT_PHRASE);
    expect(spoken).not.toContain(UNCLEAR_EXIT_PHRASE);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  // 7.6. 등록 개념 - fetch 목록 히트
  it('concept_id 가 fetch 된 목록에 있으면 {uri} asset 을 쓰고 generateBoard 를 부르지 않는다', async () => {
    const { deps } = makeDeps({
      fetchRecordStatus: jest
        .fn()
        .mockResolvedValue({ recording: false, had_speech: true, rms: 0 }),
      classify: jest
        .fn()
        .mockResolvedValueOnce({ transcript: 'sin이 뭐야', intent: 'concept' })
        .mockResolvedValueOnce({ transcript: '이해했어', intent: 'done' }),
      fetchConcepts: jest.fn().mockResolvedValue([
        {
          id: 'trigonometric-ratio',
          name: '삼각비',
          aliases: ['sin', 'cos'],
          sketch: '직각삼각형',
          imageUrl: 'https://cdn.test/trigonometric-ratio.png',
        },
      ]),
      explain: jest.fn().mockResolvedValue({
        message: '삼각비는 이런 거야.',
        board_prompt: '단위원 그림',
        concept_id: 'trigonometric-ratio',
        usage: USAGE,
      }),
    });
    const { ref } = renderIntentLoop(deps);

    await act(async () => {
      await ref.current.begin();
    });

    expect(deps.generateBoard).not.toHaveBeenCalled();
    expect(ref.current.boardAsset).toEqual({ uri: 'https://cdn.test/trigonometric-ratio.png' });
    expect(deps.explain).toHaveBeenCalledWith(
      'sin이 뭐야',
      expect.any(Array),
      undefined,
      expect.arrayContaining([expect.objectContaining({ id: 'trigonometric-ratio' })]),
    );
  });

  // 7.7. 미등록 개념 - 기존 생성 폴백
  it('concept_id 가 registry 에 없으면 기존 generateBoard 폴백', async () => {
    const { deps } = makeDeps({
      fetchRecordStatus: jest
        .fn()
        .mockResolvedValue({ recording: false, had_speech: true, rms: 0 }),
      classify: jest
        .fn()
        .mockResolvedValueOnce({ transcript: '위상수학이 뭐야', intent: 'concept' })
        .mockResolvedValueOnce({ transcript: '이해했어', intent: 'done' }),
      explain: jest.fn().mockResolvedValue({
        message: '위상수학은...',
        board_prompt: '도넛과 컵 그림',
        concept_id: '',
        usage: USAGE,
      }),
    });
    const { ref } = renderIntentLoop(deps);

    await act(async () => {
      await ref.current.begin();
    });

    expect(deps.generateBoard).toHaveBeenCalled();
    expect(ref.current.boardAsset).toBeNull();
  });

  // 7.7b. imageUrl 없는 메타 행 - 등록 목록에서 제외돼 생성 폴백 (최종 리뷰 I1)
  it('imageUrl 없는 개념은 explain 목록에서 빠져 concept_id 로 매치되지 않고 generateBoard 폴백', async () => {
    const { deps } = makeDeps({
      fetchRecordStatus: jest
        .fn()
        .mockResolvedValue({ recording: false, had_speech: true, rms: 0 }),
      classify: jest
        .fn()
        .mockResolvedValueOnce({ transcript: '이거 뭐야', intent: 'concept' })
        .mockResolvedValueOnce({ transcript: '이해했어', intent: 'done' }),
      fetchConcepts: jest.fn().mockResolvedValue([
        {
          id: 'trigonometric-ratio',
          name: '삼각비',
          aliases: ['sin', 'cos'],
          sketch: '직각삼각형',
          imageUrl: 'https://cdn.test/trigonometric-ratio.png',
        },
        {
          id: 'no-image-yet',
          name: '아직없음',
          aliases: [],
          sketch: '',
        },
      ]),
      explain: jest.fn().mockResolvedValue({
        message: '생성 그림으로 보여줄게.',
        board_prompt: '생성 그림',
        concept_id: 'no-image-yet',
        usage: USAGE,
      }),
    });
    const { ref } = renderIntentLoop(deps);

    await act(async () => {
      await ref.current.begin();
    });

    expect(deps.explain).toHaveBeenCalledWith('이거 뭐야', expect.any(Array), undefined, [
      expect.objectContaining({
        id: 'trigonometric-ratio',
        imageUrl: 'https://cdn.test/trigonometric-ratio.png',
      }),
    ]);
    expect(deps.generateBoard).toHaveBeenCalled();
    expect(ref.current.boardAsset).toBeNull();
  });

  // 7.8. 말로만 답한 턴 - 이전 판서/이미지 제거 (WS1 리뷰 반영)
  it('concept_id 와 board_prompt 가 둘 다 빈 문자열이면 이전 턴의 판서/이미지를 지운다', async () => {
    const { deps } = makeDeps({
      fetchRecordStatus: jest
        .fn()
        .mockResolvedValue({ recording: false, had_speech: true, rms: 0 }),
      classify: jest
        .fn()
        .mockResolvedValueOnce({ transcript: 'sin이 뭐야', intent: 'concept' })
        .mockResolvedValueOnce({ transcript: '그럼 cos는?', intent: 'concept' })
        .mockResolvedValueOnce({ transcript: '이해했어', intent: 'done' }),
      fetchConcepts: jest.fn().mockResolvedValue([
        {
          id: 'trigonometric-ratio',
          name: '삼각비',
          aliases: ['sin', 'cos'],
          sketch: '직각삼각형',
          imageUrl: 'https://cdn.test/trigonometric-ratio.png',
        },
      ]),
      explain: jest
        .fn()
        .mockResolvedValueOnce({
          message: '삼각비는 이런 거야.',
          board_prompt: '단위원 그림',
          concept_id: 'trigonometric-ratio',
          usage: USAGE,
        })
        .mockResolvedValueOnce({
          message: '말로만 설명할게.',
          board_prompt: '',
          concept_id: '',
          usage: USAGE,
        }),
    });
    const { ref } = renderIntentLoop(deps);

    await act(async () => {
      await ref.current.begin();
    });

    // 첫 턴이 registry asset 을 세팅한 뒤, 말로만 답한 두 번째 턴에서
    // 새 주제와 어긋난 화면이 남지 않도록 asset/이미지 둘 다 비워야 한다.
    expect(ref.current.boardAsset).toBeNull();
    expect(ref.current.boardImageBase64).toBeNull();
  });

  // 8. 사전분석 미완 - 필러 문구
  it('사전분석 미완: classify(solve) 시점에 스캔이 안 끝났으면 FILLER_PHRASE 를 말하고 완료를 기다린다', async () => {
    let resolveFetchPhoto: (v: string) => void;
    const fetchPhotoPromise = new Promise<string>((resolve) => {
      resolveFetchPhoto = resolve;
    });
    const { deps, spoken } = makeDeps({
      fetchPhoto: jest.fn().mockReturnValue(fetchPhotoPromise),
      fetchRecordStatus: statusSequence(
        { recording: true, had_speech: true },
        { recording: false, had_speech: true },
      ),
      classify: jest.fn().mockResolvedValue({ transcript: '이 문제 풀어줘', intent: 'solve' }),
    });
    const { ref, onAnalyzed } = renderIntentLoop(deps);

    let beginPromise: Promise<void>;
    await act(async () => {
      beginPromise = ref.current.begin();
      await flush();
    });

    expect(spoken).toContain(FILLER_PHRASE);
    expect(onAnalyzed).not.toHaveBeenCalled();

    await act(async () => {
      resolveFetchPhoto('desk-photo');
      await beginPromise;
    });

    expect(onAnalyzed).toHaveBeenCalledTimes(1);
  });

  // 9. 촬영 실패 + Pi 사망
  it('촬영 실패 + Pi 사망: probeNow false 면 문구 없이 onExit 한다', async () => {
    const { deps, spoken } = makeDeps({
      capturePhoto: jest.fn().mockRejectedValue(new Error('capture fail')),
      probeNow: jest.fn().mockResolvedValue(false),
      fetchRecordStatus: statusSequence(
        { recording: true, had_speech: true },
        { recording: false, had_speech: true },
      ),
      classify: jest.fn().mockResolvedValue({ transcript: '이 문제 풀어줘', intent: 'solve' }),
    });
    const { ref, onExit, onAnalyzed, onPhoneCamera } = renderIntentLoop(deps);

    await act(async () => {
      await ref.current.begin();
    });

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onAnalyzed).not.toHaveBeenCalled();
    expect(onPhoneCamera).not.toHaveBeenCalled();
    expect(spoken).toEqual([GREETING_PHRASE, FILLER_PHRASE]); // 종료 문구 없음
  });

  // 10. 촬영 실패 + Pi 생존 + 재시도 성공
  it('촬영 실패 + Pi 생존: 풀프레임 재시도(2회째) 가 성공하면 onAnalyzed 로 이어간다', async () => {
    const { deps } = makeDeps({
      capturePhoto: jest
        .fn()
        .mockRejectedValueOnce(new Error('capture fail'))
        .mockResolvedValue(undefined),
      probeNow: jest.fn().mockResolvedValue(true),
      fetchRecordStatus: statusSequence(
        { recording: true, had_speech: true },
        { recording: false, had_speech: true },
      ),
      classify: jest.fn().mockResolvedValue({ transcript: '이 문제 풀어줘', intent: 'solve' }),
    });
    const { ref, onAnalyzed, onExit, onPhoneCamera } = renderIntentLoop(deps);

    await act(async () => {
      await ref.current.begin();
    });

    expect(deps.capturePhoto).toHaveBeenCalledTimes(2);
    expect(onAnalyzed).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();
    expect(onPhoneCamera).not.toHaveBeenCalled();
  });

  // 11. begin() 예외 가드 (C1) - 청취 중 Pi 드랍 + 생존
  it('청취 중 fetchRecordStatus 거부(Pi 드랍) + probeNow true: 미처리 예외 없이 onPhoneCamera 로 폴백한다', async () => {
    const { deps } = makeDeps({
      fetchRecordStatus: jest.fn().mockRejectedValue(new Error('pi drop mid-listen')),
      probeNow: jest.fn().mockResolvedValue(true),
    });
    const { ref, onExit, onAnalyzed, onPhoneCamera } = renderIntentLoop(deps);

    await act(async () => {
      await ref.current.begin();
    });

    expect(onPhoneCamera).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();
    expect(onAnalyzed).not.toHaveBeenCalled();
  });

  // 12. begin() 예외 가드 (C1) - 청취 중 Pi 드랍 + 사망
  it('청취 중 fetchRecordStatus 거부(Pi 드랍) + probeNow false: onExit 으로 종료한다', async () => {
    const { deps } = makeDeps({
      fetchRecordStatus: jest.fn().mockRejectedValue(new Error('pi drop mid-listen')),
      probeNow: jest.fn().mockResolvedValue(false),
    });
    const { ref, onExit, onAnalyzed, onPhoneCamera } = renderIntentLoop(deps);

    await act(async () => {
      await ref.current.begin();
    });

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onAnalyzed).not.toHaveBeenCalled();
    expect(onPhoneCamera).not.toHaveBeenCalled();
  });

  // 12.5. Track B: listening 표시는 마이크가 실제로 열린 뒤에만
  it('마이크가 열리기 전까지는 phase 가 listening 으로 바뀌지 않는다 (Track B)', async () => {
    let resolveStart: () => void;
    const startPromise = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    // fetchRecordStatus 도 붙잡아둔다 - 안 그러면 pollIntervalMs:0 인 이
    // 스위트에서 startRecording 을 풀자마자 나머지 루프가 같은 flush 안에서
    // 끝(done)까지 통째로 돌아버려 listening 중간 상태를 못 본다(#8 과 같은
    // 이유).
    let resolveStatus: (v: { recording: boolean; had_speech: boolean }) => void;
    const statusPromise = new Promise<{ recording: boolean; had_speech: boolean }>((resolve) => {
      resolveStatus = resolve;
    });
    const { deps } = makeDeps({
      startRecording: jest.fn().mockReturnValue(startPromise),
      fetchRecordStatus: jest.fn().mockReturnValue(statusPromise),
    });
    const { ref } = renderIntentLoop(deps);

    let beginPromise: Promise<void>;
    await act(async () => {
      beginPromise = ref.current.begin();
      await flush();
    });

    // startRecording 이 아직 안 풀렸으니 화면은 listening 이 아니어야 한다 -
    // 이 순서가 뒤집혀 있으면 마이크 생기기 전에 학생이 말을 시작해 첫
    // 마디가 잘린다(Track B 배경).
    expect(ref.current.phase).not.toBe('listening');
    expect(deps.sendEyeState).not.toHaveBeenCalledWith('processing');

    await act(async () => {
      resolveStart();
      await flush();
    });

    expect(ref.current.phase).toBe('listening');
    expect(deps.sendEyeState).toHaveBeenCalledWith('processing');

    await act(async () => {
      resolveStatus({ recording: false, had_speech: false });
      await beginPromise;
    });
  });

  // 12.6. Track B: 마이크 시작 실패 - 기존 예외 처리(C1) 경로 유지
  it('마이크 시작 실패(startRecording reject): listening 으로 전환하지 않고 기존 onPhoneCamera 폴백을 탄다 (Track B)', async () => {
    const { deps } = makeDeps({
      startRecording: jest.fn().mockRejectedValue(new Error('mic open fail')),
      probeNow: jest.fn().mockResolvedValue(true),
    });
    const { ref, onExit, onAnalyzed, onPhoneCamera } = renderIntentLoop(deps);

    await act(async () => {
      await ref.current.begin();
    });

    expect(ref.current.phase).not.toBe('listening');
    expect(deps.sendEyeState).not.toHaveBeenCalledWith('processing');
    expect(onPhoneCamera).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();
    expect(onAnalyzed).not.toHaveBeenCalled();
  });

  // 13. concept 설명 자막 문장 분할 (Task 3)
  //
  // 브리프는 jest.useFakeTimers() 스니펫을 제시하지만, 이 스위트는 sleep 을
  // 즉시-resolve 로 페이크해 begin() 이 한 번의 act() 안에서 마이크로태스크
  // 만으로 끝까지 돌아버린다 - 중간 상태(첫 문장 표시 시점)를 관측할
  // 정지 지점이 없다(가짜 타이머를 써도 exitWith 까지 그대로 진행돼버려
  // 소용없다). 그래서 #8(사전분석 미완)과 같은 패턴으로 다음 청취의
  // fetchRecordStatus 를 수동 프라미스로 붙잡아 정지 지점을 만들고, 자막
  // 타이머는 실제 setTimeout 을 아주 짧은 실제 시간으로 재게 한다(가짜
  // 타이머 미사용 - real-timer 대안, task 브리핑에서 허용).
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('concept 설명 자막: 문장 단위로 나눠 onPlay 시점부터 순차 표시하고, 종료 시 남은 타이머를 정리한다', async () => {
    let resolveSecondStatus: (v: { recording: boolean; had_speech: boolean }) => void;
    const secondStatus = new Promise<{ recording: boolean; had_speech: boolean }>((resolve) => {
      resolveSecondStatus = resolve;
    });
    // durationMs=2300(×10, real-timer 여유 확보), 문장 길이 약 7/8/8자 →
    // cue 대략 0ms / 700ms / 1500ms.
    const spoken: string[] = [];
    const speak = jest.fn(async (text: string, onPlay?: (d: number) => void) => {
      spoken.push(text);
      onPlay?.(2300);
    }) as unknown as IntentLoopDeps['speak'];
    const { deps } = makeDeps({
      speak,
      fetchRecordStatus: jest
        .fn()
        .mockResolvedValueOnce({ recording: false, had_speech: true })
        .mockReturnValueOnce(secondStatus),
      classify: jest.fn().mockResolvedValue({ transcript: '약분이 뭐야', intent: 'concept' }),
      explain: jest.fn().mockResolvedValue({
        message: '첫 문장이다. 둘째 문장이다. 셋째 문장이다.',
        board_prompt: '',
        usage: USAGE,
      }),
    });
    const { ref, onExit } = renderIntentLoop(deps);

    let beginPromise: Promise<void>;
    await act(async () => {
      beginPromise = ref.current.begin();
      await flush();
    });

    // onPlay(2300) 직후(showAtMs<=0) 첫 문장이 바로 뜬다.
    expect(ref.current.subtitle).toBe('첫 문장이다.');

    await act(async () => {
      await wait(1000); // cue1(~700ms) 은 지나고 cue2(~1500ms) 은 아직.
    });
    expect(ref.current.subtitle).toBe('둘째 문장이다.');

    // 두 번째 청취를 무응답으로 마감 - concept 이후라 CONCEPT_EXIT_PHRASE 로
    // exitWith 진입, 아직 안 지난 세 번째 cue(~1500ms) 타이머가 정리돼야 한다.
    await act(async () => {
      resolveSecondStatus({ recording: false, had_speech: false });
      await beginPromise;
    });
    expect(spoken).toContain(CONCEPT_EXIT_PHRASE);
    expect(ref.current.subtitle).toBe(CONCEPT_EXIT_PHRASE);
    expect(onExit).toHaveBeenCalledTimes(1);

    // 세 번째 cue 시점을 지나도(타이머가 clearSubtitleTimers 로 정리됐으니)
    // 셋째 문장으로 덮어써지면 안 된다.
    await act(async () => {
      await wait(1500);
    });
    expect(ref.current.subtitle).toBe(CONCEPT_EXIT_PHRASE);
  });

  // 13.5. concept 자막 선표시 제거 (2026-08-13 실기기 피드백: 자막이 나레이션보다
  // 합성 왕복(1~2.5초)만큼 먼저 떴다). 자막은 onPlay(재생 시작)부터만 - 단
  // speak 실패 시엔 첫 문장을 폴백으로 남긴다 (5898d73 의도 보존).
  it('concept 자막: speak 전엔 안 뜨고, speak 실패 시에만 첫 문장을 폴백 표시한다', async () => {
    let resolveSecondStatus: (v: { recording: boolean; had_speech: boolean }) => void;
    const secondStatus = new Promise<{ recording: boolean; had_speech: boolean }>((resolve) => {
      resolveSecondStatus = resolve;
    });
    const holder: { subtitleAtSpeakStart: string | null } = { subtitleAtSpeakStart: null };
    const speak = jest.fn(async (text: string) => {
      if (text.includes('첫 문장이다')) {
        holder.subtitleAtSpeakStart = ref.current.subtitle;
        throw new Error('tts down'); // 합성 실패 재현 - onPlay 없이 reject
      }
    }) as unknown as IntentLoopDeps['speak'];
    const { deps } = makeDeps({
      speak,
      fetchRecordStatus: jest
        .fn()
        .mockResolvedValueOnce({ recording: false, had_speech: true })
        .mockReturnValueOnce(secondStatus),
      classify: jest.fn().mockResolvedValue({ transcript: '약분이 뭐야', intent: 'concept' }),
      explain: jest.fn().mockResolvedValue({
        message: '첫 문장이다. 둘째 문장이다.',
        board_prompt: '',
        usage: USAGE,
      }),
    });
    const { ref } = renderIntentLoop(deps);

    let beginPromise: Promise<void>;
    await act(async () => {
      beginPromise = ref.current.begin();
      await flush();
    });

    // speak 가 불린 시점에 개념 첫 문장이 미리 떠 있으면 안 된다 (선표시 금지
    // - 직전 발화 자막이 남아 있는 건 정상, onPlay 가 교체한다).
    expect(holder.subtitleAtSpeakStart).not.toBe('첫 문장이다.');
    // speak 실패 후에는 첫 문장이 폴백으로 떠 있어야 한다.
    expect(ref.current.subtitle).toBe('첫 문장이다.');

    await act(async () => {
      resolveSecondStatus({ recording: false, had_speech: false });
      await beginPromise;
    });
  });

  // 13.6. 직전 자막 잔상 제거 (2026-08-14 실기기: 학생 답이 끝난 뒤 다음 발화
  // onPlay 까지의 TTS 합성 왕복 동안 직전 질문 자막이 큰 자막으로 다시
  // 페이드인했다). 학생 입력이 확정돼 thinking 으로 넘어가면 자막을 지운다.
  it('학생 입력 확정 시 직전 자막을 지운다 - 다음 speak 시작 시점 자막은 빈 문자열', async () => {
    let resolveSecondStatus: (v: { recording: boolean; had_speech: boolean }) => void;
    const secondStatus = new Promise<{ recording: boolean; had_speech: boolean }>((resolve) => {
      resolveSecondStatus = resolve;
    });
    const holder: { subtitleAtSpeakStart: string | null } = { subtitleAtSpeakStart: null };
    const speak = jest.fn(async (text: string, onPlay?: (d: number) => void) => {
      if (text.includes('첫 문장이다')) holder.subtitleAtSpeakStart = ref.current.subtitle;
      onPlay?.(0);
    }) as unknown as IntentLoopDeps['speak'];
    const { deps } = makeDeps({
      speak,
      fetchRecordStatus: jest
        .fn()
        .mockResolvedValueOnce({ recording: false, had_speech: true })
        .mockReturnValueOnce(secondStatus),
      classify: jest.fn().mockResolvedValue({ transcript: '약분이 뭐야', intent: 'concept' }),
      explain: jest.fn().mockResolvedValue({
        message: '첫 문장이다.',
        board_prompt: '',
        usage: USAGE,
      }),
    });
    const { ref } = renderIntentLoop(deps);

    let beginPromise: Promise<void>;
    await act(async () => {
      beginPromise = ref.current.begin();
      await flush();
    });

    // 인사(GREETING_PHRASE) 자막이 청취를 지나 concept speak 시작까지 남아
    // 있으면 안 된다 - thinking 진입 시점에 지워져 있어야 한다.
    expect(holder.subtitleAtSpeakStart).toBe('');

    await act(async () => {
      resolveSecondStatus({ recording: false, had_speech: false });
      await beginPromise;
    });
  });

  // 14. listenOnce 레이스: 마이크 열기 왕복 중 타이핑 제출이 먼저 청취를
  // 마감하면(Finding 2, 2026-08-14 리뷰) startRecording 이 뒤늦게 resolve
  // 돼도 phase 를 'listening' 으로 되돌리면 안 된다 - 이미 thinking 으로
  // 넘어간 뒤라 되돌리면 화면이 깜빡인다.
  it('listenOnce: startRecording 왕복 중 타이핑 제출이 먼저 마감되면 뒤늦은 resolve 가 phase 를 되돌리지 않는다', async () => {
    let resolveStart: () => void = () => {};
    const startPromise = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const startRecording = jest.fn().mockReturnValueOnce(startPromise).mockResolvedValue(undefined);
    const { deps } = makeDeps({
      startRecording,
      classifyText: jest.fn().mockResolvedValue({ transcript: '약분이 뭐야', intent: 'concept' }),
      explain: jest
        .fn()
        .mockResolvedValue({ message: '설명이다.', board_prompt: '', usage: USAGE }),
    });
    const { ref } = renderIntentLoop(deps);

    let beginPromise: Promise<void>;
    act(() => {
      beginPromise = ref.current.begin();
    });
    await act(async () => {
      await flush(); // greeting speak 완료, listenOnce 진입 - startRecording 은 아직 pending.
    });
    expect(deps.startRecording).toHaveBeenCalledTimes(1);
    expect(ref.current.phase).not.toBe('listening'); // 아직 마이크 왕복 중.

    await act(async () => {
      ref.current.submitText('약분이 뭐야'); // typedResolveRef 경로 - 즉시 청취를 마감한다.
      await flush();
    });
    // 텍스트 제출이 청취를 마감했으니 phase 는 이미 listening 을 지나쳐 있다
    // (thinking/speaking 등). stopRecording 도 이미 호출됐다(레이스 누수 없음).
    expect(ref.current.phase).not.toBe('listening');
    expect(deps.stopRecording).toHaveBeenCalled();
    const phaseBeforeLateResolve = ref.current.phase;

    await act(async () => {
      resolveStart(); // 뒤늦게 마이크가 열림 - listenOnce 의 settled 가드가 막아야 한다.
      await flush();
    });
    expect(ref.current.phase).not.toBe('listening');
    expect(ref.current.phase).toBe(phaseBeforeLateResolve); // 되돌아가지 않았다.

    await act(async () => {
      await beginPromise; // 개념 턴 이후 다음 청취는 무응답으로 곧장 종료된다.
    });
  });
});

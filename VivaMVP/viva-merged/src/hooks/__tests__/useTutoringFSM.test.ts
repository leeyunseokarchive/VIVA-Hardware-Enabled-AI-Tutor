/**
 * Unit tests for useTutoringFSM (task-5-brief.md Steps 1-9, 완료 기준 1-6).
 *
 * `evaluateStudentInput` and `speak` are injected as mocks (constructor
 * options) so this exercises the real branching logic (wrongStreak/hintCount
 * updates, consent gating, SOLVE_STAGE entry, SessionEvent logging) without
 * any real network/audio calls. Live-Gemini verification of the same test
 * inputs from the brief lives in test-fsm-flow.js.
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import {
  useTutoringFSM,
  UseTutoringFSMResult,
  PHONE_FALLBACK_QUESTION,
  PHONE_FALLBACK_DECLINE_MESSAGE,
  DISMISSAL_EXIT_PHRASE,
} from '../useTutoringFSM';
import { clearSessionEvents, getSessionEvents } from '../../services/sessionLog.service';
import { saveSession } from '../../services/sessionHistory.service';
import {
  HANDWRITING_ASKBACK_MAX,
  HANDWRITING_ASKBACK_QUESTION,
  HANDWRITING_ASKBACK_RETRY,
  HANDWRITING_ASKBACK_FALLBACK,
  HANDWRITING_ASKBACK_SILENCE_MS,
  HANDWRITING_READ_COUNT,
} from '../../utils/captureDecision';
import type { GeminiTutoringResponse } from '../../types/Tutoring';
import { EMPTY_TOKEN_USAGE, type TokenUsage } from '../../types/ApiUsage';

// backgroundSaveSession 은 fire-and-forget 으로 Supabase 를 직접 호출한다 -
// 테스트에선 무음 network fail 로 그냥 삼켜지던 걸 mock 으로 바꿔 폰 폴백
// 되묻기 문답이 실제로 저장 호출까지 이어지는지 검증 가능하게 한다.
jest.mock('../../services/sessionHistory.service');
const mockedSaveSession = saveSession as jest.MockedFunction<typeof saveSession>;

function baseResponse(
  overrides: Partial<GeminiTutoringResponse> & { usage?: TokenUsage } = {},
): GeminiTutoringResponse & { usage?: TokenUsage } {
  return {
    fsm_state: 'HINT_STAGE',
    explicit_answer_request: false,
    is_on_correct_path: null,
    requires_board: true,
    board_update_needed: false,
    message: 'default message',
    board_prompt: 'board prompt',
    confidence: 0.9,
    error_type: 'NONE',
    misconception_type: 'NONE',
    topic: '기타',
    title: 'default title',
    ...overrides,
  };
}

function renderFsm(options: {
  evaluateStudentInputFn: jest.Mock;
  speakFn?: jest.Mock;
  onSessionComplete?: jest.Mock;
  directSolveMode?: boolean;
  analyzeImageFn?: jest.Mock;
  recognizeHandwritingFn?: jest.Mock;
  stopListeningFn?: jest.Mock;
}) {
  const speakFn = options.speakFn ?? jest.fn().mockResolvedValue(undefined);
  const ref: { current: UseTutoringFSMResult | null } = { current: null };

  function Harness() {
    ref.current = useTutoringFSM({
      evaluateStudentInputFn: options.evaluateStudentInputFn,
      speakFn,
      onSessionComplete: options.onSessionComplete,
      directSolveMode: options.directSolveMode,
      analyzeImageFn: options.analyzeImageFn,
      recognizeHandwritingFn: options.recognizeHandwritingFn,
      stopListeningFn: options.stopListeningFn,
    });
    return null;
  }

  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(React.createElement(Harness));
  });
  activeRenderers.push(renderer);

  return { ref: ref as { current: UseTutoringFSMResult }, speakFn };
}

// renderFsm 이 만든 렌더러를 언마운트하지 않으면, 되묻기 무응답 타이머(real
// setTimeout)가 훅의 언마운트 정리를 못 타고 스위트 종료 뒤에 발화해
// "Cannot log after tests are done" 콘솔 에러를 낸다 - afterEach 에서 일괄 정리.
const activeRenderers: ReactTestRenderer.ReactTestRenderer[] = [];

describe('useTutoringFSM', () => {
  beforeEach(() => {
    clearSessionEvents();
  });

  afterEach(() => {
    act(() => {
      activeRenderers.forEach((r) => r.unmount());
    });
    activeRenderers.length = 0;
  });

  it('completion criterion 1: speaks the first HINT_STAGE message after startSession', async () => {
    const evaluateStudentInputFn = jest.fn();
    const { ref, speakFn } = renderFsm({ evaluateStudentInputFn });

    const analysis = baseResponse({ message: '이 문제에서 구해야 하는 건 뭘까?' });

    await act(async () => {
      await ref.current.startSession(analysis, {
        sessionId: 'sess-1',
        problemImageBase64: 'img',
      });
    });

    expect(speakFn).toHaveBeenCalledWith('이 문제에서 구해야 하는 건 뭘까?');
    expect(ref.current.phase).toBe('awaiting_input');
    expect(ref.current.conversation?.fsmState).toBe('HINT_STAGE');
    expect(ref.current.session.hintCount).toBe(1);
    expect(ref.current.session.wrongStreak).toBe(0);
  });

  it('completion criterion 2: "모르겠어" (is_on_correct_path=null) stays in HINT_STAGE, increments hintCount, leaves wrongStreak untouched', async () => {
    const evaluateStudentInputFn = jest.fn();
    const { ref } = renderFsm({ evaluateStudentInputFn });

    await act(async () => {
      await ref.current.startSession(baseResponse(), {
        sessionId: 'sess-1',
        problemImageBase64: 'img',
      });
    });

    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({
        fsm_state: 'HINT_STAGE',
        is_on_correct_path: null,
        explicit_answer_request: false,
        message: '천천히 다시 생각해볼까?',
      }),
    );

    await act(async () => {
      await ref.current.submitStudentInput('모르겠어');
    });

    expect(ref.current.session.fsmState).toBe('HINT_STAGE');
    expect(ref.current.session.hintCount).toBe(2);
    expect(ref.current.session.wrongStreak).toBe(0);
    expect(ref.current.phase).toBe('awaiting_input');
  });

  it('"어려워" behaves the same as "모르겠어" (HINT_STAGE maintained)', async () => {
    const evaluateStudentInputFn = jest.fn();
    const { ref } = renderFsm({ evaluateStudentInputFn });

    await act(async () => {
      await ref.current.startSession(baseResponse(), {
        sessionId: 'sess-1',
        problemImageBase64: 'img',
      });
    });

    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({ is_on_correct_path: null, explicit_answer_request: false }),
    );

    await act(async () => {
      await ref.current.submitStudentInput('어려워');
    });

    expect(ref.current.session.fsmState).toBe('HINT_STAGE');
    expect(ref.current.phase).toBe('awaiting_input');
  });

  it('hint mode: bare "답 알려줘" (explicit_answer_request=true, no consent/direct-solve) is BLOCKED - stays HINT_STAGE with a refusal message, never speaks the leaked solution text', async () => {
    const evaluateStudentInputFn = jest.fn();
    const onSessionComplete = jest.fn();
    const { ref, speakFn } = renderFsm({ evaluateStudentInputFn, onSessionComplete });

    await act(async () => {
      await ref.current.startSession(baseResponse(), {
        sessionId: 'sess-1',
        problemImageBase64: 'img',
      });
    });

    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({
        fsm_state: 'SOLVE_STAGE',
        explicit_answer_request: true,
        is_on_correct_path: null,
        requires_board: true,
        board_update_needed: true,
        message: '전체 풀이: x = 2야.', // must never reach speakFn
      }),
    );

    await act(async () => {
      await ref.current.submitStudentInput('답 알려줘');
    });

    expect(ref.current.session.fsmState).toBe('HINT_STAGE');
    expect(ref.current.conversation?.fsmState).toBe('HINT_STAGE');
    expect(ref.current.conversation?.requires_board).toBe(false);
    expect(ref.current.conversation?.board_update_needed).toBe(false);
    expect(speakFn).not.toHaveBeenCalledWith('전체 풀이: x = 2야.');
    expect(ref.current.phase).toBe('awaiting_input');
    expect(onSessionComplete).not.toHaveBeenCalled();
  });

  it('"바로 정답" 모드(directSolveMode=true): "답 알려줘"가 SOLVE_STAGE로 허용되고, 완료 후에도 화면은 done에 머문다(onSessionComplete 자동 호출 없음)', async () => {
    const evaluateStudentInputFn = jest.fn();
    const onSessionComplete = jest.fn();
    const { ref, speakFn } = renderFsm({
      evaluateStudentInputFn,
      onSessionComplete,
      directSolveMode: true,
    });

    await act(async () => {
      await ref.current.startSession(baseResponse(), {
        sessionId: 'sess-1',
        problemImageBase64: 'img',
      });
    });

    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({
        fsm_state: 'SOLVE_STAGE',
        explicit_answer_request: true,
        is_on_correct_path: null,
        requires_board: true,
        board_update_needed: true,
        message: '전체 풀이: ...',
      }),
    );

    await act(async () => {
      await ref.current.submitStudentInput('답 알려줘');
    });

    expect(ref.current.session.fsmState).toBe('SOLVE_STAGE');
    expect(ref.current.conversation?.fsmState).toBe('SOLVE_STAGE');
    expect(speakFn).toHaveBeenLastCalledWith('전체 풀이: ...');
    expect(ref.current.phase).toBe('done');
    expect(onSessionComplete).not.toHaveBeenCalled();
  });

  it('학생이 스스로 풀어서 최종 정답을 맞혔을 때(is_on_correct_path=true + SOLVE_STAGE): 마무리 메시지를 말한 뒤 자동으로 onSessionComplete가 호출된다 (자동 홈 복귀)', async () => {
    const evaluateStudentInputFn = jest.fn();
    const onSessionComplete = jest.fn();
    const { ref, speakFn } = renderFsm({ evaluateStudentInputFn, onSessionComplete });

    await act(async () => {
      await ref.current.startSession(baseResponse(), {
        sessionId: 'sess-1',
        problemImageBase64: 'img',
      });
    });

    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({
        fsm_state: 'SOLVE_STAGE',
        explicit_answer_request: false,
        is_on_correct_path: true,
        requires_board: false,
        message: '맞아! 이차방정식 단원 완전히 이해했네, 앞으로 이 단원은 자신 있게 풀 수 있겠다!',
      }),
    );

    await act(async () => {
      await ref.current.submitStudentInput('x=2야');
    });

    expect(ref.current.session.fsmState).toBe('SOLVE_STAGE');
    expect(speakFn).toHaveBeenLastCalledWith(
      '맞아! 이차방정식 단원 완전히 이해했네, 앞으로 이 단원은 자신 있게 풀 수 있겠다!',
    );
    expect(ref.current.phase).toBe('done');
    expect(onSessionComplete).toHaveBeenCalledTimes(1);
  });

  it('hint mode: "그냥 풀어줘"도 마찬가지로 차단된다', async () => {
    const evaluateStudentInputFn = jest.fn();
    const { ref } = renderFsm({ evaluateStudentInputFn });

    await act(async () => {
      await ref.current.startSession(baseResponse(), {
        sessionId: 'sess-1',
        problemImageBase64: 'img',
      });
    });

    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({ explicit_answer_request: true, message: '풀이 시작' }),
    );

    await act(async () => {
      await ref.current.submitStudentInput('그냥 풀어줘');
    });

    expect(ref.current.session.fsmState).toBe('HINT_STAGE');
  });

  // 동의 질문 자체는 Gemini 가 프롬프트(wrongStreakInstruction) 지시대로 하고,
  // 훅은 "그 동의에 실제로 응했는가" 만 로컬로 확인한다. wrongStreak>=3 이라는
  // 사실만으로 정답 공개를 허가하면, 그 이후로는 무슨 말을 하든 정답이 새는
  // 백스톱 구멍이 생긴다(wrongStreak 은 정답 맞힐 때까지 안 내려감).
  it('3연속 오답 뒤라도 동의가 아닌 발화("답 알려줘")로는 SOLVE_STAGE 가 열리지 않는다', async () => {
    const evaluateStudentInputFn = jest.fn();
    const { ref, speakFn } = renderFsm({ evaluateStudentInputFn });

    await act(async () => {
      await ref.current.startSession(baseResponse(), {
        sessionId: 'sess-1',
        problemImageBase64: 'img',
      });
    });

    for (let i = 0; i < 3; i += 1) {
      evaluateStudentInputFn.mockResolvedValueOnce(
        baseResponse({ is_on_correct_path: false, message: `힌트 ${i}` }),
      );
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await ref.current.submitStudentInput('오답입니다');
      });
    }
    expect(ref.current.session.wrongStreak).toBe(3);

    // Gemini 가 (지시를 어기고) 전체 풀이를 뱉어도 훅이 막아야 한다.
    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({
        fsm_state: 'SOLVE_STAGE',
        explicit_answer_request: true,
        message: '전체 풀이: x = 2',
      }),
    );
    await act(async () => {
      await ref.current.submitStudentInput('답 알려줘');
    });

    expect(ref.current.session.fsmState).toBe('HINT_STAGE');
    expect(speakFn).not.toHaveBeenLastCalledWith('전체 풀이: x = 2');
    expect(ref.current.phase).toBe('awaiting_input');
  });

  // 실기기 피드백 2026-08-05: consentGranted 가 `explicit_answer_request ||
  // SOLVE_STAGE` 분기 안에서만 쓰여서, 학생이 "응" 했는데 Gemini 가 그 턴에
  // HINT_STAGE + explicit_answer_request=false 를 돌려주면 동의가 조용히 버려지고
  // 힌트가 또 나갔다 - 자기가 제안해 놓고 수락을 거절하는 꼴.
  it('동의했는데 모델이 HINT_STAGE 로 답하면, 정답 모드로 다시 물어 풀이를 공개한다', async () => {
    const evaluateStudentInputFn = jest.fn();
    const { ref, speakFn } = renderFsm({ evaluateStudentInputFn });

    await act(async () => {
      await ref.current.startSession(baseResponse(), {
        sessionId: 'sess-1',
        problemImageBase64: 'img',
      });
    });

    for (let i = 0; i < 3; i += 1) {
      evaluateStudentInputFn.mockResolvedValueOnce(
        baseResponse({ is_on_correct_path: false, message: `힌트 ${i}` }),
      );
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await ref.current.submitStudentInput('오답입니다');
      });
    }
    // 마지막 모델 발화가 동의 질문이어야 askedConsentQuestion 이 참이 된다.
    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({ is_on_correct_path: false, message: '답을 같이 볼까?' }),
    );
    await act(async () => {
      await ref.current.submitStudentInput('또 틀렸어');
    });

    // 학생이 동의했는데 모델은 힌트를 돌려준다.
    evaluateStudentInputFn.mockResolvedValueOnce(baseResponse({ message: '또 다른 힌트' }));
    // 재질문(정답 모드)에서 진짜 풀이가 온다.
    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({ fsm_state: 'SOLVE_STAGE', message: '전체 풀이: x = 2' }),
    );
    await act(async () => {
      await ref.current.submitStudentInput('응');
    });

    expect(evaluateStudentInputFn).toHaveBeenCalledTimes(6); // 3 + 1 + 원턴 + 재질문
    expect(speakFn).toHaveBeenLastCalledWith('전체 풀이: x = 2');
    expect(speakFn).not.toHaveBeenCalledWith('또 다른 힌트');
    expect(ref.current.session.fsmState).toBe('SOLVE_STAGE');
  });

  it('correct-path answers reset wrongStreak to 0', async () => {
    const evaluateStudentInputFn = jest.fn();
    const { ref } = renderFsm({ evaluateStudentInputFn });

    await act(async () => {
      await ref.current.startSession(baseResponse(), {
        sessionId: 'sess-1',
        problemImageBase64: 'img',
      });
    });

    evaluateStudentInputFn.mockResolvedValueOnce(baseResponse({ is_on_correct_path: false }));
    await act(async () => {
      await ref.current.submitStudentInput('오답입니다');
    });
    expect(ref.current.session.wrongStreak).toBe(1);

    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({ is_on_correct_path: true, message: '맞았어! 다음은?' }),
    );
    await act(async () => {
      await ref.current.submitStudentInput('정답입니다');
    });
    expect(ref.current.session.wrongStreak).toBe(0);
    expect(ref.current.session.hintCount).toBe(3);
  });

  it('completion criterion 4b: 3연속 오답 뒤 동의("응")하면 SOLVE_STAGE 로 넘어간다', async () => {
    const evaluateStudentInputFn = jest.fn();
    const { ref } = renderFsm({ evaluateStudentInputFn });

    await act(async () => {
      await ref.current.startSession(baseResponse(), {
        sessionId: 'sess-1',
        problemImageBase64: 'img',
      });
    });

    for (let i = 0; i < 3; i += 1) {
      evaluateStudentInputFn.mockResolvedValueOnce(baseResponse({ is_on_correct_path: false }));
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await ref.current.submitStudentInput('오답');
      });
    }
    expect(ref.current.session.wrongStreak).toBe(3);

    // wrongStreak>=3 이라 이 턴의 프롬프트가 Gemini 에게 동의 질문을 시킨다.
    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({ message: '많이 어려워 보이는데, 답을 같이 볼까?' }),
    );
    await act(async () => {
      await ref.current.submitStudentInput('모르겠어');
    });
    expect(ref.current.session.fsmState).toBe('HINT_STAGE');

    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({
        fsm_state: 'SOLVE_STAGE',
        message: '전체 풀이를 알려줄게: ...',
        requires_board: true,
      }),
    );

    await act(async () => {
      await ref.current.submitStudentInput('응');
    });

    expect(ref.current.session.fsmState).toBe('SOLVE_STAGE');
    expect(ref.current.phase).toBe('done');
  });

  it('동의 질문 직후의 "네 알려주세요"도 동의로 인정한다 (run-8: 거절 반복 모순)', async () => {
    const evaluateStudentInputFn = jest.fn();
    const { ref } = renderFsm({ evaluateStudentInputFn });

    await act(async () => {
      await ref.current.startSession(baseResponse(), {
        sessionId: 'sess-1',
        problemImageBase64: 'img',
      });
    });

    for (let i = 0; i < 3; i += 1) {
      evaluateStudentInputFn.mockResolvedValueOnce(baseResponse({ is_on_correct_path: false }));
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await ref.current.submitStudentInput('오답');
      });
    }

    // 튜터가 동의 질문을 던진 턴 - 이 메시지가 history 에 남는다.
    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({ message: '많이 어려워 보이는데, 답을 같이 볼까?' }),
    );
    await act(async () => {
      await ref.current.submitStudentInput('그럼 a(x-y)가 되는데 왜 안되죠?');
    });

    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({ fsm_state: 'SOLVE_STAGE', message: '전체 풀이를 알려줄게: ...' }),
    );
    await act(async () => {
      await ref.current.submitStudentInput('네 알려주세요.');
    });

    expect(ref.current.session.fsmState).toBe('SOLVE_STAGE');
    expect(ref.current.phase).toBe('done');
  });

  it('completion criterion 5: only board-referencing utterances set board_update_needed=true', async () => {
    const evaluateStudentInputFn = jest.fn();
    const { ref } = renderFsm({ evaluateStudentInputFn });

    await act(async () => {
      await ref.current.startSession(baseResponse(), {
        sessionId: 'sess-1',
        problemImageBase64: 'img',
      });
    });

    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({
        is_on_correct_path: null,
        board_update_needed: true,
        message: 'BC는 여기야.',
      }),
    );
    await act(async () => {
      await ref.current.submitStudentInput('BC가 어디야');
    });
    expect(ref.current.conversation?.board_update_needed).toBe(true);

    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({
        is_on_correct_path: null,
        board_update_needed: true,
        message: '구해야 하는 점을 표시했어.',
      }),
    );
    await act(async () => {
      await ref.current.submitStudentInput('구해야 하는 점 표시해줘');
    });
    expect(ref.current.conversation?.board_update_needed).toBe(true);

    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({
        is_on_correct_path: null,
        board_update_needed: false,
        message: '다음은 근의 공식을 써볼까?',
      }),
    );
    await act(async () => {
      await ref.current.submitStudentInput('다음엔 뭐 해야 돼?');
    });
    expect(ref.current.conversation?.board_update_needed).toBe(false);
  });

  it('completion criterion 6: SessionEvent is logged on startSession and every submitStudentInput transition', async () => {
    const evaluateStudentInputFn = jest.fn();
    const { ref } = renderFsm({ evaluateStudentInputFn });

    await act(async () => {
      await ref.current.startSession(baseResponse(), {
        sessionId: 'sess-1',
        problemImageBase64: 'img',
      });
    });

    expect(getSessionEvents()).toHaveLength(1);
    expect(getSessionEvents()[0]).toMatchObject({
      sessionId: 'sess-1',
      appState: 'conversation',
      fsmState: 'HINT_STAGE',
    });

    evaluateStudentInputFn.mockResolvedValueOnce(baseResponse({ is_on_correct_path: false }));
    await act(async () => {
      await ref.current.submitStudentInput('오답');
    });

    expect(getSessionEvents()).toHaveLength(2);
    expect(getSessionEvents()[1].meta?.wrongStreak).toBe(1);

    // No raw image/audio/utterance text stored anywhere in the event log.
    const serialized = JSON.stringify(getSessionEvents());
    expect(serialized).not.toContain('오답');
    expect(serialized).not.toContain('img');
  });

  it('never calls a board-generation function during SOLVE_STAGE (Step 9: no such service exists yet)', async () => {
    const evaluateStudentInputFn = jest.fn();
    const { ref } = renderFsm({ evaluateStudentInputFn });

    await act(async () => {
      await ref.current.startSession(baseResponse(), {
        sessionId: 'sess-1',
        problemImageBase64: 'img',
      });
    });

    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({ explicit_answer_request: true, requires_board: true }),
    );
    await act(async () => {
      await ref.current.submitStudentInput('답 알려줘');
    });

    expect(ref.current.conversation?.requires_board).toBe(false);
    // (No board.service import exists in useTutoringFSM.ts at all — enforced
    // structurally, not just behaviorally; see report.)
  });

  it('barge-in: a second submitStudentInput while the first is in flight supersedes it - the stale response is abandoned (not spoken/applied) and the newest one wins', async () => {
    const evaluateStudentInputFn = jest.fn();
    const { ref, speakFn } = renderFsm({ evaluateStudentInputFn });

    await act(async () => {
      await ref.current.startSession(baseResponse(), {
        sessionId: 'sess-1',
        problemImageBase64: 'img',
      });
    });
    speakFn.mockClear();

    // First submission is in flight, paused on an unresolved evaluate call.
    let resolveFirstEval: (r: GeminiTutoringResponse) => void = () => {};
    const firstEvalPromise = new Promise<GeminiTutoringResponse>((resolve) => {
      resolveFirstEval = resolve;
    });
    // Second submission's evaluate resolves immediately.
    let resolveSecondEval: (r: GeminiTutoringResponse) => void = () => {};
    const secondEvalPromise = new Promise<GeminiTutoringResponse>((resolve) => {
      resolveSecondEval = resolve;
    });
    evaluateStudentInputFn
      .mockReturnValueOnce(firstEvalPromise)
      .mockReturnValueOnce(secondEvalPromise);

    let firstCallPromise: Promise<void> = Promise.resolve();
    act(() => {
      firstCallPromise = ref.current.submitStudentInput('첫 번째 답');
    });
    expect(ref.current.phase).toBe('evaluating');

    // The student barges in with a new answer before the first resolves.
    // Barge-in no longer DROPS it - it starts a fresh turn (a second evaluate
    // call) that supersedes the first.
    let secondCallPromise: Promise<void> = Promise.resolve();
    act(() => {
      secondCallPromise = ref.current.submitStudentInput('두 번째 답');
    });
    expect(evaluateStudentInputFn).toHaveBeenCalledTimes(2);

    // The (now stale) first evaluate resolves LATE - it must be abandoned:
    // no speak, no state mutation, because its turn id is no longer the latest.
    await act(async () => {
      resolveFirstEval(
        baseResponse({
          fsm_state: 'HINT_STAGE',
          is_on_correct_path: false,
          message: '오래된 답변',
        }),
      );
      await firstCallPromise;
    });
    expect(speakFn).not.toHaveBeenCalledWith('오래된 답변');
    expect(ref.current.session.wrongStreak).toBe(0); // stale wrong-answer not applied

    // The second (latest) turn resolves and IS applied/spoken.
    await act(async () => {
      resolveSecondEval(
        baseResponse({ fsm_state: 'HINT_STAGE', is_on_correct_path: true, message: '최신 답변' }),
      );
      await secondCallPromise;
    });
    expect(speakFn).toHaveBeenCalledWith('최신 답변');
    expect(ref.current.phase).toBe('awaiting_input');
    // hintCount incremented exactly once - from the winning turn only.
    expect(ref.current.session.hintCount).toBe(2);
  });

  it('cancel() suppresses speakFn and the phase transition once an in-flight evaluate call resolves (back-button-mid-inference bug)', async () => {
    const evaluateStudentInputFn = jest.fn();
    const { ref, speakFn } = renderFsm({ evaluateStudentInputFn });

    await act(async () => {
      await ref.current.startSession(baseResponse({ message: '첫 메시지' }), {
        sessionId: 'sess-1',
        problemImageBase64: 'img',
      });
    });
    speakFn.mockClear();

    let resolveEval: (r: GeminiTutoringResponse) => void = () => {};
    const evalPromise = new Promise<GeminiTutoringResponse>((resolve) => {
      resolveEval = resolve;
    });
    evaluateStudentInputFn.mockReturnValueOnce(evalPromise);

    let submitPromise: Promise<void> = Promise.resolve();
    act(() => {
      submitPromise = ref.current.submitStudentInput('생각 중인 동안 뒤로가기');
    });
    expect(ref.current.phase).toBe('evaluating');

    // Student pressed "back" while Gemini was still thinking - the owning
    // screen unmounts and calls cancel().
    act(() => {
      ref.current.cancel();
    });

    // The evaluate call was already in flight and now resolves - without
    // the cancel guard, this would call speakFn() and flip phase to
    // 'speaking', starting TTS playback for a session the student already
    // left.
    await act(async () => {
      resolveEval(baseResponse({ message: '뒤늦게 도착한 답변' }));
      await submitPromise;
    });

    expect(speakFn).not.toHaveBeenCalled();
    expect(ref.current.phase).toBe('evaluating');
  });

  it('seeds history properly when initialQuestion is provided to startSession', async () => {
    const evaluateStudentInputFn = jest.fn();
    const { ref } = renderFsm({ evaluateStudentInputFn });

    const analysis = baseResponse({ message: '첫 질문에 답해주자' });

    await act(async () => {
      await ref.current.startSession(
        analysis,
        { sessionId: 'sess-1', problemImageBase64: 'img' },
        '처음 한 질문',
      );
    });

    expect(ref.current.session.history).toEqual([
      { role: 'user', message: '처음 한 질문', timestamp: expect.any(Number) },
      { role: 'model', message: '첫 질문에 답해주자', timestamp: expect.any(Number) },
    ]);
  });

  it('accumulates history with each student submitStudentInput turn', async () => {
    const evaluateStudentInputFn = jest.fn();
    const { ref } = renderFsm({ evaluateStudentInputFn });

    await act(async () => {
      await ref.current.startSession(
        baseResponse({ message: '튜터첫답' }),
        { sessionId: 'sess-1', problemImageBase64: 'img' },
        '학습자첫질문',
      );
    });

    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({ is_on_correct_path: true, message: '튜터둘째답' }),
    );

    await act(async () => {
      await ref.current.submitStudentInput('학습자둘째답');
    });

    expect(ref.current.session.history).toEqual([
      { role: 'user', message: '학습자첫질문', timestamp: expect.any(Number) },
      { role: 'model', message: '튜터첫답', timestamp: expect.any(Number) },
      { role: 'user', message: '학습자둘째답', timestamp: expect.any(Number) },
      { role: 'model', message: '튜터둘째답', timestamp: expect.any(Number) },
    ]);
  });

  it('triggers onCameraNeeded callback when Gemini returns fsm_state=ERROR and error_type=OCR_FAILED', async () => {
    const evaluateStudentInputFn = jest.fn();
    const onCameraNeeded = jest.fn();

    const speakFn = jest.fn().mockResolvedValue(undefined);
    const ref: { current: UseTutoringFSMResult | null } = { current: null };

    function Harness() {
      ref.current = useTutoringFSM({
        evaluateStudentInputFn,
        speakFn,
        onCameraNeeded,
      });
      return null;
    }

    act(() => {
      ReactTestRenderer.create(React.createElement(Harness));
    });

    await act(async () => {
      await ref.current.startSession(baseResponse({ message: '첫대화' }), {
        sessionId: 'sess-1',
        problemImageBase64: 'img',
      });
    });

    evaluateStudentInputFn.mockResolvedValueOnce(
      baseResponse({
        fsm_state: 'ERROR',
        error_type: 'OCR_FAILED',
        message: '사진을 찍어서 보여줘.',
      }),
    );

    await act(async () => {
      await ref.current.submitStudentInput('이거 풀어줘');
    });

    expect(ref.current.session.fsmState).toBe('ERROR');
    expect(speakFn).toHaveBeenLastCalledWith('사진을 찍어서 보여줘.');
    // 재촬영 뒤에도 같은 세션을 이어가야 하므로, 지금 세션 스냅샷을 같이 넘긴다.
    expect(onCameraNeeded).toHaveBeenCalledWith(
      '이거 풀어줘',
      expect.objectContaining({ sessionId: 'sess-1' }),
    );
  });

  // 대화 도중 재촬영을 하면 ConversationScreen 이 언마운트됐다가 다시 뜬다.
  // 그때 새 세션을 만들면 history/hintCount/wrongStreak 이 전부 날아가고 DB 에는
  // 고아 세션 row 가 하나 더 생긴다. seed 로 넘어온 연속성 값을 이어받아야 한다.
  it('resumes a prior session from the seed instead of restarting from scratch', async () => {
    const { ref } = renderFsm({ evaluateStudentInputFn: jest.fn() });

    await act(async () => {
      await ref.current.startSession(
        baseResponse({ message: '다시 찍은 사진 보고 이어서 말할게' }),
        {
          sessionId: 'sess-1',
          problemImageBase64: 'img2',
          hintCount: 4,
          wrongStreak: 2,
          history: [
            { role: 'user', message: '앞선 질문' },
            { role: 'model', message: '앞선 답' },
          ],
        },
      );
    });

    expect(ref.current.session.sessionId).toBe('sess-1');
    expect(ref.current.session.hintCount).toBe(5);
    expect(ref.current.session.wrongStreak).toBe(2);
    expect(ref.current.session.history).toEqual([
      { role: 'user', message: '앞선 질문' },
      { role: 'model', message: '앞선 답' },
      {
        role: 'model',
        message: '다시 찍은 사진 보고 이어서 말할게',
        timestamp: expect.any(Number),
      },
    ]);
  });

  it('still starts a clean session when the seed carries no continuity', async () => {
    const { ref } = renderFsm({ evaluateStudentInputFn: jest.fn() });

    await act(async () => {
      await ref.current.startSession(baseResponse({ message: '첫 힌트' }), {
        sessionId: 'sess-new',
        problemImageBase64: 'img',
      });
    });

    expect(ref.current.session.hintCount).toBe(1);
    expect(ref.current.session.wrongStreak).toBe(0);
    expect(ref.current.session.history).toEqual([
      { role: 'model', message: '첫 힌트', timestamp: expect.any(Number) },
    ]);
  });

  it('persists noPhotoConceptQuestion context flag across turns when session has no problemImageBase64', async () => {
    const evaluateStudentInputFn = jest
      .fn()
      .mockResolvedValue(baseResponse({ message: '두번째 응답' }));
    const { ref } = renderFsm({ evaluateStudentInputFn });

    await act(async () => {
      await ref.current.startSession(baseResponse({ message: '첫 개념 답' }), {
        sessionId: 'sess-1',
        problemImageBase64: '',
      });
    });

    await act(async () => {
      await ref.current.submitStudentInput('접선이 뭐야?');
    });

    expect(evaluateStudentInputFn).toHaveBeenCalledWith(
      '접선이 뭐야?',
      expect.objectContaining({ problemImageBase64: '' }),
      expect.stringContaining('This is a pure concept/formula question with NO photo.'),
    );
  });

  describe('usage accumulation', () => {
    it("seeds session.usage from startSession's initialUsage param", async () => {
      const evaluateStudentInputFn = jest.fn();
      const { ref } = renderFsm({ evaluateStudentInputFn });

      await act(async () => {
        await ref.current.startSession(
          baseResponse(),
          { sessionId: 'sess-1', problemImageBase64: 'img' },
          undefined,
          { promptTokens: 100, candidateTokens: 20, totalTokens: 120 },
        );
      });

      expect(ref.current.session.usage).toMatchObject({
        textCalls: 1,
        promptTokens: 100,
        candidateTokens: 20,
        totalTokens: 120,
      });
    });

    it('defaults session.usage to the empty summary when startSession gets no initialUsage', async () => {
      const evaluateStudentInputFn = jest.fn();
      const { ref } = renderFsm({ evaluateStudentInputFn });

      await act(async () => {
        await ref.current.startSession(baseResponse(), {
          sessionId: 'sess-1',
          problemImageBase64: 'img',
        });
      });

      expect(ref.current.session.usage).toEqual({
        textCalls: 0,
        imageCalls: 0,
        promptTokens: 0,
        candidateTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      });
    });

    it('accumulates usage from each evaluateStudentInput response onto session.usage', async () => {
      const evaluateStudentInputFn = jest.fn();
      const { ref } = renderFsm({ evaluateStudentInputFn });

      await act(async () => {
        await ref.current.startSession(
          baseResponse(),
          { sessionId: 'sess-1', problemImageBase64: 'img' },
          undefined,
          { promptTokens: 100, candidateTokens: 20, totalTokens: 120 },
        );
      });

      evaluateStudentInputFn.mockResolvedValueOnce(
        baseResponse({
          is_on_correct_path: true,
          usage: { promptTokens: 50, candidateTokens: 10, totalTokens: 60 },
        }),
      );
      await act(async () => {
        await ref.current.submitStudentInput('정답입니다');
      });

      expect(ref.current.session.usage).toMatchObject({
        textCalls: 2,
        promptTokens: 150,
        candidateTokens: 30,
        totalTokens: 180,
      });
    });

    it('accumulates board-image usage via updateBoardData', async () => {
      const evaluateStudentInputFn = jest.fn();
      const { ref } = renderFsm({ evaluateStudentInputFn });

      await act(async () => {
        await ref.current.startSession(baseResponse(), {
          sessionId: 'sess-1',
          problemImageBase64: 'img',
        });
      });

      act(() => {
        ref.current.updateBoardData('board-base64', {
          promptTokens: 300,
          candidateTokens: 0,
          totalTokens: 300,
        });
      });

      expect(ref.current.session.usage).toMatchObject({ imageCalls: 1, promptTokens: 300 });
      expect(ref.current.session.lastBoardImageBase64).toBe('board-base64');
    });
  });

  describe('directSolveMode', () => {
    it("finishes the session immediately when startSession's analysis is already SOLVE_STAGE (requires directSolveMode=true - the only authorized reveal path on turn 1)", async () => {
      const evaluateStudentInputFn = jest.fn();
      const onSessionComplete = jest.fn();
      const { ref, speakFn } = renderFsm({
        evaluateStudentInputFn,
        onSessionComplete,
        directSolveMode: true,
      });

      await act(async () => {
        await ref.current.startSession(
          baseResponse({
            fsm_state: 'SOLVE_STAGE',
            explicit_answer_request: true,
            requires_board: true, // Gemini's own choice - board policy still applies for authorized solves.
            message: '전체 풀이: 2x + 3 = 7이니까 x = 2야.',
          }),
          { sessionId: 'sess-1', problemImageBase64: 'img' },
        );
      });

      expect(speakFn).toHaveBeenCalledWith('전체 풀이: 2x + 3 = 7이니까 x = 2야.');
      expect(ref.current.phase).toBe('done');
      // Session stays on the solution screen - no auto-navigation home.
      expect(onSessionComplete).not.toHaveBeenCalled();
    });

    it('blocks SOLVE_STAGE on turn 1 when directSolveMode is OFF - refuses instead of speaking the leaked solution text', async () => {
      const evaluateStudentInputFn = jest.fn();
      const onSessionComplete = jest.fn();
      const { ref, speakFn } = renderFsm({ evaluateStudentInputFn, onSessionComplete });

      await act(async () => {
        await ref.current.startSession(
          baseResponse({
            fsm_state: 'SOLVE_STAGE',
            explicit_answer_request: true,
            requires_board: true,
            message: '전체 풀이: 2x + 3 = 7이니까 x = 2야.', // must never reach speakFn
          }),
          { sessionId: 'sess-1', problemImageBase64: 'img' },
        );
      });

      expect(speakFn).not.toHaveBeenCalledWith('전체 풀이: 2x + 3 = 7이니까 x = 2야.');
      expect(ref.current.session.fsmState).toBe('HINT_STAGE');
      expect(ref.current.conversation?.fsmState).toBe('HINT_STAGE');
      expect(ref.current.conversation?.requires_board).toBe(false);
      expect(ref.current.phase).toBe('awaiting_input');
      expect(onSessionComplete).not.toHaveBeenCalled();
    });

    it("still waits for input as before when startSession's analysis is HINT_STAGE", async () => {
      const evaluateStudentInputFn = jest.fn();
      const onSessionComplete = jest.fn();
      const { ref } = renderFsm({ evaluateStudentInputFn, onSessionComplete });

      await act(async () => {
        await ref.current.startSession(baseResponse({ fsm_state: 'HINT_STAGE' }), {
          sessionId: 'sess-1',
          problemImageBase64: 'img',
        });
      });

      expect(ref.current.phase).toBe('awaiting_input');
      expect(onSessionComplete).not.toHaveBeenCalled();
    });

    it('passes directSolveMode through to the system prompt built for evaluateStudentInput', async () => {
      const evaluateStudentInputFn = jest.fn().mockResolvedValue(baseResponse());
      const speakFn = jest.fn().mockResolvedValue(undefined);
      const ref: { current: UseTutoringFSMResult | null } = { current: null };

      function Harness() {
        ref.current = useTutoringFSM({ evaluateStudentInputFn, speakFn, directSolveMode: true });
        return null;
      }

      act(() => {
        ReactTestRenderer.create(React.createElement(Harness));
      });

      await act(async () => {
        await ref.current!.startSession(baseResponse({ fsm_state: 'HINT_STAGE' }), {
          sessionId: 'sess-1',
          problemImageBase64: 'img',
        });
      });

      await act(async () => {
        await ref.current!.submitStudentInput('문제 다시 물어볼게');
      });

      expect(evaluateStudentInputFn).toHaveBeenCalledWith(
        '문제 다시 물어볼게',
        expect.anything(),
        expect.stringContaining('바로 정답'),
      );
    });
  });

  // D-37: 로봇 사다리 소진 시 폰 카메라를 무음으로 열지 않고 음성으로 묻는다.
  // 동의("응") -> onCameraNeeded, 그 외("아니") -> 마무리 발화 후 세션 종료.
  // 폰 세션(photoSource 미지정)은 기존처럼 즉시 onCameraNeeded (위 687행 테스트).
  describe('음성 확인 폰 폴백 (D-37, 로봇 세션)', () => {
    function renderPiFsm() {
      const evaluateStudentInputFn = jest.fn();
      const onCameraNeeded = jest.fn();
      const onSessionComplete = jest.fn();
      const speakFn = jest.fn().mockResolvedValue(undefined);
      const ref: { current: UseTutoringFSMResult | null } = { current: null };

      function Harness() {
        ref.current = useTutoringFSM({
          evaluateStudentInputFn,
          speakFn,
          onCameraNeeded,
          onSessionComplete,
        });
        return null;
      }
      act(() => {
        ReactTestRenderer.create(React.createElement(Harness));
      });
      return {
        ref: ref as { current: UseTutoringFSMResult },
        evaluateStudentInputFn,
        onCameraNeeded,
        onSessionComplete,
        speakFn,
      };
    }

    async function driveToFallbackQuestion(f: ReturnType<typeof renderPiFsm>) {
      await act(async () => {
        await f.ref.current.startSession(baseResponse(), {
          sessionId: 'sess-pi',
          problemImageBase64: 'img',
          photoSource: 'pi',
        });
      });
      // 재촬영 함수 미주입 -> piRetake 불가 -> 사다리 소진과 같은 종단.
      f.evaluateStudentInputFn.mockResolvedValueOnce(
        baseResponse({
          fsm_state: 'ERROR',
          error_type: 'OCR_FAILED',
          message: '사진이 잘 안 보여.',
        }),
      );
      await act(async () => {
        await f.ref.current.submitStudentInput('이거 풀어줘');
      });
    }

    it('사다리 소진 시 폰 카메라를 바로 열지 않고 확인 질문을 말한 뒤 대답을 기다린다', async () => {
      const f = renderPiFsm();
      await driveToFallbackQuestion(f);

      expect(f.speakFn).toHaveBeenLastCalledWith(PHONE_FALLBACK_QUESTION, undefined, 1.0);
      expect(f.ref.current.conversation?.message).toBe(PHONE_FALLBACK_QUESTION);
      expect(f.ref.current.phase).toBe('awaiting_input');
      expect(f.onCameraNeeded).not.toHaveBeenCalled();
      expect(f.onSessionComplete).not.toHaveBeenCalled();
    });

    // 실기기 피드백 2026-08-05: 확인 질문 앞에 Gemini 의 ERROR 문구("사진이 잘
    // 안 보여." + 로봇 모드에선 실행 불가능한 "네가 찍어서 보여줘")가 먼저
    // 나가서, 학생 대답을 받지도 않고 묻고 자문자답하는 꼴이었다.
    it('확인 질문 앞에 Gemini 의 ERROR 문구를 덧붙이지 않는다 (자문자답 방지)', async () => {
      const f = renderPiFsm();
      await driveToFallbackQuestion(f);

      const spoken = f.speakFn.mock.calls.map((c: unknown[]) => c[0]);
      expect(spoken).not.toContain('사진이 잘 안 보여.');
      // 첫 힌트 발화 + 확인 질문, 둘뿐.
      expect(spoken).toHaveLength(2);
      expect(spoken[1]).toBe(PHONE_FALLBACK_QUESTION);
      // 들은 말 = 기록된 말.
      expect(f.ref.current.session.history?.map((h) => h.message)).not.toContain(
        '사진이 잘 안 보여.',
      );
    });

    it('"응" -> onCameraNeeded 가 원래 발화와 세션 스냅샷을 들고 호출된다', async () => {
      const f = renderPiFsm();
      await driveToFallbackQuestion(f);

      await act(async () => {
        await f.ref.current.submitStudentInput('응');
      });

      expect(f.onCameraNeeded).toHaveBeenCalledWith(
        '이거 풀어줘',
        expect.objectContaining({ sessionId: 'sess-pi' }),
      );
      // 대답은 인터셉트가 소비한다 - ERROR 턴 1회 이후 EVAL 이 다시 돌면 안 된다.
      expect(f.evaluateStudentInputFn).toHaveBeenCalledTimes(1);
    });

    it('"응" -> 확인 질문과 학생의 동의 발화가 세션 이력(다음 세션에 승계될 snapshot)에 남는다', async () => {
      const f = renderPiFsm();
      await driveToFallbackQuestion(f);

      await act(async () => {
        await f.ref.current.submitStudentInput('응');
      });

      const [, snapshot] = f.onCameraNeeded.mock.calls[0];
      expect(snapshot.history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'model', message: PHONE_FALLBACK_QUESTION }),
          expect.objectContaining({ role: 'user', message: '응' }),
        ]),
      );
    });

    it('"아니" -> 마무리 발화 후 세션 종료, 폰 카메라는 열리지 않는다', async () => {
      const f = renderPiFsm();
      await driveToFallbackQuestion(f);

      await act(async () => {
        await f.ref.current.submitStudentInput('아니');
      });

      expect(f.onCameraNeeded).not.toHaveBeenCalled();
      expect(f.speakFn).toHaveBeenLastCalledWith(PHONE_FALLBACK_DECLINE_MESSAGE, undefined, 1.0);
      expect(f.ref.current.phase).toBe('done');
      expect(f.onSessionComplete).toHaveBeenCalled();
      expect(f.evaluateStudentInputFn).toHaveBeenCalledTimes(1);
    });

    it('"아니" -> 확인 질문/거절 대답까지 포함해 세션이 저장된다 (예전엔 이 마지막 문답이 저장 자체가 안 됐다)', async () => {
      const f = renderPiFsm();
      await driveToFallbackQuestion(f);
      mockedSaveSession.mockClear();

      await act(async () => {
        await f.ref.current.submitStudentInput('아니');
      });

      expect(mockedSaveSession).toHaveBeenCalled();
      const savedEntry = mockedSaveSession.mock.calls[mockedSaveSession.mock.calls.length - 1][0];
      expect(savedEntry.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'model', message: PHONE_FALLBACK_QUESTION }),
          expect.objectContaining({ role: 'user', message: '아니' }),
          expect.objectContaining({ role: 'model', message: PHONE_FALLBACK_DECLINE_MESSAGE }),
        ]),
      );
    });

    // 실기기 피드백 2026-08-05: 질문이 "찍게 도와줄까?" 인데 동의어 사전은
    // "볼까?" 류에 맞춰져 있어서, 가장 자연스러운 대답인 "도와줘"/"부탁해"/
    // "찍어줘" 가 전부 거절로 떨어졌다 - 학생이 수락했는데 로봇이 세션을 닫았다.
    it.each(['도와줘', '응 도와줘', '부탁해', '찍어줘', '네 도와주세요'])(
      '"%s" -> 수락으로 본다 (질문이 "도와줄까?" 이므로)',
      async (reply) => {
        const f = renderPiFsm();
        await driveToFallbackQuestion(f);

        await act(async () => {
          await f.ref.current.submitStudentInput(reply);
        });

        expect(f.onCameraNeeded).toHaveBeenCalled();
        expect(f.onSessionComplete).not.toHaveBeenCalled();
      },
    );

    // 넓힌 사전이 거절까지 삼키면 안 된다.
    it.each(['아니', '괜찮아', '그만할래'])('"%s" -> 여전히 거절이다', async (reply) => {
      const f = renderPiFsm();
      await driveToFallbackQuestion(f);

      await act(async () => {
        await f.ref.current.submitStudentInput(reply);
      });

      expect(f.onCameraNeeded).not.toHaveBeenCalled();
      expect(f.onSessionComplete).toHaveBeenCalled();
    });

    // 실기기 2026-08-05 "히스토리에 내 발화가 없다" 회귀: startSession 종단이
    // recordSessionId 없이 물어봐서, 학생의 동의/거절 발화와 거절 마무리가
    // 이력·저장에서 통째로 빠졌다.
    it('첫 분석 ERROR 경로: 질문과 "응" 이 세션 이력(스냅샷)에 남고, usage 도 승계된다', async () => {
      const f = renderPiFsm();
      await act(async () => {
        await f.ref.current.startSession(
          baseResponse({
            fsm_state: 'ERROR',
            error_type: 'OCR_FAILED',
            message: '사진이 잘 안 보여.',
          }),
          { sessionId: 'sess-pi', problemImageBase64: 'img', photoSource: 'pi' },
        );
      });
      await act(async () => {
        await f.ref.current.submitStudentInput('응');
      });

      const [, snapshot] = f.onCameraNeeded.mock.calls[0];
      const spokenHistory = snapshot.history?.map((h: { message: string }) => h.message) ?? [];
      expect(spokenHistory).toEqual([PHONE_FALLBACK_QUESTION, '응']);
      expect(snapshot.usage).toBeDefined();
    });

    it('첫 분석 ERROR 경로: 거절하면 "아니"/마무리 발화까지 포함해 저장된다', async () => {
      const f = renderPiFsm();
      await act(async () => {
        await f.ref.current.startSession(
          baseResponse({
            fsm_state: 'ERROR',
            error_type: 'OCR_FAILED',
            message: '사진이 잘 안 보여.',
          }),
          { sessionId: 'sess-pi', problemImageBase64: 'img', photoSource: 'pi' },
        );
      });
      mockedSaveSession.mockClear();
      await act(async () => {
        await f.ref.current.submitStudentInput('아니');
      });

      expect(mockedSaveSession).toHaveBeenCalled();
      const saved = mockedSaveSession.mock.calls[mockedSaveSession.mock.calls.length - 1][0];
      expect(saved.messages.map((m) => m.message)).toEqual([
        PHONE_FALLBACK_QUESTION,
        '아니',
        PHONE_FALLBACK_DECLINE_MESSAGE,
      ]);
    });

    it('첫 분석 ERROR (startSession 종단) 도 같은 확인 질문을 탄다', async () => {
      const f = renderPiFsm();
      await act(async () => {
        await f.ref.current.startSession(
          baseResponse({
            fsm_state: 'ERROR',
            error_type: 'OCR_FAILED',
            message: '사진이 잘 안 보여.',
          }),
          { sessionId: 'sess-pi', problemImageBase64: 'img', photoSource: 'pi' },
        );
      });

      expect(f.speakFn).toHaveBeenLastCalledWith(PHONE_FALLBACK_QUESTION, undefined, 1.0);
      expect(f.ref.current.phase).toBe('awaiting_input');
      expect(f.onCameraNeeded).not.toHaveBeenCalled();

      await act(async () => {
        await f.ref.current.submitStudentInput('응');
      });
      expect(f.onCameraNeeded).toHaveBeenCalledWith(
        '',
        expect.objectContaining({ sessionId: 'sess-pi' }),
      );
    });
  });

  describe('handwriting ask-back', () => {
    /** 3회 독립 판독 중 갈리는(투표 불일치) 시퀀스 - voteHandwriting 이
     * askBack:true 를 내도록 판독 1을 다르게 준다. */
    function mockDisagreeingReads(recognizeHandwritingFn: jest.Mock) {
      recognizeHandwritingFn
        .mockResolvedValueOnce({ candidates: ['96'], usage: EMPTY_TOKEN_USAGE })
        .mockResolvedValueOnce({ candidates: ['66'], usage: EMPTY_TOKEN_USAGE })
        .mockResolvedValueOnce({ candidates: ['96'], usage: EMPTY_TOKEN_USAGE });
    }

    // ERROR 게이트 전용 커버리지: 다른 모든 ERROR 테스트는 is_on_correct_path
    // 가 baseResponse 기본값(null)이라 "판단할 학생 풀이 없음" 게이트가 이미
    // 막아서 이 게이트 삭제해도 안 걸린다. is_on_correct_path 를 false 로 줘서
    // ERROR 게이트만이 막는지 확인한다. 안 막으면: 흐릿한 사진(OCR_FAILED)에
    // 판독 3회가 나가고, 서로 다른 값을 읽어 되묻기가 ERROR 메시지와
    // fsm_state 를 덮어써 재촬영 사다리(piFirstRetake/폰 폴백/onCameraNeeded)
    // 가 아예 안 돈다 - 학생이 붕 뜬다.
    it('ERROR 응답(OCR_FAILED)은 is_on_correct_path 가 있어도 인식 호출을 하지 않는다', async () => {
      const evaluateStudentInputFn = jest.fn();
      const recognizeHandwritingFn = jest.fn();
      const { ref } = renderFsm({ evaluateStudentInputFn, recognizeHandwritingFn });

      await act(async () => {
        await ref.current.startSession(
          baseResponse({
            fsm_state: 'ERROR',
            error_type: 'OCR_FAILED',
            is_on_correct_path: false,
          }),
          { sessionId: 'sess-hw-error', problemImageBase64: 'img' },
        );
      });

      expect(recognizeHandwritingFn).not.toHaveBeenCalled();
    });

    // IMPORTANT 1 회귀 방지: 폰 세션은 cropFlowOpen(=photoSource==='pi' &&
    // fetchProblemCropFn) 이 항상 false 라 729행의 "몇 번 풀고 있어?" 분기가
    // 안 열리고, 898행 단일 문제 크롭도 problems.length===1 일 때만 돈다.
    // 즉 problems.length>=2 인 폰 세션은 askBackImage 가 페이지 풀프레임인
    // 채로 세션을 시작한다 - 이 게이트가 없으면 3회 판독이 서로 다른 문제의
    // 손글씨 답을 집어 가짜 불일치("다른 문제 답")로 되묻기가 뜬다.
    it('다문제 페이지(폰 세션, problems.length>=2)는 인식 호출을 하지 않는다', async () => {
      const evaluateStudentInputFn = jest.fn();
      const recognizeHandwritingFn = jest.fn();
      const { ref } = renderFsm({ evaluateStudentInputFn, recognizeHandwritingFn });

      await act(async () => {
        await ref.current.startSession(
          baseResponse({
            is_on_correct_path: false,
            problems: [
              { label: '3번', box_2d: [100, 100, 400, 500] },
              { label: '5번', box_2d: [450, 100, 800, 500] },
            ],
          }),
          { sessionId: 'sess-hw-multi', problemImageBase64: 'full-page-img', photoSource: 'phone' },
        );
      });

      expect(recognizeHandwritingFn).not.toHaveBeenCalled();
    });

    it('판독이 갈리면 모델 message 대신 되묻기 질문을 말한다', async () => {
      const evaluateStudentInputFn = jest.fn();
      const recognizeHandwritingFn = jest.fn();
      mockDisagreeingReads(recognizeHandwritingFn);
      const { ref, speakFn } = renderFsm({ evaluateStudentInputFn, recognizeHandwritingFn });

      // board_update_needed 를 true 로 띄워둬야 아래 false 단언이 실제로 뭔가를
      // 잡는다 - baseResponse 기본값이 false 라 그대로 두면 공단언이 된다.
      const analysis = baseResponse({
        message: '정답은 96이야.',
        is_on_correct_path: false,
        board_update_needed: true,
      });

      await act(async () => {
        await ref.current.startSession(analysis, {
          sessionId: 'sess-hw-1',
          problemImageBase64: 'img',
        });
      });

      // IMPORTANT 3: 판독이 seed 의 이번 사진으로 나가는지 핀 - setSessionState
      // 는 아직 안 돈 시점이라, 실수로 sessionRef.current.problemImageBase64
      // 를 넘기면 이전 세션 값('' - 초기 state)이 나가 이 단언이 깨진다.
      expect(recognizeHandwritingFn).toHaveBeenCalledWith('img');
      expect(recognizeHandwritingFn).toHaveBeenCalledTimes(HANDWRITING_READ_COUNT);

      const lastSpoken = speakFn.mock.calls[speakFn.mock.calls.length - 1][0];
      expect(lastSpoken).toBe(HANDWRITING_ASKBACK_QUESTION);
      expect(speakFn).not.toHaveBeenCalledWith('정답은 96이야.');
      // cc60dd0 회귀 방지: 되묻는 턴이 requires_board 를 false 로 갈아끼우면
      // 첫 사진 턴에서 BOARD_PROMPT_POLICY 가 여는 유일한 지점이 죽어
      // 세션 내내 판서가 한 번도 안 뜬다. board_update_needed 만 꺼야 한다.
      expect(ref.current.conversation?.requires_board).toBe(true);
      expect(ref.current.conversation?.board_update_needed).toBe(false);
    });

    // 661행 주석의 "History 비용 ~12% 과소보고" 버그와 같은 종류: 판독 3회의
    // usage 가 seed.usage+initialUsage 재계산으로 덮이면 접힌 값이 증발한다.
    // 구 recomputation(`usage: initialUsage ? addTextUsage(seed.usage ?? EMPTY,
    // initialUsage) : ...`)이면 textCalls 가 1(최초 분석)에서 멈춘다 - 이
    // 테스트는 그 recomputation 으로 되돌리면 실패해야 한다.
    it('되묻기 판독 usage 가 세션 usage 총합에 접힌다', async () => {
      const evaluateStudentInputFn = jest.fn();
      const recognizeHandwritingFn = jest.fn();
      const readUsage: TokenUsage = { promptTokens: 10, candidateTokens: 2, totalTokens: 12 };
      recognizeHandwritingFn
        .mockResolvedValueOnce({ candidates: ['96'], usage: readUsage })
        .mockResolvedValueOnce({ candidates: ['66'], usage: readUsage })
        .mockResolvedValueOnce({ candidates: ['96'], usage: readUsage });
      const { ref } = renderFsm({ evaluateStudentInputFn, recognizeHandwritingFn });

      await act(async () => {
        await ref.current.startSession(
          baseResponse({ message: '정답은 96이야.', is_on_correct_path: false }),
          { sessionId: 'sess-hw-usage', problemImageBase64: 'img' },
          undefined,
          { promptTokens: 100, candidateTokens: 20, totalTokens: 120 },
        );
      });

      // 최초 분석 1회 + 판독 3회 = 4. 토큰도 판독 3회분(10/2/12 씩)이 더해져야
      // 한다.
      expect(ref.current.session.usage).toMatchObject({
        textCalls: 4,
        promptTokens: 130,
        candidateTokens: 26,
        totalTokens: 156,
      });
    });

    it('되묻기 후 학생 대답은 재판독 없이 EVAL 턴으로 흐른다', async () => {
      const evaluateStudentInputFn = jest.fn();
      const analyzeImageFn = jest.fn();
      const recognizeHandwritingFn = jest.fn();
      mockDisagreeingReads(recognizeHandwritingFn);
      const { ref } = renderFsm({
        evaluateStudentInputFn,
        analyzeImageFn,
        recognizeHandwritingFn,
      });

      await act(async () => {
        await ref.current.startSession(
          baseResponse({ message: '정답은 96이야.', is_on_correct_path: false }),
          { sessionId: 'sess-hw-2', problemImageBase64: 'img' },
        );
      });

      evaluateStudentInputFn.mockResolvedValueOnce(baseResponse({ message: '좋아, 맞았어!' }));

      await act(async () => {
        await ref.current.submitStudentInput('96이야');
      });

      expect(analyzeImageFn).not.toHaveBeenCalled();
      // startSession 의 3회 판독뿐 - 대답 턴엔 재판독이 없다.
      expect(recognizeHandwritingFn).toHaveBeenCalledTimes(HANDWRITING_READ_COUNT);
      expect(evaluateStudentInputFn).toHaveBeenCalledTimes(1);
      const [sentText] = evaluateStudentInputFn.mock.calls[0];
      // 프리픽스가 붙어야 모델이 "학생이 확정한 답" 임을 안다 - 원문 그대로면
      // 일반 EVAL 턴과 구분이 안 된다.
      expect(sentText).toBe('내가 종이에 쓴 최종 답을 말해줄게: 96이야');
      // 이력엔 학생의 원문 발화만 남는다 (프리픽스는 모델 호출에만 붙는다).
      expect(ref.current.session.history?.map((h) => h.message)).toContain('96이야');
    });

    it('문제당 3회 소진 후에는 판독이 갈려도 조용히 진행한다', async () => {
      const evaluateStudentInputFn = jest.fn();
      const recognizeHandwritingFn = jest.fn();
      for (let i = 0; i < HANDWRITING_ASKBACK_MAX; i++) {
        mockDisagreeingReads(recognizeHandwritingFn);
      }
      const { ref, speakFn } = renderFsm({ evaluateStudentInputFn, recognizeHandwritingFn });

      for (let i = 0; i < HANDWRITING_ASKBACK_MAX; i++) {
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          await ref.current.startSession(
            baseResponse({ message: `모델 메시지 ${i}`, is_on_correct_path: false }),
            { sessionId: 'sess-hw-3', problemImageBase64: 'img' },
          );
        });
        const spoken = speakFn.mock.calls[speakFn.mock.calls.length - 1][0];
        expect(spoken).toBe(HANDWRITING_ASKBACK_QUESTION);
      }
      expect(recognizeHandwritingFn).toHaveBeenCalledTimes(
        HANDWRITING_ASKBACK_MAX * HANDWRITING_READ_COUNT,
      );

      speakFn.mockClear();
      recognizeHandwritingFn.mockClear();
      await act(async () => {
        await ref.current.startSession(
          baseResponse({ message: '4번째 애매 메시지', is_on_correct_path: false }),
          { sessionId: 'sess-hw-3', problemImageBase64: 'img' },
        );
      });

      expect(speakFn).toHaveBeenLastCalledWith('4번째 애매 메시지');
      // 상한 소진 - 인식 호출 자체가 안 나간다.
      expect(recognizeHandwritingFn).not.toHaveBeenCalled();
    });

    it('SOLVE_STAGE 에서 판독이 갈려 되묻기 발동 시, 자동 종료(onSessionComplete)가 억제되고 학생 답을 기다린다', async () => {
      const evaluateStudentInputFn = jest.fn();
      const onSessionComplete = jest.fn();
      const recognizeHandwritingFn = jest.fn();
      mockDisagreeingReads(recognizeHandwritingFn);
      const { ref, speakFn } = renderFsm({
        evaluateStudentInputFn,
        onSessionComplete,
        recognizeHandwritingFn,
      });

      const analysis = baseResponse({
        fsm_state: 'SOLVE_STAGE',
        is_on_correct_path: true,
        message: '맞다, 정답은 96이야!',
      });

      await act(async () => {
        await ref.current.startSession(analysis, {
          sessionId: 'sess-hw-solve',
          problemImageBase64: 'img',
        });
      });

      // 되묻기 질문이 말해진다 (모델 message 대신)
      const lastSpoken = speakFn.mock.calls[speakFn.mock.calls.length - 1][0];
      expect(lastSpoken).toBe(HANDWRITING_ASKBACK_QUESTION);
      expect(speakFn).not.toHaveBeenCalledWith('맞다, 정답은 96이야!');

      // SOLVE_STAGE 자동 종료가 억제된다
      expect(onSessionComplete).not.toHaveBeenCalled();
      // 세션은 열린 상태에서 학생 답을 기다린다
      expect(ref.current.phase).toBe('awaiting_input');
    });

    it('되묻기 프리픽스는 대답 턴 한 번만 붙고, 다음 발화로 새지 않는다', async () => {
      const evaluateStudentInputFn = jest.fn();
      const recognizeHandwritingFn = jest.fn();
      mockDisagreeingReads(recognizeHandwritingFn);
      const { ref } = renderFsm({ evaluateStudentInputFn, recognizeHandwritingFn });

      await act(async () => {
        await ref.current.startSession(
          baseResponse({ message: '정답은 96이야.', is_on_correct_path: false }),
          { sessionId: 'sess-hw-4', problemImageBase64: 'img' },
        );
      });

      evaluateStudentInputFn.mockResolvedValueOnce(baseResponse({ message: '좋아, 맞았어!' }));
      await act(async () => {
        await ref.current.submitStudentInput('96이야');
      });

      evaluateStudentInputFn.mockResolvedValueOnce(baseResponse({ message: '다음 문제 풀자.' }));
      await act(async () => {
        await ref.current.submitStudentInput('다음 질문이야');
      });

      expect(evaluateStudentInputFn).toHaveBeenCalledTimes(2);
      const [secondSentText] = evaluateStudentInputFn.mock.calls[1];
      expect(secondSentText).not.toContain('내가 종이에 쓴 최종 답을 말해줄게');
      expect(secondSentText).toBe('다음 질문이야');
    });

    it('손글씨가 없으면(is_on_correct_path === null) 인식 호출을 하지 않는다', async () => {
      const evaluateStudentInputFn = jest.fn();
      const recognizeHandwritingFn = jest.fn();
      const { ref } = renderFsm({ evaluateStudentInputFn, recognizeHandwritingFn });

      await act(async () => {
        await ref.current.startSession(baseResponse({ is_on_correct_path: null }), {
          sessionId: 'sess-hw-5',
          problemImageBase64: 'img',
        });
      });

      expect(recognizeHandwritingFn).not.toHaveBeenCalled();
    });

    it('판독을 3회 병렬 호출한다 (순차 루프가 아니다)', async () => {
      const evaluateStudentInputFn = jest.fn();
      // 아무것도 즉시 resolve 하지 않는 deferred promise 3개 - 순차
      // `for (...) await` 루프였다면 이 시점에 recognizeHandwritingFn 이
      // 1번만 불려 있고, 2/3번째는 1번째가 resolve 되기 전엔 호출조차 안 된다.
      const resolvers: ((v: { candidates: string[]; usage: TokenUsage }) => void)[] = [];
      const recognizeHandwritingFn = jest.fn(
        () =>
          new Promise<{ candidates: string[]; usage: TokenUsage }>((resolve) => {
            resolvers.push(resolve);
          }),
      );
      const { ref, speakFn } = renderFsm({ evaluateStudentInputFn, recognizeHandwritingFn });

      let startPromise: Promise<void> = Promise.resolve();
      act(() => {
        startPromise = ref.current.startSession(
          baseResponse({ is_on_correct_path: false, message: '정답은 22야.' }),
          { sessionId: 'sess-hw-6', problemImageBase64: 'img' },
        );
      });

      // 마이크로태스크 한 틱만 흘려서 확인한다 - 셋 다 이미 걸려 있어야 병렬.
      await Promise.resolve();
      expect(recognizeHandwritingFn.mock.calls.length).toBe(HANDWRITING_READ_COUNT);
      // IMPORTANT 2: 판독 대기 구간에도 phase 가 'idle' 로 남으면 안 된다 -
      // 자막/로딩 닷이 없고 마이크가 열린 채 학생이 아직 안 시딩된 세션에
      // 대고 말하게 된다.
      expect(ref.current.phase).toBe('evaluating');

      await act(async () => {
        resolvers.forEach((resolve) => resolve({ candidates: ['22'], usage: EMPTY_TOKEN_USAGE }));
        await startPromise;
      });

      // 3개 다 일치이므로 되묻지 않고 원래 message 를 말한다.
      expect(speakFn).toHaveBeenLastCalledWith('정답은 22야.');
      expect(ref.current.phase).toBe('awaiting_input');
    });

    it('인식 호출이 2개 이상 실패하면 되묻지 않고 진행한다', async () => {
      const evaluateStudentInputFn = jest.fn();
      const recognizeHandwritingFn = jest
        .fn()
        .mockRejectedValueOnce(new Error('network'))
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValueOnce({ candidates: ['22'], usage: EMPTY_TOKEN_USAGE });
      const { ref, speakFn } = renderFsm({ evaluateStudentInputFn, recognizeHandwritingFn });

      await act(async () => {
        await ref.current.startSession(
          baseResponse({ is_on_correct_path: false, message: '정답은 22야.' }),
          { sessionId: 'sess-hw-7', problemImageBase64: 'img' },
        );
      });

      // 원래 analysis.message 가 발화되고 세션이 정상 진행된다.
      expect(speakFn).toHaveBeenLastCalledWith('정답은 22야.');
      expect(ref.current.phase).toBe('awaiting_input');
    });

    /** 되묻기가 뜬 상태까지 몰아주는 공통 셋업. */
    async function seedAskBack(overrides: { evaluateStudentInputFn: jest.Mock }) {
      const recognizeHandwritingFn = jest.fn();
      mockDisagreeingReads(recognizeHandwritingFn);
      const f = renderFsm({ ...overrides, recognizeHandwritingFn });
      await act(async () => {
        await f.ref.current.startSession(
          baseResponse({ message: '정답은 96이야.', is_on_correct_path: false }),
          { sessionId: 'sess-hw-kind', problemImageBase64: 'img' },
        );
      });
      expect(f.speakFn).toHaveBeenLastCalledWith(HANDWRITING_ASKBACK_QUESTION);
      return { ...f, recognizeHandwritingFn };
    }

    it('confused 대답은 모델 호출 없이 재질문 1회를 말한다', async () => {
      const evaluateStudentInputFn = jest.fn();
      const { ref, speakFn } = await seedAskBack({ evaluateStudentInputFn });

      await act(async () => {
        await ref.current.submitStudentInput('무슨 말이야?');
      });

      expect(evaluateStudentInputFn).not.toHaveBeenCalled();
      expect(speakFn).toHaveBeenLastCalledWith(HANDWRITING_ASKBACK_RETRY, undefined, 1.0);
      expect(ref.current.phase).toBe('awaiting_input');
    });

    it('재질문 뒤에도 confused 면 풀이 과정으로 전환한다', async () => {
      const evaluateStudentInputFn = jest.fn();
      const { ref, speakFn } = await seedAskBack({ evaluateStudentInputFn });

      await act(async () => {
        await ref.current.submitStudentInput('무슨 말이야?');
      });
      await act(async () => {
        await ref.current.submitStudentInput('응? 뭐라고?');
      });

      expect(evaluateStudentInputFn).not.toHaveBeenCalled();
      expect(speakFn).toHaveBeenLastCalledWith(HANDWRITING_ASKBACK_FALLBACK, undefined, 1.0);
    });

    it('재질문(retried) 뒤 정상 답이 오면 프리픽스를 붙여 EVAL 로 흐른다', async () => {
      const evaluateStudentInputFn = jest.fn();
      const { ref } = await seedAskBack({ evaluateStudentInputFn });

      await act(async () => {
        await ref.current.submitStudentInput('무슨 말이야?');
      });

      evaluateStudentInputFn.mockResolvedValueOnce(baseResponse({ message: '좋아, 맞았어!' }));
      await act(async () => {
        await ref.current.submitStudentInput('96이야');
      });

      expect(evaluateStudentInputFn).toHaveBeenCalledTimes(1);
      const [sentText] = evaluateStudentInputFn.mock.calls[0];
      expect(sentText).toBe('내가 종이에 쓴 최종 답을 말해줄게: 96이야');
    });

    // 자기 글씨를 못 읽는 학생에게 같은 질문을 다시 하는 건 의미가 없다 -
    // 재질문 예산을 쓰지 않고 바로 풀이 전환으로 간다.
    it('cant_read 대답은 재질문을 건너뛰고 바로 풀이 전환한다', async () => {
      const evaluateStudentInputFn = jest.fn();
      const { ref, speakFn } = await seedAskBack({ evaluateStudentInputFn });

      await act(async () => {
        await ref.current.submitStudentInput('나도 모르겠어');
      });

      expect(speakFn).toHaveBeenLastCalledWith(HANDWRITING_ASKBACK_FALLBACK, undefined, 1.0);
      expect(evaluateStudentInputFn).not.toHaveBeenCalled();
    });

    it('풀이 전환 뒤 다음 발화는 프리픽스 없는 일반 EVAL 턴이다', async () => {
      const evaluateStudentInputFn = jest.fn();
      const { ref } = await seedAskBack({ evaluateStudentInputFn });

      await act(async () => {
        await ref.current.submitStudentInput('나도 모르겠어');
      });
      evaluateStudentInputFn.mockResolvedValueOnce(baseResponse({ message: '그렇구나.' }));
      await act(async () => {
        await ref.current.submitStudentInput('88에서 66을 뺐어');
      });

      const [sentText] = evaluateStudentInputFn.mock.calls[0];
      expect(sentText).toBe('88에서 66을 뺐어');
    });

    it('재질문·풀이 전환 발화가 이력에 남는다', async () => {
      const evaluateStudentInputFn = jest.fn();
      const { ref } = await seedAskBack({ evaluateStudentInputFn });

      await act(async () => {
        await ref.current.submitStudentInput('무슨 말이야?');
      });

      const messages = ref.current.session.history?.map((h) => h.message) ?? [];
      expect(messages).toContain('무슨 말이야?');
      expect(messages).toContain(HANDWRITING_ASKBACK_RETRY);
    });

    // 되묻기 대기 중엔 마이크가 열려 있다. 타이머가 말을 시작하기 전에 닫지
    // 않으면 VIVA 자기 목소리가 학생 발화로 전사돼 되돌아온다.
    it('무응답 8초면 마이크를 닫고 재질문한다', async () => {
      jest.useFakeTimers();
      try {
        const evaluateStudentInputFn = jest.fn();
        const stopListeningFn = jest.fn();
        const recognizeHandwritingFn = jest.fn();
        mockDisagreeingReads(recognizeHandwritingFn);
        const { ref, speakFn } = renderFsm({
          evaluateStudentInputFn,
          recognizeHandwritingFn,
          stopListeningFn,
        });

        await act(async () => {
          await ref.current.startSession(
            baseResponse({ message: '정답은 96이야.', is_on_correct_path: false }),
            { sessionId: 'sess-hw-timer', problemImageBase64: 'img' },
          );
        });

        await act(async () => {
          await jest.advanceTimersByTimeAsync(HANDWRITING_ASKBACK_SILENCE_MS);
        });

        expect(stopListeningFn).toHaveBeenCalled();
        expect(speakFn).toHaveBeenLastCalledWith(HANDWRITING_ASKBACK_RETRY, undefined, 1.0);
        expect(stopListeningFn.mock.invocationCallOrder[0]).toBeLessThan(
          speakFn.mock.invocationCallOrder[speakFn.mock.invocationCallOrder.length - 1],
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('재질문 뒤에도 무응답이면 풀이 과정으로 전환한다', async () => {
      jest.useFakeTimers();
      try {
        const evaluateStudentInputFn = jest.fn();
        const recognizeHandwritingFn = jest.fn();
        mockDisagreeingReads(recognizeHandwritingFn);
        const { ref, speakFn } = renderFsm({ evaluateStudentInputFn, recognizeHandwritingFn });

        await act(async () => {
          await ref.current.startSession(
            baseResponse({ message: '정답은 96이야.', is_on_correct_path: false }),
            { sessionId: 'sess-hw-timer2', problemImageBase64: 'img' },
          );
        });

        await act(async () => {
          await jest.advanceTimersByTimeAsync(HANDWRITING_ASKBACK_SILENCE_MS);
        });
        await act(async () => {
          await jest.advanceTimersByTimeAsync(HANDWRITING_ASKBACK_SILENCE_MS);
        });

        expect(speakFn).toHaveBeenLastCalledWith(HANDWRITING_ASKBACK_FALLBACK, undefined, 1.0);
        expect(evaluateStudentInputFn).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('학생이 답하면 무응답 타이머는 더 이상 울리지 않는다', async () => {
      jest.useFakeTimers();
      try {
        const evaluateStudentInputFn = jest.fn();
        const recognizeHandwritingFn = jest.fn();
        mockDisagreeingReads(recognizeHandwritingFn);
        const { ref, speakFn } = renderFsm({ evaluateStudentInputFn, recognizeHandwritingFn });

        await act(async () => {
          await ref.current.startSession(
            baseResponse({ message: '정답은 96이야.', is_on_correct_path: false }),
            { sessionId: 'sess-hw-timer3', problemImageBase64: 'img' },
          );
        });

        evaluateStudentInputFn.mockResolvedValueOnce(baseResponse({ message: '좋아, 맞았어!' }));
        await act(async () => {
          await ref.current.submitStudentInput('96이야');
        });
        speakFn.mockClear();
        await act(async () => {
          await jest.advanceTimersByTimeAsync(HANDWRITING_ASKBACK_SILENCE_MS * 3);
        });

        expect(speakFn).not.toHaveBeenCalledWith(HANDWRITING_ASKBACK_RETRY, undefined, 1.0);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // 학생 하차 인터셉트: "알았어 꺼져", "이제 가도 돼" - 모델이 student_dismissal
  // 로 신호하면 튜터링 내용 없이 고정 인사만 말하고 세션을 닫는다.
  describe('학생 하차 (student_dismissal)', () => {
    async function startBasicSession(f: {
      ref: { current: UseTutoringFSMResult };
    }) {
      await act(async () => {
        await f.ref.current.startSession(baseResponse(), {
          sessionId: 'sess-dismiss',
          problemImageBase64: 'img',
        });
      });
    }

    it('student_dismissal=true: 모델 메시지 대신 고정 인사를 말하고 onSessionComplete 가 호출된다', async () => {
      const evaluateStudentInputFn = jest.fn();
      const onSessionComplete = jest.fn();
      const f = renderFsm({ evaluateStudentInputFn, onSessionComplete });
      await startBasicSession(f);

      evaluateStudentInputFn.mockResolvedValueOnce(
        baseResponse({ student_dismissal: true, message: '알겠어, 그럼 정리해볼게...' }),
      );
      await act(async () => {
        await f.ref.current.submitStudentInput('알았어 꺼져');
      });

      expect(f.speakFn).toHaveBeenLastCalledWith(DISMISSAL_EXIT_PHRASE, undefined, 1.0);
      expect(f.speakFn).not.toHaveBeenCalledWith('알겠어, 그럼 정리해볼게...');
      expect(onSessionComplete).toHaveBeenCalledTimes(1);
      // 학생이 들은 문구 그대로 이력에 남는다.
      expect(f.ref.current.session.history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', message: '알았어 꺼져' }),
          expect.objectContaining({ role: 'model', message: DISMISSAL_EXIT_PHRASE }),
        ]),
      );
    });

    it.each([
      ['false', { student_dismissal: false as const }],
      ['undefined (구 mock/응답)', {}],
    ])('student_dismissal=%s: 일반 흐름 그대로, 세션 종료 없음', async (_label, extra) => {
      const evaluateStudentInputFn = jest.fn();
      const onSessionComplete = jest.fn();
      const f = renderFsm({ evaluateStudentInputFn, onSessionComplete });
      await startBasicSession(f);

      evaluateStudentInputFn.mockResolvedValueOnce(
        baseResponse({ ...extra, message: '다음 단계는 뭘까?' }),
      );
      await act(async () => {
        await f.ref.current.submitStudentInput('인수분해 했어');
      });

      expect(f.speakFn).toHaveBeenLastCalledWith('다음 단계는 뭘까?');
      expect(onSessionComplete).not.toHaveBeenCalled();
      expect(f.ref.current.phase).toBe('awaiting_input');
    });
  });
});

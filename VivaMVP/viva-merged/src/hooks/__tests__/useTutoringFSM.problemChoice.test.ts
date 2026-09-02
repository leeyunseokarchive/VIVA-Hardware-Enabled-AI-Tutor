/**
 * 다문제 되묻기 + 인식 실패 크롭 재분석 (2026-07-28 크롭 파이프라인 스펙).
 * fetchProblemCropFn/analyzeImageFn 을 목으로 주입해 네트워크 없이 분기만
 * 검증한다.
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import {
  useTutoringFSM,
  UseTutoringFSMResult,
  PHONE_FALLBACK_QUESTION,
  PI_RETAKE_FILLER,
} from '../useTutoringFSM';
import type { GeminiTutoringResponse } from '../../types/Tutoring';

function baseResponse(overrides: Partial<GeminiTutoringResponse> = {}): GeminiTutoringResponse {
  return {
    fsm_state: 'HINT_STAGE',
    explicit_answer_request: false,
    is_on_correct_path: null,
    requires_board: false,
    board_update_needed: false,
    message: 'default message',
    board_prompt: '',
    confidence: 0.9,
    error_type: 'NONE',
    misconception_type: 'NONE',
    topic: '기타',
    title: 'default title',
    ...overrides,
  };
}

const TWO_PROBLEMS = [
  { label: '3번', box_2d: [100, 100, 400, 500] },
  { label: '4번', box_2d: [450, 100, 800, 500] },
];

function renderFsm(options: {
  speakFn?: jest.Mock;
  analyzeImageFn?: jest.Mock;
  fetchProblemCropFn?: jest.Mock;
  onCameraNeeded?: jest.Mock;
  evaluateStudentInputFn?: jest.Mock;
  recapturePiRegionFn?: jest.Mock;
  fetchPiPhotoFn?: jest.Mock;
  capturePhotoNowFn?: jest.Mock;
}) {
  const speakFn = options.speakFn ?? jest.fn().mockResolvedValue(undefined);
  const ref: { current: UseTutoringFSMResult | null } = { current: null };

  function Harness() {
    ref.current = useTutoringFSM({
      evaluateStudentInputFn:
        options.evaluateStudentInputFn ?? jest.fn().mockResolvedValue(baseResponse()),
      speakFn,
      analyzeImageFn: options.analyzeImageFn,
      fetchProblemCropFn: options.fetchProblemCropFn,
      onCameraNeeded: options.onCameraNeeded,
      recapturePiRegionFn: options.recapturePiRegionFn,
      fetchPiPhotoFn: options.fetchPiPhotoFn,
      capturePhotoNowFn: options.capturePhotoNowFn,
    });
    return null;
  }
  act(() => {
    ReactTestRenderer.create(React.createElement(Harness));
  });
  return { ref: ref as { current: UseTutoringFSMResult }, speakFn };
}

const PI_SEED = {
  sessionId: 's1',
  problemImageBase64: 'full-frame-b64',
  photoSource: 'pi' as const,
};

describe('multi-problem ask flow', () => {
  it('asks which problem instead of tutoring when 2+ problems from pi', async () => {
    const fetchProblemCropFn = jest.fn();
    const { ref, speakFn } = renderFsm({ fetchProblemCropFn });
    await act(async () => {
      await ref.current.startSession(
        baseResponse({ message: 'tutoring msg', problems: TWO_PROBLEMS }),
        PI_SEED,
      );
    });
    expect(speakFn.mock.calls[0][0]).toContain('몇 번');
    expect(speakFn.mock.calls[0][0]).not.toBe('tutoring msg');
    expect(ref.current.phase).toBe('awaiting_input');
    expect(fetchProblemCropFn).not.toHaveBeenCalled(); // 대답 전엔 크롭 안 함
  });

  it('crops the matched problem and re-analyzes on answer', async () => {
    const fetchProblemCropFn = jest.fn().mockResolvedValue('crop-b64');
    const analyzeImageFn = jest
      .fn()
      .mockResolvedValue(baseResponse({ message: 'cropped tutoring msg' }));
    const { ref, speakFn } = renderFsm({ fetchProblemCropFn, analyzeImageFn });
    await act(async () => {
      await ref.current.startSession(baseResponse({ problems: TWO_PROBLEMS }), PI_SEED);
    });
    await act(async () => {
      await ref.current.submitStudentInput('3번이요');
    });
    expect(fetchProblemCropFn).toHaveBeenCalledWith([100, 100, 400, 500]);
    expect(analyzeImageFn).toHaveBeenCalledWith(
      'crop-b64',
      expect.anything(),
      expect.any(String),
      undefined,
      undefined,
    );
    expect(speakFn).toHaveBeenLastCalledWith('cropped tutoring msg');
    expect(ref.current.session.problemImageBase64).toBe('crop-b64');
    // 매칭 성공 경로는 "몇 번 풀고 있어?" 질문과 학생의 "3번이요" 대답을 새
    // 세션 이력에 안 남기던 버그가 있었다(매칭 실패 폴백 경로만 남겼음) -
    // export-chat/디버깅에서 이 문답이 통째로 사라지던 원인의 수정 검증.
    expect(ref.current.session.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'model', message: expect.stringContaining('몇 번') }),
        expect.objectContaining({ role: 'user', message: '3번이요' }),
      ]),
    );
  });

  // 되묻기는 언제나 정확히 1회. 매칭/크롭이 실패해도 원본 분석 message 를
  // 다시 발화하지 않는다 (그 message 는 거의 항상 "몇 번 풀어볼까?" 라서
  // 방금 대답한 학생에게 같은 질문을 두 번 하는 꼴이었다).
  it('evaluates the utterance instead of asking again when it matches nothing', async () => {
    const fetchProblemCropFn = jest.fn();
    const evaluateStudentInputFn = jest
      .fn()
      .mockResolvedValue(baseResponse({ message: 'eval reply' }));
    const { ref, speakFn } = renderFsm({ fetchProblemCropFn, evaluateStudentInputFn });
    await act(async () => {
      await ref.current.startSession(
        baseResponse({ message: 'full-frame msg', problems: TWO_PROBLEMS }),
        PI_SEED,
      );
    });
    await act(async () => {
      await ref.current.submitStudentInput('몰라');
    });
    expect(fetchProblemCropFn).not.toHaveBeenCalled();
    expect(evaluateStudentInputFn).toHaveBeenCalled();
    expect(speakFn).toHaveBeenLastCalledWith('eval reply');
    // 되묻기 발화는 처음 1회뿐
    expect(speakFn.mock.calls.filter((c) => String(c[0]).includes('몇 번'))).toHaveLength(1);
    expect(speakFn.mock.calls.map((c) => c[0])).not.toContain('full-frame msg');
    expect(ref.current.phase).toBe('awaiting_input');
    // 풀프레임 사진은 그대로 물고 가야 EVAL 이 이미지를 볼 수 있다
    expect(ref.current.session.problemImageBase64).toBe('full-frame-b64');
  });

  it('evaluates the utterance instead of asking again when the crop fetch fails', async () => {
    const fetchProblemCropFn = jest.fn().mockRejectedValue(new Error('network'));
    const evaluateStudentInputFn = jest
      .fn()
      .mockResolvedValue(baseResponse({ message: 'eval reply' }));
    const { ref, speakFn } = renderFsm({ fetchProblemCropFn, evaluateStudentInputFn });
    await act(async () => {
      await ref.current.startSession(
        baseResponse({ message: 'full-frame msg', problems: TWO_PROBLEMS }),
        PI_SEED,
      );
    });
    await act(async () => {
      await ref.current.submitStudentInput('3번');
    });
    expect(speakFn).toHaveBeenLastCalledWith('eval reply');
    expect(speakFn.mock.calls.filter((c) => String(c[0]).includes('몇 번'))).toHaveLength(1);
  });

  it('does NOT ask when photoSource is not pi', async () => {
    const { ref, speakFn } = renderFsm({ fetchProblemCropFn: jest.fn() });
    await act(async () => {
      await ref.current.startSession(
        baseResponse({ message: 'tutoring msg', problems: TWO_PROBLEMS }),
        { sessionId: 's1', problemImageBase64: 'b64' }, // photoSource 없음
      );
    });
    expect(speakFn).toHaveBeenCalledWith('tutoring msg');
  });

  it('suppresses board generation while the ask is pending', async () => {
    const fetchProblemCropFn = jest.fn();
    const { ref } = renderFsm({ fetchProblemCropFn });
    await act(async () => {
      await ref.current.startSession(
        baseResponse({
          problems: TWO_PROBLEMS,
          requires_board: true,
          board_update_needed: true,
          board_prompt: 'draw something',
        }),
        PI_SEED,
      );
    });
    expect(ref.current.conversation?.requires_board).toBe(false);
    expect(ref.current.conversation?.board_update_needed).toBe(false);
    expect(ref.current.conversation?.board_prompt).toBe('');
  });

  it('clears a stale pending ask when startSession re-enters for a new photo', async () => {
    const fetchProblemCropFn = jest.fn();
    const evaluateStudentInputFn = jest
      .fn()
      .mockResolvedValue(baseResponse({ message: 'eval reply' }));
    const { ref } = renderFsm({ fetchProblemCropFn, evaluateStudentInputFn });
    await act(async () => {
      await ref.current.startSession(baseResponse({ problems: TWO_PROBLEMS }), PI_SEED);
    });
    await act(async () => {
      await ref.current.startSession(baseResponse({ message: 'second photo msg' }), {
        sessionId: 's2',
        problemImageBase64: 'b64-2',
        photoSource: 'pi' as const,
      });
    });
    await act(async () => {
      await ref.current.submitStudentInput('3번');
    });
    expect(fetchProblemCropFn).not.toHaveBeenCalled();
    expect(evaluateStudentInputFn).toHaveBeenCalled();
  });
});

describe('OCR-failure crop retry', () => {
  const ERROR_ANALYSIS = baseResponse({
    fsm_state: 'ERROR',
    error_type: 'OCR_FAILED',
    message: 'retake please',
    problems: [TWO_PROBLEMS[0]],
  });

  it('retries with a crop before asking for a retake', async () => {
    const fetchProblemCropFn = jest.fn().mockResolvedValue('crop-b64');
    const analyzeImageFn = jest.fn().mockResolvedValue(baseResponse({ message: 'recovered msg' }));
    const onCameraNeeded = jest.fn();
    const { ref, speakFn } = renderFsm({ fetchProblemCropFn, analyzeImageFn, onCameraNeeded });
    await act(async () => {
      await ref.current.startSession(ERROR_ANALYSIS, PI_SEED);
    });
    expect(fetchProblemCropFn).toHaveBeenCalledWith([100, 100, 400, 500]);
    expect(speakFn).toHaveBeenLastCalledWith('recovered msg');
    expect(onCameraNeeded).not.toHaveBeenCalled();
  });

  it('falls through to the retake flow when the crop retry also errors', async () => {
    const fetchProblemCropFn = jest.fn().mockResolvedValue('crop-b64');
    const analyzeImageFn = jest
      .fn()
      .mockResolvedValue(
        baseResponse({ fsm_state: 'ERROR', error_type: 'OCR_FAILED', message: 'still bad' }),
      );
    const onCameraNeeded = jest.fn();
    const { ref } = renderFsm({ fetchProblemCropFn, analyzeImageFn, onCameraNeeded });
    await act(async () => {
      await ref.current.startSession(ERROR_ANALYSIS, PI_SEED);
    });
    // D-37: 사다리 소진 후엔 음성 확인("응")을 거쳐야 폰 카메라가 열린다.
    expect(onCameraNeeded).not.toHaveBeenCalled();
    await act(async () => {
      await ref.current.submitStudentInput('응');
    });
    expect(onCameraNeeded).toHaveBeenCalled();
  });

  // Tier 2 (실기기 피드백 2026-07-28): 크롭 재분석도 실패하면 폰 카메라를
  // 켜는 대신 로봇 카메라로 그 bbox 에 AF 를 걸고 재촬영해 재분석한다.
  it('re-captures the region on the robot camera when the crop is still unreadable', async () => {
    const fetchProblemCropFn = jest.fn().mockResolvedValue('crop-b64');
    const analyzeImageFn = jest
      .fn()
      .mockResolvedValueOnce(
        baseResponse({ fsm_state: 'ERROR', error_type: 'OCR_FAILED', message: 'still bad' }),
      )
      .mockResolvedValueOnce(baseResponse({ message: 'recovered after recapture' }));
    const recapturePiRegionFn = jest.fn().mockResolvedValue(undefined);
    const fetchPiPhotoFn = jest.fn().mockResolvedValue('shot-b64');
    const onCameraNeeded = jest.fn();
    const { ref, speakFn } = renderFsm({
      fetchProblemCropFn,
      analyzeImageFn,
      recapturePiRegionFn,
      fetchPiPhotoFn,
      onCameraNeeded,
    });
    await act(async () => {
      await ref.current.startSession(ERROR_ANALYSIS, PI_SEED);
    });
    expect(recapturePiRegionFn).toHaveBeenCalledWith([100, 100, 400, 500]);
    expect(analyzeImageFn).toHaveBeenLastCalledWith(
      'shot-b64',
      expect.anything(),
      expect.any(String),
      undefined,
      undefined,
    );
    expect(speakFn).toHaveBeenLastCalledWith('recovered after recapture');
    expect(ref.current.session.problemImageBase64).toBe('shot-b64');
    expect(onCameraNeeded).not.toHaveBeenCalled();
  });

  it('falls back to the retake flow when the region re-capture also fails', async () => {
    const fetchProblemCropFn = jest.fn().mockResolvedValue('crop-b64');
    const analyzeImageFn = jest
      .fn()
      .mockResolvedValue(
        baseResponse({ fsm_state: 'ERROR', error_type: 'OCR_FAILED', message: 'still bad' }),
      );
    const recapturePiRegionFn = jest.fn().mockRejectedValue(new Error('pi down'));
    const fetchPiPhotoFn = jest.fn();
    const onCameraNeeded = jest.fn();
    const { ref } = renderFsm({
      fetchProblemCropFn,
      analyzeImageFn,
      recapturePiRegionFn,
      fetchPiPhotoFn,
      onCameraNeeded,
    });
    await act(async () => {
      await ref.current.startSession(ERROR_ANALYSIS, PI_SEED);
    });
    expect(recapturePiRegionFn).toHaveBeenCalled();
    // D-37: 최후 수단(폰 카메라)은 음성 확인 뒤에만 열린다.
    expect(onCameraNeeded).not.toHaveBeenCalled();
    await act(async () => {
      await ref.current.submitStudentInput('응');
    });
    expect(onCameraNeeded).toHaveBeenCalled();
  });

  it('skips the retry entirely without a crop fn (phone path safety)', async () => {
    const onCameraNeeded = jest.fn();
    const { ref, speakFn } = renderFsm({ onCameraNeeded });
    await act(async () => {
      await ref.current.startSession(ERROR_ANALYSIS, PI_SEED);
    });
    // 폰 폴백으로 끝나는 로봇 경로는 Gemini 의 ERROR 문구('retake please')를
    // 말하지 않는다 - 폰이 거치된 로봇 모드에서 학생이 실행할 수 없는 지시인데다
    // 곧바로 이어지는 확인 질문이 같은 내용을 담아, 묻고 자문자답하는 꼴이었다
    // (실기기 피드백 2026-08-05). 실제로 나가는 발화는 확인 질문 하나뿐이다.
    expect(speakFn).not.toHaveBeenCalledWith('retake please');
    expect(speakFn).toHaveBeenCalledTimes(1);
    expect(speakFn).toHaveBeenCalledWith(PHONE_FALLBACK_QUESTION, undefined, expect.any(Number));
    // D-37: 로봇 세션이므로 음성 확인을 거친다.
    expect(onCameraNeeded).not.toHaveBeenCalled();
    await act(async () => {
      await ref.current.submitStudentInput('응');
    });
    expect(onCameraNeeded).toHaveBeenCalled();
  });
});

// 실기기 피드백 2026-07-29: 풀이 도중 "다시 촬영해" 를 하면 폰 카메라가 켜졌다.
// system_prompt 의 ERROR_POLICY 가 그 요청을 ERROR/OCR_FAILED 로 돌려주는데,
// 78c7e35 의 Tier 사다리는 startSession 에만 있었고 submitStudentInput 의 ERROR
// 분기는 photoSource 검사조차 없이 바로 onCameraNeeded(=폰)를 불렀다.
describe('mid-conversation retake on the robot camera', () => {
  const OCR_ERROR = () =>
    baseResponse({
      fsm_state: 'ERROR',
      error_type: 'OCR_FAILED',
      message: '사진으로 찍어서 보여줘!',
    });

  // response.message 를 직접 갈아끼우므로 목 객체를 두 턴에 공유하면 변형이
  // 샌다 - 호출마다 새 객체를 만든다.
  function piSession(overrides: {
    capturePhotoNowFn?: jest.Mock;
    fetchPiPhotoFn?: jest.Mock;
    analyzeImageFn?: jest.Mock;
    onCameraNeeded?: jest.Mock;
    seed?: { sessionId: string; problemImageBase64: string; photoSource?: 'pi' | 'phone' };
  }) {
    return renderFsm({
      evaluateStudentInputFn: jest.fn().mockImplementation(async () => OCR_ERROR()),
      capturePhotoNowFn: overrides.capturePhotoNowFn,
      fetchPiPhotoFn: overrides.fetchPiPhotoFn,
      analyzeImageFn: overrides.analyzeImageFn,
      onCameraNeeded: overrides.onCameraNeeded,
    });
  }

  it('re-shoots with the robot camera instead of opening the phone camera', async () => {
    const capturePhotoNowFn = jest.fn().mockResolvedValue(undefined);
    const fetchPiPhotoFn = jest.fn().mockResolvedValue('shot-b64');
    const analyzeImageFn = jest
      .fn()
      .mockImplementation(async () => baseResponse({ message: 'recovered after retake' }));
    const onCameraNeeded = jest.fn();
    const { ref, speakFn } = piSession({
      capturePhotoNowFn,
      fetchPiPhotoFn,
      analyzeImageFn,
      onCameraNeeded,
    });

    await act(async () => {
      await ref.current.startSession(baseResponse({ message: 'first hint' }), PI_SEED);
    });
    await act(async () => {
      await ref.current.submitStudentInput('다시 촬영해줘');
    });

    expect(capturePhotoNowFn).toHaveBeenCalled();
    // Tier 1 크롭이 아니라 새로 찍은 프레임으로 재분석한다
    expect(analyzeImageFn).toHaveBeenLastCalledWith(
      'shot-b64',
      expect.anything(),
      expect.any(String),
      '다시 촬영해줘',
      undefined,
    );
    // Gemini 의 "네가 찍어서 보여줘" 는 로봇 모드에서 학생이 실행할 수 없는
    // 지시라 필러로 갈아끼운다
    expect(speakFn.mock.calls.map((c) => c[0])).not.toContain('사진으로 찍어서 보여줘!');
    expect(speakFn.mock.calls.some((c) => c[0] === PI_RETAKE_FILLER)).toBe(true);
    expect(speakFn).toHaveBeenLastCalledWith('recovered after retake');
    // 같은 세션 계속
    expect(ref.current.session.sessionId).toBe('s1');
    expect(ref.current.session.problemImageBase64).toBe('shot-b64');
    expect(onCameraNeeded).not.toHaveBeenCalled();
  });

  it('shares the single retake budget with the first-analysis ladder (no double filler)', async () => {
    const capturePhotoNowFn = jest.fn().mockResolvedValue(undefined);
    const fetchPiPhotoFn = jest.fn().mockResolvedValue('shot-b64');
    // 재분석도 ERROR - 예산 공유가 없으면 재진입한 첫 분석 사다리가 재촬영을
    // 한 번 더 돌아 필러를 두 번 말한다 (run-6 problem_switcher)
    const analyzeImageFn = jest.fn().mockImplementation(async () => OCR_ERROR());
    const onCameraNeeded = jest.fn();
    const { ref, speakFn } = piSession({
      capturePhotoNowFn,
      fetchPiPhotoFn,
      analyzeImageFn,
      onCameraNeeded,
    });

    await act(async () => {
      await ref.current.startSession(baseResponse({ message: 'first hint' }), PI_SEED);
    });
    await act(async () => {
      await ref.current.submitStudentInput('다시 촬영해줘');
    });

    expect(capturePhotoNowFn).toHaveBeenCalledTimes(1);
    const fillers = speakFn.mock.calls.filter((c) => c[0] === PI_RETAKE_FILLER);
    expect(fillers).toHaveLength(1);
    // D-37: 예산 소진 후엔 음성 확인을 거쳐야 폰 카메라가 열린다.
    expect(onCameraNeeded).not.toHaveBeenCalled();
    await act(async () => {
      await ref.current.submitStudentInput('응');
    });
    expect(onCameraNeeded).toHaveBeenCalled();
  });

  it('records the student utterance exactly once across the re-entry', async () => {
    const { ref } = piSession({
      capturePhotoNowFn: jest.fn().mockResolvedValue(undefined),
      fetchPiPhotoFn: jest.fn().mockResolvedValue('shot-b64'),
      analyzeImageFn: jest.fn().mockImplementation(async () => baseResponse({ message: 'ok' })),
    });
    await act(async () => {
      await ref.current.startSession(baseResponse({ message: 'first hint' }), PI_SEED);
    });
    await act(async () => {
      await ref.current.submitStudentInput('다시 촬영해줘');
    });
    expect(
      (ref.current.session.history ?? []).filter((m) => m.message === '다시 촬영해줘'),
    ).toHaveLength(1);
  });

  it('still opens the phone camera for a phone session', async () => {
    const capturePhotoNowFn = jest.fn();
    const onCameraNeeded = jest.fn();
    const { ref } = piSession({
      capturePhotoNowFn,
      fetchPiPhotoFn: jest.fn(),
      onCameraNeeded,
    });
    await act(async () => {
      await ref.current.startSession(
        baseResponse({ message: 'first hint' }),
        { sessionId: 's1', problemImageBase64: 'b64' }, // photoSource 없음 = 폰
      );
    });
    await act(async () => {
      await ref.current.submitStudentInput('다시 촬영해줘');
    });
    expect(capturePhotoNowFn).not.toHaveBeenCalled();
    expect(onCameraNeeded).toHaveBeenCalled();
  });

  it('falls back to the phone camera when the robot capture fails', async () => {
    const capturePhotoNowFn = jest.fn().mockRejectedValue(new Error('pi down'));
    const onCameraNeeded = jest.fn();
    const { ref } = piSession({
      capturePhotoNowFn,
      fetchPiPhotoFn: jest.fn(),
      onCameraNeeded,
    });
    await act(async () => {
      await ref.current.startSession(baseResponse({ message: 'first hint' }), PI_SEED);
    });
    await act(async () => {
      await ref.current.submitStudentInput('다시 촬영해줘');
    });
    expect(capturePhotoNowFn).toHaveBeenCalled();
    // D-37: 로봇 촬영 실패 후에도 음성 확인을 거쳐 폰 카메라를 연다.
    expect(onCameraNeeded).not.toHaveBeenCalled();
    await act(async () => {
      await ref.current.submitStudentInput('응');
    });
    expect(onCameraNeeded).toHaveBeenCalledWith(
      '다시 촬영해줘',
      expect.objectContaining({ sessionId: 's1' }),
    );
  });
});

// 실기기 피드백 2026-07-30: 59번 풀이 도중 "59번은 됐으니까 60번 풀어줘" 를
// 하면 EVAL 첨부(현재 문제 전사 판서)에 60번이 없어 "안 보인다, 다시 찍자" 로
// 빠졌다. 첫 풀프레임 분석의 problems bbox 를 훅이 보존하고 있다가, 전환
// 발화를 감지하면 Gemini 에게 묻지 않고 보관본 크롭으로 새 세션을 연다.
describe('mid-conversation problem switch via the archived full frame', () => {
  async function startCroppedSession(opts: {
    fetchProblemCropFn: jest.Mock;
    analyzeImageFn: jest.Mock;
    evaluateStudentInputFn?: jest.Mock;
  }) {
    const rendered = renderFsm(opts);
    await act(async () => {
      await rendered.ref.current.startSession(baseResponse({ problems: TWO_PROBLEMS }), PI_SEED);
    });
    // 되묻기에 3번을 골라 크롭 세션으로 진입 (problems 는 세션 객체에서 벗겨짐)
    await act(async () => {
      await rendered.ref.current.submitStudentInput('3번이요');
    });
    return rendered;
  }

  it('re-crops the archived frame and starts a NEW session for the requested problem', async () => {
    const fetchProblemCropFn = jest
      .fn()
      .mockResolvedValueOnce('crop-3-b64')
      .mockResolvedValueOnce('crop-4-b64');
    const analyzeImageFn = jest
      .fn()
      .mockResolvedValueOnce(baseResponse({ message: '3번 시작', title: '3번 문제' }))
      .mockResolvedValueOnce(baseResponse({ message: '4번 시작', title: '4번 문제' }));
    const evaluateStudentInputFn = jest.fn();
    const { ref, speakFn } = await startCroppedSession({
      fetchProblemCropFn,
      analyzeImageFn,
      evaluateStudentInputFn,
    });
    const firstSessionId = ref.current.session.sessionId;

    await act(async () => {
      await ref.current.submitStudentInput('3번은 됐으니까 4번 문제 풀어줘');
    });

    // Gemini EVAL 을 묻지 않고 앱이 직접 4번 bbox 크롭으로 새 세션을 연다.
    expect(evaluateStudentInputFn).not.toHaveBeenCalled();
    expect(fetchProblemCropFn).toHaveBeenLastCalledWith([450, 100, 800, 500]);
    expect(speakFn).toHaveBeenLastCalledWith('4번 시작');
    expect(ref.current.session.problemImageBase64).toBe('crop-4-b64');
    // 새 문제 = 새 세션 (힌트/오답 카운터는 문제 단위 상태)
    expect(ref.current.session.sessionId).not.toBe(firstSessionId);
  });

  it.each([
    ['5'], // 맨몸 숫자 = 답변
    ['4번'], // 전환 의도 동사 없음
    ['3번 풀어줘'], // 현재 문제 재언급
  ])('does NOT switch on %s - falls through to normal EVAL', async (utterance) => {
    const fetchProblemCropFn = jest.fn().mockResolvedValue('crop-3-b64');
    const analyzeImageFn = jest.fn().mockResolvedValue(baseResponse({ message: '3번 시작' }));
    const evaluateStudentInputFn = jest
      .fn()
      .mockResolvedValue(baseResponse({ message: 'eval reply' }));
    const { ref } = await startCroppedSession({
      fetchProblemCropFn,
      analyzeImageFn,
      evaluateStudentInputFn,
    });

    await act(async () => {
      await ref.current.submitStudentInput(utterance);
    });

    expect(evaluateStudentInputFn).toHaveBeenCalled();
    expect(fetchProblemCropFn).toHaveBeenCalledTimes(1); // 되묻기 크롭 1회뿐
  });

  it('falls back to normal EVAL when the switch crop fails', async () => {
    const fetchProblemCropFn = jest
      .fn()
      .mockResolvedValueOnce('crop-3-b64')
      .mockRejectedValueOnce(new Error('archive gone'));
    const analyzeImageFn = jest.fn().mockResolvedValue(baseResponse({ message: '3번 시작' }));
    const evaluateStudentInputFn = jest
      .fn()
      .mockResolvedValue(baseResponse({ message: 'eval reply' }));
    const { ref, speakFn } = await startCroppedSession({
      fetchProblemCropFn,
      analyzeImageFn,
      evaluateStudentInputFn,
    });

    await act(async () => {
      await ref.current.submitStudentInput('4번 풀어줘');
    });

    expect(evaluateStudentInputFn).toHaveBeenCalled();
    expect(speakFn).toHaveBeenLastCalledWith('eval reply');
  });
});

// 실기기 피드백 2026-07-29(2차): 로봇으로 찍은 첫 사진이 회전돼 있어 Gemini 가
// problems bbox 를 하나도 못 잡으면(빈 배열) Tier1/2 사다리가 `problems.length
// >= 1` 게이트에 걸려 아예 안 열리고, 종단 ERROR 분기가 곧장 폰 카메라를 켰다.
// 로봇 세션의 첫 분석 ERROR 는 로봇 풀프레임 재촬영 1회를 먼저 시도해야 한다.
describe('first-analysis ERROR retakes on the robot camera', () => {
  const ROTATED_ERROR = () =>
    baseResponse({
      fsm_state: 'ERROR',
      error_type: 'OCR_FAILED',
      message: '책을 바르게 놓고 다시 찍어줄래?',
      problems: [], // bbox 없음 - 크롭 사다리가 열리지 않는 케이스
    });

  it('retakes with the robot instead of opening the phone camera', async () => {
    const capturePhotoNowFn = jest.fn().mockResolvedValue(undefined);
    const fetchPiPhotoFn = jest.fn().mockResolvedValue('retaken-b64');
    const analyzeImageFn = jest
      .fn()
      .mockResolvedValue(baseResponse({ message: '다시 보니 읽히네, 시작하자' }));
    const onCameraNeeded = jest.fn();
    const { ref } = renderFsm({
      capturePhotoNowFn,
      fetchPiPhotoFn,
      analyzeImageFn,
      onCameraNeeded,
    });

    await act(async () => {
      await ref.current.startSession(ROTATED_ERROR(), PI_SEED);
    });

    expect(capturePhotoNowFn).toHaveBeenCalledTimes(1);
    // 재촬영본으로 재분석해 같은 세션으로 진입, 폰 카메라는 안 연다.
    expect(analyzeImageFn).toHaveBeenCalledWith(
      'retaken-b64',
      expect.anything(),
      expect.anything(),
      undefined,
      undefined,
    );
    expect(onCameraNeeded).not.toHaveBeenCalled();
    expect(ref.current.session.problemImageBase64).toBe('retaken-b64');
    expect(ref.current.session.fsmState).toBe('HINT_STAGE');
  });

  // 실기기 피드백 2026-08-05: 재촬영 안내가 두 번 나갔다. Gemini 의 ERROR 문구가
  // 질문형("다시 찍어줄래?")인데 학생 대답을 받지도 않고 곧바로 "알겠어, 내가 다시
  // 찍어볼게" 가 이어져 묻고 자문자답하는 꼴이었고, history 엔 앞 문구만 남아
  // 들은 말과 기록도 어긋났다.
  it("speaks only the retake filler - never Gemini's question first", async () => {
    const capturePhotoNowFn = jest.fn().mockResolvedValue(undefined);
    const fetchPiPhotoFn = jest.fn().mockResolvedValue('retaken-b64');
    const analyzeImageFn = jest
      .fn()
      .mockResolvedValue(baseResponse({ message: '다시 보니 읽히네, 시작하자' }));
    const { ref, speakFn } = renderFsm({
      capturePhotoNowFn,
      fetchPiPhotoFn,
      analyzeImageFn,
      onCameraNeeded: jest.fn(),
    });

    await act(async () => {
      await ref.current.startSession(ROTATED_ERROR(), PI_SEED);
    });

    // 촬영 전에 나가는 발화는 정확히 하나 (그 뒤는 재분석 성공 발화).
    const spoken = speakFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(spoken).not.toContain('책을 바르게 놓고 다시 찍어줄래?');
    expect(spoken[0]).toBe(PI_RETAKE_FILLER);
    // 들은 말 = 기록된 말.
    expect(ref.current.session.history?.map((h) => h.message)).not.toContain(
      '책을 바르게 놓고 다시 찍어줄래?',
    );
  });

  it('opens the phone camera only after the single robot retake also fails', async () => {
    const capturePhotoNowFn = jest.fn().mockResolvedValue(undefined);
    const fetchPiPhotoFn = jest.fn().mockResolvedValue('still-rotated-b64');
    const analyzeImageFn = jest.fn().mockImplementation(async () => ROTATED_ERROR());
    const onCameraNeeded = jest.fn();
    const { ref } = renderFsm({
      capturePhotoNowFn,
      fetchPiPhotoFn,
      analyzeImageFn,
      onCameraNeeded,
    });

    await act(async () => {
      await ref.current.startSession(ROTATED_ERROR(), PI_SEED);
    });

    // 재촬영은 세션당 1회만 - 그 뒤에도 ERROR 면 폰 카메라가 최종 종결자.
    // D-37: 단, 음성 확인("응")을 거쳐서만 열린다.
    expect(capturePhotoNowFn).toHaveBeenCalledTimes(1);
    expect(onCameraNeeded).not.toHaveBeenCalled();
    await act(async () => {
      await ref.current.submitStudentInput('응');
    });
    expect(onCameraNeeded).toHaveBeenCalledWith('', expect.objectContaining({ sessionId: 's1' }));
  });

  it('goes straight to the phone camera for phone-sourced sessions', async () => {
    const capturePhotoNowFn = jest.fn();
    const onCameraNeeded = jest.fn();
    const { ref } = renderFsm({ capturePhotoNowFn, fetchPiPhotoFn: jest.fn(), onCameraNeeded });

    await act(async () => {
      await ref.current.startSession(ROTATED_ERROR(), {
        sessionId: 's-phone',
        problemImageBase64: 'img',
        photoSource: 'phone',
      });
    });

    expect(capturePhotoNowFn).not.toHaveBeenCalled();
    expect(onCameraNeeded).toHaveBeenCalled();
  });
});

// D-30 선지 불일치. 1차는 조용한 재인식(ERROR/LOW_IMAGE_QUALITY), 2차는 학생에게
// 선지를 읽어달라고 묻는다. 그 대답을 받는 인터셉트가 없어서, 읽어준 선지가 일반
// EVAL 턴으로 흘러갔고 EVAL 턴은 프롬프트상 final_answer 재도출이 금지라 잘못
// 읽힌 선지가 세션 끝까지 굳었다 (실기기 피드백 2026-08-05).
describe('choice-mismatch re-read (D-30)', () => {
  const MISMATCH = () => baseResponse({ answer_not_in_choices: true, message: 'hint msg' });

  /** 재인식 1회를 소진시켜 CHOICE_MISMATCH_MESSAGE 가 나가는 상태까지 민다. */
  async function driveToChoiceQuestion(overrides: Parameters<typeof renderFsm>[0] = {}) {
    const f = renderFsm(overrides);
    await act(async () => {
      await f.ref.current.startSession(MISMATCH(), PI_SEED); // 1차: 조용한 재인식
    });
    await act(async () => {
      await f.ref.current.startSession(MISMATCH(), PI_SEED); // 2차: 학생에게 물음
    });
    return f;
  }

  it('학생이 읽어준 선지를 원본 사진 재분석에 넘긴다 (EVAL 턴으로 흘리지 않는다)', async () => {
    const analyzeImageFn = jest
      .fn()
      .mockResolvedValue(baseResponse({ message: '아, 4번이 그 값이었구나!' }));
    const evaluateStudentInputFn = jest.fn().mockResolvedValue(baseResponse());
    const f = await driveToChoiceQuestion({ analyzeImageFn, evaluateStudentInputFn });
    expect(f.speakFn).toHaveBeenLastCalledWith(expect.stringContaining('하나씩 읽어줄래'));

    await act(async () => {
      await f.ref.current.submitStudentInput('1번 3, 2번 5, 3번 8, 4번 루트3분의80');
    });

    // 재분석은 원본 사진 + 학생 발화로. EVAL 은 돌지 않는다.
    expect(analyzeImageFn).toHaveBeenCalledWith(
      'full-frame-b64',
      expect.anything(),
      expect.any(String),
      '1번 3, 2번 5, 3번 8, 4번 루트3분의80',
      undefined,
    );
    expect(evaluateStudentInputFn).not.toHaveBeenCalled();
    expect(f.ref.current.session.history?.map((h) => h.message)).toContain(
      '1번 3, 2번 5, 3번 8, 4번 루트3분의80',
    );
  });

  it('재분석 후에도 불일치면 같은 질문을 반복하지 않는다 (무한 루프 방지)', async () => {
    // 재분석 결과가 여전히 answer_not_in_choices=true.
    const analyzeImageFn = jest.fn().mockResolvedValue(MISMATCH());
    const f = await driveToChoiceQuestion({ analyzeImageFn });

    await act(async () => {
      await f.ref.current.submitStudentInput('1번 3, 2번 5');
    });

    const asked = f.speakFn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('하나씩 읽어줄래'),
    );
    expect(asked).toHaveLength(1);
    // 3번째 불일치는 모델 메시지를 그대로 쓴다.
    expect(f.speakFn).toHaveBeenLastCalledWith('hint msg');
  });
});

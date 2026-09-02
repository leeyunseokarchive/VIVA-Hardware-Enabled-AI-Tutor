/**
 * Unit tests for the capture-result retake decision (Task 4 Step 5,
 * task-4-brief.md 완료 기준 3: "이미지 품질 실패 시 재촬영 흐름 동작").
 *
 * This is the one piece of real branching logic CameraScreen needs: given a
 * GeminiTutoringResponse from analyzeImage(), decide whether to ask the
 * student to retake the photo (low confidence or ERROR fsm_state) or
 * proceed to the `processing` -> `conversation` AppState transition.
 *
 * gemini.service.ts's analyzeImage is NOT called here — this only tests the
 * pure decision function against hand-built GeminiTutoringResponse fixtures,
 * per the brief's guidance to unit-test the retake branching with a mocked
 * analyzeImage (the mock lives at the call-site in CameraScreen; here we
 * just test the decision function it delegates to).
 */
import {
  evaluateCaptureResult,
  CONFIDENCE_RETAKE_THRESHOLD,
  OUT_OF_SCOPE_RETAKE_MESSAGE,
  OCR_FAILED_RETAKE_MESSAGE,
  GENERIC_RETAKE_MESSAGE,
  voteHandwriting,
  describeVotePattern,
  HANDWRITING_READ_COUNT,
  HANDWRITING_ASKBACK_QUESTION,
  HANDWRITING_ASKBACK_RETRY,
  HANDWRITING_ASKBACK_FALLBACK,
  HANDWRITING_ASKBACK_SILENCE_MS,
  classifyAskBackReply,
} from '../captureDecision';
import type { GeminiTutoringResponse } from '../../types/Tutoring';

function makeResponse(overrides: Partial<GeminiTutoringResponse> = {}): GeminiTutoringResponse {
  return {
    fsm_state: 'HINT_STAGE',
    explicit_answer_request: false,
    is_on_correct_path: null,
    requires_board: true,
    board_update_needed: true,
    message: 'first hint',
    board_prompt: 'draw something',
    confidence: 0.9,
    error_type: 'NONE',
    misconception_type: 'NONE',
    topic: '기타',
    title: 'test title',
    ...overrides,
  };
}

describe('evaluateCaptureResult', () => {
  it('proceeds when confidence is high and fsm_state is not ERROR', () => {
    const result = evaluateCaptureResult(makeResponse({ confidence: 0.9 }));

    expect(result.shouldRetake).toBe(false);
    expect(result.retakeMessage).toBeUndefined();
  });

  it('proceeds when confidence is exactly at the threshold (not below)', () => {
    const result = evaluateCaptureResult(makeResponse({ confidence: CONFIDENCE_RETAKE_THRESHOLD }));

    expect(result.shouldRetake).toBe(false);
  });

  it('requests a retake when confidence is below the threshold', () => {
    const result = evaluateCaptureResult(
      makeResponse({ confidence: CONFIDENCE_RETAKE_THRESHOLD - 0.01 }),
    );

    expect(result.shouldRetake).toBe(true);
    expect(result.retakeMessage).toBeTruthy();
  });

  it('requests a retake when confidence is very low (e.g. 0.2)', () => {
    const result = evaluateCaptureResult(makeResponse({ confidence: 0.2 }));

    expect(result.shouldRetake).toBe(true);
  });

  it('requests a retake when fsm_state is ERROR even with high confidence', () => {
    const result = evaluateCaptureResult(
      makeResponse({
        fsm_state: 'ERROR',
        error_type: 'LOW_IMAGE_QUALITY',
        confidence: 0.95,
      }),
    );

    expect(result.shouldRetake).toBe(true);
  });

  it('surfaces a Korean retake message tailored to LOW_IMAGE_QUALITY', () => {
    const result = evaluateCaptureResult(
      makeResponse({ fsm_state: 'ERROR', error_type: 'LOW_IMAGE_QUALITY' }),
    );

    expect(result.retakeMessage).toBe(GENERIC_RETAKE_MESSAGE);
  });

  it('surfaces a Korean retake message tailored to OCR_FAILED', () => {
    const result = evaluateCaptureResult(
      makeResponse({ fsm_state: 'ERROR', error_type: 'OCR_FAILED' }),
    );

    expect(result.retakeMessage).toBe(OCR_FAILED_RETAKE_MESSAGE);
  });

  it('requests a retake for OUT_OF_SCOPE with a scope-limitation message (not photo-quality)', () => {
    // Product decision: brief says ANY ERROR fsm_state triggers retake,
    // full stop. OUT_OF_SCOPE means the problem itself is outside VIVA's
    // supported curriculum, so the retake mechanism is reused but the
    // message must say "different problem", not "photo is blurry".
    // 문구 자체는 톤 조정으로 바뀐다 - 리터럴 대신 상수로 비교하되,
    // 사진 품질 문구가 아니라는 구분(원래 정규식의 목적)은 그대로 남긴다.
    const result = evaluateCaptureResult(
      makeResponse({
        fsm_state: 'ERROR',
        error_type: 'OUT_OF_SCOPE',
        confidence: 0.9,
      }),
    );

    expect(result.shouldRetake).toBe(true);
    expect(result.retakeMessage).toBe(OUT_OF_SCOPE_RETAKE_MESSAGE);
    expect(result.retakeMessage).not.toBe(GENERIC_RETAKE_MESSAGE);
    expect(result.retakeMessage).not.toBe(OCR_FAILED_RETAKE_MESSAGE);
  });

  it('requests a retake for UNSUPPORTED_PROBLEM with a scope-limitation message (not photo-quality)', () => {
    const result = evaluateCaptureResult(
      makeResponse({
        fsm_state: 'ERROR',
        error_type: 'UNSUPPORTED_PROBLEM',
        confidence: 0.9,
      }),
    );

    expect(result.shouldRetake).toBe(true);
    expect(result.retakeMessage).toBe(OUT_OF_SCOPE_RETAKE_MESSAGE);
    expect(result.retakeMessage).not.toBe(GENERIC_RETAKE_MESSAGE);
    expect(result.retakeMessage).not.toBe(OCR_FAILED_RETAKE_MESSAGE);
  });

  it('requests a retake when fsm_state is ERROR with error_type NONE (defensive default)', () => {
    // Defensive: ERROR + NONE shouldn't normally happen, but if it does we
    // should still not silently proceed into a tutoring conversation.
    const result = evaluateCaptureResult(makeResponse({ fsm_state: 'ERROR', error_type: 'NONE' }));

    expect(result.shouldRetake).toBe(true);
  });
});

describe('voteHandwriting', () => {
  it('상수는 3', () => {
    expect(HANDWRITING_READ_COUNT).toBe(3);
  });

  it('3표 일치 → 안 물음', () => {
    expect(voteHandwriting([['22'], ['22'], ['22']]).askBack).toBe(false);
  });

  it('전부 빈 판독 → 안 물음', () => {
    expect(voteHandwriting([[], [], []]).askBack).toBe(false);
  });

  it('답 낸 판독이 1개뿐 → 안 물음 (지어내기 되묻기 방지)', () => {
    expect(voteHandwriting([['22'], [], []]).askBack).toBe(false);
  });

  it('2:1 → 되묻되 값을 읽어주지 않는다', () => {
    const d = voteHandwriting([['66'], ['96'], ['66']]);
    expect(d.askBack).toBe(true);
    if (d.askBack) {
      expect(d.question).toBe(HANDWRITING_ASKBACK_QUESTION);
      expect(d.question).not.toContain('66');
      expect(d.question).not.toContain('96');
    }
  });

  it('1:1:1 → 되묻되 값을 읽어주지 않는다', () => {
    const d = voteHandwriting([['96'], ['66'], ['46']]);
    expect(d.askBack).toBe(true);
    if (d.askBack) {
      expect(d.question).toBe(HANDWRITING_ASKBACK_QUESTION);
      expect(d.question).not.toContain('46');
    }
  });

  it('되묻기 문형에 숫자가 섞이지 않는다 (선택형 회귀 방지)', () => {
    const d = voteHandwriting([['24'], ['240'], ['24']]);
    expect(d.askBack).toBe(true);
    if (d.askBack) expect(d.question).not.toMatch(/\d/);
  });

  it('단위만 다르면 같은 값 → 안 물음', () => {
    expect(voteHandwriting([['5cm'], ['5'], ['5 cm']]).askBack).toBe(false);
  });

  it('중간식과 그 값은 같은 값 → 안 물음', () => {
    expect(voteHandwriting([['88-66=22'], ['22'], ['22']]).askBack).toBe(false);
  });

  it('π 유무는 다른 값 → 되묻기', () => {
    expect(voteHandwriting([['27'], ['27π'], ['27']]).askBack).toBe(true);
  });

  it('자릿수가 다르면 다른 값 → 되묻기', () => {
    expect(voteHandwriting([['24'], ['240'], ['24']]).askBack).toBe(true);
  });

  it('각 판독의 첫 후보만 그 판독의 답으로 본다', () => {
    // 두 번째 판독이 96 을 먼저 냈으므로 66 과 갈린다.
    const d = voteHandwriting([['66', '96'], ['96', '66'], ['66']]);
    expect(d.askBack).toBe(true);
  });

  it('세 판독이 같은 후보쌍을 냈어도 되묻는다 (27/21 회귀)', () => {
    // 첫 후보는 셋 다 "27" 이라 판독 사이는 만장일치지만, 판독마다 후보가
    // 2개 = 모델이 "안 또렷하다" 고 말한 것이다. 예전엔 여기서 안 물었다.
    const d = voteHandwriting([
      ['27', '21'],
      ['27', '21'],
      ['27', '21'],
    ]);
    expect(d.askBack).toBe(true);
    if (d.askBack) expect(d.question).not.toMatch(/\d/);
  });

  it('판독 하나만 후보 2개여도 되묻는다', () => {
    expect(voteHandwriting([['27', '21'], ['27'], ['27']]).askBack).toBe(true);
  });

  it('후보 2개가 정규화하면 같은 값이면 안 묻는다', () => {
    // 표기 차이는 이견이 아니다 - 판독 사이 규칙과 같은 기준을 쓴다.
    expect(voteHandwriting([['5cm', '5'], ['5'], ['5']]).askBack).toBe(false);
  });

  it('답 낸 판독이 1개뿐이면 그 판독이 망설여도 안 묻는다', () => {
    // 2/3 이 "손글씨 없다" 인데 나머지 하나의 망설임을 붙잡으면
    // 지어내기를 되묻는 꼴이다 - 기존 가드가 먼저 걸려야 한다.
    expect(voteHandwriting([['27', '21'], [], []]).askBack).toBe(false);
  });
});

describe('classifyAskBackReply', () => {
  it('숫자를 말하면 answer', () => {
    expect(classifyAskBackReply('96이야')).toBe('answer');
    expect(classifyAskBackReply('22')).toBe('answer');
  });

  it('한글 수사도 answer', () => {
    expect(classifyAskBackReply('이십이')).toBe('answer');
  });

  it('수학 기호만 있어도 answer', () => {
    expect(classifyAskBackReply('x = 3')).toBe('answer');
  });

  it('질문을 못 알아들으면 confused', () => {
    expect(classifyAskBackReply('무슨 말이야?')).toBe('confused');
    expect(classifyAskBackReply('어? 다시 말해줘')).toBe('confused');
  });

  it('자기 글씨를 못 읽으면 cant_read', () => {
    expect(classifyAskBackReply('나도 모르겠어')).toBe('cant_read');
    expect(classifyAskBackReply('안 보여')).toBe('cant_read');
  });

  // 판정 순서가 규칙이다: cant_read 를 먼저 안 보면 '뭐라고' 에 걸려
  // confused 로 오판하고, 못 읽는 학생에게 같은 질문을 다시 던진다.
  it('cant_read 신호가 confused 신호보다 우선한다', () => {
    expect(classifyAskBackReply('뭐라고 썼는지 모르겠어')).toBe('cant_read');
  });

  // 오분류 방향은 비대칭이다 - 비답을 answer 로 보면 채점이 오염되고,
  // 답을 confused 로 보면 헛 재질문 1회로 끝난다. 양성 토큰이 없으면
  // answer 로 치지 않는다.
  it('숫자·수학기호가 없는 서술형은 answer 로 치지 않는다', () => {
    expect(classifyAskBackReply('이등변삼각형')).toBe('confused');
  });

  it('빈 문자열은 confused', () => {
    expect(classifyAskBackReply('')).toBe('confused');
    expect(classifyAskBackReply('   ')).toBe('confused');
  });

  it('일상 어휘가 한글 수사에 부분 매칭돼 answer 로 새지 않는다', () => {
    expect(classifyAskBackReply('열심히 했어')).toBe('confused');
    expect(classifyAskBackReply('인터넷에서 봤어')).toBe('confused');
    expect(classifyAskBackReply('둘러봤어')).toBe('confused');
  });

  it('해가 없다는 답은 cant_read 가 아니다', () => {
    expect(classifyAskBackReply('해가 없어')).not.toBe('cant_read');
  });
});

describe('되묻기 발화 문구', () => {
  it('세 문구 모두 판독 후보값을 읽어주지 않는다', () => {
    expect(HANDWRITING_ASKBACK_QUESTION).not.toMatch(/\d/);
    expect(HANDWRITING_ASKBACK_RETRY).not.toMatch(/\d/);
    expect(HANDWRITING_ASKBACK_FALLBACK).not.toMatch(/\d/);
  });

  it('무응답 타임아웃은 8초', () => {
    expect(HANDWRITING_ASKBACK_SILENCE_MS).toBe(8000);
  });
});

// 로그 전용 라벨(useTutoringFSM 의 `[FSM] handwriting vote:` 로그가 소비).
// voteHandwriting 의 되묻기 판정과는 독립된 함수라 여기서 따로 검증한다.
describe('describeVotePattern', () => {
  it('셋 다 같으면 unanimous', () => {
    expect(describeVotePattern([['22'], ['22'], ['22']])).toBe('unanimous');
  });

  it('둘이 같고 하나가 다르면 2:1', () => {
    expect(describeVotePattern([['66'], ['96'], ['66']])).toBe('2:1');
  });

  it('셋 다 다르면 1:1:1', () => {
    expect(describeVotePattern([['96'], ['66'], ['46']])).toBe('1:1:1');
  });

  it('답을 낸 판독이 2개 미만이면 insufficient', () => {
    expect(describeVotePattern([['22'], [], []])).toBe('insufficient');
  });

  it('정규화 기준은 되묻기 판정과 같다', () => {
    expect(describeVotePattern([['5cm'], ['5'], ['5 cm']])).toBe('unanimous');
    expect(voteHandwriting([['5cm'], ['5'], ['5 cm']]).askBack).toBe(false);
  });

  // 판독 1개가 실패해 2개만 성공한 경우 unanimous/2:1/1:1:1 을 쓰면 3표
  // 기준 통계(다음 라운드 분석)에 표본이 섞인다 - 별도 라벨(partial)로 뺀다.
  it('판독이 2개만 성공하고 값이 갈리면 partial (1:1:1 아님)', () => {
    expect(describeVotePattern([['66'], ['96'], []])).toBe('partial');
  });

  it('판독이 2개만 성공하고 값이 같으면 partial (unanimous 아님)', () => {
    expect(describeVotePattern([['22'], ['22'], []])).toBe('partial');
  });
});

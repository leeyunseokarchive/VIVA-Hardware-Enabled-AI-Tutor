/**
 * 판서 프롬프트의 단계 분기 (실기기 피드백 2026-07-29).
 *
 * board.service 의 ANSWER POLICY 는 최종 답을 무조건 금지했는데,
 * system_prompt.ts 의 BOARD_PROMPT_POLICY 는 SOLVE_STAGE 에서 "풀이 단계를
 * 판서로 시각화해도 된다" 고 지시한다. 한 요청 안에 반대되는 지시가 같이
 * 들어가면 모델이 어느 쪽도 제대로 안 따른다 - 단계를 보고 한쪽으로 정리한
 * 분기가 실제로 프롬프트에 반영되는지만 확인한다. 네트워크는 타지 않는다.
 */
import {
  generateBoardImage,
  generateVerifiedBoardImage,
  TRANSCRIPTION_INSTRUCTION,
} from '../board.service';
import type { TutoringSession } from '../../types/Tutoring';

const mockGenerateContent = jest.fn();

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent: mockGenerateContent }),
  })),
  // 검증 스키마(VERIFY_SCHEMA)가 모듈 로드 시점에 참조한다.
  SchemaType: { OBJECT: 'OBJECT', BOOLEAN: 'BOOLEAN', ARRAY: 'ARRAY', STRING: 'STRING' },
}));

const ANSWER_BAN = 'Do NOT display the final numeric answer';

function session(overrides: Partial<TutoringSession> = {}): TutoringSession {
  return {
    sessionId: 's1',
    problemImageBase64: '',
    fsmState: 'HINT_STAGE',
    hintCount: 0,
    wrongStreak: 0,
    boardRegenerationCount: 0,
    ...overrides,
  };
}

/** 모델에 실제로 전달된 모든 text 파트를 이어붙인다. */
function sentPrompt(): string {
  const parts = mockGenerateContent.mock.calls[0][0] as { text?: string }[];
  return parts.map((p) => p.text ?? '').join('\n');
}

beforeEach(() => {
  mockGenerateContent.mockReset();
  mockGenerateContent.mockResolvedValue({
    response: {
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'png-b64' } }] } },
      ],
    },
  });
});

describe('board prompt ANSWER POLICY', () => {
  it('bans the final answer during the hint loop', async () => {
    await generateBoardImage('photo-b64', 'point at the unknown', session());
    expect(sentPrompt()).toContain(ANSWER_BAN);
  });

  it('asks for the final answer at SOLVE_STAGE', async () => {
    await generateBoardImage(
      'photo-b64',
      'show the worked steps',
      session({ fsmState: 'SOLVE_STAGE' }),
    );
    const prompt = sentPrompt();
    expect(prompt).not.toContain(ANSWER_BAN);
    expect(prompt).toContain('DO show the final numeric answer');
  });

  // 전사 턴은 annotation 요소 광고(점선 원 등)가 프롬프트에서 빠져야 한다 -
  // SPECIFIC HINT INSTRUCTION 의 "no circles" 와 충돌해 전사 판서에
  // 동그라미가 그려지던 실기기 증상 (2026-07-30).
  it('advertises zero annotation elements on transcription turns', async () => {
    await generateBoardImage('photo-b64', TRANSCRIPTION_INSTRUCTION, session());
    const prompt = sentPrompt();
    expect(prompt).toContain('ANNOTATION ELEMENTS: NONE');
    expect(prompt).not.toContain('Dashed circles');
  });

  it('still advertises annotation elements on hint turns', async () => {
    await generateBoardImage('photo-b64', 'point at the unknown', session());
    expect(sentPrompt()).toContain('Dashed circles');
  });

  // 판서 상한은 과금 직결이라(모델 교체로 장당 단가가 3배 됐다) 남겨둔다.
  it('refuses past the per-session generation cap', async () => {
    await expect(
      generateBoardImage('photo-b64', 'anything', session({ boardRegenerationCount: 15 })),
    ).rejects.toThrow('API_LIMIT_EXCEEDED');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  // 개념 분기(사진 없음)는 문제 풀이용 board 프롬프트를 그대로 쓰면 물음표·
  // 질문 문구가 개념 도해에 섞여 나온다 (회의 피드백 2026-08-13, WS1).
  it('개념 분기(사진 없음) 프롬프트에 물음표 금지 규칙이 들어간다', async () => {
    await generateBoardImage('', '삼각비 개념을 설명하는 그림', session());
    const prompt = sentPrompt();
    expect(prompt).toContain('물음표');
  });
});

// 그라운딩 + 사후검증 (스펙 2026-07-29). 호출 순서:
// 1) 이미지 생성 -> 2) 검증(텍스트) -> 불합격이면 3) 재생성 -> 4) 재검증.
describe('generateVerifiedBoardImage', () => {
  const imageResponse = (data: string) => ({
    response: {
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data } }] } }],
    },
  });
  const verifyResponse = (pass: boolean, issues: string[] = []) => ({
    response: { text: () => JSON.stringify({ pass, issues }) },
  });

  it('injects problem_facts as ground truth and passes verification first try', async () => {
    mockGenerateContent
      .mockResolvedValueOnce(imageResponse('board-1'))
      .mockResolvedValueOnce(verifyResponse(true));

    const result = await generateVerifiedBoardImage(
      'photo-b64',
      'point at AB',
      session({ problemFacts: '직각삼각형 ABC, AB=6cm' }),
    );

    expect(result.imageBase64).toBe('board-1');
    expect(result.debug.verify?.pass).toBe(true);
    expect(result.debug.regenerated).toBe(false);
    // 생성 프롬프트에 ground truth 블록이 실려야 한다.
    expect(result.debug.fullPrompt).toContain('PROBLEM GROUND TRUTH');
    expect(result.debug.fullPrompt).toContain('AB=6cm');
  });

  // 실기기 피드백 2026-08-07: 생성 프롬프트는 "학생의 손글씨 풀이를 그대로
  // 다시 그려라" 인데, 검증 프롬프트의 ground truth 에는 문제만 들어간다.
  // 그래서 지시대로 손풀이를 옮겨 그리면 "문제에 없는 수식"으로 무조건
  // 불합격했다 - 손풀이가 있는 사진마다 재생성 1회가 강제로 발생하는 오탐.
  it('tells the verifier that the student handwriting is expected content', async () => {
    mockGenerateContent
      .mockResolvedValueOnce(imageResponse('board-1'))
      .mockResolvedValueOnce(verifyResponse(true));

    await generateVerifiedBoardImage(
      'photo-b64',
      TRANSCRIPTION_INSTRUCTION,
      session({ problemFacts: 'AB=6cm' }),
    );

    const verifyParts = mockGenerateContent.mock.calls[1][0] as { text?: string }[];
    const verifyPrompt = verifyParts.map((p) => p.text ?? '').join('\n');
    // 사진이 있으면 사진이 권위다 - 학생 손글씨 삭제가 곧 불합격 사유가 된다.
    expect(verifyPrompt).toContain("removing or altering the student's own work is a fail");
    // 규칙 5 가 문제 문장에서 도형을 추론하면 없는 원을 그리라고 지시하게 된다.
    expect(verifyPrompt).toContain('the photo is the authority');
    expect(verifyPrompt).not.toContain('FIRST infer from the ground truth what shapes');
  });

  // 실기기 A/B 2026-08-07 (사용자 판정: "학생의 풀이는 없어지면 안 된다"):
  // 교정 재생성이 검증 지적사항을 따라 학생 손글씨를 지웠다. 재작화는 학생이
  // 쓰지 않은 단계를 지어내고 부호 실수까지 조용히 고쳤다. 두 방어선 -
  // 전사 규칙의 불가침 조항 + 교정 지시를 거부할 근거 - 이 프롬프트에 있어야 한다.
  it('makes the student handwriting untouchable in both the base and correction prompts', async () => {
    await generateBoardImage('photo-b64', TRANSCRIPTION_INSTRUCTION, session());
    expect(sentPrompt()).toContain("The student's own handwritten work is SACRED");

    mockGenerateContent.mockReset();
    mockGenerateContent.mockResolvedValue({
      response: {
        candidates: [
          { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'png-b64' } }] } },
        ],
      },
    });
    await generateBoardImage(
      'photo-b64',
      TRANSCRIPTION_INSTRUCTION,
      session(),
      undefined,
      undefined,
      {
        correctionNotes: ['문제에 없는 손글씨 수식이 포함됨'],
      },
    );
    expect(sentPrompt()).toContain('HARD LIMIT');
  });

  // 실기기 A/B 2026-08-07: 검증기가 problem_facts 만 보고 판정했는데, facts 에는
  // 인쇄된 문제만 들어있다. 학생 손글씨가 원본에 있었는지, 도형에 원이 있었는지
  // 판단할 근거가 아예 없어서 오탐이 6건 중 5~6건이었다. 사진을 붙이자 3/3 정확.
  it('gives the verifier the original photo as the authority', async () => {
    mockGenerateContent
      .mockResolvedValueOnce(imageResponse('board-1'))
      .mockResolvedValueOnce(verifyResponse(true));

    await generateVerifiedBoardImage(
      'photo-b64',
      TRANSCRIPTION_INSTRUCTION,
      session({ problemFacts: 'AB=6cm' }),
    );

    const parts = mockGenerateContent.mock.calls[1][0] as {
      text?: string;
      inlineData?: { data: string };
    }[];
    // 사진이 먼저, 판서가 나중 - 프롬프트가 그 순서로 설명한다.
    expect(parts.filter((p) => p.inlineData).map((p) => p.inlineData!.data)).toEqual([
      'photo-b64',
      'board-1',
    ]);
    expect(parts.map((p) => p.text ?? '').join('\n')).toContain('ORIGINAL PHOTO');
  });

  // 재작화 교정은 사진에서 캔버스를 통째로 다시 그리는 독립 샘플이라 매번
  // 내용을 발명했다 (없는 원, 학생이 안 쓴 풀이 단계, 라벨 뒤바뀜). 1차본을
  // base 로 "지적된 것만 고치는" 편집으로 바꾼다.
  it('corrects by editing the first board instead of redrawing from the photo', async () => {
    mockGenerateContent
      .mockResolvedValueOnce(imageResponse('board-bad'))
      .mockResolvedValueOnce(verifyResponse(false, ['원본에 없는 원호 추가']))
      .mockResolvedValueOnce(imageResponse('board-fixed'))
      .mockResolvedValueOnce(verifyResponse(true));

    await generateVerifiedBoardImage(
      'photo-b64',
      TRANSCRIPTION_INSTRUCTION,
      session({ problemFacts: 'AB=6cm' }),
    );

    const parts = mockGenerateContent.mock.calls[2][0] as {
      text?: string;
      inlineData?: { data: string };
    }[];
    // 원본 사진이 아니라 1차본 하나만 base 로 들어간다.
    expect(parts.filter((p) => p.inlineData).map((p) => p.inlineData!.data)).toEqual(['board-bad']);
    const prompt = parts.map((p) => p.text ?? '').join('\n');
    expect(prompt).toContain('A verification pass found errors');
    expect(prompt).toContain('원본에 없는 원호 추가');
  });

  it('regenerates once with correction notes when verification fails', async () => {
    mockGenerateContent
      .mockResolvedValueOnce(imageResponse('board-bad'))
      .mockResolvedValueOnce(verifyResponse(false, ['변 AB를 c로 표기함']))
      .mockResolvedValueOnce(imageResponse('board-fixed'))
      .mockResolvedValueOnce(verifyResponse(true));

    const onDraft = jest.fn();
    const result = await generateVerifiedBoardImage(
      'photo-b64',
      'point at AB',
      session({ problemFacts: 'AB=6cm' }),
      { onDraft },
    );

    // 1차본은 검증 결과와 무관하게 즉시 표시용으로 흘러나와야 한다.
    expect(onDraft).toHaveBeenCalledWith('board-bad');
    expect(result.imageBase64).toBe('board-fixed');
    expect(result.debug.regenerated).toBe(true);
    expect(result.debug.verify?.pass).toBe(true);
    // 재생성 프롬프트에 검증 이슈가 수정 지시로 들어가야 한다.
    const regenParts = mockGenerateContent.mock.calls[2][0] as { text?: string }[];
    const regenPrompt = regenParts.map((p) => p.text ?? '').join('\n');
    expect(regenPrompt).toContain('CORRECTION NOTES');
    expect(regenPrompt).toContain('변 AB를 c로 표기함');
  });

  // 실기기 피드백 2026-08-07: 검증에 또 떨어진 재생성본이 화면의 1차본을
  // 덮어썼다 (1차본은 점 P 라벨 1개, 재생성본은 2개 + 도형 붕괴). 재생성은
  // 사진에서 처음부터 다시 그리는 독립 샘플이라 품질이 단조 증가하지 않는다 -
  // 합격한 재생성본만 채택하고, 아니면 1차본을 유지한다.
  it('keeps the first board when the regeneration also fails verification', async () => {
    mockGenerateContent
      .mockResolvedValueOnce(imageResponse('board-0'))
      .mockResolvedValueOnce(verifyResponse(false, ['선지 누락']))
      .mockResolvedValueOnce(imageResponse('board-1'))
      .mockResolvedValueOnce(verifyResponse(false, ['점 P 라벨 중복']));

    const onDraft = jest.fn();
    const result = await generateVerifiedBoardImage(
      'photo-b64',
      'point at AB',
      session({ problemFacts: 'AB=6cm' }),
      { onDraft },
    );

    // 재생성 1회(상한)까지만 시도하고 멈춘다.
    expect(mockGenerateContent).toHaveBeenCalledTimes(4);
    // 화면에 이미 걸린 1차본을 유지 - regenerated=false 라야 화면이 교체하지 않는다.
    expect(result.imageBase64).toBe('board-0');
    expect(result.debug.regenerated).toBe(false);
    // verify 는 언제나 "반환된 이미지"의 판정이다.
    expect(result.debug.verify?.issues).toEqual(['선지 누락']);
    // 버려진 재생성본의 판정도 남는다 - 안 남기면 이미지 호출 1회가 기록에서 증발한다.
    expect(result.debug.regenVerify?.issues).toEqual(['점 P 라벨 중복']);
  });

  it('skips verification entirely when there are no problem facts', async () => {
    mockGenerateContent.mockResolvedValueOnce(imageResponse('board-1'));

    const result = await generateVerifiedBoardImage('', 'draw the formula', session());

    expect(result.imageBase64).toBe('board-1');
    expect(result.debug.verify).toBeUndefined();
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  });

  it('still returns the board when verification itself errors', async () => {
    mockGenerateContent
      .mockResolvedValueOnce(imageResponse('board-1'))
      .mockRejectedValueOnce(new Error('verify network down'));

    const result = await generateVerifiedBoardImage(
      'photo-b64',
      'point at AB',
      session({ problemFacts: 'AB=6cm' }),
    );

    expect(result.imageBase64).toBe('board-1');
    expect(result.debug.verify).toBeUndefined();
  });
});

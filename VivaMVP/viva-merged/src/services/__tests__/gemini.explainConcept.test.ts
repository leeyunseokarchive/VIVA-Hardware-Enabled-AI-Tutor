/**
 * explainConcept (의도파악 루프의 개념 설명 호출). 통합 튜터링과 달리
 * 묻는 것에 바로 답한다 — 선택지 평가, 재입력 없음. 수학 표기는 LaTeX 계약.
 */
import { explainConcept } from '../gemini.service';

const mockGenerateContent = jest.fn();

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent: mockGenerateContent }),
  })),
  SchemaType: { OBJECT: 'OBJECT', ARRAY: 'ARRAY', STRING: 'STRING' },
}));

beforeEach(() => {
  mockGenerateContent.mockReset();
});

describe('explainConcept', () => {
  it('message 와 board_prompt 를 파싱한다', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () =>
          JSON.stringify({
            message: '삼각함수는 각도와 변 길이의 비를 잇는 함수야.',
            board_prompt: '단위원 위의 sin/cos 정의 그림',
          }),
        usageMetadata: {},
      },
    });
    const res = await explainConcept('삼각함수가 뭐야?', []);
    expect(res.message).toContain('삼각함수');
    expect(res.board_prompt).toBe('단위원 위의 sin/cos 정의 그림');
  });

  it('history 와 이전 판서를 요청 파츠에 싣는다', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify({ message: '이어서 설명하면...', board_prompt: '' }),
        usageMetadata: {},
      },
    });
    await explainConcept(
      '그럼 cos 은?',
      [
        { role: 'user', message: '삼각함수가 뭐야?' },
        { role: 'model', message: '...' },
      ],
      'prevBoardBase64',
    );
    const parts = mockGenerateContent.mock.calls[0][0];
    const textPart = parts.find((p: any) => p.text)?.text ?? '';
    expect(textPart).toContain('삼각함수가 뭐야?');
    expect(parts.some((p: any) => p.inlineData?.data === 'prevBoardBase64')).toBe(true);
  });

  it('knownConcepts 가 있으면 concept_id 를 파싱하고 프롬프트에 목록을 싣는다', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () =>
          JSON.stringify({
            message: '삼각비는...',
            board_prompt: '',
            concept_id: 'trigonometric-ratio',
          }),
        usageMetadata: {},
      },
    });
    const known = [{ id: 'trigonometric-ratio', name: '삼각비', aliases: ['sin', 'cos'] }];
    const res = await explainConcept('sin이 뭐야', [], undefined, known);
    expect(res.concept_id).toBe('trigonometric-ratio');
    const textPart = mockGenerateContent.mock.calls[0][0].find((p: any) => p.text)?.text ?? '';
    expect(textPart).toContain('trigonometric-ratio');
    expect(textPart).toContain('삼각비');
  });

  it('환각 concept_id 는 빈 문자열로 정규화한다', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () =>
          JSON.stringify({ message: '...', board_prompt: '그림', concept_id: 'made-up-id' }),
        usageMetadata: {},
      },
    });
    const res = await explainConcept('질문', [], undefined, [
      { id: 'square-root', name: '제곱근', aliases: [] },
    ]);
    expect(res.concept_id).toBe('');
  });

  it('첫 턴(history 비어있음)에도 새 개념 시각 자료 규칙을 프롬프트에 싣는다', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify({ message: 'm', board_prompt: 'b', concept_id: '' }),
        usageMetadata: {},
      },
    });
    await explainConcept('삼각함수가 뭐야?', []);
    const textPart = mockGenerateContent.mock.calls[0][0].find((p: any) => p.text)?.text ?? '';
    expect(textPart).toContain('처음 설명할 때는 반드시 시각 자료');
    expect(textPart).toContain('빈 문자열 금지');
  });

  it('후속 턴(history 있음)에도 새 개념 시각 자료 규칙을 싣는다 — 연속으로 다른 개념을 물어도 이미지 보장', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify({ message: 'm', board_prompt: '', concept_id: '' }),
        usageMetadata: {},
      },
    });
    await explainConcept('그럼 이차방정식은 뭐야?', [
      { role: 'user', message: '삼각함수가 뭐야?' },
      { role: 'model', message: '...' },
    ]);
    const textPart = mockGenerateContent.mock.calls[0][0].find((p: any) => p.text)?.text ?? '';
    expect(textPart).toContain('처음 설명할 때는 반드시 시각 자료');
  });

  it('knownConcepts 없으면 concept_id 는 빈 문자열이고 기존 동작 유지', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify({ message: 'm', board_prompt: 'b' }),
        usageMetadata: {},
      },
    });
    const res = await explainConcept('질문', []);
    expect(res.concept_id).toBe('');
  });

  it('knownConcepts 의 sketch 를 프롬프트에 싣고 도해 정합 규칙을 포함한다', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () =>
          JSON.stringify({ message: 'm', board_prompt: '', concept_id: 'linear-equation' }),
        usageMetadata: {},
      },
    });
    await explainConcept('일차방정식이 뭐야', [], undefined, [
      {
        id: 'linear-equation',
        name: '일차방정식',
        aliases: ['등식의 성질'],
        sketch: '양팔저울 2개를 위아래로',
      },
    ]);
    const textPart = mockGenerateContent.mock.calls[0][0].find((p: any) => p.text)?.text ?? '';
    expect(textPart).toContain('도해: 양팔저울 2개를 위아래로');
    expect(textPart).toContain('도해에 맞춰');
  });
});

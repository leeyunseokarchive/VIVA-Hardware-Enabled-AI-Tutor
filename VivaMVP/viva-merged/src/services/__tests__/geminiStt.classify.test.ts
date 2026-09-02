/**
 * transcribeAndClassify 단위 테스트. GoogleGenerativeAI 모듈 mock —
 * gemini.recognize.test.ts 와 같은 패턴.
 */
import { transcribeAndClassify } from '../geminiStt.service';

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

describe('transcribeAndClassify', () => {
  it('전사와 intent 를 파싱한다', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify({ transcript: '이거 어떻게 풀어?', intent: 'solve' }),
      },
    });
    const res = await transcribeAndClassify('wav64');
    expect(res).toEqual({ transcript: '이거 어떻게 풀어?', intent: 'solve' });
  });

  it('intent 가 스키마 밖 값이면 unclear 로 강등', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => JSON.stringify({ transcript: '어', intent: 'banana' }) },
    });
    const res = await transcribeAndClassify('wav64');
    expect(res.intent).toBe('unclear');
  });

  it('빈 전사는 unclear', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => JSON.stringify({ transcript: '', intent: 'solve' }) },
    });
    const res = await transcribeAndClassify('wav64');
    expect(res).toEqual({ transcript: '', intent: 'unclear' });
  });
});

/**
 * detectProblems 단위 테스트 — gemini.recognize.test.ts 와 같은 모듈 mock 패턴.
 */
import { detectProblems } from '../gemini.service';

const mockGenerateContent = jest.fn();

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent: mockGenerateContent }),
  })),
  SchemaType: { OBJECT: 'OBJECT', ARRAY: 'ARRAY', STRING: 'STRING', INTEGER: 'INTEGER' },
}));

beforeEach(() => {
  mockGenerateContent.mockReset();
});

describe('detectProblems', () => {
  it('problems 배열을 파싱해 돌려준다', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () =>
          JSON.stringify({
            problems: [
              { label: '59번', box_2d: [100, 50, 400, 950] },
              { label: '60번', box_2d: [420, 50, 800, 950] },
            ],
          }),
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50 },
      },
    });
    const res = await detectProblems('base64jpeg');
    expect(res.problems).toHaveLength(2);
    expect(res.problems[0].label).toBe('59번');
    expect(res.problems[1].box_2d).toEqual([420, 50, 800, 950]);
  });

  it('problems 가 배열이 아니면 빈 배열', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => JSON.stringify({}), usageMetadata: {} },
    });
    const res = await detectProblems('base64jpeg');
    expect(res.problems).toEqual([]);
  });
});

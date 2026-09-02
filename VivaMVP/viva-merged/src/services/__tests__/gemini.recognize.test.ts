/**
 * recognizeHandwriting (스펙 v2: 인식 전용 호출). 통합 분석 호출과 분리된
 * 얇은 프롬프트/스키마로 후보만 판독한다 - 여기서는 응답 파싱만 검증한다
 * (실제 인식 품질은 실기기/수동 확인 소관). 네트워크는 타지 않는다.
 */
import { recognizeHandwriting } from '../gemini.service';

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

describe('recognizeHandwriting', () => {
  it('parses a normal candidates response', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify({ candidates: ['22'] }),
        usageMetadata: { promptTokenCount: 1109, candidatesTokenCount: 5, totalTokenCount: 1114 },
      },
    });

    const result = await recognizeHandwriting('photo-b64');

    expect(result.candidates).toEqual(['22']);
    expect(result.usage).toEqual({
      promptTokens: 1109,
      candidateTokens: 5,
      totalTokens: 1114,
    });
  });

  // IMPORTANT 3: 실제로 보낸 요청 부분을 핀 - 넘긴 base64 가 이미지 파트에
  // 그대로 실리고, 텍스트 파트가 판독 전용 프롬프트인지. 이게 없으면 FSM
  // 이 엉뚱한 이미지(예: 이전 세션 값)를 넘기거나 통합 분석 프롬프트가 잘못
  // 섞여 들어가도 파싱만 성공하면 테스트가 계속 초록불이다.
  it('sends the passed base64 as the image part and the recognition prompt as the text part', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify({ candidates: ['22'] }),
        usageMetadata: { promptTokenCount: 1109, candidatesTokenCount: 5, totalTokenCount: 1114 },
      },
    });

    await recognizeHandwriting('photo-b64');

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    const [parts] = mockGenerateContent.mock.calls[0];
    expect(parts).toEqual([
      { inlineData: { mimeType: 'image/jpeg', data: 'photo-b64' } },
      // 판독 대상은 "채점에 쓰이는 줄 하나" — 최종 답, 없으면 마지막 줄
      // (2026-08-07 확대. 최종 답만 읽던 시절엔 중간식의 오독을 못 잡았다).
      { text: expect.stringContaining('the line their grade depends on') },
    ]);
  });

  it('defaults to an empty array when candidates is missing', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify({}),
        usageMetadata: undefined,
      },
    });

    const result = await recognizeHandwriting('photo-b64');

    expect(result.candidates).toEqual([]);
  });
});

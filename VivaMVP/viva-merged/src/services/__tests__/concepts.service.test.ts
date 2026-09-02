/**
 * fetchConcepts — concepts 테이블 목록 + 공개 이미지 URL 조립.
 * 실패 시 빈 목록: knownConcepts 가 비면 LLM 이 board_prompt 로 생성하는
 * 기존 계약이 폴백이라 여기서 던지면 안 된다 (스펙 §에러).
 */
import { fetchConcepts, clearConceptsCache } from '../concepts.service';
import { supabase } from '../../lib/supabase';

jest.mock('../../lib/supabase', () => ({
  supabase: { from: jest.fn(), storage: { from: jest.fn() } },
}));

const mockedFrom = supabase.from as jest.Mock;
const mockedStorageFrom = supabase.storage.from as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  clearConceptsCache();
  mockedStorageFrom.mockReturnValue({
    getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/${p}` } }),
  });
});

describe('fetchConcepts', () => {
  it('행을 ConceptInfo 로 매핑하고 image_path 를 공개 URL 로 조립한다', async () => {
    mockedFrom.mockReturnValue({
      select: jest.fn().mockResolvedValue({
        data: [
          { id: 'square-root', name: '제곱근', aliases: ['루트'], sketch: '정사각형', image_path: 'square-root.png' },
          { id: 'no-image', name: '이미지없음', aliases: [], sketch: 's', image_path: null },
        ],
        error: null,
      }),
    });
    const res = await fetchConcepts();
    expect(res).toEqual([
      {
        id: 'square-root',
        name: '제곱근',
        aliases: ['루트'],
        sketch: '정사각형',
        imageUrl: 'https://cdn.test/square-root.png',
      },
      { id: 'no-image', name: '이미지없음', aliases: [], sketch: 's', imageUrl: undefined },
    ]);
  });

  it('성공 결과는 모듈 캐시 - 두 번째 호출에 재조회하지 않는다', async () => {
    mockedFrom.mockReturnValue({
      select: jest.fn().mockResolvedValue({ data: [], error: null }),
    });
    await fetchConcepts();
    await fetchConcepts();
    expect(mockedFrom).toHaveBeenCalledTimes(1);
  });

  it('실패 시 빈 목록을 돌려주고 캐시하지 않는다(다음 호출 재시도)', async () => {
    mockedFrom.mockReturnValueOnce({
      select: jest.fn().mockResolvedValue({ data: null, error: { message: 'down' } }),
    });
    expect(await fetchConcepts()).toEqual([]);
    mockedFrom.mockReturnValueOnce({
      select: jest.fn().mockResolvedValue({
        data: [{ id: 'a', name: 'n', aliases: [], sketch: 's', image_path: null }],
        error: null,
      }),
    });
    expect(await fetchConcepts()).toHaveLength(1);
  });
});

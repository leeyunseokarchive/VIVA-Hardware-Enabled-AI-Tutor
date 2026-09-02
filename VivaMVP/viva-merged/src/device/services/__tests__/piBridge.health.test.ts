import { fetchPiHealth } from '../piBridge.service';

const mockFetch = jest.fn();

function okResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

describe('fetchPiHealth', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    (global as any).fetch = mockFetch;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    (console.warn as jest.Mock).mockRestore();
  });

  it('snake_case 를 camelCase 로 옮긴다', async () => {
    mockFetch.mockResolvedValue(okResponse({ status: 'ok', mic_ok: true, speaker_ok: false }));
    await expect(fetchPiHealth()).resolves.toEqual({ micOk: true, speakerOk: false });
  });

  it('cam_ok/display_ok 도 같은 방식으로 camelCase 로 옮긴다 (파이 서버 후속 프로브 대비)', async () => {
    mockFetch.mockResolvedValue(okResponse({ cam_ok: false, display_ok: true }));
    await expect(fetchPiHealth()).resolves.toEqual({ camOk: false, displayOk: true });
  });

  it('필드가 없는 구버전 Pi 는 undefined 로 남긴다 - "모름"이지 "정상"이 아니다', async () => {
    mockFetch.mockResolvedValue(okResponse({ status: 'ok' }));
    await expect(fetchPiHealth()).resolves.toEqual({ micOk: undefined, speakerOk: undefined });
  });

  it('불리언이 아닌 값은 undefined 로 떨군다', async () => {
    mockFetch.mockResolvedValue(okResponse({ mic_ok: 'yes', speaker_ok: null }));
    await expect(fetchPiHealth()).resolves.toEqual({ micOk: undefined, speakerOk: undefined });
  });

  it('본문이 JSON 이 아니어도 연결 자체는 살아있는 것으로 본다', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('not json');
      },
    });
    await expect(fetchPiHealth()).resolves.toEqual({ micOk: undefined, speakerOk: undefined });
  });

  it('HTTP 실패는 null', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(fetchPiHealth()).resolves.toBeNull();
  });

  it('네트워크 예외는 삼키고 null', async () => {
    mockFetch.mockRejectedValue(new Error('Network request failed'));
    await expect(fetchPiHealth()).resolves.toBeNull();
  });
});

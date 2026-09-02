/**
 * playAudioOnPi 의 업로드/재생 2요청 분리 검증 (2026-08-20).
 * 자막 시계용 onUploaded 는 /play/upload 응답 직후·/play/start 요청 전에
 * 정확히 1회 와야 한다 - XHR upload 이벤트 추정 방식이 실기기에서 안 와서
 * 자막이 재생 종료 후에나 시작되던 회귀(개념 풀이 자막 실종)의 재발 방지.
 */
jest.mock('expo-file-system', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
}));

import * as FileSystem from 'expo-file-system';
import { playAudioOnPi } from '../piBridge.service';

const mockFetch = jest.fn();

describe('playAudioOnPi (upload/start 분리)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global as any).fetch = mockFetch;
  });

  it('업로드 응답 후·재생 시작 전에 onUploaded 가 1회 온다', async () => {
    const events: string[] = [];
    mockFetch.mockImplementation(async (url: string) => {
      events.push(new URL(url).pathname);
      return { ok: true, status: 200 };
    });
    const onUploaded = jest.fn(() => events.push('onUploaded'));

    await playAudioOnPi('bXAz', onUploaded);

    expect(events).toEqual(['/play/upload', 'onUploaded', '/play/start']);
    expect(onUploaded).toHaveBeenCalledTimes(1);
    // 임시 mp3 파일은 항상 지운다.
    expect(FileSystem.deleteAsync).toHaveBeenCalled();
  });

  it('구 서버(404) 는 단일 /play 로 폴백하고 onUploaded 를 부르지 않는다', async () => {
    const urls: string[] = [];
    mockFetch.mockImplementation(async (url: string) => {
      urls.push(new URL(url).pathname);
      if (url.endsWith('/play/upload')) return { ok: false, status: 404 };
      return { ok: true, status: 200 };
    });
    const onUploaded = jest.fn();

    await playAudioOnPi('bXAz', onUploaded);

    expect(urls).toEqual(['/play/upload', '/play']);
    // 구 서버는 업로드 완료 시점을 모른다 - speak() 의 재생 후 폴백이 자막을 살린다.
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it('업로드 실패(500)는 throw 하고 onUploaded 도 없다', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const onUploaded = jest.fn();

    await expect(playAudioOnPi('bXAz', onUploaded)).rejects.toThrow('play/upload failed: 500');
    expect(onUploaded).not.toHaveBeenCalled();
    expect(FileSystem.deleteAsync).toHaveBeenCalled();
  });

  it('재생 시작 실패는 throw 한다 (자막 시계는 이미 시작 - speak 쪽 정책 그대로)', async () => {
    mockFetch.mockImplementation(async (url: string) => ({
      ok: !url.endsWith('/play/start'),
      status: url.endsWith('/play/start') ? 500 : 200,
    }));

    await expect(playAudioOnPi('bXAz', jest.fn())).rejects.toThrow('play/start failed: 500');
  });
});

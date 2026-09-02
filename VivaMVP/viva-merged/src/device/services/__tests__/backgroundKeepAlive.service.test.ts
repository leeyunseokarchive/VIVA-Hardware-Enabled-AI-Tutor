/**
 * backgroundKeepAlive: 무음 루프의 시작/정지 멱등성과 직렬화.
 * expo-av 는 전부 모킹 - 실제 오디오 검증은 실기기 체크리스트(스펙 §테스트).
 */
const mockSound = {
  playAsync: jest.fn().mockResolvedValue(undefined),
  unloadAsync: jest.fn().mockResolvedValue(undefined),
  getStatusAsync: jest.fn().mockResolvedValue({ isLoaded: true, isPlaying: true }),
};

jest.mock('expo-av', () => ({
  InterruptionModeIOS: { MixWithOthers: 0 },
  Audio: {
    setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
    Sound: { createAsync: jest.fn(() => Promise.resolve({ sound: mockSound })) },
  },
}));

// mock 객체는 팩토리 안에서 만든다 - jest.mock 은 import 위로 hoist 되므로
// 바깥 const 를 참조하면(이 리포는 const→var 트랜스파일이라 TDZ 로 안 터지고
// 조용히 undefined 가 잡힌다) FGS 호출이 전부 무명 mock 을 놓친다
// (useWakeWord.test.ts 의 동일 관례 참고).
jest.mock('react-native-background-actions', () => ({
  __esModule: true,
  default: {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    isRunning: jest.fn().mockReturnValue(false),
  },
}));

import { Platform } from 'react-native';
import { Audio } from 'expo-av';
import BackgroundServiceMock from 'react-native-background-actions';
import { backgroundKeepAlive } from '../backgroundKeepAlive.service';

const mockBackgroundService = BackgroundServiceMock as unknown as {
  start: jest.Mock;
  stop: jest.Mock;
  isRunning: jest.Mock;
};

beforeEach(async () => {
  await backgroundKeepAlive.stop();
  jest.clearAllMocks();
});

describe('backgroundKeepAlive', () => {
  it('start 는 오디오 모드 설정 후 무음 루프를 재생한다', async () => {
    await backgroundKeepAlive.start();
    expect(Audio.setAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        staysActiveInBackground: true,
        playsInSilentModeIOS: true,
      }),
    );
    expect(Audio.Sound.createAsync).toHaveBeenCalledWith(expect.anything(), {
      isLooping: true,
      volume: 0,
    });
    expect(mockSound.playAsync).toHaveBeenCalled();
    expect(backgroundKeepAlive.active).toBe(true);
  });

  it('start 두 번은 사운드를 한 번만 만든다 (멱등)', async () => {
    await backgroundKeepAlive.start();
    await backgroundKeepAlive.start();
    expect(Audio.Sound.createAsync).toHaveBeenCalledTimes(1);
  });

  it('stop 은 unload 하고 active 를 내린다. 두 번 불러도 안전', async () => {
    await backgroundKeepAlive.start();
    await backgroundKeepAlive.stop();
    await backgroundKeepAlive.stop();
    expect(mockSound.unloadAsync).toHaveBeenCalledTimes(1);
    expect(backgroundKeepAlive.active).toBe(false);
  });

  it('start 직후 await 없이 stop 하면 최종 상태는 정지 (마지막 의도 승리)', async () => {
    const p1 = backgroundKeepAlive.start();
    const p2 = backgroundKeepAlive.stop();
    await Promise.all([p1, p2]);
    expect(backgroundKeepAlive.active).toBe(false);
    // 만들었다면 반드시 되물렸어야 한다
    if ((Audio.Sound.createAsync as jest.Mock).mock.calls.length > 0) {
      expect(mockSound.unloadAsync).toHaveBeenCalled();
    }
  });

  it('ensurePlaying 은 멈춘 재생을 되살린다', async () => {
    await backgroundKeepAlive.start();
    mockSound.playAsync.mockClear();
    mockSound.getStatusAsync.mockResolvedValueOnce({ isLoaded: true, isPlaying: false });
    await backgroundKeepAlive.ensurePlaying();
    expect(mockSound.playAsync).toHaveBeenCalledTimes(1);
  });

  it('ensurePlaying 은 정지 상태에선 아무것도 안 한다', async () => {
    await backgroundKeepAlive.ensurePlaying();
    expect(mockSound.getStatusAsync).not.toHaveBeenCalled();
  });

  it('start 실패 후 ensurePlaying 이 재획득한다 (자가치유)', async () => {
    (Audio.Sound.createAsync as jest.Mock).mockRejectedValueOnce(new Error('오디오 로드 실패'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await backgroundKeepAlive.start();
      expect(backgroundKeepAlive.active).toBe(false);

      await backgroundKeepAlive.ensurePlaying();

      expect(backgroundKeepAlive.active).toBe(true);
      expect(mockSound.playAsync).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('createAsync 가 reject 하면: start() 는 throw 하지 않고 resolve, active === false', async () => {
    const err = new Error('오디오 로드 실패');
    (Audio.Sound.createAsync as jest.Mock).mockRejectedValueOnce(err);

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // void 로 호출해도 unhandled rejection 없음
      const p = backgroundKeepAlive.start();
      await expect(p).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        '[BackgroundKeepAlive] start 실패:',
        '오디오 로드 실패',
      );
      expect(backgroundKeepAlive.active).toBe(false);
      expect(mockSound.playAsync).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  describe('Android FGS', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('android 에선 start 가 FGS 도 올린다 (connectedDevice)', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await backgroundKeepAlive.start();
      expect(mockBackgroundService.start).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          taskName: 'VivaKeepAlive',
          foregroundServiceType: ['connectedDevice'],
        }),
      );
      // Platform 이 아직 android 인 동안 내려야 fgsDesired 가 다음 테스트로
      // 새지 않는다 - beforeEach 의 stop() 은 Platform 기본값(ios)이라 이걸
      // 못 잡는다.
      await backgroundKeepAlive.stop();
    });

    it('android 에선 stop 이 FGS 도 내린다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      await backgroundKeepAlive.start();
      await backgroundKeepAlive.stop();
      expect(mockBackgroundService.stop).toHaveBeenCalledTimes(1);
    });

    it('ios 에선 FGS 를 건드리지 않는다', async () => {
      await backgroundKeepAlive.start();
      await backgroundKeepAlive.stop();
      expect(mockBackgroundService.start).not.toHaveBeenCalled();
      expect(mockBackgroundService.stop).not.toHaveBeenCalled();
    });

    it('FGS start 가 reject 해도 start 는 throw 하지 않는다', async () => {
      jest.replaceProperty(Platform, 'OS', 'android');
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        mockBackgroundService.start.mockRejectedValueOnce(new Error('FGS 거부'));
        await expect(backgroundKeepAlive.start()).resolves.toBeUndefined();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});

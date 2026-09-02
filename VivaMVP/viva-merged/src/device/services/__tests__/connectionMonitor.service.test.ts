jest.mock('../piBridge.service', () => ({
  fetchPiHealth: jest.fn(),
}));

jest.mock('../backgroundKeepAlive.service', () => ({
  backgroundKeepAlive: {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    ensurePlaying: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../eyeSync.service', () => {
  const listeners = new Set();
  return {
    eyeSyncService: {
      onConnectionChange: jest.fn((l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      }),
      // 끊김 전파(2026-08-11): disconnected 엣지에서 stop, connected 엣지에서
      // resendLast 가 불리는지 검증한다.
      stop: jest.fn(),
      resendLast: jest.fn(),
      __fireConnectionChange: (connected) =>
        listeners.forEach((l: any) => l(connected)),
    },
  };
});

import { AppState } from 'react-native';
import { fetchPiHealth } from '../piBridge.service';
import { backgroundKeepAlive } from '../backgroundKeepAlive.service';
import { connectionMonitor } from '../connectionMonitor.service';

const mockCheck = fetchPiHealth as jest.Mock;
/** 연결 성공 = 헬스 객체, 실패 = null. 기존 true/false 자리에 그대로 들어간다. */
const ALIVE = {};

/** probe 의 await 체인(마이크로태스크)을 비운다. */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('connectionMonitor', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockCheck.mockReset();
    connectionMonitor.stop(); // 싱글턴 초기화: 폴링 해제 + 'connecting' 복귀
    // 위 stop() 이 이미 backgroundKeepAlive.stop 을 호출했다 - 다음 테스트의
    // toHaveBeenCalled 계열 단언이 이전 잔여 호출을 보지 않도록 비운다.
    (backgroundKeepAlive.start as jest.Mock).mockClear();
    (backgroundKeepAlive.stop as jest.Mock).mockClear();
    (backgroundKeepAlive.ensurePlaying as jest.Mock).mockClear();
  });

  afterEach(() => {
    connectionMonitor.stop();
    jest.useRealTimers();
  });

  it('starts as connecting, then connected on successful probe', async () => {
    mockCheck.mockResolvedValue(ALIVE);
    connectionMonitor.start();
    expect(connectionMonitor.status).toBe('connecting');
    await flush();
    expect(connectionMonitor.status).toBe('connected');
  });

  it('goes disconnected when the probe fails', async () => {
    mockCheck.mockResolvedValue(null);
    connectionMonitor.start();
    await flush();
    expect(connectionMonitor.status).toBe('disconnected');
  });

  it('keeps polling every 5s and notifies only on change', async () => {
    mockCheck.mockResolvedValue(ALIVE);
    const seen: string[] = [];
    const unsub = connectionMonitor.onStatusChange((s) => seen.push(s));
    connectionMonitor.start();
    await flush();
    expect(seen).toEqual(['connected']);

    // 같은 결과가 반복돼도 리스너는 다시 안 불린다
    jest.advanceTimersByTime(5000);
    await flush();
    expect(seen).toEqual(['connected']);

    // Pi 가 죽으면 2연속 실패 후 disconnected (2-strike)
    mockCheck.mockResolvedValue(null);
    jest.advanceTimersByTime(5000);
    await flush();
    jest.advanceTimersByTime(5000);
    await flush();
    expect(seen).toEqual(['connected', 'disconnected']);
    unsub();
  });

  describe('2-strike: connected 는 2연속 실패에만 내려간다 (08-14 플랩 방어)', () => {
    it('connected 중 단발 실패는 상태를 유지하고 통지도 없다', async () => {
      mockCheck.mockResolvedValue(ALIVE);
      connectionMonitor.start();
      await flush();
      const seen: string[] = [];
      const unsub = connectionMonitor.onStatusChange((s) => seen.push(s));

      mockCheck.mockResolvedValueOnce(null); // 단발 실패
      jest.advanceTimersByTime(5000);
      await flush();
      expect(connectionMonitor.status).toBe('connected');
      expect(seen).toEqual([]);

      jest.advanceTimersByTime(5000); // 다음 폴링은 성공 - 복구
      await flush();
      expect(connectionMonitor.status).toBe('connected');
      unsub();
    });

    it('2연속 실패면 disconnected', async () => {
      mockCheck.mockResolvedValue(ALIVE);
      connectionMonitor.start();
      await flush();

      mockCheck.mockResolvedValue(null);
      jest.advanceTimersByTime(5000);
      await flush();
      expect(connectionMonitor.status).toBe('connected'); // strike 1
      jest.advanceTimersByTime(5000);
      await flush();
      expect(connectionMonitor.status).toBe('disconnected'); // strike 2
    });

    it('실패 사이 성공이 끼면 스트릭이 리셋된다', async () => {
      mockCheck.mockResolvedValue(ALIVE);
      connectionMonitor.start();
      await flush();

      mockCheck.mockResolvedValueOnce(null); // 실패
      jest.advanceTimersByTime(5000);
      await flush();
      jest.advanceTimersByTime(5000); // 성공 - 리셋
      await flush();
      mockCheck.mockResolvedValueOnce(null); // 다시 단발 실패
      jest.advanceTimersByTime(5000);
      await flush();
      expect(connectionMonitor.status).toBe('connected');
    });

    it('connecting 에선 첫 실패로 즉시 disconnected (시작 시 지연 없음)', async () => {
      mockCheck.mockResolvedValue(null);
      connectionMonitor.start();
      await flush();
      expect(connectionMonitor.status).toBe('disconnected');
    });
  });

  it('reportFailure triggers an immediate re-probe', async () => {
    mockCheck.mockResolvedValue(ALIVE);
    connectionMonitor.start();
    await flush();
    expect(connectionMonitor.status).toBe('connected');

    mockCheck.mockClear();
    mockCheck.mockResolvedValue(null);
    connectionMonitor.reportFailure(); // 5초 안 기다리고 즉시 프로브
    await flush();
    expect(mockCheck).toHaveBeenCalled();
    expect(connectionMonitor.status).toBe('connected'); // strike 1 - 아직 유지
    jest.advanceTimersByTime(5000); // strike 2
    await flush();
    expect(connectionMonitor.status).toBe('disconnected');
  });

  it('reportFailure is a no-op while stopped (APP mode)', async () => {
    mockCheck.mockResolvedValue(null);
    connectionMonitor.reportFailure();
    await flush();
    expect(mockCheck).not.toHaveBeenCalled();
    expect(connectionMonitor.status).toBe('connecting');
  });

  it('stop() halts polling and resets to connecting', async () => {
    mockCheck.mockResolvedValue(ALIVE);
    connectionMonitor.start();
    await flush();
    connectionMonitor.stop();
    expect(connectionMonitor.status).toBe('connecting');
    mockCheck.mockClear();
    jest.advanceTimersByTime(20000);
    await flush();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('a probe resolving after stop() does not override the connecting status it set', async () => {
    let resolveCheck: (health: object | null) => void = () => {};
    mockCheck.mockImplementation(
      () =>
        new Promise<object | null>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    connectionMonitor.start(); // probe() 시작 - fetchPiHealth 가 pending 인 채 대기
    connectionMonitor.stop(); // APP 모드 전환: 'connecting' 으로 되돌림
    resolveCheck(ALIVE); // 뒤늦게 도착한 판정
    await flush();
    expect(connectionMonitor.status).toBe('connecting');
  });

  it('probeNow returns the fresh verdict - 2-strike 디바운스와 무관', async () => {
    mockCheck.mockResolvedValue(ALIVE);
    connectionMonitor.start();
    await flush();
    mockCheck.mockResolvedValue(null);
    // 단발 실패라 상태는 아직 connected 지만, 호출부(beginCapture 폴백
    // 분기)엔 방금 프로브의 진실(false)을 준다.
    await expect(connectionMonitor.probeNow()).resolves.toBe(false);
    expect(connectionMonitor.status).toBe('connected');
  });

  it('eye-WS drop triggers an immediate re-probe', async () => {
    const { eyeSyncService } = require('../eyeSync.service');
    mockCheck.mockResolvedValue(ALIVE);
    connectionMonitor.start();
    await flush();
    expect(connectionMonitor.status).toBe('connected');

    mockCheck.mockClear();
    mockCheck.mockResolvedValue(null);
    eyeSyncService.__fireConnectionChange(false);
    await flush();
    expect(mockCheck).toHaveBeenCalled(); // 즉시 재프로브 (strike 1)
    jest.advanceTimersByTime(5000); // strike 2
    await flush();
    expect(connectionMonitor.status).toBe('disconnected');
  });

  it('eye-WS reconnect (true) is not a trigger', async () => {
    const { eyeSyncService } = require('../eyeSync.service');
    mockCheck.mockResolvedValue(ALIVE);
    connectionMonitor.start();
    await flush();
    mockCheck.mockClear();
    eyeSyncService.__fireConnectionChange(true);
    await flush();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('disconnected 엣지에서 눈 WS 를 내린다 - 보드가 스스로 끊김을 알게', async () => {
    const { eyeSyncService } = require('../eyeSync.service');
    mockCheck.mockResolvedValue(ALIVE);
    connectionMonitor.start();
    await flush();
    eyeSyncService.stop.mockClear();

    mockCheck.mockResolvedValue(null);
    jest.advanceTimersByTime(5000); // strike 1
    await flush();
    jest.advanceTimersByTime(5000); // strike 2
    await flush();
    expect(connectionMonitor.status).toBe('disconnected');
    expect(eyeSyncService.stop).toHaveBeenCalledTimes(1);

    // 같은 disconnected 가 반복돼도 다시 안 내린다 (엣지에서만).
    jest.advanceTimersByTime(5000);
    await flush();
    expect(eyeSyncService.stop).toHaveBeenCalledTimes(1);
  });

  it('connected 복귀 엣지에서 마지막 표정을 재송신해 눈 WS 를 되살린다', async () => {
    const { eyeSyncService } = require('../eyeSync.service');
    mockCheck.mockResolvedValue(null);
    connectionMonitor.start();
    await flush();
    expect(connectionMonitor.status).toBe('disconnected');
    eyeSyncService.resendLast.mockClear();

    mockCheck.mockResolvedValue(ALIVE);
    jest.advanceTimersByTime(5000);
    await flush();
    expect(connectionMonitor.status).toBe('connected');
    expect(eyeSyncService.resendLast).toHaveBeenCalledTimes(1);
  });

  it('exposes the health payload and clears it on stop()', async () => {
    mockCheck.mockResolvedValue({ micOk: true, speakerOk: false });
    connectionMonitor.start();
    await flush();
    expect(connectionMonitor.health).toEqual({ micOk: true, speakerOk: false });

    connectionMonitor.stop();
    expect(connectionMonitor.health).toBeNull();
  });

  it('health is null while disconnected', async () => {
    mockCheck.mockResolvedValue(null);
    connectionMonitor.start();
    await flush();
    expect(connectionMonitor.status).toBe('disconnected');
    expect(connectionMonitor.health).toBeNull();
  });

  it('notifies when only the health changes - status stays connected', async () => {
    // status 만 보고 게이팅하면 마이크가 죽어도 화면이 안 바뀐다.
    mockCheck.mockResolvedValue({ micOk: true, speakerOk: true });
    const seen: string[] = [];
    connectionMonitor.start();
    await flush();
    const unsub = connectionMonitor.onStatusChange((s) => seen.push(s));

    mockCheck.mockResolvedValue({ micOk: false, speakerOk: true });
    jest.advanceTimersByTime(5000);
    await flush();
    expect(seen).toEqual(['connected']); // 상태는 그대로지만 통지는 왔다
    expect(connectionMonitor.health).toEqual({ micOk: false, speakerOk: true });
    unsub();
  });

  it('notifies when only camOk/displayOk changes - status stays connected', async () => {
    // 카메라·디스플레이 필드도 마이크·스피커와 같은 비교 경로를 타는지 확인
    // (커밋 비교가 필드 목록을 하드코딩하므로 새 필드 추가 시 여기가 조용히
    // 빠지기 쉽다 - connectionMonitor.service.ts 의 ponytail 주석 참고).
    mockCheck.mockResolvedValue({ camOk: true, displayOk: true });
    const seen: string[] = [];
    connectionMonitor.start();
    await flush();
    const unsub = connectionMonitor.onStatusChange((s) => seen.push(s));

    mockCheck.mockResolvedValue({ camOk: false, displayOk: true });
    jest.advanceTimersByTime(5000);
    await flush();
    expect(seen).toEqual(['connected']);
    expect(connectionMonitor.health).toEqual({ camOk: false, displayOk: true });
    unsub();
  });

  it('does not notify when neither status nor health changed', async () => {
    mockCheck.mockResolvedValue({ micOk: true, speakerOk: true });
    connectionMonitor.start();
    await flush();
    const seen: string[] = [];
    const unsub = connectionMonitor.onStatusChange((s) => seen.push(s));

    mockCheck.mockResolvedValue({ micOk: true, speakerOk: true }); // 같은 값, 다른 객체
    jest.advanceTimersByTime(5000);
    await flush();
    expect(seen).toEqual([]);
    unsub();
  });

  describe('backgroundKeepAlive 라이프사이클', () => {
    it('connected 전이 시 keepalive start', async () => {
      mockCheck.mockResolvedValue(ALIVE);
      connectionMonitor.start();
      await flush();
      expect(connectionMonitor.status).toBe('connected');
      expect(backgroundKeepAlive.start).toHaveBeenCalled();
    });

    it('disconnected 전이 후 3분 유예가 지나야 keepalive stop', async () => {
      mockCheck.mockResolvedValue(ALIVE);
      connectionMonitor.start();
      await flush();
      expect(connectionMonitor.status).toBe('connected');

      mockCheck.mockResolvedValue(null);
      jest.advanceTimersByTime(5000); // strike 1
      await flush();
      jest.advanceTimersByTime(5000); // strike 2
      await flush();
      expect(connectionMonitor.status).toBe('disconnected');
      expect(backgroundKeepAlive.stop).not.toHaveBeenCalled();

      jest.advanceTimersByTime(3 * 60_000);
      await flush();
      expect(backgroundKeepAlive.stop).toHaveBeenCalledTimes(1);
    });

    it('유예 중 재연결되면 stop 타이머 취소', async () => {
      mockCheck.mockResolvedValue(ALIVE);
      connectionMonitor.start();
      await flush();

      mockCheck.mockResolvedValue(null);
      jest.advanceTimersByTime(5000); // strike 1
      await flush();
      jest.advanceTimersByTime(5000); // strike 2
      await flush();
      expect(connectionMonitor.status).toBe('disconnected');

      // 유예 중 1분 경과 (재연결 전) - 폴링은 계속 돈다
      jest.advanceTimersByTime(60_000);
      await flush();

      mockCheck.mockResolvedValue(ALIVE);
      jest.advanceTimersByTime(5000); // 다음 폴링에서 재연결 복귀
      await flush();
      expect(connectionMonitor.status).toBe('connected');

      jest.advanceTimersByTime(3 * 60_000);
      await flush();
      expect(backgroundKeepAlive.stop).not.toHaveBeenCalled();
    });

    it('monitor.stop() 은 즉시 keepalive stop + 유예 타이머 취소', async () => {
      mockCheck.mockResolvedValue(ALIVE);
      connectionMonitor.start();
      await flush();
      expect(connectionMonitor.status).toBe('connected');

      connectionMonitor.stop();
      expect(backgroundKeepAlive.stop).toHaveBeenCalled();
    });

    it('AppState active 복귀 시 즉시 재프로브 + ensurePlaying', async () => {
      const addEventListenerSpy = jest.spyOn(AppState, 'addEventListener');
      mockCheck.mockResolvedValue(ALIVE);
      connectionMonitor.start();
      await flush();

      const listener = addEventListenerSpy.mock.calls.find(
        ([event]) => event === 'change',
      )?.[1];
      expect(listener).toBeDefined();

      mockCheck.mockClear();
      listener?.('active');
      await flush();

      expect(mockCheck).toHaveBeenCalled();
      expect(backgroundKeepAlive.ensurePlaying).toHaveBeenCalled();
      addEventListenerSpy.mockRestore();
    });
  });
});

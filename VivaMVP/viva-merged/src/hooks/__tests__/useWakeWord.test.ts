/**
 * Unit tests for useWakeWord (openWakeWord ONNX engine).
 *
 * 실제 마이크/ONNX 런타임은 Jest 에서 못 쓰므로 react-native-live-audio-stream
 * 과 OpenWakeWordEngine 을 mock 으로 대체하고, 훅이 둘을 엮는 로직만 검증한다.
 * mock 객체는 팩토리 안에서 만든다 - jest.mock 은 import 위로 hoist 되므로
 * 바깥 const 를 참조하면 TDZ 에러가 나고, useWakeWord 의 try/catch 가 그걸
 * 삼켜 "모듈 없음" 으로 조용히 죽는다.
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native-live-audio-stream', () => ({
  __esModule: true,
  default: {
    init: jest.fn(),
    on: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
  },
}));

jest.mock('../../lib/openWakeWord', () => {
  const engines: any[] = [];
  return {
    OpenWakeWordEngine: jest.fn().mockImplementation((callbacks: any) => {
      const engine = {
        callbacks,
        load: jest.fn().mockResolvedValue(undefined),
        start: jest.fn(),
        stop: jest.fn(),
        reset: jest.fn(),
        release: jest.fn().mockResolvedValue(undefined),
        feedBase64: jest.fn(),
      };
      engines.push(engine);
      return engine;
    }),
    OWW_ASSETS: { mel: 'mel.onnx', emb: 'emb.onnx', ww: 'ww.onnx' },
    __engines: engines,
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockStream = require('react-native-live-audio-stream').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockOww = require('../../lib/openWakeWord');
// eslint-disable-next-line import/first
import { useWakeWord } from '../useWakeWord';

function renderWakeWord(onDetected: jest.Mock, options?: { piStream?: any }) {
  const ref: { current: any } = { current: null };

  function Harness() {
    ref.current = useWakeWord(onDetected, options);
    return null;
  }

  act(() => {
    ReactTestRenderer.create(React.createElement(Harness));
  });

  return ref;
}

/** 이 테스트에서 등록된 'data' 리스너들. */
function dataListeners(): ((b64: string) => void)[] {
  return mockStream.on.mock.calls
    .filter(([event]: [string]) => event === 'data')
    .map(([, cb]: [string, (b64: string) => void]) => cb);
}

/** 마이크 청크 1개가 도착한 것처럼 등록된 리스너를 전부 호출한다. */
// 실물 LiveAudioStream.on() 은 removeAllListeners 를 먼저 부르므로 살아 있는
// 리스너는 언제나 마지막에 등록한 것 하나뿐이다 - 청크도 그 하나에만 간다.
function emitChunk(b64: string) {
  const live = dataListeners().slice(-1);
  live.forEach((cb) => cb(b64));
}

function latestEngine() {
  return mockOww.__engines[mockOww.__engines.length - 1];
}

describe('useWakeWord (openWakeWord engine)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOww.__engines.length = 0;
  });

  it('loads the engine and feeds mic audio into it', async () => {
    const ref = renderWakeWord(jest.fn());

    await act(async () => {
      await ref.current.startListening();
    });

    expect(ref.current.isListening).toBe(true);
    expect(mockOww.__engines).toHaveLength(1);
    expect(latestEngine().load).toHaveBeenCalledWith('mel.onnx', 'emb.onnx', 'ww.onnx');
    expect(latestEngine().start).toHaveBeenCalled();
    expect(mockStream.start).toHaveBeenCalledTimes(1);

    act(() => emitChunk('chunk'));
    expect(latestEngine().feedBase64).toHaveBeenCalledTimes(1);
  });

  it('fires onDetected when the engine reports a detection', async () => {
    const onDetected = jest.fn();
    const ref = renderWakeWord(onDetected);

    await act(async () => {
      await ref.current.startListening();
    });

    act(() => latestEngine().callbacks.onDetected());
    expect(onDetected).toHaveBeenCalledTimes(1);
  });

  it('stopListening suspends the engine (stream + engine.stop) without releasing it', async () => {
    const ref = renderWakeWord(jest.fn());

    await act(async () => {
      await ref.current.startListening();
    });
    const engine = latestEngine();

    await act(async () => {
      await ref.current.stopListening();
    });

    expect(ref.current.isListening).toBe(false);
    expect(mockStream.stop).toHaveBeenCalled();
    expect(engine.stop).toHaveBeenCalled();
    // 엔진은 세션 간 재사용된다 - stopListening 은 release 하지 않는다.
    expect(engine.release).not.toHaveBeenCalled();
  });

  it('unmounting releases the engine', async () => {
    const ref: { current: any } = { current: null };
    function Harness() {
      ref.current = useWakeWord(jest.fn());
      return null;
    }
    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(React.createElement(Harness));
    });

    await act(async () => {
      await ref.current.startListening();
    });
    const engine = latestEngine();

    act(() => {
      renderer.unmount();
    });

    expect(engine.release).toHaveBeenCalled();
  });

  it('feeds Pi PCM without starting the phone microphone', async () => {
    const piStream = {
      start: jest.fn(async (cb: (b64: string) => void) => cb('pi-pcm')),
      stop: jest.fn(),
    };
    const ref = renderWakeWord(jest.fn(), { piStream });
    await act(async () => {
      await ref.current.startListening();
    });
    expect(latestEngine().feedBase64).toHaveBeenCalledWith('pi-pcm');
    expect(mockStream.start).not.toHaveBeenCalled();
  });

  it('falls back to the phone microphone when the Pi stream fails to start', async () => {
    const piStream = { start: jest.fn().mockRejectedValue(new Error('pi down')) };
    const ref = renderWakeWord(jest.fn(), { piStream });
    await act(async () => {
      await ref.current.startListening();
    });

    expect(ref.current.isListening).toBe(true);
    expect(mockStream.start).toHaveBeenCalledTimes(1);
    act(() => emitChunk('chunk'));
    expect(latestEngine().feedBase64).toHaveBeenCalledWith('chunk');
  });

  // Regression (실기기 2026-07-29): 청취를 시작할 때마다 'data' 를 **다시**
  // 등록해야 한다. LiveAudioStream.on() 은 removeAllListeners 를 먼저 부르므로
  // 누적은 애초에 불가능하고, 대신 마지막에 부른 쪽이 스트림을 독점한다 -
  // 예전엔 "누적 방지" 로 훅 인스턴스당 1회만 등록했는데, 대화 중
  // useVoiceInput 이 on() 을 부르면 호출어 리스너가 제거된 뒤 다시 등록되지
  // 않아 홈으로 돌아와도 "비바야" 가 영영 안 먹었다.
  it('re-registers the mic data listener on every restart, and reuses one engine via reset', async () => {
    const ref = renderWakeWord(jest.fn());

    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await ref.current.startListening();
      });
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        await ref.current.stopListening();
      });
    }
    await act(async () => {
      await ref.current.startListening();
    });

    // 시작할 때마다 등록 = 4회 (start 3회 + 마지막 start 1회)
    expect(dataListeners()).toHaveLength(4);

    // 살아 있는 리스너는 하나뿐이고, 그게 지금 엔진으로만 흘린다.
    const liveEngine = latestEngine();
    act(() => emitChunk('chunk'));
    expect(liveEngine.feedBase64).toHaveBeenCalledTimes(1);

    // 엔진은 훅 수명 동안 딱 1개만 만들어진다(세션마다 재로드하지 않는다).
    expect(mockOww.__engines).toHaveLength(1);
    const engine = latestEngine();
    // 최초 시작은 아직 엔진이 없어 reset 없이 생성된다 - 그 뒤 재시작
    // 3회(2·3·4번째 start)만 reset 을 부르고, 그 reset 은 매번 같은
    // 사이클의 start 보다 먼저 실행된다(버퍼를 비우고 재개하는 순서).
    const resetOrder: number[] = engine.reset.mock.invocationCallOrder;
    const startOrder: number[] = engine.start.mock.invocationCallOrder;
    expect(resetOrder).toHaveLength(3);
    expect(startOrder).toHaveLength(4);
    resetOrder.forEach((resetCallOrder, idx) => {
      expect(resetCallOrder).toBeLessThan(startOrder[idx + 1]);
    });
  });
});

/**
 * Unit tests for useVoiceInput (녹음 전체 → Gemini 전사 방식).
 *
 * 실제 마이크/네트워크는 Jest 에서 못 쓰므로, LiveAudioStream 호환 fake 와
 * transcribeFn mock 을 주입해 다음의 진짜 로직을 검증한다:
 * - RMS 침묵 감지로 발화가 정확히 1회 전사·제출되는지
 * - 빈 전사 결과는 제출하지 않는지
 * - 시작 실패/모듈 부재 시 text_fallback 전환
 *
 * 로봇 마이크 경로는 piBridge 를 직접 mock 하지 않는다 - 훅은 이제
 * Pi 를 모르고 RobotMicAdapter 를 주입받으므로(Task 3), makeAdapter() 로
 * 만든 fake 어댑터의 spy 를 그대로 단언한다.
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import {
  useVoiceInput,
  UseVoiceInputResult,
  RobotMicAdapter,
  VOICE_SILENCE_FINALIZE_MS,
  SETTLING_SILENCE_MS,
  MAX_UTTERANCE_MS,
  ROBOT_POLL_INTERVAL_MS,
} from '../useVoiceInput';

// --- PCM helpers -------------------------------------------------------------

/** amplitude(0~32767)의 int16 mono PCM 청크를 base64 로 만든다. */
function pcmChunkBase64(amplitude: number, samples = 1024): string {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(amplitude, i * 2);
  }
  return buf.toString('base64');
}

const LOUD = pcmChunkBase64(8000); // RMS ≈ 0.24 (말하는 중)
const SILENT = pcmChunkBase64(0); // RMS 0 (침묵)

// --- fakes -------------------------------------------------------------------

interface FakeStream {
  init: jest.Mock;
  on: jest.Mock;
  start: jest.Mock;
  stop: jest.Mock;
  emit: (b64: string) => void;
}

function makeFakeStream(overrides: Partial<FakeStream> = {}): FakeStream {
  const listeners: ((b64: string) => void)[] = [];
  return {
    init: jest.fn(),
    on: jest.fn((event: string, cb: (b64: string) => void) => {
      if (event === 'data') listeners.push(cb);
    }),
    start: jest.fn(),
    stop: jest.fn(),
    emit: (b64: string) => listeners.forEach((cb) => cb(b64)),
    ...overrides,
  };
}

const fakeVoice = { stop: jest.fn().mockResolvedValue(undefined) } as any;

/** 로봇 마이크 어댑터 fake. 기본값은 "듣는 중, 아직 무음" 상태 - 개별
 * 테스트가 필요한 필드만 overrides 로 갈아끼운다. */
function makeAdapter(overrides: Partial<RobotMicAdapter> = {}): RobotMicAdapter & {
  startRecording: jest.Mock;
  stopRecording: jest.Mock;
  fetchStatus: jest.Mock;
  fetchAudio: jest.Mock;
} {
  return {
    startRecording: jest.fn().mockResolvedValue(undefined),
    stopRecording: jest.fn().mockResolvedValue(undefined),
    fetchStatus: jest.fn().mockResolvedValue({ recording: true, silent_ms: 0, had_speech: false }),
    fetchAudio: jest.fn().mockResolvedValue('d2F2'),
    ...overrides,
  } as any;
}

function renderVoiceInput(opts: {
  onResult: jest.Mock;
  stream: FakeStream | null;
  transcribeFn?: jest.Mock;
  getTranscribeContext?: () => string | undefined;
  robotMic?: RobotMicAdapter | null;
  allowPhoneMicFallback?: boolean;
}) {
  const ref: { current: UseVoiceInputResult | null } = { current: null };

  function Harness() {
    ref.current = useVoiceInput({
      onResult: opts.onResult,
      audioStreamModule: opts.stream,
      transcribeFn: (opts.transcribeFn ?? jest.fn().mockResolvedValue('')) as any,
      getTranscribeContext: opts.getTranscribeContext,
      voiceModule: fakeVoice,
      robotMic: opts.robotMic,
      allowPhoneMicFallback: opts.allowPhoneMicFallback,
    });
    return null;
  }

  act(() => {
    ReactTestRenderer.create(React.createElement(Harness));
  });

  return ref as { current: UseVoiceInputResult };
}

/** startListening 내부의 오디오 세션 settle(300ms)까지 넘겨서 시작한다. */
async function startWithTimers(ref: { current: UseVoiceInputResult }) {
  await act(async () => {
    const p = ref.current.startListening();
    await jest.advanceTimersByTimeAsync(400);
    await p;
  });
}

describe('useVoiceInput (record-then-Gemini-transcribe)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts in voice mode', () => {
    const ref = renderVoiceInput({ onResult: jest.fn(), stream: makeFakeStream() });
    expect(ref.current.mode).toBe('voice');
  });

  it('falls back to text mode when the audio stream module is unavailable', async () => {
    const ref = renderVoiceInput({ onResult: jest.fn(), stream: null });
    await startWithTimers(ref);
    expect(ref.current.mode).toBe('text_fallback');
  });

  it('falls back to text mode when stream start throws', async () => {
    const stream = makeFakeStream({
      start: jest.fn(() => {
        throw new Error('mic busy');
      }),
    });
    const ref = renderVoiceInput({ onResult: jest.fn(), stream });
    await startWithTimers(ref);
    expect(ref.current.mode).toBe('text_fallback');
    expect(ref.current.errorMessage).toBe('mic busy');
  });

  it('starts listening with 16kHz mono LINEAR16 options', async () => {
    const stream = makeFakeStream();
    const ref = renderVoiceInput({ onResult: jest.fn(), stream });
    await startWithTimers(ref);

    expect(ref.current.mode).toBe('voice');
    expect(ref.current.isListening).toBe(true);
    expect(stream.init).toHaveBeenCalledWith(
      expect.objectContaining({ sampleRate: 16000, channels: 1, bitsPerSample: 16 }),
    );
    expect(stream.start).toHaveBeenCalledTimes(1);
  });

  it('transcribes EXACTLY ONCE after speech then silence, submitting the transcript', async () => {
    const onResult = jest.fn();
    const stream = makeFakeStream();
    const transcribeFn = jest.fn().mockResolvedValue('근의 공식이 뭐야');
    const ref = renderVoiceInput({ onResult, stream, transcribeFn });
    await startWithTimers(ref);

    // 말하는 중: 침묵 판정이 나면 안 된다.
    await act(async () => {
      stream.emit(LOUD);
      await jest.advanceTimersByTimeAsync(500);
      stream.emit(LOUD);
    });
    expect(onResult).not.toHaveBeenCalled();

    // 침묵 > VOICE_SILENCE_FINALIZE_MS → 전사 1회 → onResult 1회.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(VOICE_SILENCE_FINALIZE_MS + 100);
      stream.emit(SILENT);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(transcribeFn).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith('근의 공식이 뭐야');
    expect(ref.current.isListening).toBe(false);
    expect(stream.stop).toHaveBeenCalled();

    // 뒤늦은 청크는 무시(중복 제출 없음).
    await act(async () => {
      stream.emit(LOUD);
      await jest.advanceTimersByTimeAsync(3000);
      stream.emit(SILENT);
    });
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('applies math post-processing to the transcript', async () => {
    const onResult = jest.fn();
    const stream = makeFakeStream();
    const transcribeFn = jest.fn().mockResolvedValue('이차 방정식 풀이 알려줘');
    const ref = renderVoiceInput({ onResult, stream, transcribeFn });
    await startWithTimers(ref);

    await act(async () => {
      stream.emit(LOUD);
      await jest.advanceTimersByTimeAsync(VOICE_SILENCE_FINALIZE_MS + 100);
      stream.emit(SILENT);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(onResult).toHaveBeenCalledWith('이차방정식 풀이 알려줘');
  });

  // 2026-07-30: 전사에 직전 튜터 질문을 힌트로 넘긴다 - "오" 를 감탄사가
  // 아니라 숫자 5 로 받아쓰게 하는 문맥 주입 경로의 배선 회귀 방지.
  it('passes getTranscribeContext() to transcribeFn as the second argument', async () => {
    const onResult = jest.fn();
    const stream = makeFakeStream();
    const transcribeFn = jest.fn().mockResolvedValue('5');
    const ref = renderVoiceInput({
      onResult,
      stream,
      transcribeFn,
      getTranscribeContext: () => '루트 25는 뭘까?',
    });
    await startWithTimers(ref);

    await act(async () => {
      stream.emit(LOUD);
      await jest.advanceTimersByTimeAsync(VOICE_SILENCE_FINALIZE_MS + 100);
      stream.emit(SILENT);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(transcribeFn).toHaveBeenCalledWith(expect.any(String), '루트 25는 뭘까?');
    expect(onResult).toHaveBeenCalledWith('5');
  });

  it('does NOT finalize on silence alone (never spoke yet)', async () => {
    const onResult = jest.fn();
    const stream = makeFakeStream();
    const transcribeFn = jest.fn();
    const ref = renderVoiceInput({ onResult, stream, transcribeFn });
    await startWithTimers(ref);

    await act(async () => {
      stream.emit(SILENT);
      await jest.advanceTimersByTimeAsync(5000);
      stream.emit(SILENT);
    });

    expect(transcribeFn).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    expect(ref.current.isListening).toBe(true);
  });

  // Regression: MAX_UTTERANCE_MS 는 말을 한 적이 없어도 세션을 끝낸다. 그때
  // 무음 WAV 를 Gemini 에 보내면 돈만 나가고 결과는 빈 문자열이라, 화면의
  // 자동 재청취가 다시 켜서 무한히 반복된다. 말이 한 번도 없었으면 전사
  // 요청 자체를 하지 않아야 한다(세션은 정리하고 다시 듣게 둔다).
  it('does not transcribe a max-length session that contained no speech', async () => {
    const onResult = jest.fn();
    const stream = makeFakeStream();
    const transcribeFn = jest.fn().mockResolvedValue('');
    const ref = renderVoiceInput({ onResult, stream, transcribeFn });
    await startWithTimers(ref);

    await act(async () => {
      stream.emit(SILENT);
      await jest.advanceTimersByTimeAsync(MAX_UTTERANCE_MS + 100);
      stream.emit(SILENT);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(transcribeFn).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    expect(ref.current.isListening).toBe(false);
    expect(stream.stop).toHaveBeenCalled();
  });

  it('does not invoke onResult when the transcript is empty', async () => {
    const onResult = jest.fn();
    const stream = makeFakeStream();
    const transcribeFn = jest.fn().mockResolvedValue('');
    const ref = renderVoiceInput({ onResult, stream, transcribeFn });
    await startWithTimers(ref);

    await act(async () => {
      stream.emit(LOUD);
      await jest.advanceTimersByTimeAsync(VOICE_SILENCE_FINALIZE_MS + 100);
      stream.emit(SILENT);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(transcribeFn).toHaveBeenCalledTimes(1);
    expect(onResult).not.toHaveBeenCalled();
  });

  it('serializes startListening: overlapping calls are no-ops', async () => {
    const stream = makeFakeStream();
    const ref = renderVoiceInput({ onResult: jest.fn(), stream });

    await act(async () => {
      const p1 = ref.current.startListening();
      const p2 = ref.current.startListening();
      const p3 = ref.current.startListening();
      await jest.advanceTimersByTimeAsync(500);
      await Promise.all([p1, p2, p3]);
    });

    expect(stream.start).toHaveBeenCalledTimes(1);
    expect(ref.current.mode).toBe('voice');
  });

  it('stopListening stops the stream without submitting', async () => {
    const onResult = jest.fn();
    const stream = makeFakeStream();
    const transcribeFn = jest.fn();
    const ref = renderVoiceInput({ onResult, stream, transcribeFn });
    await startWithTimers(ref);

    await act(async () => {
      stream.emit(LOUD);
      await ref.current.stopListening();
    });

    expect(ref.current.isListening).toBe(false);
    expect(stream.stop).toHaveBeenCalled();
    expect(transcribeFn).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('submitText invokes onResult directly (manual text fallback entry)', () => {
    const onResult = jest.fn();
    const ref = renderVoiceInput({ onResult, stream: makeFakeStream() });

    act(() => {
      ref.current.submitText('답 알려줘');
    });

    expect(onResult).toHaveBeenCalledWith('답 알려줘');
  });

  it('switchToTextFallback forces text_fallback mode', () => {
    const ref = renderVoiceInput({ onResult: jest.fn(), stream: makeFakeStream() });

    act(() => {
      ref.current.switchToTextFallback();
    });

    expect(ref.current.mode).toBe('text_fallback');
  });

    it('말이 멈추고 SETTLING_SILENCE_MS 가 지나면 isSettling 이 true 가 된다', async () => {
      const stream = makeFakeStream();
      const hook = renderVoiceInput({ onResult: jest.fn(), stream });
      await startWithTimers(hook);

      act(() => {
        stream.emit(LOUD);
      });
      expect(hook.current.isSettling).toBe(false);

      await act(async () => {
        await jest.advanceTimersByTimeAsync(SETTLING_SILENCE_MS + 50);
      });
      act(() => {
        stream.emit(SILENT);
      });
      expect(hook.current.isSettling).toBe(true);
    });

    it('발화가 재개되면 isSettling 이 false 로 돌아온다', async () => {
      const stream = makeFakeStream();
      const hook = renderVoiceInput({ onResult: jest.fn(), stream });
      await startWithTimers(hook);

      act(() => {
        stream.emit(LOUD);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(SETTLING_SILENCE_MS + 50);
      });
      act(() => {
        stream.emit(SILENT);
      });
      expect(hook.current.isSettling).toBe(true);

      act(() => {
        stream.emit(LOUD);
      });
      expect(hook.current.isSettling).toBe(false);
    });

  // 로봇 마이크 모드 (D-33): 녹음·침묵 감지는 어댑터 구현체(Pi 서버 등),
  // 훅은 fetchStatus() 폴링만 한다 - 어댑터는 fake spy 로 주입한다(Task 3).
  describe('robot mic mode', () => {
    it('로봇 어댑터가 있으면 폰 스트림 대신 어댑터로 녹음을 시작한다', async () => {
      const adapter = makeAdapter();
      const stream = makeFakeStream();
      const ref = renderVoiceInput({ onResult: jest.fn(), stream, robotMic: adapter });
      await startWithTimers(ref);

      expect(adapter.startRecording).toHaveBeenCalled();
      // 폰 마이크 스트림은 아예 건드리지 않는다.
      expect(stream.start).not.toHaveBeenCalled();
    });

    it('polls adapter status and transcribes the fetched WAV once recording auto-stops', async () => {
      const onResult = jest.fn();
      const stream = makeFakeStream();
      const transcribeFn = jest.fn().mockResolvedValue('근의 공식이 뭐야');
      const adapter = makeAdapter({
        fetchStatus: jest
          .fn()
          .mockResolvedValueOnce({ recording: true, had_speech: false })
          .mockResolvedValueOnce({ recording: true, had_speech: true })
          .mockResolvedValue({ recording: false, had_speech: true }),
        fetchAudio: jest.fn().mockResolvedValue('cm9ib3Qtd2F2'),
      });

      const ref = renderVoiceInput({
        onResult,
        stream,
        transcribeFn,
        robotMic: adapter,
        getTranscribeContext: () => '루트 25는 뭘까?',
      });
      await startWithTimers(ref);

      expect(adapter.startRecording).toHaveBeenCalledTimes(1);
      expect(ref.current.isListening).toBe(true);
      expect(stream.start).not.toHaveBeenCalled();

      await act(async () => {
        await jest.advanceTimersByTimeAsync(ROBOT_POLL_INTERVAL_MS * 4);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(adapter.fetchAudio).toHaveBeenCalledTimes(1);
      expect(transcribeFn).toHaveBeenCalledTimes(1);
      expect(transcribeFn).toHaveBeenCalledWith('cm9ib3Qtd2F2', '루트 25는 뭘까?');
      expect(onResult).toHaveBeenCalledWith('근의 공식이 뭐야');
      expect(ref.current.isListening).toBe(false);
    });

    it('does not transcribe a robot session that had no speech (30s cap)', async () => {
      const onResult = jest.fn();
      const transcribeFn = jest.fn();
      const adapter = makeAdapter({
        fetchStatus: jest.fn().mockResolvedValue({ recording: false, had_speech: false }),
      });

      const ref = renderVoiceInput({
        onResult,
        stream: makeFakeStream(),
        transcribeFn,
        robotMic: adapter,
      });
      await startWithTimers(ref);

      await act(async () => {
        await jest.advanceTimersByTimeAsync(ROBOT_POLL_INTERVAL_MS * 2);
      });

      expect(adapter.fetchAudio).not.toHaveBeenCalled();
      expect(transcribeFn).not.toHaveBeenCalled();
      expect(onResult).not.toHaveBeenCalled();
      expect(ref.current.isListening).toBe(false);
    });

    it('어댑터 시작 실패 + 기본값이면 폰 마이크로 폴백한다', async () => {
      const adapter = makeAdapter({
        startRecording: jest.fn().mockRejectedValue(new Error('pi down')),
      });
      const stream = makeFakeStream();

      const ref = renderVoiceInput({
        onResult: jest.fn(),
        stream,
        transcribeFn: jest.fn(),
        robotMic: adapter,
      });
      await startWithTimers(ref);

      expect(stream.start).toHaveBeenCalledTimes(1);
      expect(ref.current.mode).toBe('voice');
      expect(ref.current.isListening).toBe(true);
    });

    it('어댑터 시작 실패 + allowPhoneMicFallback:false 면 text_fallback 으로 간다', async () => {
      const adapter = makeAdapter({
        startRecording: jest.fn().mockRejectedValue(new Error('EBUSY')),
      });
      const stream = makeFakeStream();

      const ref = renderVoiceInput({
        onResult: jest.fn(),
        stream,
        transcribeFn: jest.fn(),
        robotMic: adapter,
        allowPhoneMicFallback: false,
      });
      await startWithTimers(ref);

      expect(ref.current.mode).toBe('text_fallback');
      expect(stream.start).not.toHaveBeenCalled();
    });

    it('stopListening discards the utterance and stops the robot recording', async () => {
      const onResult = jest.fn();
      const transcribeFn = jest.fn();
      const adapter = makeAdapter({
        fetchStatus: jest.fn().mockResolvedValue({ recording: true, had_speech: true }),
      });

      const ref = renderVoiceInput({
        onResult,
        stream: makeFakeStream(),
        transcribeFn,
        robotMic: adapter,
      });
      await startWithTimers(ref);

      await act(async () => {
        await ref.current.stopListening();
      });

      expect(adapter.stopRecording).toHaveBeenCalled();
      expect(transcribeFn).not.toHaveBeenCalled();
      expect(onResult).not.toHaveBeenCalled();
      expect(ref.current.isListening).toBe(false);
    });
  });
});

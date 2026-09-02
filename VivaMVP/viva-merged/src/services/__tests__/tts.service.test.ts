/**
 * Unit tests for tts.service 의 오디오 세션 모드 전환.
 *
 * 검증 대상은 iOS 라우팅이다: `allowsRecordingIOS: true` 는 오디오 카테고리를
 * PlayAndRecord 로 만들고, 그러면 출력이 스피커가 아니라 수화기(earpiece)로
 * 나가 TTS 가 아주 작게 들린다. 재생 경로는 false, 녹음 직전 준비 경로만
 * true 여야 한다.
 *
 * mock 객체는 팩토리 안에서 만든다 - jest.mock 은 import 위로 hoist 되므로
 * 바깥 const 를 참조하면 TDZ 에러가 난다.
 */
jest.mock('expo-av', () => {
  const statusCallbacks: ((status: any) => void)[] = [];
  return {
    Audio: {
      setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
      Sound: {
        createAsync: jest.fn().mockImplementation(() => ({
          sound: {
            getStatusAsync: jest.fn().mockResolvedValue({ isLoaded: true, durationMillis: 1000 }),
            setOnPlaybackStatusUpdate: jest.fn((cb: (s: any) => void) => {
              statusCallbacks.push(cb);
            }),
            playAsync: jest.fn().mockResolvedValue(undefined),
            stopAsync: jest.fn().mockResolvedValue(undefined),
            unloadAsync: jest.fn().mockResolvedValue(undefined),
          },
        })),
      },
    },
    __statusCallbacks: statusCallbacks,
  };
});

jest.mock('expo-file-system', () => ({
  cacheDirectory: 'file:///cache/',
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  EncodingType: { Base64: 'base64' },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockAv = require('expo-av');
// eslint-disable-next-line import/first
import {
  speak,
  stopSpeaking,
  setAudioSink,
  prepareAudioSessionForRecording,
} from '../tts.service';

const setAudioModeAsync = mockAv.Audio.setAudioModeAsync as jest.Mock;

describe('tts.service audio session mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAv.__statusCallbacks.length = 0;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ audioContent: 'ZmFrZS1tcDM=' }),
    }) as any;
  });

  it('plays TTS through the speaker (never in record mode)', async () => {
    const playback = speak('안녕');
    // 재생 완료 콜백이 등록될 때까지 마이크로태스크를 흘린다.
    for (let i = 0; i < 30 && mockAv.__statusCallbacks.length === 0; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
    expect(mockAv.__statusCallbacks).toHaveLength(1);
    mockAv.__statusCallbacks[0]({ isLoaded: true, didJustFinish: true });
    await playback;

    const recordingModeCalls = setAudioModeAsync.mock.calls
      .map(([mode]) => mode.allowsRecordingIOS)
      .filter((v) => v === true);
    expect(recordingModeCalls).toHaveLength(0);
    expect(setAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({ allowsRecordingIOS: false, playsInSilentModeIOS: true }),
    );
  });

  it('switches to record mode only when preparing for STT', async () => {
    await prepareAudioSessionForRecording();

    expect(setAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({ allowsRecordingIOS: true }),
    );
  });

  // 회귀: staysActiveInBackground: false 를 명시하면 expo-av 의 "명시된 키만
  // 덮어쓰기" 병합 규칙 때문에 디바이스판 backgroundKeepAlive 의 true 가 매
  // 발화마다 꺼진다 - 이 서비스는 그 키를 아예 안 건드려야 한다.
  it('setAudioModeAsync 호출 인자에 staysActiveInBackground 키가 없다', async () => {
    await prepareAudioSessionForRecording();

    const playback = speak('안녕');
    for (let i = 0; i < 30 && mockAv.__statusCallbacks.length === 0; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
    mockAv.__statusCallbacks[0]({ isLoaded: true, didJustFinish: true });
    await playback;

    expect(setAudioModeAsync.mock.calls.length).toBeGreaterThan(0);
    for (const [arg] of setAudioModeAsync.mock.calls) {
      expect('staysActiveInBackground' in arg).toBe(false);
    }
  });

  // 고정 발화(되묻기, 크롭 필러 등)는 매번 같은 문자열이다 - 합성 결과를
  // 캐시해 두 번째부터는 Google TTS 왕복이 없어야 한다.
  it('synthesizes a repeated short utterance only once', async () => {
    const finishPlayback = async (playback: Promise<void>, expected: number) => {
      for (let i = 0; i < 30 && mockAv.__statusCallbacks.length < expected; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      mockAv.__statusCallbacks[expected - 1]({ isLoaded: true, didJustFinish: true });
      await playback;
    };

    await finishPlayback(speak('책상에 문제가 여러 개 보이네! 지금 몇 번 문제 풀고 있어?'), 1);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await finishPlayback(speak('책상에 문제가 여러 개 보이네! 지금 몇 번 문제 풀고 있어?'), 2);
    expect(global.fetch).toHaveBeenCalledTimes(1); // 캐시 히트 - 재합성 없음
  });

  // AudioSink 주입(태스크 2): 합성 mp3 를 폰 스피커 대신 등록된 sink 로 보낸다.
  describe('AudioSink routing', () => {
    afterEach(() => {
      setAudioSink(null);
    });

    it('AudioSink 가 등록되면 폰 재생 대신 sink.play 로 간다', async () => {
      const play = jest.fn().mockResolvedValue(undefined);
      const onPlay = jest.fn();
      setAudioSink({ play, stop: jest.fn().mockResolvedValue(undefined) });

      await speak('안녕', onPlay);

      expect(play).toHaveBeenCalledWith('ZmFrZS1tcDM=', expect.any(Function));
      // 폰 경로(파일 쓰기/Sound 로드)는 안 탄다 - 기존 robot 케이스의 단언 유지
      expect(mockAv.Audio.Sound.createAsync).not.toHaveBeenCalled();
      // sink 는 재생 길이를 안 알려준다 - onPlay(0) 로 자막 추정 폴백을 태운다.
      expect(onPlay).toHaveBeenCalledWith(0);
    });

    // 자막-나레이션 싱크(2026-08-20): 자막 시계(onPlay)는 sink 가 "업로드
    // 끝, 곧 소리 난다"(onStarted)를 알린 시점에 시작해야 한다. 예전엔
    // sink.play 호출 직전에 무조건 불러서, mp3 업로드 시간(길이 비례)만큼
    // 자막이 나레이션을 앞섰다 - 긴 개념 설명에서 체감된 그 버그.
    it('sink 가 onStarted 를 부르면 그 시점에 onPlay 가 오고, 중복으로 오지 않는다', async () => {
      const onPlay = jest.fn();
      let releasePlay: () => void = () => {};
      const play = jest.fn().mockImplementation(
        (_b64: string, onStarted?: () => void) =>
          new Promise<void>((resolve) => {
            // 업로드 완료 신호 → 이 순간 자막이 시작돼야 한다 (재생 완료 전).
            onStarted?.();
            expect(onPlay).toHaveBeenCalledTimes(1);
            releasePlay = resolve;
          }),
      );
      setAudioSink({ play, stop: jest.fn().mockResolvedValue(undefined) });

      const playback = speak('개념 설명 문장', onPlay);
      for (let i = 0; i < 30 && play.mock.calls.length === 0; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      releasePlay();
      await playback;

      // 재생 완료 후 폴백이 또 부르면 자막 스케줄이 리셋된다 - 1회여야 한다.
      expect(onPlay).toHaveBeenCalledTimes(1);
      expect(onPlay).toHaveBeenCalledWith(0);
    });

    it('sink 가 onStarted 를 안 부르면 play 종료 후 폴백으로 onPlay 가 1회 온다', async () => {
      const onPlay = jest.fn();
      setAudioSink({
        play: jest.fn().mockResolvedValue(undefined), // onStarted 미호출 sink
        stop: jest.fn().mockResolvedValue(undefined),
      });

      await speak('업로드 실패 등으로 신호가 없던 발화', onPlay);

      // 실패해도 자막은 내용을 전달해야 한다 (디바이스판 "자막이 전달" 정책).
      expect(onPlay).toHaveBeenCalledTimes(1);
    });

    it('sink.play 가 throw 하면 폰 스피커로 폴백한다', async () => {
      setAudioSink({ play: jest.fn().mockRejectedValue(new Error('pi down')), stop: jest.fn() });

      const playback = speak('폴백 문장');
      for (let i = 0; i < 30 && mockAv.__statusCallbacks.length === 0; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      expect(mockAv.__statusCallbacks).toHaveLength(1);
      mockAv.__statusCallbacks[0]({ isLoaded: true, didJustFinish: true });
      await playback;

      expect(mockAv.Audio.Sound.createAsync).toHaveBeenCalled();
    });

    it('stopSpeaking 은 등록된 sink.stop 을 부른다', async () => {
      const stop = jest.fn().mockResolvedValue(undefined);
      setAudioSink({ play: jest.fn().mockResolvedValue(undefined), stop });

      await stopSpeaking();

      expect(stop).toHaveBeenCalled();
    });
  });
});

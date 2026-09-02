/**
 * Voice input hook — 발화 전체 녹음 → Gemini 직접 전사 (charing_viva 방식).
 *
 * 변천사: 온디바이스 @react-native-voice(앞/뒤 씹힘) → Google Cloud STT
 * REST(한국어 수학 발화 인식률 부족) → 현재. react-native-live-audio-stream
 * 으로 마이크 PCM 을 직접 받아:
 *   1) 자동 종료: 청크별 RMS 로 말 시작/침묵을 감지, 말 시작 후
 *      VOICE_SILENCE_FINALIZE_MS 동안 침묵이면 발화 종료로 판정.
 *   2) 전사: 발화 전체 WAV 를 Gemini 에 inline 오디오로 보내 전사,
 *      onResult 를 정확히 한 번 호출.
 * 실시간 자막(중간 인식)은 없다 — 정확도를 위해 의도적으로 제거.
 * partialText 는 청취 중 '' 이며, 전사 완료 순간 최종 문장으로 한 번 채워진다.
 * 오디오 전체를 한 번에 전사하므로 앞/뒤 잘림이 구조적으로 없다.
 *
 * 공개 인터페이스(mode/isListening/partialText/...)는 이전과 동일해서
 * ConversationScreen 은 수정 없이 그대로 동작한다. STT 시작 실패·권한 거부
 * 시 text_fallback 으로 전환하는 정책도 유지.
 *
 * 마이크 스트림 공유 주의: LiveAudioStream 은 useWakeWord 와 공유하는
 * 싱글턴이다. `on('data')` 는 removeAllListeners 를 먼저 부르므로 누적되지
 * 않고, 대신 **마지막에 등록한 쪽이 스트림을 독점**한다 - 그래서 청취를
 * 시작할 때마다 다시 등록해야 한다(안 하면 상대 훅에 빼앗긴 채로 남는다).
 * 넘어온 청크는 sessionActiveRef 로 한 번 더 게이트한다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import Voice from '@react-native-voice/voice';
import { prepareAudioSessionForRecording } from '../services/tts.service';
import { transcribeWavWithGemini } from '../services/geminiStt.service';
import { postProcessSTT } from '../utils/sttPostProcessor';
import { concatPcmChunks, pcmRms, pcmToWavBase64 } from '../utils/wavEncode';

const STT_SAMPLE_RATE = 16000;

// 네이티브 모듈: 설치 전/테스트 환경에서 require 실패 가능 → try/catch.
let LiveAudioStream: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  LiveAudioStream = require('react-native-live-audio-stream').default;
} catch {
  LiveAudioStream = null;
}

export type VoiceInputMode = 'voice' | 'text_fallback';

/** 로봇 마이크 폴링 응답 - 훅이 필요로 하는 최소 구조. Pi 응답
 * (PiRecordStatus)은 이와 구조적으로 맞아 매핑 없이 그대로 쓸 수 있다. */
export interface RobotMicStatus {
  recording: boolean;
  silent_ms?: number;
  had_speech: boolean;
}

/** 훅이 로봇(Pi 등) 마이크를 조작하는 데 필요한 전부. 훅은 이 인터페이스만
 * 알고 Pi 를 직접 모른다 - 폰 단독판은 이 옵션 자체를 안 넘기면 된다
 * (화면 분리, Task 3). */
export interface RobotMicAdapter {
  /** 녹음 시작. throw 시 폰 마이크 폴백 여부는 allowPhoneMicFallback 이 결정. */
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  fetchStatus: () => Promise<RobotMicStatus>;
  /** 발화 전체 WAV base64. */
  fetchAudio: () => Promise<string>;
}

export interface UseVoiceInputOptions {
  /** Called with the final recognized voice transcript, or with whatever
   * text the caller passes to `submitText` in fallback mode. */
  onResult: (text: string) => void;
  /** Injectable for tests: LiveAudioStream 호환 객체 (init/on/start/stop). */
  audioStreamModule?: any;
  /** Injectable for tests: WAV base64 → 전사 텍스트. 기본은 Gemini 전사. */
  transcribeFn?: (wavBase64: string, context?: string) => Promise<string>;
  /** 전사 시점에 호출돼 전사 힌트(직전 튜터 질문)를 공급한다. "오" 를 감탄사가
   * 아닌 숫자 5 로 받아쓰게 하는 문맥 - 없으면 기존과 동일하게 무맥락 전사. */
  getTranscribeContext?: () => string | undefined;
  /** 있으면 폰 마이크 대신 이 어댑터로 듣는다 (D-33). 녹음과 침묵 감지는
   * 어댑터 구현체(Pi 서버 등)가 하고(스트리밍이 없어 폰 RMS 감지는 불가),
   * 이 훅은 fetchStatus() 를 폴링하다 종료를 보면 fetchAudio() 로 WAV 를
   * 받아 같은 전사 파이프라인에 태운다. 어댑터 시작이 실패하면
   * allowPhoneMicFallback 여부에 따라 폰 마이크로 폴백하거나 text_fallback. */
  robotMic?: RobotMicAdapter | null;
  /** robotMic 시작 실패 시 폰 마이크로 이어갈지. 기본 true(기존 동작 유지 -
   * 폰 단독판). false 면 text_fallback 으로 조용히 넘어가지 않는다 - 디바이스
   * 연동판은 마이크가 로봇 전용이라 폰 마이크로 새는 게 정책 위반이다(Task 6). */
  allowPhoneMicFallback?: boolean;
  /** (구버전 호환) 더 이상 인식에는 안 쓰고, 대화 진입 시 wake word 가 잡고
   * 있을 수 있는 온디바이스 인식기를 stop 하는 데만 쓴다. */
  voiceModule?: typeof Voice;
  /** 유지: 호출부 호환용. 클라우드 STT 는 ko-KR 고정. */
  locale?: string;
}

export interface UseVoiceInputResult {
  mode: VoiceInputMode;
  isListening: boolean;
  /** True from the moment speech ends (mic already off) until the Gemini
   * transcription call resolves and onResult fires. Callers should treat
   * this like "still busy with the previous utterance" - e.g. gate any
   * auto-restart-listening logic on `!isProcessing`, otherwise the mic
   * flips back on mid-transcription and then off again once the result
   * lands, which looks like the button flickering. */
  isProcessing: boolean;
  /** 말이 멈춘 것으로 보이나 마이크는 아직 열려 있는 구간. 로봇 눈을
   * '다 들었다'(processing)로 바꿔 턴 교대를 유도하는 용도다 - 학생이
   * 그걸 보고 스스로 말을 멈추면 마감 대기의 체감이 사라진다. 이어 말하면
   * 다시 false 가 되고 마감 타이머도 리셋된다.
   * 청취 중이 아니면 항상 false (내부 플래그와 무관하게 게이트된다). */
  isSettling: boolean;
  /** Live partial transcript while listening (voice mode only). */
  partialText: string;
  /** Live mic input level while listening, 0~1 (raw RMS, unclamped above
   * 1 in practice). No live transcript exists (see file header) - this is
   * for a volume-reactive UI indicator instead of text. 0 when not
   * listening. */
  micLevel: number;
  errorMessage: string | undefined;
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
  submitText: (text: string) => void;
  switchToTextFallback: () => void;
  switchToVoice: () => void;
}

/** 청크마다(초당 ~20회) 로그를 찍는다. 원인 규명 끝났으니 기본 off -
 * 켜두면 로그가 브릿지를 계속 타서 그 자체가 지연에 기여하고, 세션이 끝난
 * 뒤에도 호출어 오디오가 이 핸들러로 흘러들어와 계속 찍힌다. */
const VOICE_DEBUG = false;

/** 말 시작 후 이 시간 동안 침묵이면 발화 종료로 판단해 최종 제출.
 * 1500ms 는 "생각하며 뜸 들이는" 학생을 중간에 끊었다(실기기 피드백
 * 2026-07-30) - 3000ms 로 올렸다가 2000ms 로 내렸다(2026-08-07). 3000 을
 * 지루하게 만든 건 길이보다 **무신호**였고, 그건 isSettling → 로봇 눈
 * 신호로 따로 푼다. 이 값은 그 뒤 남은 체감만 깎는 몫이다.
 * Pi 쪽 SILENCE_MS 와 같은 값을 유지한다(로봇 마이크 경로의 대응물). */
export const VOICE_SILENCE_FINALIZE_MS = 2000;
/** 이만큼 조용하면 "말이 끝난 것 같다"로 보고 신호를 낸다(마이크는 아직
 * 열려 있다). 마감(2000)보다 훨씬 짧아 신호 후에도 이어 말할 여유가 남는다. */
export const SETTLING_SILENCE_MS = 600;
/** 이 RMS(0~1) 이상이면 "말하는 중"으로 판단. 조용한 방 기준 잡음 ~0.003. */
export const SPEECH_RMS_THRESHOLD = 0.015;
/** 한 번의 청취가 이보다 길어지면 강제 종료(마이크가 영원히 열려 있는 것 방지). */
export const MAX_UTTERANCE_MS = 50000;
/** 로봇 마이크 모드에서 Pi /record/status 를 이 간격으로 폴링한다. 서버 측
 * 침묵 판정(3초)에 폴링 지연이 더해지는 구조라 너무 길면 응답 개시가 늦는다.
 * 500 -> 200 (Track B): 종료 판정 후 앱이 그걸 알아채는 데까지 걸리는
 * 꼬리 지연을 줄인다. */
export const ROBOT_POLL_INTERVAL_MS = 200;
/** 폴링이 이만큼 연속 실패하면(Wi-Fi 단절 등) 이번 청취를 무음 종료한다 -
 * 화면의 자동 재청취가 다음 시도를 하고, 그 시작도 실패하면 폰 마이크 폴백. */
const ROBOT_POLL_MAX_FAILS = 6;

const LIVE_AUDIO_OPTIONS = {
  sampleRate: STT_SAMPLE_RATE,
  channels: 1,
  bitsPerSample: 16,
  audioSource: 6, // Android VOICE_RECOGNITION
  bufferSize: 4096,
};

export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputResult {
  const {
    onResult,
    audioStreamModule = LiveAudioStream,
    transcribeFn = transcribeWavWithGemini,
    getTranscribeContext,
    voiceModule = Voice,
    robotMic = null,
    allowPhoneMicFallback = true,
  } = options;

  const [mode, setMode] = useState<VoiceInputMode>('voice');
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  // 내부 플래그. 밖으로는 isListening 으로 게이트해서 내보내므로(반환문 참고)
  // 종료 경로마다 리셋을 심을 필요가 없다 - 그렇게 하면 나중에 생기는
  // 여섯 번째 종료 경로에서 반드시 새어나간다.
  const [settled, setSettled] = useState(false);
  const [partialText, setPartialText] = useState('');
  const [micLevel, setMicLevel] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();

  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const robotMicRef = useRef(robotMic);
  robotMicRef.current = robotMic;
  const allowPhoneMicFallbackRef = useRef(allowPhoneMicFallback);
  allowPhoneMicFallbackRef.current = allowPhoneMicFallback;
  // 렌더마다 갱신 - finalize 시점(비동기)에 최신 대화 이력을 읽어야 한다.
  const getTranscribeContextRef = useRef(getTranscribeContext);
  getTranscribeContextRef.current = getTranscribeContext;

  // --- 세션 상태 ------------------------------------------------------------
  const sessionActiveRef = useRef(false); // 'data' 게이트 (등록된 리스너는 영구)
  const hasFiredRef = useRef(false); // onResult 는 세션당 정확히 1회
  const isStartingRef = useRef(false); // startListening 재진입 가드(자동 재청취가 렌더마다 호출)
  const isListeningRef = useRef(false);
  const chunksRef = useRef<string[]>([]); // base64 PCM 누적
  const hasSpeechRef = useRef(false); // RMS 임계 초과가 한 번이라도 있었나
  const lastVoiceAtRef = useRef(0);
  const sessionStartAtRef = useRef(0);
  const finalizingRef = useRef(false);
  const debugChunkCountRef = useRef(0); // DEBUG instrumentation, see startListening
  const settledRef = useRef(false); // 청크마다(초당 ~20회) setState 하지 않기 위한 게이트

  const updateSettled = useCallback((value: boolean) => {
    if (settledRef.current === value) return;
    settledRef.current = value;
    setSettled(value);
  }, []);

  const setListening = useCallback((value: boolean) => {
    isListeningRef.current = value;
    setIsListening(value);
  }, []);

  const stopStream = useCallback(() => {
    try {
      audioStreamModule?.stop?.();
    } catch {
      // best-effort
    }
  }, [audioStreamModule]);

  /** 발화 종료: 스트림을 멈추고 발화 전체 WAV 를 Gemini 로 전사해 onResult 1회 호출. */
  const finalizeResult = useCallback(async () => {
    if (hasFiredRef.current || finalizingRef.current) return;
    finalizingRef.current = true;
    hasFiredRef.current = true;
    sessionActiveRef.current = false;
    stopStream();
    // 순서 중요: isProcessing 을 먼저 올린다. 이 앱은 legacy root(new arch off)
    // 라 네이티브 이벤트 콜백 안의 setState 가 배치되지 않는다 - 반대 순서면
    // "isListening=false 인데 isProcessing 은 아직 false" 인 커밋이 한 번
    // 생기고, 화면의 자동 재청취 effect 가 바로 그 커밋에서 조건을 만족해
    // 전사 도중에 마이크를 다시 켜버렸다(학생 눈엔 대답이 끝났는데 입력
    // 화면이 한 번 더 깜빡이고 로딩 닷이 늦게 뜨는 것으로 보인다).
    setIsProcessing(true);
    setListening(false);
    setMicLevel(0);

    try {
      const pcm = concatPcmChunks(chunksRef.current);
      chunksRef.current = [];
      // 말이 한 번도 없었으면(= MAX_UTTERANCE_MS 로 강제 종료된 무음 세션)
      // 전사하지 않는다. 무음 WAV 를 보내봐야 결과는 빈 문자열인데 요금은
      // 그대로 나가고, 화면의 자동 재청취가 다시 켜서 무한 반복이 된다.
      if (pcm.length === 0 || !hasSpeechRef.current) return;
      const wav = pcmToWavBase64(pcm, STT_SAMPLE_RATE);
      const raw = await transcribeFn(wav, getTranscribeContextRef.current?.());
      const text = raw.trim().length > 0 ? postProcessSTT(raw.trim()) : '';
      if (text.length > 0) {
        setPartialText(text);
        onResultRef.current(text);
      }
      // 빈 결과(잡음만 잡힘)면 조용히 종료 — 화면의 자동 재청취 effect 가
      // isListening=false 를 보고 다음 청취를 다시 시작한다.
    } catch (err) {
      console.error('[VoiceInput] transcription failed:', err);
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setMode('text_fallback');
    } finally {
      finalizingRef.current = false;
      setIsProcessing(false);
    }
  }, [stopStream, setListening, transcribeFn]);

  /** 로봇 마이크 발화 종료: Pi 에서 WAV 를 받아 폰 경로와 같은 전사
   * 파이프라인(transcribeFn → postProcessSTT → onResult 1회)에 태운다.
   * hadSpeech=false(무음 세션)면 폰 경로처럼 전사 없이 조용히 끝난다. */
  const finalizeRobotResult = useCallback(
    async (hadSpeech: boolean) => {
      if (hasFiredRef.current || finalizingRef.current) return;
      finalizingRef.current = true;
      hasFiredRef.current = true;
      sessionActiveRef.current = false;
      // 순서 중요: finalizeResult 와 동일 - isProcessing 먼저 (자동 재청취 가드).
      setIsProcessing(true);
      setListening(false);

      try {
        if (!hadSpeech) return;
        const wav = await robotMicRef.current!.fetchAudio();
        const raw = await transcribeFn(wav, getTranscribeContextRef.current?.());
        const text = raw.trim().length > 0 ? postProcessSTT(raw.trim()) : '';
        if (text.length > 0) {
          setPartialText(text);
          onResultRef.current(text);
        }
      } catch (err) {
        console.error('[VoiceInput] robot transcription failed:', err);
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setMode('text_fallback');
      } finally {
        finalizingRef.current = false;
        setIsProcessing(false);
      }
    },
    [setListening, transcribeFn],
  );

  /** 로봇 마이크 청취 시작. Pi 녹음을 켜고 /record/status 폴링 루프를 띄운다.
   * 시작 실패 시 false - 호출부(startListening)가 폰 마이크로 폴백한다. */
  const startRobotListening = useCallback(async (): Promise<boolean> => {
    if (!robotMicRef.current) return false;
    try {
      await robotMicRef.current.startRecording();
    } catch (err) {
      console.warn('[VoiceInput] robot mic startRecording failed - falling back to phone mic:', err);
      return false;
    }

    setErrorMessage(undefined);
    setPartialText('');
    setMicLevel(0); // Pi 는 스트리밍이 없어 실시간 레벨도 없다
    hasFiredRef.current = false;
    finalizingRef.current = false;
    hasSpeechRef.current = false;
    updateSettled(false);
    chunksRef.current = [];
    sessionStartAtRef.current = Date.now();
    sessionActiveRef.current = true;
    setListening(true);
    setMode('voice');

    void (async () => {
      let fails = 0;
      while (sessionActiveRef.current && !hasFiredRef.current) {
        await new Promise<void>((r) => setTimeout(r, ROBOT_POLL_INTERVAL_MS));
        if (!sessionActiveRef.current || hasFiredRef.current) return;
        try {
          const status = await robotMicRef.current!.fetchStatus();
          fails = 0;
          updateSettled((status.silent_ms ?? 0) >= SETTLING_SILENCE_MS);
          if (!status.recording) {
            // Pi 가 침묵(또는 30초 상한)으로 스스로 멈췄다 - 발화 종료.
            void finalizeRobotResult(status.had_speech);
            return;
          }
        } catch (err) {
          fails += 1;
          if (fails >= ROBOT_POLL_MAX_FAILS) {
            console.warn(
              '[VoiceInput] robot status polling kept failing - ending this listen:',
              err,
            );
            void finalizeRobotResult(false);
            return;
          }
        }
      }
    })();

    return true;
  }, [setListening, finalizeRobotResult, updateSettled]);

  /** PCM 청크 수신: 누적 + RMS 로 말 시작/침묵 판정. */
  const handleChunk = useCallback(
    (base64Chunk: string) => {
      debugChunkCountRef.current += 1;
      if (debugChunkCountRef.current <= 5 || debugChunkCountRef.current % 20 === 0) {
        VOICE_DEBUG &&
          console.log(
            '[VoiceInput][DEBUG] handleChunk #',
            debugChunkCountRef.current,
            'sessionActive=',
            sessionActiveRef.current,
            'hasFired=',
            hasFiredRef.current,
            'chunkLen=',
            base64Chunk?.length,
          );
      }
      if (!sessionActiveRef.current || hasFiredRef.current) return;
      chunksRef.current.push(base64Chunk);

      const now = Date.now();
      const rms = pcmRms(base64Chunk);
      if (debugChunkCountRef.current <= 5 || debugChunkCountRef.current % 20 === 0) {
        VOICE_DEBUG &&
          console.log('[VoiceInput][DEBUG] rms=', rms, 'threshold=', SPEECH_RMS_THRESHOLD);
      }
      setMicLevel(rms);
      if (rms >= SPEECH_RMS_THRESHOLD) {
        hasSpeechRef.current = true;
        lastVoiceAtRef.current = now;
      }
      updateSettled(
        hasSpeechRef.current &&
          now - lastVoiceAtRef.current >= SETTLING_SILENCE_MS,
      );

      const tooLong = now - sessionStartAtRef.current > MAX_UTTERANCE_MS;
      const silentLongEnough =
        hasSpeechRef.current && now - lastVoiceAtRef.current >= VOICE_SILENCE_FINALIZE_MS;

      if (silentLongEnough || tooLong) {
        void finalizeResult();
      }
    },
    [finalizeResult, updateSettled],
  );
  const handleChunkRef = useRef(handleChunk);
  handleChunkRef.current = handleChunk;

  useEffect(() => {
    return () => {
      // 언마운트: 늦게 도착하는 결과가 죽은 화면으로 onResult 하지 못하게.
      hasFiredRef.current = true;
      sessionActiveRef.current = false;
      stopStream();
      // 청취 중 화면 이탈이면 로봇 녹음이 30초 상한까지 돌 필요 없다.
      robotMicRef.current?.stopRecording().catch(() => {});
    };
  }, [stopStream]);

  const startListening = useCallback(async () => {
    // DEBUG instrumentation (temporary - remove once "voice input still
    // doesn't work" is root-caused): logs every boundary in the mic-start
    // pipeline so a real-device repro tells us exactly which step fails,
    // instead of guessing another fix blind.
    VOICE_DEBUG &&
      console.log(
        '[VoiceInput][DEBUG] startListening() called. isStarting=',
        isStartingRef.current,
        'isListening=',
        isListeningRef.current,
        'Platform=',
        Platform.OS,
      );
    if (isStartingRef.current || isListeningRef.current) {
      VOICE_DEBUG && console.log('[VoiceInput][DEBUG] bailing early - already starting/listening.');
      return;
    }
    isStartingRef.current = true;

    try {
      // 로봇 마이크 모드: 폰 마이크 준비(권한/오디오 세션/스트림) 없이 Pi
      // 녹음을 켠다. 시작이 실패하면 아래 폰 마이크 경로로 그대로 폴백.
      if (robotMicRef.current) {
        const robotStarted = await startRobotListening();
        if (robotStarted) return;
        if (!allowPhoneMicFallbackRef.current) {
          // 디바이스 연동판: 마이크는 로봇 전용 - 폰 마이크로 조용히 잇지 않는다.
          setMode('text_fallback');
          return;
        }
      }

      const isIOSSimulator =
        Platform.OS === 'ios' &&
        (typeof FileSystem !== 'undefined' && FileSystem.cacheDirectory
          ? FileSystem.cacheDirectory.includes('CoreSimulator')
          : false);
      VOICE_DEBUG &&
        console.log(
          '[VoiceInput][DEBUG] isIOSSimulator=',
          isIOSSimulator,
          'cacheDirectory=',
          FileSystem?.cacheDirectory,
        );
      if (isIOSSimulator) {
        console.log('[VoiceInput] Simulator detected - falling back to text input.');
        setMode('text_fallback');
        return;
      }

      VOICE_DEBUG &&
        console.log('[VoiceInput][DEBUG] audioStreamModule present?', !!audioStreamModule);
      if (!audioStreamModule) {
        console.warn('[VoiceInput] live-audio-stream unavailable - falling back to text input.');
        setMode('text_fallback');
        return;
      }

      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          {
            title: '마이크 권한',
            message: 'VIVA가 음성 튜터링을 위해 마이크를 사용합니다.',
            buttonPositive: '허용',
            buttonNegative: '거부',
          },
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          console.warn('[VoiceInput] RECORD_AUDIO permission denied - falling back to text input.');
          setErrorMessage('마이크 권한이 거부되었습니다. 설정에서 허용해주세요.');
          setMode('text_fallback');
          return;
        }
      }

      // wake word 등이 온디바이스 인식기/마이크를 잡고 있으면 놓게 한다.
      VOICE_DEBUG && console.log('[VoiceInput][DEBUG] calling voiceModule.stop()...');
      await voiceModule.stop().catch((e) => {
        VOICE_DEBUG &&
          console.log('[VoiceInput][DEBUG] voiceModule.stop() rejected (swallowed):', e);
      });
      VOICE_DEBUG && console.log('[VoiceInput][DEBUG] voiceModule.stop() done.');
      // TTS 재생 중이면 끊고 녹음 가능한 오디오 세션으로 전환. 반드시 완료를
      // 기다린 후 네이티브 레코더를 시작해야 한다 - 이전엔 fire-and-forget으로
      // 호출하고 고정 300ms만 기다렸는데, 실기기에서 stopSpeaking()+
      // setAudioModeAsync(allowsRecordingIOS)가 그보다 오래 걸리면 iOS가 아직
      // 녹음 모드로 전환되기 전에 레코더가 시작돼 마이크 세션은 열리지만
      // (isListening=true, UI는 정상 표시) 실제 오디오는 하나도 안 잡히는
      // 문제가 있었다 (RMS가 계속 0 → 파형이 안 움직이고 아무 것도 인식 안 됨).
      VOICE_DEBUG &&
        console.log('[VoiceInput][DEBUG] calling prepareAudioSessionForRecording()...');
      await prepareAudioSessionForRecording();
      VOICE_DEBUG && console.log('[VoiceInput][DEBUG] prepareAudioSessionForRecording() done.');
      // 오디오 세션 전환이 실제 하드웨어에 반영될 짧은 여유.
      await new Promise<void>((resolve) => setTimeout(resolve, 150));

      setErrorMessage(undefined);
      setPartialText('');
      setMicLevel(0);
      hasFiredRef.current = false;
      finalizingRef.current = false;
      chunksRef.current = [];
      hasSpeechRef.current = false;
      updateSettled(false);
      lastVoiceAtRef.current = 0;
      sessionStartAtRef.current = Date.now();
      debugChunkCountRef.current = 0;

      VOICE_DEBUG &&
        console.log('[VoiceInput][DEBUG] calling audioStreamModule.init()...', LIVE_AUDIO_OPTIONS);
      audioStreamModule.init(LIVE_AUDIO_OPTIONS);
      // 매번 등록한다. LiveAudioStream.on() 은 removeAllListeners('data') 를 먼저
      // 부르고 새로 붙이므로 누적이 애초에 불가능하고(라이브러리 소스 참고),
      // 대신 **마지막에 부른 쪽이 스트림을 독점**한다. 1회만 등록하면 호출어
      // 훅이 나중에 on() 을 부른 뒤로 이쪽이 오디오를 못 받는다 - 그 반대
      // 방향이 실기기 호출어 무반응의 원인이었다(useWakeWord 주석 참고).
      audioStreamModule.on('data', (b64: string) => handleChunkRef.current(b64));
      VOICE_DEBUG && console.log('[VoiceInput][DEBUG] calling audioStreamModule.start()...');
      audioStreamModule.start();
      VOICE_DEBUG && console.log('[VoiceInput][DEBUG] start() done - waiting for data chunks now.');

      sessionActiveRef.current = true;
      setListening(true);
      setMode('voice');
    } catch (err) {
      sessionActiveRef.current = false;
      console.error('[VoiceInput] start failed:', err);
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setMode('text_fallback');
    } finally {
      isStartingRef.current = false;
    }
  }, [audioStreamModule, voiceModule, setListening]);

  const stopListening = useCallback(async () => {
    // 수동 중단 = 제출 없이 이 세션을 끝낸다.
    hasFiredRef.current = true;
    sessionActiveRef.current = false;
    chunksRef.current = [];
    stopStream();
    // 로봇 쪽 녹음도 끊는다 (발화 폐기 - WAV 는 가져가지 않는다).
    robotMicRef.current?.stopRecording().catch(() => {});
    setListening(false);
    setIsProcessing(false);
    setMicLevel(0);
  }, [stopStream, setListening]);

  const submitText = useCallback(
    (text: string) => {
      onResult(text);
    },
    [onResult],
  );

  const switchToTextFallback = useCallback(() => {
    setMode('text_fallback');
  }, []);

  const switchToVoice = useCallback(() => {
    setMode('voice');
  }, []);

  return {
    mode,
    isListening,
    isProcessing,
    isSettling: isListening && settled,
    partialText,
    micLevel,
    errorMessage,
    startListening,
    stopListening,
    submitText,
    switchToTextFallback,
    switchToVoice,
  };
}

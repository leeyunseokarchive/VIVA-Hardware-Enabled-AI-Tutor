/**
 * On-device wake-word ("비바야") detection — openWakeWord 전용.
 *
 * 마이크 PCM 을 react-native-live-audio-stream 으로 받아 OpenWakeWordEngine
 * (src/lib/openWakeWord.ts)에 흘려보낸다. STT 폴백은 사용하지 않는다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';

export interface PiWakeStream {
  start(onPcm: (base64: string) => void): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

// 네이티브 모듈. 설치 전이면 require 가 실패할 수 있어 try/catch 로 감싼다.
let LiveAudioStream: any = null;
let OpenWakeWordEngine: any = null;
let OWW_ASSETS: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  LiveAudioStream = require('react-native-live-audio-stream').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const oww = require('../lib/openWakeWord');
  OpenWakeWordEngine = oww.OpenWakeWordEngine;
  OWW_ASSETS = oww.OWW_ASSETS;
} catch {
  LiveAudioStream = null;
  OpenWakeWordEngine = null;
}

const LIVE_AUDIO_OPTIONS = {
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  audioSource: 6, // Android VOICE_RECOGNITION
  bufferSize: 4096,
};

interface UseWakeWordResult {
  isListening: boolean;
  isSimulatorMock: boolean;
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
}

export interface WakeWordOptions {
  /** 있으면 폰 마이크 대신 Pi PCM 스트림을 엔진에 물린다. start 실패 시 폰 마이크로 폴백. */
  piStream?: PiWakeStream;
}

export function useWakeWord(
  onDetected: () => void,
  options: WakeWordOptions = {},
): UseWakeWordResult {
  const [isListening, setIsListening] = useState(false);
  const activeRef = useRef(false);
  const engineRef = useRef<any>(null);

  const onDetectedRef = useRef(onDetected);
  onDetectedRef.current = onDetected;
  const piStreamRef = useRef(options.piStream);
  piStreamRef.current = options.piStream;

  /** 오디오 피드만 내리고 엔진은 유지한다(세션 간 재사용).
   *
   * 예전엔 매번 엔진을 파괴하고 startListening 이 새로 만들었다 - JSI 수리
   * (≤1.5초) + ONNX 세션 3개 로드(3.2MB) + 2초 버퍼 재충전이 홈 복귀마다
   * 들어 "비바야" 가 ~15초 무반응이었다 (실기기 2026-08-12). 엔진은 앱 수명
   * 동안 1개, 세션 중엔 running=false 로 판정만 끊는다.
   */
  const suspend = useCallback(() => {
    try {
      LiveAudioStream?.stop?.();
    } catch {
      /* ignore */
    }
    try {
      engineRef.current?.stop?.();
    } catch {
      /* ignore */
    }
  }, []);

  /** 완전 해제 - 언마운트 전용, 그리고 startListening 실패 시 자가치유용.
   *
   * **ONNX 세션 해제를 기다리지 않는다.** `await engine.release()` 로 하면,
   * release() 는 세션 3개를 순차로 release 하고 feedBase64 는 runDetection() 을
   * await 없이 띄운다 - 즉 추론이 도는 중에 그 세션을 해제하러 들어갈 수 있고,
   * onnxruntime 에서 그건 그대로 멈춰버린다. 그러면 그걸 await 하던
   * stopListening 이 영영 resolve 하지 않고, 그걸 await 하는 촬영 진입점
   * (App.tsx 의 beginCapture)이 첫 줄에서 막혀 **버튼을 눌러도 아무 일도 안
   * 일어난다** (실기기 2026-07-29: 풀이 후 홈 복귀 상태에서 재현).
   *
   * engineRef 를 비워 재사용 경로(startListening 의 `if (engine)`)를 다시
   * 타지 않게 한다 - 안 그러면 재사용 중 실패한 고장난 엔진을 계속 붙잡고
   * 재시도할 때마다 같은 이유로 죽는다. */
  const destroy = useCallback(() => {
    suspend();
    const engine = engineRef.current;
    engineRef.current = null;
    engine?.release?.().catch(() => {
      /* ignore */
    });
  }, [suspend]);

  useEffect(() => {
    return () => {
      activeRef.current = false;
      destroy();
    };
  }, [destroy]);

  const startListening = useCallback(async () => {
    if (activeRef.current) return;
    console.log('[WakeWord] Starting openWakeWord listener ("비바야")...');
    activeRef.current = true;
    try {
      // 안드로이드 마이크(RECORD_AUDIO) 런타임 권한.
      if (Platform.OS === 'android') {
        const alreadyGranted = await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        );
        if (!alreadyGranted) {
          const result = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
            {
              title: '마이크 권한',
              message: 'VIVA를 "비바야"로 부르려면 마이크 권한이 필요해.',
              buttonPositive: '허용',
              buttonNegative: '거부',
            },
          );
          if (result !== PermissionsAndroid.RESULTS.GRANTED) {
            console.warn('[WakeWord] RECORD_AUDIO permission denied - wake word disabled.');
            activeRef.current = false;
            setIsListening(false);
            return;
          }
        }
      }

      if (!OpenWakeWordEngine || !LiveAudioStream || !OWW_ASSETS) {
        console.warn(
          '[WakeWord] openWakeWord/live-audio-stream not available - wake word disabled.',
        );
        activeRef.current = false;
        setIsListening(false);
        return;
      }

      // 엔진 재사용: 있으면 버퍼만 비우고 재시작, 없으면(첫 기동) 생성+로드.
      let engine = engineRef.current;
      if (engine) {
        engine.reset?.();
      } else {
        engine = new OpenWakeWordEngine({
          onDetected: () => onDetectedRef.current(),
          onError: (err: unknown) => console.warn('[WakeWord] openWakeWord runtime error:', err),
        });
        await engine.load(OWW_ASSETS.mel, OWW_ASSETS.emb, OWW_ASSETS.ww);
        engineRef.current = engine;
      }
      engine.start();

      // Pi PCM 스트림이 주어졌으면 그쪽을 먼저 시도한다. 성공하면 폰 마이크
      // (LiveAudioStream)는 아예 켜지 않는다 - Pi 마이크가 유일한 소스.
      // 실패하면 기존 폰 마이크 경로 그대로.
      const piStream = piStreamRef.current;
      if (piStream) {
        try {
          await piStream.start((b64: string) => {
            const eng = engineRef.current;
            if (eng) eng.feedBase64(b64);
          });
          setIsListening(true);
          console.log('[WakeWord] openWakeWord engine started (Pi PCM source).');
          return;
        } catch (err) {
          console.warn('[WakeWord] Pi wake stream failed - falling back to phone mic:', err);
        }
      }

      LiveAudioStream.init(LIVE_AUDIO_OPTIONS);
      // 매번 등록한다. LiveAudioStream.on() 은 내부적으로
      // `EventEmitter.removeAllListeners('data')` 를 먼저 부르고 새로 붙이므로
      // (node_modules/react-native-live-audio-stream/index.js) 누적이 애초에
      // 불가능하다 - 대신 **마지막에 부른 쪽이 스트림을 독점**한다.
      //
      // 예전엔 "누적 방지" 로 1회만 등록했는데, 그러면 대화 중
      // useVoiceInput 이 on() 을 부르는 순간 이 리스너가 제거되고, 대화가
      // 끝나 홈으로 돌아와도 가드에 걸려 다시 등록되지 않았다. 엔진은 떠
      // 있는데 오디오가 한 조각도 안 들어와서 "비바야" 를 불러도 아무 반응이
      // 없었다 (실기기 2026-07-29: idle 복귀 후 [openWakeWord] peak score 로그가
      // 한 줄도 안 찍히는 것으로 확인).
      LiveAudioStream.on('data', (b64: string) => {
        const eng = engineRef.current;
        if (eng) eng.feedBase64(b64);
      });
      LiveAudioStream.start();

      setIsListening(true);
      console.log('[WakeWord] openWakeWord engine started.');
    } catch (err) {
      console.error('[WakeWord] Failed to start wake word listener:', err);
      activeRef.current = false;
      // suspend() 가 아니라 destroy() - 재사용 경로에서 실패했으면 그 엔진은
      // 고장난 채 engineRef 에 남아, 다음 startListening 마다 같은 실패를
      // 반복한다. engineRef 를 비워 다음 시도가 새로 만들게 한다.
      destroy();
      setIsListening(false);
    }
  }, [destroy]);

  const stopListening = useCallback(async () => {
    if (!activeRef.current) return;
    console.log('[WakeWord] Stopping openWakeWord listener...');
    activeRef.current = false;
    suspend();
    setIsListening(false);
  }, [suspend]);

  return {
    isListening,
    isSimulatorMock: false,
    startListening,
    stopListening,
  };
}

/**
 * openWakeWord 온디바이스 실행 엔진 ("비바야") — 버퍼 배치 방식.
 *
 * 설계 배경: openWakeWord 원본의 "80ms 청크마다 증분 멜" 스트리밍은 (1) 원본도
 * 인정하는 수치 불안정이 있고 (2) 80ms마다 ONNX 3개를 JS↔네이티브 브리지로
 * 호출해 실시간을 못 따라가 오디오가 밀린다(지연).
 *
 * 그래서 여기서는 최근 ~2.2초 오디오를 링 버퍼에 담아두고, ~300ms마다 한 번씩:
 *   mel(버퍼 전체) 1회 → 새 오디오에서 끝나는 윈도우들만 배치 임베딩 1회 →
 *   bibaya.onnx 1회 → 그 중 최고 점수 → WakeFireGate 로 2연속 홉 확인 후 발화
 * 수치는 openWakeWord의 비스트리밍(embed_clips) 경로와 동일해 정확하고,
 * ONNX 호출이 초당 ~37회에서 ~7회로 줄어 병목이 사라진다. 매 홉 "새 윈도우만"
 * 채점하는 이유는 scoreBuffer 주석 참조(기침 오인식 방지, 2026-08-13).
 *
 * 모델 입출력 이름(업로드된 파일에서 직접 확인):
 *  - melspectrogram.onnx : in 'input' [1, samples] → out [.,.,frames,32]
 *  - embedding_model.onnx: in 'input_1' [K,76,32,1] → out 'conv2d_19' [K,1,1,96]
 *  - bibaya.onnx         : in 'onnx::Flatten_0' [W,16,96] → out 'output' [W,1]
 */
import { InferenceSession, Tensor } from 'onnxruntime-react-native';
import { NativeModules } from 'react-native';
import { Asset } from 'expo-asset';
import { decode as decodeBase64 } from 'base64-arraybuffer';
import { WakeFireGate } from './wakeFireGate';

// onnxruntime 내부 binding 모듈 (Metro 는 package.json "react-native": "lib/index"
// 를 쓰므로 이 경로가 라이브러리가 실제 사용 중인 동일 모듈 인스턴스다).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const onnxBinding = require('onnxruntime-react-native/lib/binding');

/**
 * Metro JS 리로드 직후엔 RCTBridge runtime 이 서기 전에 binding.ts 모듈 평가가
 * 먼저 돌아 OnnxruntimeJSIHelper.install() 이 조용히 실패할 수 있다. 그러면
 * jsiHelper 가 throw 스텁으로 굳어 이후 모든 추론이
 * "jsiOnnxruntimeStoreArrayBuffer is not found" 로 죽는다(앱 완전 재시작 전까지
 * 웨이크 영구 무반응 - 실기기 2026-08-12). install 은 재호출해도 전역 함수를
 * 다시 세팅할 뿐이라, 엔진 load 시점(브릿지 확실히 준비됨)에 다시 깔고 스텁을
 * 실제 함수로 갈아끼운다. 정상 상태에서 불려도 동등한 함수로 덮을 뿐 무해.
 */
async function repairJsiHelperAfterReload(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const installed = NativeModules.OnnxruntimeJSIHelper?.install?.();
      const g = globalThis as Record<string, any>;
      if (installed && g.jsiOnnxruntimeStoreArrayBuffer && onnxBinding?.jsiHelper) {
        onnxBinding.jsiHelper.storeArrayBuffer = g.jsiOnnxruntimeStoreArrayBuffer;
        onnxBinding.jsiHelper.resolveArrayBuffer = g.jsiOnnxruntimeResolveArrayBuffer;
        // binding.ts 와 동일하게 전역은 청소한다.
        delete g.jsiOnnxruntimeStoreArrayBuffer;
        delete g.jsiOnnxruntimeResolveArrayBuffer;
        console.log(`[openWakeWord] JSI helper ok (attempt ${attempt})`);
        return;
      }
      console.warn(`[openWakeWord] JSI install returned ${String(installed)} (attempt ${attempt})`);
    } catch (err) {
      console.warn('[openWakeWord] JSI repair attempt failed:', err);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.warn(
    '[openWakeWord] JSI repair failed - ONNX 추론 불가. 앱을 완전히 종료 후 재실행해야 한다.',
  );
}

// --- 튜닝 파라미터 ---------------------------------------------------------
// 0~1. 오인식 많으면 0.5~0.7, 잘 못 잡으면 0.15~0.25. 원거리 발화는 점수가
// 코앞(0.9+)보다 크게 떨어진다.
// 0.15 는 hey_viva 모델 기준 실측이었다. bibaya 로 전환 후 실기기에서 5번
// 불러 1번 잡히는 저인식(2026-08-12 피드백) - bibaya 는 3음절+받침이라
// hey_viva 보다 오인식이 적어(더 특이한 발음) 문턱을 더 내릴 여유가 있다.
// 0.08 로 낮춰 인식률을 올린다. 오인식(촬영+Gemini 세션 유발)이 늘면 이 값을
// 다시 올린다 - 정확한 튜닝은 OWW_DEBUG=true 로 peak score 로그를 보고 잡는다.
// ponytail: 하드웨어 튜닝 노브 - 실기기 발화 점수 분포에 맞춰 조정하는 값.
export const OWW_THRESHOLD = 0.08;
// 매 판정(초당 여러 번)마다 최고 점수를 찍는다. 임계값 튜닝할 때만 켠다 -
// 켜두면 idle 대기 중에도 브릿지로 로그가 계속 넘어가 체감 반응이 나빠진다.
// TEMP 2026-08-11: "메인 화면 웨이크 무반응" 진단 + bibaya 전환 임계값 튜닝용.
// logcat 에서 "비바야" 를 부르며 다음을 확인한 뒤 다시 false 로 되돌린다:
//   - [openWakeWord] peak score=?? | audio amp max=?? mean=??  (5초마다)
//       · amp max 가 말할 때 수천~수만이면 오디오 정상 → 점수(score)만 보면 됨
//         (score 가 0.3 을 못 넘으면 모델 문턱 문제 → OWW_THRESHOLD 하향)
//       · amp max 가 수십~수백이면 오디오가 거의 안 들어옴(폰 마이크 폴백 등)
//   - [WakeWord] openWakeWord engine started (Pi PCM source).  ← wake.py 정상
//   - [WakeWord] Pi wake stream failed - falling back to phone mic:  ← viva-wake 다운
// 평소엔 false - 켜두면 idle 대기 중에도 5초마다 peak score 로그가 metro 를
// 뒤덮는다(2026-08-12 피드백). 임계값 재튜닝할 때만 잠깐 true 로.
export const OWW_DEBUG = false;

const MEL_BINS = 32;
const EMB_DIM = 96;
const EMB_WINDOW = 76; // 임베딩 1개를 만드는 멜 프레임 수
const EMB_STEP = 8; // 슬라이딩 스텝(원본과 동일)
const WW_FRAMES = 16; // wakeword 모델이 보는 임베딩 개수

const BUFFER_SAMPLES = 35000; // 링 버퍼 크기(~2.2초). 16개 임베딩 윈도우 확보에 충분.
const MIN_SAMPLES = 32000; // 판정 시작에 필요한 최소 샘플(~2초)
const DETECT_HOP = 4800; // 새 오디오 이만큼(~300ms) 쌓일 때마다 1회 판정
const MEL_HOP_SAMPLES = 160; // melspectrogram.onnx 의 프레임 홉(10ms @16kHz)

type OnnxSession = InferenceSession;

function base64ToInt16(b64: string): Int16Array {
  return new Int16Array(decodeBase64(b64));
}

async function loadSession(assetModule: number): Promise<OnnxSession> {
  const asset = Asset.fromModule(assetModule);
  await asset.downloadAsync();
  const uri = asset.localUri || asset.uri;
  try {
    return await InferenceSession.create(uri);
  } catch {
    return await InferenceSession.create(uri.replace('file://', ''));
  }
}

export interface OpenWakeWordCallbacks {
  onDetected: () => void;
  onError?: (err: unknown) => void;
}

export class OpenWakeWordEngine {
  private melSession: OnnxSession | null = null;
  private embSession: OnnxSession | null = null;
  private wwSession: OnnxSession | null = null;

  private buf = new Float32Array(BUFFER_SAMPLES);
  private filled = 0;
  private newSince = 0;

  private running = false;
  private detecting = false;
  private fireGate = new WakeFireGate(OWW_THRESHOLD);
  private lastChunkAt = 0;
  private chunkCount = 0;
  private dbgLast = 0;
  private dbgLoudLast = 0;
  private lastAmpMax = 0;
  private lastAmpMean = 0;

  constructor(private cb: OpenWakeWordCallbacks) {}

  async load(melModule: number, embModule: number, wwModule: number): Promise<void> {
    await repairJsiHelperAfterReload();
    [this.melSession, this.embSession, this.wwSession] = await Promise.all([
      loadSession(melModule),
      loadSession(embModule),
      loadSession(wwModule),
    ]);
    this.buf = new Float32Array(BUFFER_SAMPLES);
    this.filled = 0;
    this.newSince = 0;
  }

  start() {
    this.running = true;
  }

  stop() {
    this.running = false;
  }

  /** 링 버퍼를 비운다. 세션 간 엔진을 재사용할 때 이전 세션 오디오(직전
   * "비바야" 포함)가 남아 복귀 즉시 재트리거되는 것을 막는다. */
  reset() {
    this.filled = 0;
    this.newSince = 0;
    this.fireGate.reset();
  }

  /** 링 버퍼에 새 오디오를 append 하고, 슬라이드(오래된 것 제거). */
  private append(s: Int16Array) {
    const len = s.length;
    if (len >= BUFFER_SAMPLES) {
      for (let i = 0; i < BUFFER_SAMPLES; i += 1) this.buf[i] = s[len - BUFFER_SAMPLES + i];
      this.filled = BUFFER_SAMPLES;
      return;
    }
    if (this.filled + len > BUFFER_SAMPLES) {
      const shift = this.filled + len - BUFFER_SAMPLES;
      this.buf.copyWithin(0, shift, this.filled);
      this.filled -= shift;
    }
    for (let i = 0; i < len; i += 1) this.buf[this.filled++] = s[i];
  }

  /** react-native-live-audio-stream 의 base64 PCM16 청크를 넣는다. */
  feedBase64(b64: string): void {
    if (!this.running) return;
    const s = base64ToInt16(b64);

    this.append(s);
    this.newSince += s.length;

    // 판정 중이거나, 데이터가 모자라거나, 아직 홉만큼 안 쌓였으면 대기.
    // (오디오는 계속 버퍼에 쌓이므로 유실 없음. 판정은 주기적으로만.)
    if (this.detecting || this.filled < MIN_SAMPLES || this.newSince < DETECT_HOP) return;
    const newSamples = this.newSince;
    this.newSince = 0;
    this.detecting = true;
    // 판정은 비동기로 돌리고 기다리지 않는다(그 사이 들어온 오디오는 버퍼에 쌓임).
    this.runDetection(newSamples).finally(() => {
      this.detecting = false;
    });
  }

  private async runDetection(newSamples: number): Promise<void> {
    if (!this.melSession || !this.embSession || !this.wwSession) return;
    // 버퍼 스냅샷(판정 중 append 로 바뀌어도 안전하게).
    const snapshot = this.buf.slice(0, this.filled);
    const t0 = Date.now();
    try {
      const score = await this.scoreBuffer(snapshot, newSamples);
      if (OWW_DEBUG) {
        const now = Date.now();
        if (now - this.dbgLast > 5000) {
          this.dbgLast = now;
          console.log(
            '[openWakeWord] peak score=',
            score.toFixed(3),
            '| audio amp max=',
            this.lastAmpMax | 0,
            'mean=',
            this.lastAmpMean | 0,
            '| infer',
            Date.now() - t0,
            'ms',
          );
        }
        // "말했는데 반응이 없다" 진단용: 버퍼에 큰 소리가 들어온 판정은 5초
        // 스로틀을 우회해 즉시 찍는다 - 이 줄이 안 뜨면 발화가 엔진까지 안 온
        // 것(소스/스트림 문제), 뜨는데 score 가 낮으면 모델/임계값 문제다.
        if (this.lastAmpMax > 4000 && now - this.dbgLoudLast > 1000) {
          this.dbgLoudLast = now;
          console.log(
            '[openWakeWord] loud audio: amp max=',
            this.lastAmpMax | 0,
            'score=',
            score.toFixed(3),
          );
        }
      }
      if (this.fireGate.push(score, Date.now())) {
        console.log('[openWakeWord] "비바야" detected, score=', score.toFixed(3));
        this.cb.onDetected();
      }
    } catch (err) {
      this.cb.onError?.(err);
    }
  }

  /**
   * 이번 홉에 새로 도착한 오디오에서 "끝나는" 윈도우들만 채점해 최고 점수를
   * 낸다(멜/임베딩 수치는 openWakeWord 비스트리밍 경로와 동일).
   *
   * 예전엔 매 홉 버퍼(~2.2초) 전체의 최대 점수를 썼는데, 그러면 기침 같은
   * 단발 트랜지언트의 피크 윈도우가 버퍼에 남아있는 ~7홉 내내 재검출돼
   * 연속 홉 확인이 무력화된다. 새 윈도우만 보면 단발 트랜지언트는 1홉만
   * 임계값을 넘고, 실제 "비바야" 발화는 연속 홉에서 넘는다 → WakeFireGate
   * 의 2연속 확인이 유효해진다. 대가: 실제 발화 감지 ~300ms(1홉) 지연 - 허용.
   */
  private async scoreBuffer(samples: Float32Array, newSamples: number): Promise<number> {
    // 진단: 버퍼에 실제로 들어온 오디오의 진폭(최대/평균 절댓값)을 확인한다.
    // 정상 마이크라면 말할 때 최대 절댓값이 수천~2만대여야 한다. 수십~수백이면
    // 오디오가 너무 작거나(게인/포맷 문제) 거의 무음이라 모델이 못 알아듣는다.
    if (OWW_DEBUG) {
      let mx = 0;
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const a = samples[i] < 0 ? -samples[i] : samples[i];
        if (a > mx) mx = a;
        sum += a;
      }
      this.lastAmpMax = mx;
      this.lastAmpMean = sum / samples.length;
    }

    // 1) mel(전체) → (frames, 32), /10+2 적용
    const melInput = new Tensor('float32', new Float32Array(samples), [1, samples.length]);
    const melOut = await this.melSession!.run({ input: melInput });
    const melFlat = melOut[Object.keys(melOut)[0]].data as Float32Array;
    const frames = Math.floor(melFlat.length / MEL_BINS);
    if (frames < EMB_WINDOW + (WW_FRAMES - 1) * EMB_STEP) return 0;
    const mel = new Float32Array(melFlat.length);
    for (let i = 0; i < melFlat.length; i += 1) mel[i] = melFlat[i] / 10 + 2;

    // 2) 새 오디오에서 끝나는 wake 윈도우만 고른다.
    //    wake 윈도우 w 는 임베딩 w..w+15 를, 임베딩 k 는 멜 프레임
    //    k*EMB_STEP..k*EMB_STEP+75 를 덮으므로 윈도우 끝은 EMB_STEP(8프레임)씩
    //    이동한다 → 새 멜 프레임 newFrames 개 안에서 끝나는 윈도우는
    //    ceil(newFrames/EMB_STEP)개(홉 4800샘플 ≈ 30프레임 ≈ 윈도우 4개).
    const K = Math.floor((frames - EMB_WINDOW) / EMB_STEP) + 1;
    const W = K - WW_FRAMES + 1;
    if (W <= 0) return 0;
    const newFrames = Math.ceil(newSamples / MEL_HOP_SAMPLES);
    const numNew = Math.min(W, Math.max(1, Math.ceil(newFrames / EMB_STEP)));
    const wMin = W - numNew; // 첫 "새" wake 윈도우의 전역 인덱스

    // 새 윈도우가 쓰는 임베딩(전역 wMin..K-1)만 배치 1회 [kCount,76,32,1]
    const kCount = K - wMin; // = numNew + WW_FRAMES - 1
    const embInputData = new Float32Array(kCount * EMB_WINDOW * MEL_BINS);
    for (let w = 0; w < kCount; w += 1) {
      const start = (wMin + w) * EMB_STEP;
      for (let f = 0; f < EMB_WINDOW; f += 1) {
        const srcRow = (start + f) * MEL_BINS;
        const dstRow = (w * EMB_WINDOW + f) * MEL_BINS;
        for (let m = 0; m < MEL_BINS; m += 1) embInputData[dstRow + m] = mel[srcRow + m];
      }
    }
    const embInput = new Tensor('float32', embInputData, [kCount, EMB_WINDOW, MEL_BINS, 1]);
    const embOut = await this.embSession!.run({ input_1: embInput });
    const embFlat = embOut[Object.keys(embOut)[0]].data as Float32Array; // kCount*96

    // 3) 새 윈도우 numNew 개 → 배치 wakeword 1회 [numNew,16,96] → 최고 점수
    //    (embFlat 은 wMin 부터 시작하므로 로컬 인덱스 w+f 그대로 쓴다)
    const wwInputData = new Float32Array(numNew * WW_FRAMES * EMB_DIM);
    for (let w = 0; w < numNew; w += 1) {
      for (let f = 0; f < WW_FRAMES; f += 1) {
        const srcRow = (w + f) * EMB_DIM;
        const dstRow = (w * WW_FRAMES + f) * EMB_DIM;
        for (let e = 0; e < EMB_DIM; e += 1) wwInputData[dstRow + e] = embFlat[srcRow + e];
      }
    }
    const wwInput = new Tensor('float32', wwInputData, [numNew, WW_FRAMES, EMB_DIM]);
    const wwOut = await this.wwSession!.run({ 'onnx::Flatten_0': wwInput });
    const wwFlat = wwOut[Object.keys(wwOut)[0]].data as Float32Array; // W scores
    let best = 0;
    for (let i = 0; i < wwFlat.length; i += 1) if (wwFlat[i] > best) best = wwFlat[i];
    return best;
  }

  async release() {
    this.running = false;
    for (const s of [this.melSession, this.embSession, this.wwSession]) {
      try {
        await (s as any)?.release?.();
      } catch {
        /* ignore */
      }
    }
    this.melSession = this.embSession = this.wwSession = null;
  }
}

// 모델 에셋(metro.config.js 에서 .onnx assetExt 등록 필요)
export const OWW_ASSETS = {
  mel: require('../assets/wakeword/melspectrogram.onnx'),
  emb: require('../assets/wakeword/embedding_model.onnx'),
  // 2026-08-11 호출어 "헤이 비바" → "비바야" 전환. 2026-08-14 한국어 재학습:
  // 기존 영어 TTS 합성("bibaya") 모델이 실발화 recall 0.14 로 실측돼(10회 중
  // 1~2회 반응 사고), Google TTS ko-KR 41화자 + 원거리 증강(감쇠·잡음·잔향)
  // + 유사발음 하드 네거티브로 동일 구조 헤드를 재학습(홀드아웃 recall 0.98
  // @0.08). 구모델은 bibaya_tts_en.onnx, 그 전 모델은 hey_viva.onnx 로 롤백용.
  ww: require('../assets/wakeword/bibaya.onnx'),
};

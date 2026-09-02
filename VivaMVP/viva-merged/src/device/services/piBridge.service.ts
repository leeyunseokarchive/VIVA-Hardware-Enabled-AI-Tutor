/**
 * VivaHW(라즈베리파이 헤드) <-> VivaApp 통신.
 *
 * Pi가 HTTP 서버(pi-server/app.py), 폰(VivaApp)이 클라이언트인 구조.
 * 대화 한 턴은 half-duplex 턴제라 지속 스트리밍 없이 단발성 요청/응답으로
 * 충분하다 (record start -> stop -> photo/audio 수신 -> Gemini 호출은 기존
 * gemini.service.ts / geminiStt.service.ts 가 그대로 담당 -> 응답 TTS를
 * tts.service.ts 로 합성한 뒤 이 파일의 playAudioOnPi()로 Pi 스피커에 재생).
 *
 * 기존 CameraScreen(react-native-vision-camera)과 useVoiceInput(폰 자체
 * 마이크)은 그대로 둔다 - 로봇 헤드 없이 폰만으로 테스트/개발할 때 쓰는
 * 경로로 유지하고, 로봇 연동은 이 브릿지를 통해 별도 경로로 추가한다.
 */
import * as FileSystem from 'expo-file-system';

const PI_HOST = process.env.EXPO_PUBLIC_PI_HOST || 'viva.local';
const PI_PORT = process.env.EXPO_PUBLIC_PI_PORT || '5000';
const PI_BASE_URL = `http://${PI_HOST}:${PI_PORT}`;

/** 디버그용: 지금 빌드에 실제로 어떤 주소가 박혀 있는지 화면에서 바로
 * 확인할 수 있게 export한다 (EXPO_PUBLIC_ 변수는 빌드 시점에 고정된다). */
export function getPiBaseUrl(): string {
  return PI_BASE_URL;
}

/** 요청이 죽은 Pi에 막혀 무한 대기하지 않도록 공통 타임아웃을 건다. */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 8000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    // RN 의 AbortError 는 "Aborted" 만 남아 어느 요청이 죽었는지 알 수 없다 -
    // URL·타임아웃을 박아 다시 던진다 (의도루프 그물 로그에서 범인 식별용).
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`[piBridge] timeout after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Pi 하드웨어 상태. 필드가 없으면(구버전 펌웨어 또는 아직 없는 프로브)
 * undefined - "모름"이지 "정상"이 아니다. 화면은 모르는 항목을 아예 안
 * 그린다. camOk/displayOk는 파이 서버가 아직 안 보낸다(카메라·디스플레이
 * 프로브는 실기기 배포가 필요한 후속 작업) - 타입에 먼저 얹어 두면 서버가
 * 필드를 추가해도 앱 릴리즈 없이 그대로 받아진다. */
export interface PiHealth {
  micOk?: boolean;
  speakerOk?: boolean;
  camOk?: boolean;
  displayOk?: boolean;
}

/** Pi 는 snake_case, 앱은 camelCase. 변환은 여기 한 곳에서만 한다.
 * 불리언이 아닌 값은 떨군다 - 이상한 응답을 정상으로 오독하지 않기 위해서다. */
function optionalBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Pi 서버가 살아있는지 + 마이크·스피커가 정상인지. 죽었으면 null.
 * 절대 throw 하지 않는다 - connectionMonitor 의 판정이 여기 걸려 있다. */
export async function fetchPiHealth(): Promise<PiHealth | null> {
  try {
    const res = await fetchWithTimeout(`${PI_BASE_URL}/health`, {}, 5000);
    if (!res.ok) return null;
    // 본문이 깨져도 200 을 받았으면 서버는 살아있다 - 연결은 살리고
    // 하드웨어 상태만 "모름"으로 둔다.
    const body = await res.json().catch(() => ({}));
    return {
      micOk: optionalBool(body?.mic_ok),
      speakerOk: optionalBool(body?.speaker_ok),
      camOk: optionalBool(body?.cam_ok),
      displayOk: optionalBool(body?.display_ok),
    };
  } catch (err) {
    // 실패 원인이 IP 오타/다른 와이파이/서버 꺼짐 중 뭔지 로그로 남긴다 -
    // 호출부 Alert은 "응답 없음"이라고만 뜨니 실제 원인은 여기서 봐야 한다.
    console.warn(`[piBridge] health check failed against ${PI_BASE_URL}/health:`, err);
    return null;
  }
}

/** blob -> base64 문자열. Gemini/analyzeImage, transcribeWavWithGemini는
 * 둘 다 raw base64(데이터 URI 접두어 없음)를 기대하므로 FileReader의
 * data:*;base64,... 접두어를 잘라낸다. */
async function blobToBase64(blob: Blob): Promise<string> {
  // RN 에는 FileReader 만 있고, node(jest) 환경에는 FileReader 가
  // 없어 arrayBuffer 경로를 쓴다 - 실기기와 테스트가 같은 함수를 지나간다.
  if (typeof FileReader === 'undefined') {
    const buf = Buffer.from(await blob.arrayBuffer());
    return buf.toString('base64');
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1] ?? '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/** 녹음 시작 (마이크). 의도루프가 촬영([병렬 B])과 동시에 부른다 - Pi Zero
 * 싱글코어가 AF+JPEG 인코딩(실측 ~14초)에 깔리면 응답이 밀리므로 기본 8초로는
 * 부족하다 (2026-08-12 AbortError 실측). */
export async function startPiRecording(): Promise<void> {
  const res = await fetchWithTimeout(`${PI_BASE_URL}/record/start`, { method: 'POST' }, 20000);
  if (!res.ok) throw new Error(`Pi record/start failed: ${res.status}`);
}

/** 녹음 강제 종료 (로봇 마이크 모드의 "탭으로 발화 폐기" 경로 + 의도루프
 * 무응답 타이머가 마이크를 놓을 때도 이걸 부른다 - Pi 서버 측 침묵 감지가
 * 항상 먼저 끝낸다는 보장이 없어서다). start/status/audio 와 같은 사유로
 * 기본 8초는 Pi Zero 단일코어가 AF+JPEG 인코딩에 깔릴 때 부족해 20초로 올린다. */
export async function stopPiRecording(): Promise<void> {
  const res = await fetchWithTimeout(`${PI_BASE_URL}/record/stop`, { method: 'POST' }, 20000);
  if (!res.ok) throw new Error(`Pi record/stop failed: ${res.status}`);
}

export interface PiRecordStatus {
  recording: boolean;
  had_speech: boolean;
  /** 발화가 한 번이라도 감지된 뒤 마지막 발화로부터 경과한 밀리초. 발화 전
   * 이거나 녹음 종료 후엔 0. 앱은 이 값으로 "말이 멈춘 것 같다"(눈 신호
   * 전환)를 판정한다 - 종료 판정은 서버가 SILENCE_MS 로 따로 한다. */
  silent_ms: number;
  /** 임계값(VIVA_SILENCE_THRESHOLD) 캘리브레이션용 실측 RMS(0~1). */
  rms: number;
}

/** 로봇 마이크 모드 폴링용. recording 이 false 로 떨어지면(서버 측 침묵
 * 자동 종료 or 30초 상한) had_speech 를 보고 fetchPiAudioBase64() 여부를
 * 결정한다 - had_speech=false 무음 세션은 전사하지 않는다(폰 경로와 동일). */
export async function fetchPiRecordStatus(): Promise<PiRecordStatus> {
  // 촬영과 병렬로 폴링된다 - startPiRecording 과 같은 사유로 여유를 둔다.
  const res = await fetchWithTimeout(`${PI_BASE_URL}/record/status`, {}, 10000);
  if (!res.ok) throw new Error(`Pi record/status failed: ${res.status}`);
  return (await res.json()) as PiRecordStatus;
}

/** 녹음 없이 사진만 즉시 촬영 (Tier 1, 전체 프레임 오토포커스).
 * Pi Zero + autofocus_cycle(AF 모터 스윕) + 풀해상도 JPEG 인코딩이 합쳐지면
 * 기본 8초 타임아웃을 넘기는 경우가 실측됨(app.py 쪽은 계속 처리를 끝내고
 * 200을 로그로 남기는데, 클라이언트는 이미 AbortError로 실패 처리한
 * 상태였음) - 여유를 둔다. 눈 렌더러 가동 후 실측 14초(af 6.3+encode 7.6,
 * 2026-08-03)라 20초도 빠듯해 30초. */
export async function capturePhotoNow(): Promise<void> {
  const res = await fetchWithTimeout(`${PI_BASE_URL}/capture/photo/now`, { method: 'POST' }, 30000);
  if (!res.ok) throw new Error(`Pi capture/photo/now failed: ${res.status}`);
}

/**
 * AF 를 미리 돌려둔다 (촬영 지연의 최대 구간, 실측 5.7초).
 *
 * "이제 곧 찍는다" 를 아는 시점에 **await 하지 않고** 때린다 - 그 뒤에 어차피
 * 흘러갈 시간(호출어 마이크 정리, 재촬영 안내 발화)이 AF 를 덮어준다. Pi 는
 * AF 가 수렴한 시각을 기억했다가, VIVA_AF_FRESH_SECONDS(기본 8초) 안에 들어온
 * 전체 촬영에서 AF 사이클을 건너뛴다.
 *
 * 실패는 삼킨다. 이건 순수 최적화라 안 되면 그냥 예전처럼 촬영 때 AF 를 돌 뿐,
 * 학생에게 보여줄 에러가 아니다. Pi 가 이미 촬영 중이면 서버가 스스로
 * 건너뛴다(선행 AF 가 진짜 촬영을 기다리게 만들면 빨라지려다 느려진다).
 */
export function prewarmPiFocus(): void {
  fetchWithTimeout(`${PI_BASE_URL}/capture/prewarm`, { method: 'POST' }, 20000).catch((err) =>
    console.log('[piBridge] focus prewarm skipped:', err),
  );
}

/**
 * Tier 2 폴백: 보관 원본 크롭(/photo/crop)까지 인식 실패했을 때, 해당 문제
 * bbox 에 AF 윈도우를 걸고 ScalerCrop 으로 그 영역만 다시 촬영한다. 로봇
 * 시나리오에서 폰 카메라를 켜는 대신 쓰는 경로 - 촬영 후
 * fetchPiPhotoBase64() 로 결과를 가져온다.
 *
 * 좌표는 Gemini box_2d([ymin,xmin,ymax,xmax] 0~1000) 그대로 받고, 서버의
 * x,y,w,h(0~1) 형식으로 여기서 변환한다. 크롭과 같은 5% 여백을 두고 프레임
 * 경계로 클램프한다 - bbox 가 몇 px 어긋나도 지문이 잘리지 않게.
 */
export async function recapturePiRegion(box2d: number[]): Promise<void> {
  const [ymin, xmin, ymax, xmax] = box2d.map(Math.round);
  const padX = ((xmax - xmin) / 1000) * 0.05;
  const padY = ((ymax - ymin) / 1000) * 0.05;
  const x = Math.max(0, xmin / 1000 - padX);
  const y = Math.max(0, ymin / 1000 - padY);
  const w = Math.min(1 - x, (xmax - xmin) / 1000 + padX * 2);
  const h = Math.min(1 - y, (ymax - ymin) / 1000 + padY * 2);
  // AF 사이클 + 12MP 인코딩 + 축소본 생성 실측 ~15초 (2026-07-28) - 여유를 둔다.
  const res = await fetchWithTimeout(
    `${PI_BASE_URL}/capture/region`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y, w, h }),
    },
    30000,
  );
  if (!res.ok) throw new Error(`Pi capture/region failed: ${res.status}`);
}

/** stopPiRecording() 이후 호출. WAV base64를 돌려준다 -
 * geminiStt.service.ts의 transcribeWavWithGemini(wavBase64)에 그대로 넘기면 된다. */
export async function fetchPiAudioBase64(): Promise<string> {
  // 촬영과 병렬일 수 있다 - startPiRecording 과 같은 사유로 여유를 둔다.
  const res = await fetchWithTimeout(`${PI_BASE_URL}/capture/audio`, {}, 20000);
  if (!res.ok) throw new Error(`Pi capture/audio failed: ${res.status}`);
  const blob = await res.blob();
  return blobToBase64(blob);
}

/** stopPiRecording() 또는 capturePhotoNow() 이후 호출. JPEG base64를
 * 돌려준다 - analyzeImage(images, ...)에 그대로 넣으면 된다.
 *
 * 리사이즈는 이제 Pi 가 한다(app.py 가 12MP 원본을 보관하고 전송용
 * 2048폭 q85 축소본을 /capture/photo 로 준다) - 예전처럼 여기서
 * manipulateAsync 로 또 줄이면 JPEG 를 두 번 인코딩해 획이 뭉개진다. */
export async function fetchPiPhotoBase64(): Promise<string> {
  // Pi Zero 의 약한 CPU/WiFi 를 감안해 기본 8초보다 넉넉히 둔다.
  const res = await fetchWithTimeout(`${PI_BASE_URL}/capture/photo`, {}, 20000);
  if (!res.ok) throw new Error(`Pi capture/photo failed: ${res.status}`);
  return blobToBase64(await res.blob());
}

/** Pi 가 보관 중인 12MP 원본에서 Gemini box_2d([ymin,xmin,ymax,xmax],
 * 0~1000 정규화) 영역을 잘라 받아온다. 재촬영 없음(AF 사이클 없음) -
 * 원본과 같은 초점의 고해상 크롭이 온다. 실패는 throw - 호출부(FSM)가
 * 풀프레임 폴백을 책임진다. */
export async function fetchPiPhotoCropBase64(box2d: number[]): Promise<string> {
  // Gemini 가 스키마를 어겨 소수 좌표를 줘도 Pi 의 int 파싱이 400 으로 죽지 않게 방어
  const [ymin, xmin, ymax, xmax] = box2d.map(Math.round);
  const res = await fetchWithTimeout(
    `${PI_BASE_URL}/photo/crop?ymin=${ymin}&xmin=${xmin}&ymax=${ymax}&xmax=${xmax}`,
    {},
    20000,
  );
  if (!res.ok) throw new Error(`Pi photo/crop failed: ${res.status}`);
  return blobToBase64(await res.blob());
}

/**
 * TTS로 합성된 mp3(base64)를 Pi로 보내 스피커로 재생시킨다.
 * tts.service.ts의 speak()가 폰 스피커로 재생하는 것과 별개 경로 - 로봇
 * 모드에서는 폰 자체 재생 대신(또는 추가로) 이 함수를 호출한다.
 * 재생이 끝날 때까지 응답이 오지 않으므로(Pi가 mpg123/aplay를 동기 실행)
 * await 하면 재생 완료 시점을 그대로 알 수 있다.
 */
export async function playAudioOnPi(
  base64Mp3: string,
  /** 업로드 완료(= 곧 소리 남) 신호. tts.service 가 이 시점에 자막 시계를
   * 시작한다. /play/upload 의 응답이 이 신호다 - 예전엔 단일 /play 의 XHR
   * upload 이벤트로 추정했는데, RN 은 upload 'load' 를 안 쏘고(dispatch
   * 자체가 없다) progress 도 실기기에서 신뢰가 안 돼 자막이 재생 종료 후에나
   * 시작됐다 (개념 풀이 자막 실종, 2026-08-20). 서버 응답 기반이라 플랫폼
   * 의존이 없다. */
  onUploaded?: () => void,
): Promise<void> {
  const path = `${FileSystem.cacheDirectory}pi-tts-${Date.now()}.mp3`;
  await FileSystem.writeAsStringAsync(path, base64Mp3, {
    encoding: FileSystem.EncodingType.Base64,
  });

  // 요청 1건당 고유 id. Pi 가 같은 id 의 재생 요청을 두 번 받으면(응답 유실 시
  // iOS 네트워크 스택의 POST 재전송) 두 번째는 재생하지 않는다 - "문구가
  // 2번씩 나온다" 실기기 2026-08-13 조사. 앱 로그와 Pi 로그를 이 id 로 대조한다.
  // 업로드 재전송은 같은 파일 덮어쓰기(멱등)라 id 검사가 필요 없다.
  const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  console.log(`[piBridge] /play req_id=${reqId}`);

  const formData = new FormData();
  // React Native의 FormData는 { uri, name, type } 형태를 요구한다 - 웹의
  // Blob과 다르므로 fetch(path)로 blob을 만들지 않고 파일 경로를 직접 넘긴다.
  formData.append('audio', {
    uri: path,
    name: 'tts.mp3',
    type: 'audio/mpeg',
  } as any);

  try {
    // 1) 업로드 - 즉시 응답 (긴 개념 설명 수백 KB 도 LAN 에선 수백 ms).
    const up = await fetchWithTimeout(
      `${PI_BASE_URL}/play/upload`,
      { method: 'POST', body: formData },
      15000,
    );
    if (up.status === 404) {
      // 구 서버(골든 이미지 v1, /play/upload 없음) 폴백 - 단일 /play.
      // 자막은 speak() 의 재생 종료 후 폴백으로만 나온다 (구 동작 유지).
      formData.append('req_id', reqId);
      const legacy = await fetchWithTimeout(
        `${PI_BASE_URL}/play`,
        { method: 'POST', body: formData },
        60000,
      );
      if (!legacy.ok) throw new Error(`Pi play failed: ${legacy.status}`);
      return;
    }
    if (!up.ok) throw new Error(`Pi play/upload failed: ${up.status}`);
    onUploaded?.();

    // 2) 재생 시작 - 재생이 끝나야 응답이 온다 (speakAndWait 계약). 풀이 요약
    // (3~6문장) 같은 긴 발화도 있으니 타임아웃을 재생 최장 길이보다 넉넉히
    // 둔다. 타임아웃이 나면 Pi 는 계속 재생 중인데 앱만 실패로 보는 최악의
    // 어긋남이 생긴다.
    const startForm = new FormData();
    startForm.append('req_id', reqId);
    const res = await fetchWithTimeout(
      `${PI_BASE_URL}/play/start`,
      { method: 'POST', body: startForm },
      60000,
    );
    if (!res.ok) throw new Error(`Pi play/start failed: ${res.status}`);
  } finally {
    FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
  }
}

/** 진행 중인 Pi 재생을 즉시 끊는다 (stopSpeaking 의 로봇 대응 - barge-in).
 * 끊기면 진행 중이던 playAudioOnPi() 의 /play 요청이 그 시점에 resolve 된다. */
export async function stopPiPlayback(): Promise<void> {
  const res = await fetchWithTimeout(`${PI_BASE_URL}/play/stop`, { method: 'POST' }, 4000);
  if (!res.ok) throw new Error(`Pi play/stop failed: ${res.status}`);
}

/**
 * Google Cloud TTS service (ported from leeyunseok_viva's VivaApp/src/services/tts.service.ts).
 *
 * `GOOGLE_TTS_API_KEY` is a plain API key (not a service-account JSON), so
 * the official @google-cloud/text-to-speech SDK — which expects
 * service-account auth — is not used. Instead this calls the REST endpoint
 * directly with `fetch`.
 *
 * The synthesized mp3 (returned as base64) is written to a local cache file
 * via expo-file-system, then played with expo-av's Audio.Sound (this repo is
 * an Expo project, so expo-file-system/expo-av are used in place of the
 * bare-RN react-native-fs/react-native-sound the reference repo uses).
 * `speak()`'s Promise resolves only when playback completes, so callers (the
 * FSM) can transition to "waiting for student response" at the right time.
 *
 * A new `speak()` call stops any in-flight playback and prioritizes the
 * newest request ("latest request wins"); the stopped call's Promise
 * resolves without ever having "completed" naturally (it does not hang
 * forever).
 */
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import { cleanMathForTTS } from '../utils/mathTextProcessor';
import { mp3DurationMs } from '../utils/mp3Duration';

export function cleanTextForTTS(text: string): string {
  return cleanMathForTTS(text);
}

const TTS_ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';

/** In-message pause marker (see ANSWER_CONFIRMATION_POLICY in
 * system_prompt.ts). Gemini inserts this literal token between "맞아!" and
 * the closing praise sentence so the two don't run together with no breath
 * between them - synthesizeToBase64Mp3() below turns it into a real SSML
 * <break>. A distinct bracketed token (not plain "...") avoids colliding
 * with real ellipses that could appear in ordinary message text. */
export const TTS_PAUSE_MARKER = '[[PAUSE]]';

function escapeForSsml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Converts a TTS_PAUSE_MARKER-bearing string into a <speak> SSML document
 * with a real ~450ms silence at each marker. Returns null if there's no
 * marker (caller should just send plain text - lower risk for the common
 * case, and avoids depending on SSML support for every single utterance). */
function toPauseSsml(text: string, rate?: number): string | null {
  const hasMarker = text.includes(TTS_PAUSE_MARKER);
  if (!hasMarker && rate === undefined) return null;
  const body = text.split(TTS_PAUSE_MARKER).map(escapeForSsml).join('<break time="450ms"/>');
  // rate 를 지정한 발화만 <prosody> 로 감싼다. Chirp3-HD 는 생성형 음성이라
  // 짧고 느낌표 붙은 문장을 자연히 빠르게 읽는다 - 고정 안내 문구가 일반
  // 튜터링 발화보다 빠르게 들리는 게 그 때문이고(합성 설정은 동일하다),
  // 여기서만 명시적으로 눌러 맞춘다. SSML 을 거부하는 보이스면 아래 catch 가
  // 평문으로 폴백하므로 최악이 현행 동작이다.
  return rate === undefined
    ? `<speak>${body}</speak>`
    : `<speak><prosody rate="${rate}">${body}</prosody></speak>`;
}

/** base64 mp3 재생. 재생 완료(또는 중단)까지 resolve 보류. throw 하면
 * speak() 이 폰 스피커로 폴백한다 - 폴백을 원치 않는 셸은 sink 안에서
 * 삼키고 resolve 한다 (디바이스 연동판 정책).
 *
 * onStarted: "전송이 끝나 곧 소리가 난다" 신호. sink 가 이걸 부르는 시점에
 * speak() 이 onPlay(자막 시계 시작)를 발화한다 - 예전처럼 play 호출 직전에
 * 무조건 부르면 mp3 업로드 시간(길이 비례, 긴 개념 설명에서 수백 ms~초)만큼
 * 자막이 나레이션을 앞선다 (2026-08-20 실기기). 안 부르는 sink 여도 자막은
 * 잃지 않는다 - play 종료 후 폴백 참고. */
export interface AudioSink {
  play: (base64Mp3: string, onStarted?: () => void) => Promise<void>;
  stop: () => Promise<void>;
}

// 오디오 sink 주입. 등록돼 있으면 speak() 이 합성한 mp3 를 폰 대신 이 sink 로
// 보내 재생한다 (sink.play - 재생 완료까지 블로킹이라 speakAndWait 계약
// 유지). ConversationScreen 이 세션의 photoSource==='pi' 로 켜고 끈다 -
// 카메라와 같은 판정: Pi 가 살아 있으면 카메라도 오디오도 로봇. tts.service
// 는 이제 sink 의 구현(Pi 로 보내는지 등)을 모른다 - 그 의존은 호출부(셸)로 옮김.
let audioSink: AudioSink | null = null;

export function setAudioSink(sink: AudioSink | null): void {
  audioSink = sink;
}

// Module-level handle to the currently-playing Sound instance (and the
// resolver for its in-flight speak() Promise), so a new speak() call can
// interrupt it (MVP "latest request wins" policy) without leaving the
// superseded caller's Promise hanging forever.
let currentSound: Audio.Sound | null = null;
let currentSoundPath: string | null = null;
let resolveCurrentSpeak: (() => void) | null = null;

// Monotonically increasing token identifying the most recent speak()/stop
// request. speak() runs through an async gap (network synthesis + file
// write + Sound load) BEFORE it ever assigns `currentSound`, so a plain
// `stopCurrentPlayback()` at the top of speak() can't cancel a *previous*
// speak() that's still mid-synthesis - both would eventually reach play()
// and their audio would overlap. Every speak()/stopSpeaking() bumps this
// token and captures its own value; after each await, a speak() whose token
// is no longer the latest aborts before playing. This guarantees only the
// single newest request ever produces sound.
let playToken = 0;

async function requestSynthesis(
  apiKey: string,
  input: { text: string } | { ssml: string },
): Promise<string> {
  const res = await fetch(`${TTS_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input,
      voice: {
        languageCode: 'ko-KR',
        // Chirp 3: HD is Google's newest, most natural-sounding tier
        // (Gemini-based prosody), a clear step up from Neural2 for
        // conversational speech. "Aoede" is a warm/breezy female voice
        // that fits VIVA's casual, friendly tutor persona.
        name: 'ko-KR-Chirp3-HD-Aoede',
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: 1.05,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`TTS request failed: ${res.status} ${res.statusText}\n${errText}`);
  }

  const data = await res.json();
  if (!data.audioContent) {
    throw new Error(`TTS response missing audioContent: ${JSON.stringify(data)}`);
  }

  return data.audioContent as string;
}

// 합성 결과(mp3 base64) 캐시. 고정 발화가 여럿 있다 - PROBLEM_CHOICE_QUESTION
// ("몇 번 문제 풀고 있어?"), CROP_RETRY_FILLER, 정답 유출 차단 문구 - 전부
// 매번 똑같은 문자열인데 매번 Google TTS 왕복(0.3~0.8초 + 과금)을 하고
// 있었다. 특히 되묻기는 크롭 지연을 숨기려고 넣은 구간이라 그 앞의 TTS
// 왕복이 체감 지연에 그대로 붙는다. 짧은 문장만 캐시한다 - 일반 튜터링
// 메시지는 턴마다 유일해서 캐시해봐야 메모리만 먹는다.
// ponytail: Map 재삽입 LRU, 상한 20 (짧은 mp3 ~50KB × 20 = 수 MB 이하).
const TTS_CACHE_MAX_TEXT_LENGTH = 80;
const TTS_CACHE_MAX_ENTRIES = 20;
const synthesisCache = new Map<string, string>();

async function synthesizeToBase64Mp3(text: string, rate?: number): Promise<string> {
  const cleanedText = cleanTextForTTS(text);

  // 같은 문장이라도 rate 가 다르면 다른 오디오다 - 캐시 키에 포함한다.
  const cacheKey = rate === undefined ? cleanedText : `${rate}|${cleanedText}`;
  const cacheable = cleanedText.length <= TTS_CACHE_MAX_TEXT_LENGTH;
  if (cacheable) {
    const hit = synthesisCache.get(cacheKey);
    if (hit) {
      // 재삽입으로 최신 사용 순서 유지 (Map 은 삽입 순서 보존).
      synthesisCache.delete(cacheKey);
      synthesisCache.set(cacheKey, hit);
      return hit;
    }
  }

  const apiKey = process.env.EXPO_PUBLIC_GOOGLE_TTS_API_KEY;
  if (!apiKey) {
    throw new Error('Missing EXPO_PUBLIC_GOOGLE_TTS_API_KEY. Check .env.');
  }

  const ssml = toPauseSsml(cleanedText, rate);
  let result: string;
  if (ssml) {
    try {
      result = await requestSynthesis(apiKey, { ssml });
    } catch (err) {
      // Some voices may reject SSML unexpectedly - fall back to plain text
      // (marker collapsed to a comma, so it still reads as one sentence
      // instead of erroring the whole turn out) rather than losing playback.
      console.warn('[TTS] SSML pause request failed, retrying as plain text:', err);
      result = await requestSynthesis(apiKey, {
        text: cleanedText.split(TTS_PAUSE_MARKER).join(', '),
      });
    }
  } else {
    result = await requestSynthesis(apiKey, { text: cleanedText });
  }

  if (cacheable) {
    if (synthesisCache.size >= TTS_CACHE_MAX_ENTRIES) {
      const oldest = synthesisCache.keys().next().value;
      if (oldest) synthesisCache.delete(oldest);
    }
    synthesisCache.set(cacheKey, result);
  }
  return result;
}

async function writeMp3ToCache(base64Mp3: string): Promise<string> {
  const path = `${FileSystem.cacheDirectory}viva-tts-${Date.now()}.mp3`;
  await FileSystem.writeAsStringAsync(path, base64Mp3, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return path;
}

async function loadSound(path: string): Promise<Audio.Sound> {
  const { sound } = await Audio.Sound.createAsync({ uri: path });
  return sound;
}

function unlinkQuiet(path: string): void {
  FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
}

// Stops whatever is currently playing (if anything) and resolves its
// in-flight speak() Promise, since it was intentionally cut short rather
// than failed. Shared by speak() (superseding with a new utterance) and
// stopSpeaking() (the caller just wants playback to stop, full stop).
async function stopCurrentPlayback(): Promise<void> {
  if (!currentSound) return;
  const soundToStop = currentSound;
  const pathToDelete = currentSoundPath;
  const resolvePrevious = resolveCurrentSpeak;

  currentSound = null;
  currentSoundPath = null;
  resolveCurrentSpeak = null;

  try {
    await soundToStop.stopAsync();
  } catch {
    // best-effort
  }
  await soundToStop.unloadAsync();

  if (pathToDelete) {
    unlinkQuiet(pathToDelete);
  }

  resolvePrevious?.();
}

/**
 * Stops any in-flight TTS playback immediately, resolving the pending
 * speak() call. Intended for interrupting VIVA mid-sentence when the
 * student starts answering (mic or text) before she's done talking - the
 * FSM's speakAndWait() will then advance phase normally, as if playback
 * had finished on its own.
 */
export async function stopSpeaking(): Promise<void> {
  // Invalidate any speak() still mid-synthesis so it aborts before playing,
  // in addition to stopping whatever is already audible.
  playToken += 1;
  if (audioSink) {
    // sink 쪽 재생도 끊는다. 끊기면 진행 중이던 speak() 의 sink.play 가
    // resolve 되고 그 speak() 은 토큰 검사로 조용히 끝난다.
    audioSink.stop().catch(() => {});
  }
  await stopCurrentPlayback();
}

/**
 * Re-assert a record-capable audio session before starting STT.
 *
 * Root cause this addresses: after the camera (react-native-vision-camera)
 * touches audio, the shared audio session can be left in a mode/active state
 * where @react-native-voice/voice fails to start. expo-av's setAudioModeAsync
 * gives us the equivalent of the reference repo's
 * Sound.setActive/setCategory/setMode reset without a bare native module.
 */
export async function prepareAudioSessionForRecording(): Promise<void> {
  try {
    await stopSpeaking();
    // staysActiveInBackground 키를 안 넣는다 - expo-av 는 setAudioModeAsync 를
    // merge 가 아니라 "명시된 키만 덮어쓰기"로 처리해서, 여기 false 를 박으면
    // 디바이스판이 backgroundKeepAlive.service.ts 로 켜둔 true 가 발화마다
    // 꺼진다 (phone 판은 애초 기본값이 false 라 동작 불변).
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });
  } catch {
    // best-effort
  }
}

/**
 * Synthesizes `text` as Korean speech via Google Cloud TTS and plays it.
 * Resolves once playback completes (or is superseded by a newer speak()
 * call). Rejects on network/synthesis/load failure.
 */
export async function speak(
  text: string,
  onPlay?: (durationMillis: number) => void,
  /** 이 발화만 다른 말속도로 (SSML <prosody rate>). 미지정이면 보이스 기본값. */
  rate?: number,
): Promise<void> {
  // Claim latest-request ownership up front ("latest request wins"). Any
  // earlier speak() still mid-synthesis now has a stale token and will abort
  // at its next checkpoint instead of overlapping this one.
  const myToken = ++playToken;

  // Stop whatever is currently audible before starting the new request.
  await stopCurrentPlayback();
  if (myToken !== playToken) return; // superseded while stopping

  // allowsRecordingIOS:true 는 오디오 카테고리를 PlayAndRecord 로 만들고, 그
  // 카테고리의 iOS 기본 출력 경로는 스피커가 아니라 수화기(earpiece)다 -
  // 재생 직전에 이걸 켜두면 VIVA 목소리가 귀에 대야 들릴 만큼 작아진다.
  // 재생은 항상 false, 녹음 직전에만 prepareAudioSessionForRecording() 이
  // true 로 올린다. staysActiveInBackground 키는 안 넣는다 - 백그라운드
  // 생존과의 상호작용(backgroundKeepAlive.service.ts 참조): expo-av 는
  // 명시된 키만 덮어써서, 여기 false 를 박으면 디바이스판 keepalive 의
  // true 가 발화마다 꺼진다.
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
  }).catch(() => {});

  const base64Mp3 = await synthesizeToBase64Mp3(text, rate);
  if (myToken !== playToken) return; // superseded during network synthesis

  if (audioSink) {
    // sink 경로: mp3 를 등록된 sink 로 보내 재생. play() 는 재생 완료(또는
    // stop() 에 의한 중단)까지 블로킹이므로 await 가 곧 재생 완료다.
    // sink 는 재생 길이를 안 알려준다 - 합성한 mp3 바이트에서 직접 프레임
    // 헤더를 읽어 길이를 계산한다(CBR 이므로 정확). 파싱 실패 시 0 이 오고
    // 호출부(customSpeak)의 글자수 추정(MS_PER_CHAR) 자막 폴백이 그대로 탄다.
    try {
      const durationMs = mp3DurationMs(base64Mp3);
      let subtitlesStarted = false;
      const startSubtitles = () => {
        if (subtitlesStarted) return;
        subtitlesStarted = true;
        onPlay?.(durationMs);
      };
      // 자막 시계는 sink 의 onStarted(업로드 완료) 시점에 시작한다 - play
      // 호출 시점이 아니라. 그래야 업로드가 오래 걸리는 긴 발화에서도 자막이
      // 나레이션과 맞는다 (AudioSink 주석 참조).
      await audioSink.play(base64Mp3, startSubtitles);
      if (myToken !== playToken) return; // 밀린 발화 - 자막도 없어야 맞다
      // onStarted 가 끝내 안 왔으면(업로드 실패를 sink 가 삼킨 경우 등)
      // 늦게라도 자막은 돌린다 - 무음이어도 내용은 자막이 전달해야 한다는
      // 디바이스판 정책 유지.
      startSubtitles();
      return;
    } catch (err) {
      if (myToken !== playToken) return;
      // sink 가 안 받으면 폰 스피커로 폴백 (카메라의 폰 폴백과 같은 정책).
      console.warn('[TTS] sink playback failed - falling back to phone speaker:', err);
    }
  }

  const path = await writeMp3ToCache(base64Mp3);
  if (myToken !== playToken) {
    unlinkQuiet(path);
    return;
  }

  const sound = await loadSound(path);
  if (myToken !== playToken) {
    // A newer speak()/stopSpeaking() won while this clip was loading - never
    // play it (that overlap/late-audio was the "TTS 겹침" bug).
    await sound.unloadAsync().catch(() => {});
    unlinkQuiet(path);
    return;
  }
  currentSound = sound;
  currentSoundPath = path;

  const status = await sound.getStatusAsync();
  const duration = status.isLoaded ? (status.durationMillis ?? 0) : 0;

  return new Promise<void>((resolve, reject) => {
    resolveCurrentSpeak = resolve;

    sound.setOnPlaybackStatusUpdate((playbackStatus) => {
      // AVPlaybackStatus 는 isLoaded 로 갈라지는 union 이고 .error 는 실패
      // 쪽에만 있다. `!playbackStatus.isLoaded` 는 (strictNullChecks 가 꺼져
      // 있어) union 을 좁혀주지 않으므로 판별자를 명시적으로 === false 로
      // 비교한다 - 런타임 조건은 동일하다.
      if (playbackStatus.isLoaded === false) {
        if (playbackStatus.error) {
          if (currentSound === sound) {
            currentSound = null;
            currentSoundPath = null;
            resolveCurrentSpeak = null;
          }
          sound.unloadAsync().catch(() => {});
          unlinkQuiet(path);
          reject(new Error(`TTS playback failed: ${playbackStatus.error}`));
        }
        return;
      }

      if (playbackStatus.didJustFinish) {
        const wasCurrent = currentSound === sound;
        if (wasCurrent) {
          currentSound = null;
          currentSoundPath = null;
          resolveCurrentSpeak = null;
        }
        sound.unloadAsync().catch(() => {});
        unlinkQuiet(path);

        // Natural completion, or intentionally cut short by a newer request:
        // resolve (don't reject) so awaiters advance as if playback finished.
        resolve();
      }
    });

    sound.playAsync().catch((error) => {
      if (currentSound === sound) {
        currentSound = null;
        currentSoundPath = null;
        resolveCurrentSpeak = null;
      }
      sound.unloadAsync().catch(() => {});
      unlinkQuiet(path);
      reject(error instanceof Error ? error : new Error(String(error)));
    });

    onPlay?.(duration);
  });
}

/**
 * Socratic tutoring FSM loop (task-5-brief.md), running AFTER a successful
 * capture (Task 4 already got a usable first `GeminiTutoringResponse` via
 * `analyzeImage` + `evaluateCaptureResult`). This hook owns everything from
 * "first HINT_STAGE message" through repeated student-input/EVAL turns to
 * "SOLVE_STAGE full solution -> back to idle".
 *
 * Session state owned here (TutoringSession fields, TRD.md §2.2):
 * `hintCount`, `wrongStreak`, `boardRegenerationCount`, `lastBoardImageBase64`,
 * `fsmState`.
 *
 * Turn flow:
 *  1. `startSession(analysis, seed)` seeds the session from the first
 *     analyzeImage() result, speaks its message, then waits for input. `seed`
 *     may carry a previous session's id/history/counters (재촬영으로 화면이
 *     언마운트됐다 돌아온 경우) - 그러면 새 세션 대신 그걸 이어간다.
 *  2. `submitStudentInput(text)`:
 *     - 동의 질문 자체는 Gemini 가 프롬프트(`wrongStreakInstruction`) 지시대로
 *       한다. 훅은 "그 동의에 실제로 응했는지" 만 `isConsentPhrase()` 로 로컬
 *       확인해서, wrongStreak>=3 + 동의 발화일 때만 정답 공개를 허가한다.
 *     - `evaluateStudentInput()` (EVAL) 을 부르고 구조화 응답으로 분기한다:
 *       - `explicit_answer_request === true` -> SOLVE_STAGE (Step 3 test:
 *         "답 알려줘", "그냥 풀어줘"), `requires_board` forced to `false`.
 *       - `is_on_correct_path === true` -> `wrongStreak` resets to 0,
 *         `hintCount` increments, stay HINT_STAGE with the next tail
 *         question.
 *       - `is_on_correct_path === false` -> `wrongStreak` increments,
 *         `hintCount` increments. If the new `wrongStreak >= 3`, the next
 *         input is gated through the consent check above (Step 7/8)
 *         regardless of what Gemini's message text says.
 *       - `is_on_correct_path === null` (e.g. "모르겠어"/"어려워", not a
 *         judgable answer) -> `hintCount` increments, `wrongStreak`
 *         unchanged, stay HINT_STAGE (완료 기준 2).
 *  3. Every AppState/FSM transition is logged via `sessionLog.service`
 *     (완료 기준 6).
 *  4. On SOLVE_STAGE, the full-solution message is spoken and then
 *     `onSessionComplete()` is invoked so the caller (App-level AppState
 *     owner) can call `resetToIdle()` — this hook never touches AppState
 *     directly, matching Task 1's separation of AppState vs FSM state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  evaluateStudentInput as defaultEvaluateStudentInput,
  analyzeImage as defaultAnalyzeImage,
  recognizeHandwriting as defaultRecognizeHandwriting,
} from '../services/gemini.service';
import { matchProblemLabel, matchProblemSwitch } from '../utils/problemChoice';
import {
  voteHandwriting,
  describeVotePattern,
  classifyAskBackReply,
  HANDWRITING_ASKBACK_MAX,
  HANDWRITING_ASKBACK_RETRY,
  HANDWRITING_ASKBACK_FALLBACK,
  HANDWRITING_ASKBACK_SILENCE_MS,
  HANDWRITING_READ_COUNT,
  type HandwritingAskBack,
} from '../utils/captureDecision';
import {
  speak as defaultSpeak,
  stopSpeaking as defaultStopSpeaking,
  TTS_PAUSE_MARKER,
} from '../services/tts.service';
import { buildSystemPrompt } from '../prompts/system_prompt';
import { logSessionEvent } from '../services/sessionLog.service';
import { saveSession, saveBoardImage, saveProblemImage } from '../services/sessionHistory.service';
import {
  debugRecordCapture,
  debugSetSessionInfo,
  getSessionDebug,
} from '../services/sessionDebug.service';
import type { AppStatus, ConversationPayload, FsmState } from '../types/AppState';
import type {
  GeminiTutoringResponse,
  ResumeSessionSnapshot,
  TutoringSession,
} from '../types/Tutoring';
import type { SessionHistoryEntry, SavedBoardImage } from '../types/SessionHistory';
import {
  EMPTY_USAGE_SUMMARY,
  EMPTY_TOKEN_USAGE,
  type TokenUsage,
  type SessionUsageSummary,
} from '../types/ApiUsage';
import { addTextUsage, addImageUsage } from '../services/apiPricing.service';

/** wrongStreak threshold that triggers the "동의 요청" consent gate
 * (PRD.md §5 무한루프 방지 규칙, brief Step 7). */
export const WRONG_STREAK_CONSENT_THRESHOLD = 3;

/** 다문제 사진에서 어떤 문제를 풀고 있는지 묻는 고정 발화. */
export const PROBLEM_CHOICE_QUESTION = '책상에 문제가 여러 개 보이네! 지금 몇 번 문제 풀고 있어?';
/** 고정 안내 문구의 말속도 (SSML prosody rate).
 *
 * 0.92 로 눌렀더니 이번엔 느리다는 실기기 피드백(2026-07-29 2차) - 1.0 으로
 * 되돌려 일반 튜터링 발화(speakingRate 1.05)와 같은 체감 속도로 맞춘다.
 * 고정 문구만 빠르거나 느리게 들리면 이 값 하나로 조절한다. */
const FIXED_PHRASE_RATE = 1.0;
/** 크롭 재분석(~3초) 동안의 무음을 메우는 필러 발화. */
const CROP_RETRY_FILLER = '좋아, 문제를 다시 자세히 볼게.';
/** Tier 2 로봇 재촬영(AF+촬영+전송+재분석, 실측 ~20초) 동안의 필러 발화. */
const REGION_RECAPTURE_FILLER = '그 문제만 다시 자세히 찾아볼게, 조금만 기다려 줘!';
/** 대화 중 학생이 재촬영을 요청했을 때, 로봇이 직접 찍는 동안의 발화.
 * Gemini 는 ERROR_POLICY 에 따라 "그래, 그럼 그 문제를 사진으로 찍어서 보여줘!"
 * 를 돌려주는데, 폰이 거치돼 있는 로봇 모드에선 학생이 실행할 수 없는 지시다. */
export const PI_RETAKE_FILLER = '문제가 잘 안 보여서 다시 자세히 볼게.';
/** 대화 중 같은 페이지의 다른 문제로 전환할 때(보관본 크롭 재분석 ~3초)의 필러. */
const PROBLEM_SWITCH_FILLER = '좋아, 그 문제를 볼게. 잠깐만 기다려 줘!';
/** D-37: 로봇 사다리(Tier1/2 + 재촬영 1회) 소진 시, 폰 카메라를 무음으로
 * 열지 않고 먼저 묻는다. 동의 -> 폰 카메라, 그 외 -> 세션 종료. */
export const PHONE_FALLBACK_QUESTION =
  '여기에선 문제가 잘 안보여. 스마트폰 카메라로 찍게 도와줄까?';
export const PHONE_FALLBACK_DECLINE_MESSAGE = '알겠어, 도움이 필요하면 언제든 불러줘!';
/** 학생 하차("알았어 꺼져", "이제 가도 돼") 시 고정 마무리 인사. 모델이
 * student_dismissal 로 신호하면 튜터링 내용 없이 이 문구만 말하고 세션을 닫는다. */
export const DISMISSAL_EXIT_PHRASE = '알겠어, 필요하면 언제든 다시 불러줘!';
/** D-30: 재인식 후에도 계산 답이 선지에 없을 때(힌트 모드) - 정답 값을
 * 누설하지 않고 학생에게 선지 확인을 넘기는 고정 문구. 정답 모드는 모델
 * 메시지가 계산 답과 선지 오식 가능성을 직접 말한다 (FINAL_ANSWER_POLICY). */
const CHOICE_MISMATCH_MESSAGE =
  '흠, 내가 계산한 답이랑 보기에 적힌 선지가 잘 안 맞는 것 같아. 혹시 보기 선지들이 어떻게 적혀 있는지 하나씩 읽어줄래? 문제집이 잘못 인쇄됐을 수도 있거든!';

/** 직전 질문이 "답을 같이 볼까?" 였을 때만 추가로 인정하는 동의어.
 * 맨입 "답 알려줘" 는 정책상 동의가 아니라 기본 목록엔 없다 - 다만 동의 질문
 * 직후엔 "네 알려주세요" 가 가장 자연스러운 수락이다 (run-8 에서 이 발화가
 * 거부돼 "제안해 놓고 거절" 을 3턴 반복했다). */
export const CONSENT_WORDS_AFTER_ANSWER_ASK = '|알려줘|알려줘요|알려주세요|알려주라|답|정답';
/** 직전 질문이 폰 폴백("스마트폰 카메라로 찍게 도와줄까?") 이었을 때의 동의어.
 * 기본 사전은 "볼까?" 류 질문에 맞춰져 있어서, 이 질문에 가장 자연스러운 대답인
 * "도와줘"/"부탁해"/"찍어줘" 가 전부 거절로 떨어졌다 - 학생이 "응 도와줘" 라고
 * 해도 로봇이 "오늘은 여기까지 할게" 하고 세션을 닫았다 (실기기 피드백
 * 2026-08-05). 정답 공개 동의와 달리 여기서 허가하는 건 카메라를 여는 것뿐이라
 * 사전을 넓혀도 정책 위험이 없다. */
export const CONSENT_WORDS_AFTER_HELP_ASK =
  '|도와줘|도와줘요|도와주세요|도와줄래|도와주라|부탁해|부탁|찍어줘|찍어주세요|찍어줄래|그래줘|해줘|응|네|알았어';

/** 동의 발화만 골라낸다 ("응", "그래", "좋아", "보여줘" ...).
 *
 * 정답 공개(wrongStreak>=3)와 폰 폴백 두 자리에서 "방금 던진 질문에 실제로
 * 응했는지" 를 로컬로 확인한다 (EXPLICIT_SOLVE_REQUEST_POLICY Exception 1 과
 * 같은 규칙). 발화 전체가 동의어로만 이루어졌을 때만 참 - "그래도 모르겠어"
 * 같은 문장이 "그래" 로 걸리면 안 된다. 질문마다 자연스러운 수락 표현이
 * 다르므로, 그 질문 전용 동의어는 `extraWords` 로 호출부가 넘긴다
 * (CONSENT_WORDS_AFTER_ANSWER_ASK / CONSENT_WORDS_AFTER_HELP_ASK). */
export function isConsentPhrase(text: string, extraWords = ''): boolean {
  const normalized = text.replace(/[\s.,!?~]/g, '');
  if (normalized.length === 0) return false;
  const base =
    '응|어|네|예|그래|그러자|좋아|좋아요|오케이|ok|okay|알겠어|보여줘|보여주라|볼래|같이보자|보자';
  return new RegExp(`^(${base}${extraWords})+$`, 'i').test(normalized);
}

/** 직전 튜터 발화가 wrongStreak>=3 동의 질문("답을 같이 볼까?" 류)이었는지.
 * 모델 자유 문장이라 정확 일치는 불가 - "같이 + 볼까/보자/확인 + 답/풀이"
 * 동시 출현으로 판별한다 (프롬프트 예시와 run-6/7/8 실측 변형 모두 포함). */
export function askedConsentQuestion(message: string): boolean {
  return /같이/.test(message) && /볼까|보자|확인/.test(message) && /답|풀이/.test(message);
}

export type TutoringPhase = 'idle' | 'speaking' | 'awaiting_input' | 'evaluating' | 'done';

export interface UseTutoringFSMOptions {
  /** Injectable for tests; defaults to the real Gemini service call. */
  evaluateStudentInputFn?: typeof defaultEvaluateStudentInput;
  /** Injectable for tests; defaults to the real TTS service call. */
  speakFn?: (text: string, onPlay?: (duration: number) => void, rate?: number) => Promise<void>;
  /** Injectable for tests; defaults to the real TTS stop call. Used to cut
   * VIVA off the instant the student barges in (mic result or text send),
   * even mid-inference, before the new turn's own speak() runs. */
  stopSpeakingFn?: () => Promise<void>;
  /** 마이크를 닫는다 (useVoiceInput.stopListening). 무응답 타이머가 말을
   * 시작하기 전에 부른다 - 되묻기 대기 구간은 마이크가 열린 채라, 안 닫고
   * 말하면 VIVA 자기 목소리가 학생 발화로 전사돼 되돌아온다. 미주입이면
   * 타이머는 그대로 돌고 마이크만 안 닫힌다. */
  stopListeningFn?: () => void;
  /** Called once SOLVE_STAGE's solution has finished speaking, so the
   * caller can drive AppState back to idle. */
  onSessionComplete?: () => void;
  /** Called when Gemini decides mid-conversation that a photo is needed
   * (ERROR/OCR_FAILED). Invoked only AFTER the guidance message has been
   * spoken, carrying the student's utterance that triggered the request so
   * the eventual analyzeImage() call knows why the photo was taken, plus a
   * snapshot of the current session so the screen that comes back after the
   * retake can resume it instead of starting a brand-new one. */
  onCameraNeeded?: (question: string, resume: ResumeSessionSnapshot) => void;
  /** True when "바로 정답" mode is on - threaded into every buildSystemPrompt
   * call this hook makes, so mid-session turns also skip the hint loop. */
  directSolveMode?: boolean;
  /** Injectable for tests; defaults to the real Gemini analyzeImage. 크롭
   * 재분석(다문제 선택 후 / OCR 실패 후)에 쓴다. */
  analyzeImageFn?: typeof defaultAnalyzeImage;
  /** 손글씨 판독 1회 (기본값 gemini.service.recognizeHandwriting). FSM 이
   * 같은 이미지에 HANDWRITING_READ_COUNT 회 병렬 호출한다. 테스트 주입용. */
  recognizeHandwritingFn?: (image: string) => Promise<{ candidates: string[]; usage: TokenUsage }>;
  /** Pi 보관 원본에서 box_2d([ymin,xmin,ymax,xmax] 0~1000) 크롭을 받아오는
   * 함수. 미주입이면(폰 경로) 크롭 분기 전체가 닫힌다. */
  fetchProblemCropFn?: (box2d: number[]) => Promise<string>;
  /** Pi 보관본이 없는 경로(폰 촬영)에서 세션 사진 자체를 box_2d 로 잘라내는
   * 함수 (utils/cropImage.cropBase64Image). 단일 문제 크롭 분기에만 쓴다. */
  cropLocalImageFn?: (imageBase64: string, box2d: number[]) => Promise<string>;
  /** Tier 2: 보관본 크롭까지 인식 실패하면 해당 bbox 에 AF 를 걸고 로봇
   * 카메라로 그 영역만 재촬영한다 (piBridge.recapturePiRegion). 미주입이면
   * 크롭 실패 시 바로 재촬영 안내(onCameraNeeded, 폰 카메라)로 간다. */
  recapturePiRegionFn?: (box2d: number[]) => Promise<void>;
  /** Tier 2 재촬영 결과를 받아오는 함수 (piBridge.fetchPiPhotoBase64). */
  fetchPiPhotoFn?: () => Promise<string>;
  /** 대화 중 학생이 재촬영을 요청했을 때 로봇 카메라로 새로 한 장 찍는다
   * (piBridge.capturePhotoNow). 미주입이면 기존 폰 카메라 안내로 떨어진다.
   * 여기서 Tier 1 크롭(보관본 재사용)을 쓰지 않는 이유: 학생이 직접 요청한
   * 재촬영은 종이나 페이지 자체가 바뀌었을 수 있다는 뜻이라 보관본이 무의미하다. */
  capturePhotoNowFn?: () => Promise<void>;
  /** 촬영 전에 AF 를 미리 돌려두는 fire-and-forget 호출 (piBridge.prewarmPiFocus).
   * 순수 최적화라 미주입이어도 동작에는 영향이 없다 - 촬영이 예전처럼 자기
   * AF 를 돌 뿐이다. */
  prewarmPiFocusFn?: () => void;
}

export interface UseTutoringFSMResult {
  phase: TutoringPhase;
  session: TutoringSession;
  conversation: ConversationPayload | undefined;
  /** Seeds the session from the first analyzeImage() result and speaks the
   * first HINT_STAGE message. `initialUsage` carries the token usage from
   * that first analyzeImage()/analyzeConceptQuestion() call, if any, so it's
   * included in the session's running usage total. */
  startSession: (
    analysis: GeminiTutoringResponse,
    seed: Pick<TutoringSession, 'sessionId' | 'problemImageBase64'> &
      Partial<ResumeSessionSnapshot> & { photoSource?: 'pi' | 'phone' },
    initialQuestion?: string,
    initialUsage?: TokenUsage,
    parentConceptSessionId?: string,
  ) => Promise<void>;
  /** Submits the student's (voice-transcribed or typed) response.
   * `overrides.directSolveMode`, when given, wins over the hook's own
   * `directSolveMode` option for this call only - lets a caller that just
   * flipped 정답 모드 authorize the SOLVE_STAGE jump immediately instead of
   * waiting a render for the prop to propagate back down (would otherwise
   * race: the flip is an async setState, so a call made in the same tick
   * would still close over the pre-toggle value). */
  submitStudentInput: (text: string, overrides?: { directSolveMode?: boolean }) => Promise<void>;
  /** Updates the session's cached board image and increments the generation
   * counter, optionally accumulating the API usage that produced it.
   * `opts.boardPrompt` 는 판서 업로드에 저장될 프롬프트, `opts.imageUsages`/
   * `opts.textUsages` 는 검증·재생성이 만든 추가 usage. */
  updateBoardData: (
    imageBase64: string,
    usage?: TokenUsage,
    opts?: { boardPrompt?: string; imageUsages?: TokenUsage[]; textUsages?: TokenUsage[] },
  ) => void;
  /** 판서 이미지 교체 없이 usage 만 세션에 반영한다 (사후검증이 통과로 끝나
   * 재생성이 없을 때의 검증 호출 비용). */
  addBoardUsage: (opts: { imageUsages?: TokenUsage[]; textUsages?: TokenUsage[] }) => void;
  /** Marks the session cancelled - any Gemini call already in flight will,
   * once it resolves, skip speaking its result or advancing state. Call
   * this when the owning screen is going away (e.g. student presses back
   * mid-inference) so a stale response can't start TTS playback after the
   * student has already left. */
  cancel: () => void;
}

function toConversationPayload(response: GeminiTutoringResponse): ConversationPayload {
  return {
    fsmState: response.fsm_state,
    message: response.message,
    requires_board: response.requires_board,
    board_update_needed: response.board_update_needed,
    board_prompt: response.board_prompt,
    annotations: response.annotations,
    // Add mock fields for required AppState properties
    initialAnalysis: response,
    problemImageBase64: '',
  };
}

/** The spoken message may contain TTS_PAUSE_MARKER (see
 * ANSWER_CONFIRMATION_POLICY) so speakFn can synthesize a real pause -
 * that's a TTS-only concern. Anything PERSISTED (conversation history sent
 * back to Gemini for context, session history saved for the 오답노트/detail
 * screens) should read as normal text, so the marker is swapped for a space
 * before it's ever stored. */
function forHistory(message: string): string {
  return message.split(TTS_PAUSE_MARKER).join(' ');
}

/** 크롭 재분석 호출용 세션 컨텍스트 - 아직 시딩 전이므로 seed 값만으로 만든다. */
function sessionFromSeed(
  seed: Pick<TutoringSession, 'sessionId' | 'problemImageBase64'> & Partial<ResumeSessionSnapshot>,
): TutoringSession {
  return {
    sessionId: seed.sessionId,
    problemImageBase64: '',
    fsmState: 'HINT_STAGE',
    hintCount: seed.hintCount ?? 0,
    wrongStreak: seed.wrongStreak ?? 0,
    boardRegenerationCount: 0,
    history: seed.history,
  };
}

/** Step 9: SOLVE_STAGE transition. Preserves Gemini's board choices so that it
 * can optionally provide a visual step-by-step board update. */
function forceSolveStage(response: GeminiTutoringResponse): GeminiTutoringResponse {
  return {
    ...response,
    fsm_state: 'SOLVE_STAGE',
  };
}

export function useTutoringFSM(options: UseTutoringFSMOptions = {}): UseTutoringFSMResult {
  const {
    evaluateStudentInputFn = defaultEvaluateStudentInput,
    speakFn = defaultSpeak,
    stopSpeakingFn = defaultStopSpeaking,
    stopListeningFn,
    onSessionComplete,
    onCameraNeeded,
    directSolveMode,
    analyzeImageFn = defaultAnalyzeImage,
    recognizeHandwritingFn = defaultRecognizeHandwriting,
    fetchProblemCropFn,
    cropLocalImageFn,
    recapturePiRegionFn,
    fetchPiPhotoFn,
    capturePhotoNowFn,
    prewarmPiFocusFn,
  } = options;

  const [phase, setPhase] = useState<TutoringPhase>('idle');
  const [session, setSession] = useState<TutoringSession>({
    sessionId: '',
    problemImageBase64: '',
    fsmState: 'HINT_STAGE',
    hintCount: 0,
    wrongStreak: 0,
    boardRegenerationCount: 0,
  });
  const [conversation, setConversation] = useState<ConversationPayload>();

  // Set once the owning screen tears down (see `cancel` below). Checked
  // after every `await` that can outlive the component (Gemini calls),
  // so a response that resolves post-cancellation is discarded instead of
  // triggering TTS/state updates for a session the student already left.
  const isCancelledRef = useRef(false);
  const cancel = useCallback(() => {
    isCancelledRef.current = true;
  }, []);

  // Track saved board images to prevent duplicate file writes on every turn
  const savedBoardImagesRef = useRef<SavedBoardImage[]>([]);
  const lastSavedRegenerationCountRef = useRef(0);

  // Public URL of the captured problem photo (attempt-images bucket).
  // Uploaded once per session on the first backgroundSaveSession; the
  // in-flight guard prevents duplicate uploads from concurrent saves.
  const problemImageUrlRef = useRef<string | undefined>(undefined);
  const problemImageUploadingRef = useRef(false);

  // 이 세션 사진의 출처. seed 로만 들어오는데(startSession), 대화 한참 뒤
  // submitStudentInput 이 "다시 촬영" 요청을 로봇으로 보낼지 폰으로 보낼지
  // 정하려면 그때까지 살아 있어야 한다.
  // TutoringSession 필드로 넣지 않는 이유: 그 객체는 매 턴 통째로 Gemini
  // 프롬프트에 직렬화된다 (gemini.service.ts 의 `Session context: ...`) -
  // 카메라 라우팅용 값이 프롬프트에 낄 이유가 없다.
  // ResumeSessionSnapshot 에도 넣지 않는다: 스냅샷이 나가는 시점은 폰 카메라
  // 폴백뿐이고, 그때 새 사진은 실제로 폰 사진이 맞다.
  const photoSourceRef = useRef<'pi' | 'phone' | undefined>(undefined);

  // 이 훅 인스턴스가 촬영 디버그 기록(initial/phone_retake 판별)을 이미
  // 했는지. 사다리 재진입(같은 인스턴스)과 폰 재촬영 복귀(새 인스턴스)를
  // 구분하는 유일한 신호다 - startSession 의 기록 분기 주석 참고.
  const recordedCaptureRef = useRef(false);

  // ERROR 에 대한 로봇 풀프레임 재촬영을 세션당 1회로 제한하는 카운터.
  // 첫 분석 ERROR(startSession)와 대화 중 ERROR(submitStudentInput)가 같은
  // 예산을 공유한다 - 재촬영 후 재진입도 같은 startSession 을 타므로, 이 캡이
  // 없으면 계속 ERROR 인 사진에서 촬영→분석→촬영이 끝없이 돈다.
  // ponytail: 상한 1회 - 로봇 시도(재촬영+Tier1+Tier2)를 다 쓰고도 안 되면
  // 사람이 책을 고쳐 놓는 게 맞고, 그 경계가 폰 카메라 안내다.
  const piErrorRetakeRef = useRef<{ sessionId: string; count: number }>({
    sessionId: '',
    count: 0,
  });

  // D-30: 계산 답 ∉ 전사 선지 (answer_not_in_choices) 로 재인식을 태운 횟수.
  // 상한 1회 - 재인식 후에도 불일치면 학생에게 알리는 쪽으로 넘어간다
  // (piErrorRetakeRef 와 같은 무한 루프 방지 패턴).
  const choiceMismatchRef = useRef<{ sessionId: string; count: number }>({
    sessionId: '',
    count: 0,
  });

  // 풀프레임 첫 분석의 problems(라벨+bbox) 보존. 크롭 재진입이 세션/응답
  // 객체에서는 problems 를 벗기지만(프롬프트 오염 방지 - TutoringSession 에
  // 안 넣는 이유는 photoSourceRef 주석과 동일, D-17), 학생이 대화 중
  // "60번 풀어줘" 로 같은 페이지의 다른 문제로 전환할 때 Pi 보관본 크롭
  // (/photo/crop)을 조준할 좌표가 필요하다. 좌표의 유효 조건 = Pi 의
  // /tmp/photo_full.jpg 가 그 프레임 그대로일 것 - 새 촬영이 일어나는 지점
  // (Tier2 region, pi 재촬영)에서 비우고, 재진입 분석의 problems 로 다시 채운다.
  const pageProblemsRef = useRef<GeminiTutoringResponse['problems']>(undefined);
  // 지금 풀고 있는 문제의 라벨 ("59번"). 전환 감지에서 "현재 문제 언급" 을
  // 전환으로 오탐하지 않기 위한 기준값.
  const currentProblemLabelRef = useRef<string | undefined>(undefined);
  // 개념 대화에서 시작된 문제 풀이 세션의 부모 개념 세션 id. startSession 에서
  // 세팅되고 backgroundSaveSession 의 기록에 실린다. 홈에서 촬영한 문제는 부모가
  // 없어 undefined 로 남는다 (정상).
  const parentConceptSessionIdRef = useRef<string | undefined>(undefined);

  const backgroundSaveSession = useCallback(
    (
      currentSession: TutoringSession,
      response?: GeminiTutoringResponse,
      /** 판서 업로드 경로 전용. 판서 저장은 updateBoardData 의 재저장에서만
       * 실제로 트리거되는데(regeneration-count 가드), 그 경로엔 response 가
       * 없어서 board_prompt 가 항상 '' 로 저장되던 버그의 수정이다. */
      boardPromptForUpload?: string,
    ) => {
      // Fire and forget, don't await this so it doesn't block TTS
      (async () => {
        try {
          // Upload the problem photo once per session (attempt-images bucket).
          // Failure must not abort the session-row save - the URL just stays
          // empty and the history card falls back to the board thumbnail.
          if (
            currentSession.problemImageBase64 &&
            currentSession.problemImageBase64.trim().length > 0 &&
            !problemImageUrlRef.current &&
            !problemImageUploadingRef.current
          ) {
            problemImageUploadingRef.current = true;
            try {
              problemImageUrlRef.current = await saveProblemImage(
                currentSession.sessionId,
                currentSession.problemImageBase64,
              );
            } catch (imgErr) {
              console.warn('[FSM] Problem image upload failed (session still saved):', imgErr);
            } finally {
              problemImageUploadingRef.current = false;
            }
          }

          if (
            currentSession.lastBoardImageBase64 &&
            currentSession.boardRegenerationCount > lastSavedRegenerationCountRef.current
          ) {
            // Image upload failure (e.g. missing Storage bucket) must not
            // abort the session-row save below - messages/usage still persist.
            try {
              const saved = await saveBoardImage(
                currentSession.sessionId,
                currentSession.lastBoardImageBase64,
                boardPromptForUpload || response?.board_prompt || '',
              );
              savedBoardImagesRef.current = [...savedBoardImagesRef.current, saved];
              lastSavedRegenerationCountRef.current = currentSession.boardRegenerationCount;
            } catch (imgErr) {
              console.warn('[FSM] Board image upload failed (session still saved):', imgErr);
            }
          }

          // 디버그 스냅샷에 세션 파생 정보(photoSource/problemFacts)를 합쳐둔다.
          debugSetSessionInfo(currentSession.sessionId, {
            photoSource: photoSourceRef.current,
            problemFacts: currentSession.problemFacts,
            finalAnswer: currentSession.finalAnswer,
          });

          const historyEntry: SessionHistoryEntry = {
            sessionId: currentSession.sessionId,
            startedAt: parseInt(currentSession.sessionId.replace('session-', ''), 10) || Date.now(),
            endedAt: Date.now(),
            finalState: currentSession.fsmState,
            hintCount: currentSession.hintCount,
            // timestamp 는 발화 시점에 찍힌다 - 과거엔 저장 시점 Date.now() 로
            // 일괄 덮어써서 상세 화면의 메시지 순서/시각을 믿을 수 없었다.
            messages: (currentSession.history ?? []).map((m) => ({
              ...m,
              timestamp: m.timestamp ?? Date.now(),
            })),
            boardImages: savedBoardImagesRef.current,
            problemImageUrl: problemImageUrlRef.current,
            // Gemini-generated summary (SESSION_METADATA_POLICY) - falls back
            // to the old first-user-message slice only if a response somehow
            // didn't carry a title yet (shouldn't happen, title is required in
            // RESPONSE_SCHEMA, but a session saved before this field existed
            // could still be re-saved via updateBoardData with no fresh
            // response to read title from).
            preview:
              currentSession.title ||
              (currentSession.history ?? []).find((m) => m.role === 'user')?.message.slice(0, 50) ||
              '대화 세션',
            topic: currentSession.topic,
            usage: currentSession.usage ?? EMPTY_USAGE_SUMMARY,
            mistakeReason: currentSession.lastMistakeReason,
            debug: getSessionDebug(currentSession.sessionId),
            kind: 'solve',
            parentConceptSessionId: parentConceptSessionIdRef.current,
          };

          await saveSession(historyEntry);
        } catch (err) {
          console.warn('[FSM] Failed to background-save session:', err);
        }
      })();
    },
    [],
  );

  // Monotonic "turn epoch". Every new student utterance (submitStudentInput)
  // and the initial startSession bump this and capture their own id. A turn
  // whose id is no longer the latest has been superseded by a barge-in and
  // must abandon itself at its next checkpoint (after each Gemini/TTS await)
  // instead of speaking a now-stale response or advancing phase. This is what
  // lets a new utterance interrupt an in-flight inference/playback instead of
  // being dropped (the old isSubmittingRef just ignored barge-ins).
  const turnIdRef = useRef(0);

  // 다문제 되묻기 대기 상태. startSession 이 세션을 시딩하지 않고 여기 얹어둔
  // 채 "몇 번 풀고 있어?" 를 물으면, 다음 submitStudentInput 이 가로채 크롭
  // 재분석 또는 풀프레임 폴백으로 소비한다.
  const pendingProblemChoiceRef = useRef<{
    analysis: GeminiTutoringResponse;
    seed: Pick<TutoringSession, 'sessionId' | 'problemImageBase64'> &
      Partial<ResumeSessionSnapshot> & { photoSource?: 'pi' | 'phone' };
    initialQuestion?: string;
    initialUsage?: TokenUsage;
  } | null>(null);

  // D-37 폰 폴백 되묻기 대기 상태. 로봇 사다리 소진 시 확인 질문을 말해두면
  // 다음 submitStudentInput 이 가로채 소비한다 (pendingProblemChoiceRef 와
  // 같은 패턴). question = onCameraNeeded 에 넘길 원래 학생 발화,
  // base = 자막(conversation payload) 갱신용 직전 응답.
  const pendingPhoneFallbackRef = useRef<{
    question: string;
    base: GeminiTutoringResponse;
    // 되묻는 시점의 확정 세션 id. 대답 처리에서 sessionRef.current 와 대조해
    // 일치할 때만 이력 기록/저장을 한다 - 그 사이 세션이 갈렸으면 엉뚱한
    // 세션에 이번 문답이 섞여 들어가는 걸 막는 안전핀. 두 호출부(startSession
    // 종단, submitStudentInput ERROR) 모두 setSessionState 뒤라 항상 넘긴다.
    recordSessionId?: string;
  } | null>(null);

  // D-30 선지 확인 되묻기 대기 상태. CHOICE_MISMATCH_MESSAGE 로 "보기 선지를
  // 하나씩 읽어줄래?" 를 물어놓고도 그 대답을 받는 인터셉트가 없었다 - 학생이
  // 읽어준 선지는 일반 EVAL 턴으로 들어갔고, EVAL 턴은 프롬프트상 problem_facts
  // 재전사와 final_answer 재도출이 금지돼 있어(OUTPUT_FORMAT_POLICY: "copy
  // final_answer unchanged from the Session context") 잘못 읽힌 선지가 세션
  // 끝까지 그대로 굳었다. 대답을 원본 사진 재분석의 문맥으로 넘겨야 고쳐진다.
  const pendingChoiceReadRef = useRef<string | null>(null);

  // 손글씨 답 되묻기 대기 상태. 같은 이미지를 3회 독립 판독해 값이 갈리면
  // startSession 종단에서 확인 질문을 말해두고, 다음 submitStudentInput 이
  // 가로챈다 (pendingPhoneFallbackRef 와 같은 패턴). 대답은 3분류되고,
  // answer 만 최종 답으로 채택한다 (2026-08-07 스펙).
  // - retried: 이 되묻기에서 재질문을 이미 썼는지. 되묻기당 1회, 문제당
  //   HANDWRITING_ASKBACK_MAX(=사진 턴 상한)와는 별도 예산이다.
  // - base: 재질문·풀이 전환 발화가 자막(ConversationPayload)을 만들 때 쓰는
  //   원본 응답. 모델을 다시 부르지 않으므로 이 스냅샷이 필요하다.
  const pendingHandwritingAskBackRef = useRef<{
    sessionId: string;
    retried: boolean;
    base: GeminiTutoringResponse;
  } | null>(null);
  // 문제(세션)당 되묻기 상한 3회 카운터 (piErrorRetakeRef 패턴). 소진 후엔
  // 3회 판독이 갈려도 되묻지 않고 analysis.message(모델의 원래 판단)로
  // 조용히 진행한다.
  const handwritingAskBackRef = useRef<{ sessionId: string; count: number }>({
    sessionId: '',
    count: 0,
  });

  const isStale = useCallback(
    (turnId: number) => isCancelledRef.current || turnId !== turnIdRef.current,
    [],
  );

  // Mutable mirror of `session`, so a single turn's synchronous logic can
  // read-then-write the latest values without waiting on React's async
  // setState batching (avoids stale-closure bugs across the awaits in a
  // single submitStudentInput call).
  const sessionRef = useRef(session);
  const setSessionState = useCallback((next: TutoringSession) => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  /** 재촬영 후 같은 세션을 이어가기 위한 스냅샷(항상 최신값). */
  const resumeSnapshot = useCallback((): ResumeSessionSnapshot => {
    const current = sessionRef.current;
    return {
      sessionId: current.sessionId,
      hintCount: current.hintCount,
      wrongStreak: current.wrongStreak,
      history: current.history,
      usage: current.usage,
    };
  }, []);

  const logEvent = useCallback(
    (appState: AppStatus, fsmState: FsmState | undefined, meta?: Record<string, unknown>) => {
      logSessionEvent({
        sessionId: sessionRef.current.sessionId,
        appState,
        fsmState,
        timestamp: Date.now(),
        meta,
      });
    },
    [],
  );

  const speakAndWait = useCallback(
    async (message: string, nextPhase: TutoringPhase, turnId: number, rate?: number) => {
      if (isStale(turnId)) return;
      setPhase('speaking');
      try {
        // rate 가 없으면 인자도 넘기지 않는다 - 대부분의 발화가 이쪽이라
        // 의미 없는 undefined 를 흘리지 않는 게 낫다.
        await (rate === undefined ? speakFn(message) : speakFn(message, undefined, rate));
      } finally {
        // Only advance phase if this turn is still the active one. A barged-in
        // turn's speak() was cut short by the newer turn's stopSpeaking(); it
        // must NOT stomp the new turn's phase (e.g. back to 'awaiting_input').
        if (!isStale(turnId)) {
          setPhase(nextPhase);
        }
      }
    },
    [speakFn, isStale],
  );

  /** 되묻기 후속 발화(재질문·풀이 전환)의 공통 종단. 모델 호출 없이 고정 문구를
   * 말하고 대답을 기다린다 - 자막·이력을 한 곳에서 처리해 두 경로가 갈라지지
   * 않게 한다. studentText 가 있으면 그 발화도 이력에 먼저 남긴다(모델을 안
   * 부르는 경로라 여기서 안 남기면 학생 말이 통째로 사라진다). */
  const speakAskBackFollowUp = useCallback(
    async (message: string, base: GeminiTutoringResponse, turnId: number, studentText?: string) => {
      const now = Date.now();
      setSessionState({
        ...sessionRef.current,
        history: [
          ...(sessionRef.current.history ?? []),
          ...(studentText ? [{ role: 'user' as const, message: studentText, timestamp: now }] : []),
          { role: 'model' as const, message, timestamp: now },
        ],
      });
      setConversation(
        toConversationPayload({
          ...base,
          message,
          board_update_needed: false,
          board_prompt: '',
        }),
      );
      await speakAndWait(message, 'awaiting_input', turnId, FIXED_PHRASE_RATE);
    },
    [setSessionState, speakAndWait],
  );

  // 되묻기 무응답 타이머. 되묻기 대기 구간에서만 돈다 - 전역 nudge 가 아니다.
  const askBackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armAskBackTimerRef = useRef<(turnId: number) => void>(() => {});

  const clearAskBackTimer = useCallback(() => {
    if (askBackTimerRef.current) {
      clearTimeout(askBackTimerRef.current);
      askBackTimerRef.current = null;
    }
  }, []);

  /** 무응답은 confused 와 같은 취급이다 - 질문을 못 알아들었을 확률이 높다.
   * 재질문 예산도 같이 쓴다(별도 예산을 주면 침묵 구간만 길어진다). */
  const handleAskBackSilence = useCallback(
    async (turnId: number) => {
      const pending = pendingHandwritingAskBackRef.current;
      if (!pending || isStale(turnId)) return;
      console.log(`[FSM] askback reply: kind=timeout retried=${pending.retried}`);
      stopListeningFn?.();
      if (!pending.retried) {
        pending.retried = true;
        await speakAskBackFollowUp(HANDWRITING_ASKBACK_RETRY, pending.base, turnId);
        if (!isStale(turnId) && pendingHandwritingAskBackRef.current) {
          armAskBackTimerRef.current(turnId);
        }
        return;
      }
      pendingHandwritingAskBackRef.current = null;
      console.log('[FSM] askback outcome: timeout');
      await speakAskBackFollowUp(HANDWRITING_ASKBACK_FALLBACK, pending.base, turnId);
    },
    [isStale, speakAskBackFollowUp, stopListeningFn],
  );

  const armAskBackTimer = useCallback(
    (turnId: number) => {
      clearAskBackTimer();
      askBackTimerRef.current = setTimeout(() => {
        askBackTimerRef.current = null;
        void handleAskBackSilence(turnId);
      }, HANDWRITING_ASKBACK_SILENCE_MS);
    },
    [clearAskBackTimer, handleAskBackSilence],
  );
  // 재무장은 handleAskBackSilence 안에서 일어나므로 순환을 ref 로 끊는다
  // (startSessionRef 와 같은 패턴).
  armAskBackTimerRef.current = armAskBackTimer;

  // 언마운트 시 남은 타이머가 죽은 화면에 대고 말하지 않게 한다.
  useEffect(() => clearAskBackTimer, [clearAskBackTimer]);

  /** D-37: 로봇 사다리 소진의 공통 종단. 확인 질문을 말하고 대답을 기다린다 -
   * 대답 처리는 submitStudentInput 의 인터셉트. onCameraNeeded 미주입이면
   * 물어볼 이유가 없으니 바로 세션을 닫는다. */
  const requestPhoneFallback = useCallback(
    async (
      question: string,
      base: GeminiTutoringResponse,
      turnId: number,
      // 호출부가 "지금 sessionRef.current 가 진짜 이번 세션이다" 를 보장할 때만
      // 넘긴다 (submitStudentInput 중간 개입 - 방금 setSessionState 로 확정된
      // 세션). startSession 최초 진입 경로는 아직 세션이 없어 넘기지 않는다.
      recordSessionId?: string,
    ) => {
      if (!onCameraNeeded) {
        onSessionComplete?.();
        return;
      }
      pendingPhoneFallbackRef.current = { question, base, recordSessionId };
      // 자막도 발화와 같은 문장을 보여준다 (다문제 되묻기와 같은 규칙).
      setConversation(
        toConversationPayload({
          ...base,
          message: PHONE_FALLBACK_QUESTION,
          requires_board: false,
          board_update_needed: false,
          board_prompt: '',
        }),
      );
      // 고정 문구라 Gemini 응답 이력에 안 잡혀서 export/디버깅에서 사라지던
      // 문제(폰 폴백 확인 질문) 의 수정 - 진짜 세션일 때만 이력에 남긴다.
      // 이미 맨 뒤에 있으면 넣지 않는다: 로봇 사다리 소진 경로는 호출부가
      // base.message 를 이 질문으로 갈아끼워 세션 구성 시점에 이미 넣었다.
      // recordSessionId 는 "진짜 세션이다"(= 학생의 동의/거절 대답도 이력에
      // 남긴다) 라는 뜻도 겸하므로, 중복 회피를 호출부에 맡기면 안 된다.
      if (recordSessionId && sessionRef.current.sessionId === recordSessionId) {
        const history = sessionRef.current.history ?? [];
        if (history[history.length - 1]?.message !== PHONE_FALLBACK_QUESTION) {
          setSessionState({
            ...sessionRef.current,
            history: [
              ...history,
              { role: 'model', message: PHONE_FALLBACK_QUESTION, timestamp: Date.now() },
            ],
          });
        }
      }
      await speakAndWait(PHONE_FALLBACK_QUESTION, 'awaiting_input', turnId, FIXED_PHRASE_RATE);
    },
    [onCameraNeeded, onSessionComplete, speakAndWait, setSessionState],
  );

  const startSession = useCallback(
    async (
      analysis: GeminiTutoringResponse,
      seed: Pick<TutoringSession, 'sessionId' | 'problemImageBase64'> &
        Partial<ResumeSessionSnapshot> & {
          photoSource?: 'pi' | 'phone';
          /** 같은 세션의 앞선 호출들이 이미 쓴 usage. startSession 이 EMPTY 로
           * 리셋하면서 크롭/재촬영 재진입 시 첫 분석 비용이 집계에서 증발하던
           * 버그(History 비용 ~12% 과소보고, 2026-07-31 비용 분석)의 수정. */
          usage?: SessionUsageSummary;
        },
      initialQuestion?: string,
      initialUsage?: TokenUsage,
      parentConceptSessionId?: string,
    ) => {
      const myTurnId = ++turnIdRef.current;
      // ponytail: resume/재촬영 재진입은 이 인자를 다시 넘기지 않아 재저장 시
      // 부모가 undefined 로 갈 수 있음 — 현재 허용.
      parentConceptSessionIdRef.current = parentConceptSessionId;
      // 사다리(Tier1/2, pi 재촬영)로 재진입할 때 이번 호출의 분석 usage 를
      // seed 에 접어 넣는다 - 재진입은 initialUsage 를 새 분석 값으로 갈아
      // 끼우므로, 여기서 안 접으면 실패한 분석 호출의 비용이 증발한다.
      let carriedUsage = initialUsage
        ? addTextUsage(seed.usage ?? EMPTY_USAGE_SUMMARY, initialUsage)
        : seed.usage;
      // 사다리/재촬영 재진입은 전부 `{ ...seed }` 를 펴서 들어오므로 'pi' 가
      // 세션 내내 살아남는다. 폰 재촬영은 화면이 언마운트됐다 다시 뜨면서
      // 훅 자체가 새로 만들어지고, 그때 payload 가 'phone' 을 실어 온다.
      photoSourceRef.current = seed.photoSource;
      // 촬영 디버그 기록. 사다리(Tier1/2, 되묻기 크롭, pi 재촬영)는 각자의
      // 분기에서 stage 를 직접 기록하고 같은 훅 인스턴스로 재진입하므로
      // (recordedCaptureRef 이미 true) 여기서 중복 기록되지 않는다. 이
      // 인스턴스의 첫 진입에서만: 수집기에 기록이 없으면 최초 촬영,
      // 있으면 폰 재촬영 복귀(화면 리마운트로 훅이 새로 만들어진 경우)다.
      if (!recordedCaptureRef.current && seed.problemImageBase64) {
        const priorAttempts = getSessionDebug(seed.sessionId)?.captureAttempts.length ?? 0;
        debugRecordCapture(
          seed.sessionId,
          priorAttempts === 0 ? 'initial' : 'phone_retake',
          seed.problemImageBase64,
        );
      }
      recordedCaptureRef.current = true;
      // Fresh session: clear per-session upload state so a previous
      // session's board images / problem photo URL can't leak into this one.
      savedBoardImagesRef.current = [];
      lastSavedRegenerationCountRef.current = 0;
      problemImageUrlRef.current = undefined;
      problemImageUploadingRef.current = false;
      // 이전 사진의 되묻기 대기 상태가 새 세션 첫 발화를 가로채지 않게 초기화
      // - 다문제 분기가 아래에서 필요하면 다시 세팅한다.
      pendingProblemChoiceRef.current = null;
      pendingPhoneFallbackRef.current = null;
      pendingHandwritingAskBackRef.current = null;
      clearAskBackTimer();

      const problems = analysis.problems ?? [];
      // 풀프레임 분석의 problems 는 세션 내내 보존한다 (대화 중 문제 전환용).
      // undefined(크롭 재진입) 는 "새 정보 없음" 이라 기존 값을 유지하고,
      // 새 촬영을 동반한 재진입만 아래에서 채워/비워진다.
      if (analysis.problems && analysis.problems.length > 0) {
        pageProblemsRef.current = analysis.problems;
      }
      if (problems.length === 1) {
        currentProblemLabelRef.current = problems[0].label;
      }
      const cropFlowOpen = seed.photoSource === 'pi' && !!fetchProblemCropFn;
      // 되묻기가 왜 안 떴는지는 이 세 값 중 하나로 항상 설명된다 - 기기에서
      // 바로 보이게 남긴다 (photoSource='phone' 이면 분기 자체가 닫히고,
      // problems 가 0/1 이면 Gemini 가 문제를 하나로 뭉갠 것).
      console.log(
        `[FSM] problem-choice gate: photoSource=${seed.photoSource} ` +
          `cropFn=${!!fetchProblemCropFn} problems=${problems.length}` +
          `${problems.length ? ` [${problems.map((p) => p.label).join(', ')}]` : ''}`,
      );

      // 분기 1 (다문제): 세션을 시딩하지 않고 어떤 문제인지부터 묻는다.
      // 대답은 submitStudentInput 의 인터셉트가 소비한다. 재진입 시엔
      // problems 를 벗겨서 오므로 (problems: undefined) 다시 안 열린다.
      if (cropFlowOpen && problems.length >= 2) {
        pendingProblemChoiceRef.current = { analysis, seed, initialQuestion, initialUsage };
        // 되묻는 동안 보드 생성이 돌면 안 된다 - 어떤 문제인지 정해진 뒤
        // 재분석 응답이 보드를 결정한다.
        setConversation(
          toConversationPayload({
            ...analysis,
            message: PROBLEM_CHOICE_QUESTION,
            requires_board: false,
            board_update_needed: false,
            board_prompt: '',
          }),
        );
        await speakAndWait(PROBLEM_CHOICE_QUESTION, 'awaiting_input', myTurnId, FIXED_PHRASE_RATE);
        return;
      }

      // D-30 (선지 오인식 방어): 계산한 답이 전사된 선지에 없다는 신호는
      // 대부분 선지를 잘못 읽었다는 뜻이다 (실기기 2026-07-31: ④
      // \frac{80\sqrt{3}}{9} 를 16 으로 읽고 D-27 이 오답 ③ 을 세션에 고정).
      // 프롬프트의 같은 턴 재검토(FINAL_ANSWER_POLICY self-check)가 1차
      // 방어고, 그걸 뚫고 온 불일치는 ERROR 로 바꿔 아래 기존 재인식 사다리
      // (Pi: Tier1 크롭 재분석 → Tier2 재촬영, 폰: 재촬영 안내)를 태운다.
      // 상한 1회: 재인식 후에도 불일치면 힌트 모드는 값을 누설하지 않는
      // 고정 문구로 학생에게 선지 확인을 요청하고, 정답 모드는 모델 메시지
      // (계산 답 + 선지 오식 가능성 언급)를 그대로 쓴다.
      if (analysis.answer_not_in_choices && analysis.fsm_state !== 'ERROR') {
        if (choiceMismatchRef.current.sessionId !== seed.sessionId) {
          choiceMismatchRef.current = { sessionId: seed.sessionId, count: 0 };
        }
        if (choiceMismatchRef.current.count < 1) {
          choiceMismatchRef.current.count += 1;
          console.warn('[FSM] answer_not_in_choices - rerunning recognition ladder (D-30)');
          analysis = {
            ...analysis,
            fsm_state: 'ERROR',
            error_type: 'LOW_IMAGE_QUALITY',
            requires_board: false,
            board_update_needed: false,
            board_prompt: '',
            message: '음, 보기 선지 부분이 좀 헷갈리게 찍혔네. 다시 한번 확인해볼게!',
          };
        } else if (!directSolveMode && choiceMismatchRef.current.count < 2) {
          // count 를 여기서도 올린다. 예전엔 안 올려서 이 분기가 영구히 열려
          // 있었는데, 아래 인터셉트가 학생 대답으로 재분석을 걸기 시작한 뒤로는
          // 그게 곧 무한 루프다 (물어봄 -> 재분석 -> 여전히 불일치 -> 또 물어봄).
          // 두 번째부터는 모델 메시지를 그대로 쓴다 - 계산 답은 이미 final_answer
          // 에 있고, 학생을 같은 질문으로 계속 붙잡는 게 더 나쁘다.
          choiceMismatchRef.current.count += 1;
          console.warn('[FSM] answer_not_in_choices persisted after re-recognition (D-30)');
          analysis = { ...analysis, message: CHOICE_MISMATCH_MESSAGE };
          // 학생이 읽어줄 선지를 받을 준비. 사진이 없으면(개념 질문 세션) 재분석
          // 자체가 불가능하므로 걸지 않는다.
          pendingChoiceReadRef.current = seed.problemImageBase64?.trim() ? seed.sessionId : null;
        }
      }

      // 분기 2 (문제 1개 + 인식 실패): 재촬영을 요구하기 전에 두 단계를 밟는다.
      // Tier 1 - 보관 원본의 해당 bbox 크롭으로 조용히 재분석 (재촬영 없음, ~3초).
      // Tier 2 - 그래도 실패하면 로봇 카메라로 그 bbox 에 AF 를 걸고 재촬영해
      //          재분석 (~20초). 로봇 시나리오에서 폰 카메라를 켜는 건 틀린
      //          UX 다(폰은 거치돼 있음) - 실기기 피드백 2026-07-28.
      // 둘 다 실패해야 재진입된 startSession 이 (problems 없음) 기존 에러
      // 흐름(재촬영 안내 + onCameraNeeded)을 탄다.
      if (
        cropFlowOpen &&
        analysis.fsm_state === 'ERROR' &&
        (analysis.error_type === 'OCR_FAILED' || analysis.error_type === 'LOW_IMAGE_QUALITY') &&
        problems.length >= 1
      ) {
        // 사다리는 Tier1(~3초)+Tier2(~20초) 동안 필러만 던지고 phase 를 건드리지
        // 않아, 화면 마운트 직후면 'idle' 인 채로 그 시간을 다 보냈다 - 눈은
        // 평상시 'conversation' 이고 자막도 로딩 닷도 없어서(getStatusSlot 의
        // 'idle' 은 {kind:'none'}) 학생 눈엔 앱이 멈춘 걸로 보였다. 재분석 구간은
        // 마이크도 닫혀 있어야 한다 - 다른 대기 구간과 같은 'evaluating'.
        setPhase('evaluating');
        const box = problems[0].box_2d;
        const retrySystemPrompt = buildSystemPrompt({
          hasProblemImage: true,
          freshPhoto: true,
          directSolveMode,
        });
        const stillUnreadable = (r: GeminiTutoringResponse) =>
          r.fsm_state === 'ERROR' &&
          (r.error_type === 'OCR_FAILED' || r.error_type === 'LOW_IMAGE_QUALITY');

        // Tier 1: 보관본 크롭 재분석
        let tier1: (GeminiTutoringResponse & { usage?: TokenUsage }) | null = null;
        let tier1Crop = '';
        try {
          speakFn(CROP_RETRY_FILLER, undefined, FIXED_PHRASE_RATE).catch(() => {}); // 재분석 3초의 무음 메우기
          tier1Crop = await fetchProblemCropFn!(box);
          if (isStale(myTurnId)) return;
          debugRecordCapture(seed.sessionId, 'tier1_crop', tier1Crop, box);
          tier1 = await analyzeImageFn(
            tier1Crop,
            sessionFromSeed(seed),
            retrySystemPrompt,
            initialQuestion,
            directSolveMode,
          );
          if (isStale(myTurnId)) return;
          if (!stillUnreadable(tier1)) {
            await startSessionRef.current(
              { ...tier1, problems: undefined },
              { ...seed, problemImageBase64: tier1Crop, usage: carriedUsage },
              initialQuestion,
              tier1.usage,
            );
            return;
          }
        } catch (err) {
          console.warn('[FSM] crop retry failed - trying region re-capture:', err);
        }

        // Tier 2: 로봇 카메라 bbox 재촬영 + 재분석
        if (recapturePiRegionFn && fetchPiPhotoFn) {
          try {
            speakFn(REGION_RECAPTURE_FILLER, undefined, FIXED_PHRASE_RATE).catch(() => {});
            await recapturePiRegionFn(box);
            // region 촬영은 Pi 보관본을 "그 영역만 담은 프레임" 으로 덮는다 -
            // 기존 페이지 전체 좌표는 여기서 죽는다.
            pageProblemsRef.current = undefined;
            if (isStale(myTurnId)) return;
            const shot = await fetchPiPhotoFn();
            if (isStale(myTurnId)) return;
            debugRecordCapture(seed.sessionId, 'tier2_recapture', shot, box);
            const fresh = await analyzeImageFn(
              shot,
              sessionFromSeed(seed),
              retrySystemPrompt,
              initialQuestion,
              directSolveMode,
            );
            if (isStale(myTurnId)) return;
            // 성공이든 여전히 ERROR 든 재진입 - ERROR 면 problems 가 없으니
            // 재진입 쪽이 기존 재촬영 안내 흐름을 탄다.
            await startSessionRef.current(
              { ...fresh, problems: undefined },
              { ...seed, problemImageBase64: shot, usage: carriedUsage },
              initialQuestion,
              fresh.usage,
            );
            return;
          } catch (err) {
            console.warn('[FSM] region re-capture failed - falling back to error flow:', err);
          }
        }

        // Tier 1 결과라도 있으면 그걸로 재진입해 에러 안내를 태운다.
        if (tier1) {
          await startSessionRef.current(
            { ...tier1, problems: undefined },
            { ...seed, problemImageBase64: tier1Crop, usage: carriedUsage },
            initialQuestion,
            tier1.usage,
          );
          return;
        }
        // fall through: 아래 기존 흐름이 에러 메시지 발화 + onCameraNeeded 처리
      }

      // 분기 3 (단일 문제 크롭): 문제가 1개만 감지된 정상 분석도 세션 사진을
      // 페이지 전체가 아니라 그 문제의 bbox 크롭으로 바꾼다 - 판서가 문제집
      // 한 페이지를 통째로 전사하던 구멍의 수정 (실기기 피드백 2026-07-30).
      // 재분석은 하지 않는다: problem_facts 는 풀프레임 분석에서 이미 정확하고,
      // 크롭은 판서 base·EVAL 문맥용 이미지만 좁힌다. Pi 는 보관 원본 크롭
      // (fetchProblemCropFn), 폰은 세션 사진 로컬 크롭(cropLocalImageFn).
      // 실패 시 풀프레임 유지 - 크롭은 개선이지 필수가 아니다.
      if (analysis.fsm_state !== 'ERROR' && problems.length === 1 && problems[0].box_2d) {
        try {
          const box = problems[0].box_2d;
          let crop: string | null = null;
          if (cropFlowOpen) crop = await fetchProblemCropFn!(box);
          else if (cropLocalImageFn && seed.problemImageBase64) {
            crop = await cropLocalImageFn(seed.problemImageBase64, box);
          }
          if (isStale(myTurnId)) return;
          if (crop) {
            debugRecordCapture(seed.sessionId, 'single_problem_crop', crop, box);
            seed = { ...seed, problemImageBase64: crop };
          }
        } catch (err) {
          console.warn('[FSM] single-problem crop failed - keeping full frame:', err);
        }
      }

      // Defensive backstop, same reasoning as submitStudentInput's
      // solveJumpAuthorized guard: the FIRST turn has no wrongStreak/consent
      // history yet, so the ONLY legitimate way to see SOLVE_STAGE here is
      // "바로 정답" mode being on. If the initial image/concept analysis
      // returns SOLVE_STAGE while directSolveMode is off (e.g. the
      // student's very first question was "답 알려줘", or the model
      // misjudged), this MUST happen before `analysis.message` is ever put
      // into session/conversation state or spoken - coercing fsm_state
      // alone is not enough, because Gemini already wrote `message` (and
      // possibly board_prompt) as a full worked solution once it decided
      // SOLVE_STAGE. Trusting that text and merely relabeling the state
      // would still leak the answer via TTS/subtitles. So the leaked
      // fields are replaced with a fixed refusal instead of Gemini's text.
      // Turn-1 SOLVE_STAGE is now also legitimately reachable when the photo
      // shows the student's OWN work already fully correct (STUDENT_SOLUTION_
      // POLICY closes immediately in that case, same as ANSWER_CONFIRMATION_
      // POLICY does mid-conversation) - is_on_correct_path===true is the same
      // authorization signal submitStudentInput's solveJumpAuthorized uses.
      if (
        analysis.fsm_state === 'SOLVE_STAGE' &&
        !directSolveMode &&
        analysis.is_on_correct_path !== true
      ) {
        console.warn(
          '[FSM] blocked unauthorized SOLVE_STAGE on first turn - refusing instead of speaking the leaked solution',
        );
        analysis = {
          ...analysis,
          fsm_state: 'HINT_STAGE',
          explicit_answer_request: false,
          is_on_correct_path: null,
          requires_board: false,
          board_update_needed: false,
          board_prompt: '',
          message:
            '정답은 바로 알려줄 수 없어. 문제를 같이 하나씩 풀어보자 - 어디까지 풀었는지 말해줄래?',
        };
      }

      // 로봇 세션의 첫 분석 ERROR 는 폰 카메라가 아니라 로봇 풀프레임
      // 재촬영으로 먼저 대응한다 (실기기 피드백 2026-07-29: 회전된 사진에
      // Gemini 가 problems bbox 를 하나도 못 잡으면 Tier1/2 사다리가
      // `problems.length >= 1` 게이트에 걸려 아예 안 열리고, 종단 분기가 곧장
      // 폰 카메라를 켰다 - 폰은 거치돼 있어 틀린 UX 다).
      // 판정을 세션 구성·발화보다 먼저 하는 이유는 submitStudentInput 의 ERROR
      // 분기와 같다: Gemini 의 ERROR 문구는 "사진 다시 찍어볼까?" 같은
      // 질문형인데, 예전엔 그걸 먼저 말하고 학생 대답을 받지도 않은 채 곧바로
      // PI_RETAKE_FILLER 를 또 말했다 - 묻고 자문자답하는 꼴이었고, history 엔
      // Gemini 문구만 남아 들은 말과 기록도 어긋났다 (실기기 피드백 2026-08-05).
      // 로봇이 알아서 찍을 거라 질문 자체가 무의미하다 - 안내 한 문장으로 덮는다.
      // 세션당 1회 제한: 재촬영해도 같은 ERROR 면 그 다음은 폰 카메라가 최종
      // 종결자다 (무한 촬영 루프 방지 - handleCameraNeeded 주석 참고).
      if (piErrorRetakeRef.current.sessionId !== seed.sessionId) {
        piErrorRetakeRef.current = { sessionId: seed.sessionId, count: 0 };
      }
      const retakeError =
        analysis.fsm_state === 'ERROR' &&
        (analysis.error_type === 'OCR_FAILED' || analysis.error_type === 'LOW_IMAGE_QUALITY');
      const piFirstRetake =
        retakeError &&
        photoSourceRef.current === 'pi' &&
        !!capturePhotoNowFn &&
        !!fetchPiPhotoFn &&
        piErrorRetakeRef.current.count < 1;
      // 로봇 사다리를 다 쓰고 폰 폴백 질문으로 끝나는 경로도 같은 자문자답이었다:
      // Gemini 의 "사진 찍어서 보여줘" 를 말한 직후 PHONE_FALLBACK_QUESTION
      // ("스마트폰 카메라로 찍게 도와줄까?")이 또 나갔다. 앞 문구는 폰이 거치된
      // 로봇 모드에서 학생이 실행할 수 없는 지시고, 뒷 질문이 같은 내용을 이미
      // 담고 있다 - 질문 하나만 남긴다. onCameraNeeded 가 없으면 폴백 질문 자체가
      // 없으므로(세션 즉시 종료) 이 치환을 하면 무음이 된다.
      const piPhoneFallback =
        retakeError && photoSourceRef.current === 'pi' && !piFirstRetake && !!onCameraNeeded;
      if (piFirstRetake) {
        piErrorRetakeRef.current.count += 1;
        analysis = { ...analysis, message: PI_RETAKE_FILLER };
        // 안내 발화(~3초)를 AF 사이클(실측 5.7초)로 덮는다 - await 하지 않는다.
        prewarmPiFocusFn?.();
      } else if (piPhoneFallback) {
        // 발화는 requestPhoneFallback 이 담당한다. 여기서 message 를 갈아끼우는
        // 건 history·자막이 실제로 들은 문장과 일치하게 하기 위해서다.
        analysis = {
          ...analysis,
          message: PHONE_FALLBACK_QUESTION,
          requires_board: false,
          board_update_needed: false,
          board_prompt: '',
        };
      }

      // 손글씨 되묻기 (스펙 v2): 같은 이미지를 3회 독립 판독해 값이 갈리면
      // 모델 message 대신 확인 질문을 말한다. 대답 인터셉트는 submitStudentInput.
      // is_on_correct_path === null 은 "판단할 학생 풀이가 없었다" 는 뜻이라
      // (OUTPUT_FORMAT_POLICY) 인쇄된 문제만 찍은 사진에는 호출이 안 나간다.
      if (handwritingAskBackRef.current.sessionId !== seed.sessionId) {
        handwritingAskBackRef.current = { sessionId: seed.sessionId, count: 0 };
      }
      const askBackImage = seed.problemImageBase64?.trim() ?? '';
      let askBack: HandwritingAskBack = { askBack: false };
      if (
        !piPhoneFallback &&
        !directSolveMode &&
        !pendingChoiceReadRef.current &&
        analysis.fsm_state !== 'ERROR' &&
        // is_on_correct_path !== null 은 "채점할 손글씨가 있었다" 의 대리 신호다.
        // 그런데 글씨를 못 읽으면 판단 자체가 불가라 null 로 떨어져, "확신 없을
        // 때 되묻는 장치" 가 "이미 확신했을 것" 을 입장 조건으로 거는 모순이 된다.
        // OCR_UNCERTAIN 은 모델이 "이 턴에서 기대야 할 글씨를 못 읽겠다" 고
        // 명시한 경우라 정확히 되물어야 하는 자리다 (2026-08-07).
        (analysis.is_on_correct_path !== null ||
          analysis.misconception_type === 'OCR_UNCERTAIN') &&
        askBackImage.length > 0 &&
        // problems.length >= 2 면 (폰 세션이거나 crop 함수 미주입인 Pi 세션 -
        // 729행 분기 1 은 cropFlowOpen 일 때만 연다) 분기 3(898행)의 단일
        // 문제 크롭이 안 걸려 askBackImage 가 아직 페이지 풀프레임이다. 그
        // 상태로 3회 판독하면 서로 다른 문제의 답을 각각 집어(예: 3번 문제
        // 답 "12" vs 5번 문제 답 "7") 진짜 손글씨 모호성이 아닌 "다른 문제"
        // 불일치로 가짜 되묻기가 뜬다. 크롭 재진입은 problems: undefined 로
        // 오므로(706행) problems 가 [] 로 떨어져 여기 영향이 없다.
        problems.length <= 1 &&
        handwritingAskBackRef.current.count < HANDWRITING_ASKBACK_MAX
      ) {
        // Tier1/2 사다리(799행)와 같은 이유: 이 판독 구간(~1-3초, 429 재시도가
        // 겹치면 최대 ~7초)에 phase 를 안 건드리면 마운트 직후엔 'idle' 그대로
        // 라 자막/로딩 닷이 안 뜨고 마이크도 열려 있다 - handleMicPress 가
        // 아직 시딩 안 된 세션에 대고 학생 발화를 받아버린다.
        setPhase('evaluating');
        const settled = await Promise.allSettled(
          Array.from({ length: HANDWRITING_READ_COUNT }, () =>
            recognizeHandwritingFn(askBackImage),
          ),
        );
        if (isStale(myTurnId)) return;
        const ok = settled.filter(
          (s): s is PromiseFulfilledResult<{ candidates: string[]; usage: TokenUsage }> =>
            s.status === 'fulfilled',
        );
        // 인식 실패는 세션을 막지 않는다 - 성공분이 2개 미만이면 그냥 진행.
        ok.forEach((s) => {
          carriedUsage = addTextUsage(carriedUsage ?? EMPTY_USAGE_SUMMARY, s.value.usage);
        });
        const reads = ok.map((s) => s.value.candidates);
        askBack = voteHandwriting(reads);
        console.log(
          `[FSM] handwriting vote: reads=[${ok
            .map((s) => `[${s.value.candidates.join('|')}]`)
            .join(', ')}] failed=${settled.length - ok.length}/${HANDWRITING_READ_COUNT} ` +
            `pattern=${describeVotePattern(reads)} ` +
            `askBack=${askBack.askBack}`,
        );
      } else {
        // 안 돌았으면 왜 안 돌았는지를 남긴다 - 717행 problem-choice gate 와
        // 같은 이유로, 되묻기가 한 번도 안 뜬 실기기 run 에서 게이트 8개를
        // 손으로 소거하는 비용을 없앤다. 위 로그는 게이트를 통과한 경우만
        // 찍히므로 이 else 가 없으면 무발동 케이스가 통째로 안 보인다.
        console.log(
          `[FSM] handwriting gate blocked: piPhoneFallback=${piPhoneFallback} ` +
            `directSolve=${!!directSolveMode} choiceRead=${!!pendingChoiceReadRef.current} ` +
            `state=${analysis.fsm_state} onPath=${analysis.is_on_correct_path} ` +
            `misconception=${analysis.misconception_type} ` +
            `img=${askBackImage.length > 0} problems=${problems.length} ` +
            `count=${handwritingAskBackRef.current.count}/${HANDWRITING_ASKBACK_MAX}`,
        );
      }
      if (askBack.askBack) {
        handwritingAskBackRef.current.count += 1;
        analysis = {
          ...analysis,
          message: askBack.question,
          // 되묻는 턴은 세션을 닫으면 안 된다 - SOLVE_STAGE 자동 종료
          // (isImmediateSolve)로 빠지는 걸 막고 학생 대답을 기다린다.
          fsm_state: 'EVAL',
          // requires_board 는 갈아끼우지 않는다 - 첫 사진 턴에서
          // BOARD_PROMPT_POLICY 가 기본 true 로 여는 유일한 지점인데, 여기서
          // false 로 죽이면 세션 내내 판서가 한 번도 안 뜰 수 있다 (cc60dd0
          // 재발). board_update_needed 만 꺼서 board 이펙트가 안전한 전사
          // 지시로 떨어지게 한다.
          board_update_needed: false,
          board_prompt: '',
        };
        pendingHandwritingAskBackRef.current = {
          sessionId: seed.sessionId,
          retried: false,
          base: analysis,
        };
      }

      // 재촬영으로 돌아온 경우 seed 가 직전 세션의 연속성 값을 들고 온다
      // (없으면 새 세션과 똑같이 0에서 시작).
      const resumedHistory = seed.history ?? [];
      const initialSession: TutoringSession = {
        sessionId: seed.sessionId,
        problemImageBase64: seed.problemImageBase64,
        fsmState: analysis.fsm_state,
        hintCount: (seed.hintCount ?? 0) + 1,
        wrongStreak: seed.wrongStreak ?? 0,
        boardRegenerationCount: 0,
        lastBoardImageBase64: undefined,
        topic: analysis.topic,
        title: analysis.title,
        lastMistakeReason:
          analysis.is_on_correct_path === false && analysis.mistake_reason
            ? analysis.mistake_reason
            : undefined,
        problemFacts: analysis.problem_facts?.trim() || undefined,
        finalAnswer: analysis.final_answer?.trim() || undefined,
        // carriedUsage 는 seed.usage + initialUsage 로 시작해(위 선언부) 손글씨
        // 되묻기 판독 usage 까지 접어둔 값이다 - 여기서 같은 두 값으로 다시
        // 계산하면 판독 비용이 세션 합계에서 빠진다.
        usage: carriedUsage ?? EMPTY_USAGE_SUMMARY,
        history: initialQuestion
          ? [
              ...resumedHistory,
              { role: 'user', message: initialQuestion, timestamp: Date.now() },
              { role: 'model', message: forHistory(analysis.message), timestamp: Date.now() },
            ]
          : [
              ...resumedHistory,
              { role: 'model', message: forHistory(analysis.message), timestamp: Date.now() },
            ],
      };
      const displayAnalysis = analysis;
      setSessionState(initialSession);
      setConversation(toConversationPayload(displayAnalysis));

      backgroundSaveSession(initialSession, analysis);

      logSessionEvent({
        sessionId: initialSession.sessionId,
        appState: 'conversation',
        fsmState: analysis.fsm_state,
        timestamp: Date.now(),
        meta: {
          isOnCorrectPath: analysis.is_on_correct_path,
          explicitAnswerRequest: analysis.explicit_answer_request,
          requiresBoard: analysis.requires_board,
          boardUpdateNeeded: analysis.board_update_needed,
          hintCount: initialSession.hintCount,
          wrongStreak: initialSession.wrongStreak,
          boardRegenerationCount: initialSession.boardRegenerationCount,
          confidence: analysis.confidence,
          errorType: analysis.error_type,
          misconceptionType: analysis.misconception_type,
        },
      });

      const isImmediateSolve = analysis.fsm_state === 'SOLVE_STAGE';
      // piPhoneFallback 은 requestPhoneFallback 이 같은 문장을 말하므로 여기서
      // 말하지 않는다 (말하면 같은 질문이 두 번 나간다).
      // piFirstRetake 면 phase 를 'awaiting_input' 이 아니라 'evaluating' 으로
      // 둔다 - 20초 촬영 동안 눈은 processing 이고 마이크는 닫혀 있어야 한다
      // (submitStudentInput 의 piRetake 와 동일).
      if (!piPhoneFallback) {
        await speakAndWait(
          analysis.message,
          isImmediateSolve ? 'done' : piFirstRetake ? 'evaluating' : 'awaiting_input',
          myTurnId,
          piFirstRetake ? FIXED_PHRASE_RATE : undefined,
        );
      }
      if (isStale(myTurnId)) return;

      // 되묻기를 말했으면 무응답 타이머를 건다 (멍때림 대비).
      if (pendingHandwritingAskBackRef.current) armAskBackTimer(myTurnId);

      // directSolveMode (and, defensively, any future policy that answers a
      // problem in full on the very first turn) means this session is
      // already finished - there is no HINT_STAGE loop to wait on. Mirrors
      // finishWithSolution(): phase settles at 'done' and the solution
      // stays on screen (board + message) instead of auto-navigating home -
      // the student taps the explicit "back to home" button when ready.
      if (isImmediateSolve) {
        // Same distinction finishWithSolution makes: a revealed answer
        // (directSolveMode) stays on screen for the student to study, but
        // the student's own photographed work being fully correct is a
        // genuine "session complete" moment - close it out automatically
        // instead of leaving them staring at a screen with nothing to do.
        if (analysis.is_on_correct_path === true) {
          onSessionComplete?.();
        }
        return;
      }

      if (
        analysis.fsm_state === 'ERROR' &&
        (analysis.error_type === 'OCR_FAILED' || analysis.error_type === 'LOW_IMAGE_QUALITY')
      ) {
        // piFirstRetake 판정과 안내 발화는 위(세션 구성 직전)에서 이미 끝났다 -
        // 여기서는 그 결과대로 찍기만 한다. 재진입 프레임에서 사다리가 다시
        // 유효하도록 problems 는 벗기지 않는다.
        if (piFirstRetake) {
          try {
            await capturePhotoNowFn!();
            // 새 촬영 = 보관본 교체. 옛 프레임 좌표를 비우고, 재진입 분석의
            // problems 가 새 프레임 기준으로 다시 채운다.
            pageProblemsRef.current = undefined;
            if (isStale(myTurnId)) return;
            const shot = await fetchPiPhotoFn!();
            if (isStale(myTurnId)) return;
            debugRecordCapture(seed.sessionId, 'pi_retake', shot);
            const fresh = await analyzeImageFn(
              shot,
              sessionFromSeed(seed),
              buildSystemPrompt({ hasProblemImage: true, freshPhoto: true, directSolveMode }),
              initialQuestion,
              directSolveMode,
            );
            if (isStale(myTurnId)) return;
            await startSessionRef.current(
              fresh,
              { ...seed, problemImageBase64: shot, usage: carriedUsage },
              initialQuestion,
              fresh.usage,
            );
            return;
          } catch (err) {
            console.warn(
              '[FSM] pi first-analysis retake failed - falling back to the phone camera:',
              err,
            );
          }
        }
        // D-37: 로봇 세션은 폰 카메라를 열기 전에 음성으로 묻는다. 폰 세션은
        // 학생이 이미 폰을 들고 있으므로 기존처럼 바로 연다.
        // recordSessionId 를 넘긴다: 예전엔 "startSession 은 아직 세션이 없다"
        // 며 안 넘겼는데, 지금 이 지점은 setSessionState(initialSession) 뒤라
        // sessionRef.current 가 항상 이번 세션이다. 안 넘기면 학생의 동의/거절
        // 발화와 거절 마무리 발화가 이력·저장에서 통째로 빠진다 - "히스토리에
        // 내 발화가 없다" 회귀의 원인 1 (실기기 2026-08-05).
        if (photoSourceRef.current === 'pi') {
          await requestPhoneFallback(initialQuestion || '', analysis, myTurnId, seed.sessionId);
        } else if (onCameraNeeded) {
          onCameraNeeded(initialQuestion || '', resumeSnapshot());
        }
      }
    },
    [
      setSessionState,
      speakAndWait,
      requestPhoneFallback,
      onCameraNeeded,
      isStale,
      directSolveMode,
      backgroundSaveSession,
      resumeSnapshot,
      speakFn,
      analyzeImageFn,
      recognizeHandwritingFn,
      fetchProblemCropFn,
      capturePhotoNowFn,
      fetchPiPhotoFn,
      prewarmPiFocusFn,
      clearAskBackTimer,
      armAskBackTimer,
    ],
  );

  // 크롭 재분석 후 startSession 을 재진입하기 위한 자기 참조 (useCallback 은
  // 자기 자신을 deps 로 가질 수 없다).
  const startSessionRef = useRef(startSession);
  startSessionRef.current = startSession;

  const finishWithSolution = useCallback(
    async (
      response: GeminiTutoringResponse & { usage?: TokenUsage },
      currentHistory: { role: 'user' | 'model'; message: string }[] = [],
      turnId: number,
      autoReturnHome: boolean = false,
    ) => {
      const solved = forceSolveStage(response);
      const nextSession: TutoringSession = {
        ...sessionRef.current,
        fsmState: 'SOLVE_STAGE',
        topic: solved.topic,
        title: solved.title,
        usage: addTextUsage(
          sessionRef.current.usage ?? EMPTY_USAGE_SUMMARY,
          response.usage ?? EMPTY_TOKEN_USAGE,
        ),
        history: [
          ...currentHistory,
          { role: 'model' as const, message: forHistory(solved.message), timestamp: Date.now() },
        ],
      };
      setSessionState(nextSession);
      setConversation(toConversationPayload(solved));

      backgroundSaveSession(nextSession, response);

      logEvent('conversation', 'SOLVE_STAGE', {
        isOnCorrectPath: solved.is_on_correct_path,
        explicitAnswerRequest: solved.explicit_answer_request,
        requiresBoard: solved.requires_board,
        boardUpdateNeeded: solved.board_update_needed,
        hintCount: nextSession.hintCount,
        wrongStreak: nextSession.wrongStreak,
        boardRegenerationCount: nextSession.boardRegenerationCount,
        confidence: solved.confidence,
        errorType: solved.error_type,
        misconceptionType: solved.misconception_type,
      });

      await speakAndWait(solved.message, 'done', turnId);
      if (isStale(turnId)) return;

      // Two different endings share this function, and they behave
      // differently on purpose:
      // - "정답 모드" / 동의 후 정답 공개: VIVA is handing over an answer the
      //   student didn't reach themselves - stay on the solution screen
      //   (board image + final message) so they can actually study it. They
      //   leave via the explicit "back to home" button.
      // - The student solved it themselves and just confirmed the correct
      //   FINAL answer (`autoReturnHome`, driven by is_on_correct_path===true
      //   at SOLVE_STAGE - see ANSWER_CONFIRMATION_POLICY): this is a genuine
      //   "session complete" moment. VIVA's closing message already wraps up
      //   with the unit name + an encouraging remark, so once that's spoken
      //   the session should end on its own instead of waiting for a tap.
      if (autoReturnHome) {
        onSessionComplete?.();
      }
    },
    [logEvent, setSessionState, speakAndWait, isStale, backgroundSaveSession, onSessionComplete],
  );

  const submitStudentInput = useCallback(
    async (text: string, overrides?: { directSolveMode?: boolean }) => {
      // Barge-in: claim a new turn epoch and cut any in-flight TTS
      // immediately. Any previous turn still evaluating/speaking will see its
      // id is no longer latest at its next checkpoint and abandon itself, so
      // this new utterance interrupts instead of being dropped. The TTS stop
      // is fire-and-forget (no await) so we don't add an async gap before
      // entering 'evaluating'. (Board image generation runs on its own effect
      // and is intentionally left alone, per requirement.)
      const myTurnId = ++turnIdRef.current;
      stopSpeakingFn().catch(() => {});
      const effectiveDirectSolveMode = overrides?.directSolveMode ?? directSolveMode;
      // 학생이 말했으니 대기 타이머는 죽인다. 재질문 경로가 다시 건다.
      clearAskBackTimer();

      // D-37 폰 폴백 되묻기 대답 인터셉트: 이 발화는 튜터링 입력이 아니라
      // 폰 카메라 전환 여부의 대답이다. 동의만 전환으로 보고, 그 외("아니",
      // 딴소리, STT 오인식)는 전부 세션 종료 - 잘못 열린 카메라보다 잘못
      // 닫힌 세션이 복구 비용이 싸다(웨이크워드로 다시 부르면 된다).
      const pendingFallback = pendingPhoneFallbackRef.current;
      if (pendingFallback) {
        pendingPhoneFallbackRef.current = null;
        // requestPhoneFallback 이 물었을 때 진짜 세션이 있었을 때만 이 학생
        // 발화(동의/거절)를 이력에 남긴다 - 세션 없이 물은 경로(최초 촬영
        // 직후 에러)는 엉뚱한 이전 세션에 섞여 들어가는 걸 막기 위해 스킵.
        const hasSession =
          !!pendingFallback.recordSessionId &&
          sessionRef.current.sessionId === pendingFallback.recordSessionId;
        if (isConsentPhrase(text, CONSENT_WORDS_AFTER_HELP_ASK)) {
          if (hasSession) {
            setSessionState({
              ...sessionRef.current,
              history: [
                ...(sessionRef.current.history ?? []),
                { role: 'user', message: text, timestamp: Date.now() },
              ],
            });
          }
          onCameraNeeded?.(pendingFallback.question, resumeSnapshot());
          return;
        }
        setConversation(
          toConversationPayload({
            ...pendingFallback.base,
            message: PHONE_FALLBACK_DECLINE_MESSAGE,
            requires_board: false,
            board_update_needed: false,
            board_prompt: '',
          }),
        );
        if (hasSession) {
          const declinedSession: TutoringSession = {
            ...sessionRef.current,
            history: [
              ...(sessionRef.current.history ?? []),
              { role: 'user', message: text, timestamp: Date.now() },
              { role: 'model', message: PHONE_FALLBACK_DECLINE_MESSAGE, timestamp: Date.now() },
            ],
          };
          setSessionState(declinedSession);
          // 거절로 세션이 여기서 끝나는데 기존 코드엔 이 마지막 문답을 저장하는
          // 호출이 아예 없었다 - 세션 종료 직전 상태가 통째로 유실되던 버그.
          backgroundSaveSession(declinedSession, pendingFallback.base);
        }
        await speakAndWait(PHONE_FALLBACK_DECLINE_MESSAGE, 'done', myTurnId, FIXED_PHRASE_RATE);
        onSessionComplete?.();
        return;
      }

      // D-30 선지 확인 대답 인터셉트: 이 발화는 풀이 시도가 아니라 학생이
      // 읽어준 보기 선지다. 일반 EVAL 턴으로 흘리면 프롬프트가 problem_facts /
      // final_answer 재도출을 막고 있어 잘못 읽힌 선지가 그대로 굳는다 - 원본
      // 사진을 이 발화와 함께 다시 분석해야 FINAL_ANSWER_POLICY 의 선지 대조가
      // 새 정보로 다시 돌아간다 (freshPhoto 턴에서만 열리는 정책들).
      const pendingChoiceRead = pendingChoiceReadRef.current;
      if (pendingChoiceRead) {
        pendingChoiceReadRef.current = null;
        const image = sessionRef.current.problemImageBase64;
        if (pendingChoiceRead === sessionRef.current.sessionId && image?.trim()) {
          try {
            setPhase('evaluating');
            const fresh = await analyzeImageFn(
              image,
              sessionRef.current,
              buildSystemPrompt({
                hasProblemImage: true,
                freshPhoto: true,
                directSolveMode: effectiveDirectSolveMode,
              }),
              text,
              effectiveDirectSolveMode,
            );
            if (isStale(myTurnId)) return;
            // 같은 사진 = 이미 이 세션에서 문제 선택이 끝난 프레임. problems 를
            // 그대로 넘기면 "몇 번 문제 풀고 있어?" 되묻기가 다시 열린다.
            await startSessionRef.current(
              { ...fresh, problems: undefined },
              {
                ...resumeSnapshot(),
                problemImageBase64: image,
                photoSource: photoSourceRef.current,
                // 학생 발화는 analyzeImage 문맥으로 이미 넘겼다. 여기서 직접
                // 이력에 넣고 initialQuestion 은 비운다 - 둘 다 하면 같은 발화가
                // 두 번 쌓인다 (pi 재촬영 경로가 지키는 규칙과 동일).
                history: [
                  ...(sessionRef.current.history ?? []),
                  { role: 'user', message: text, timestamp: Date.now() },
                ],
              },
              undefined,
              fresh.usage,
            );
            return;
          } catch (err) {
            // 재분석이 실패해도 학생 발화는 살린다 - 아래 일반 EVAL 턴으로.
            console.warn('[FSM] choice re-read analysis failed - falling through to EVAL:', err);
          }
        }
      }

      // 손글씨 되묻기 대답 인터셉트 (스펙 2026-08-07): 대답을 3분류해 갈래별로
      // 처리한다. answer 만 "학생이 확정한 답" 프리픽스를 달고 EVAL 로 흐르고,
      // confused/cant_read 는 모델을 안 부르고 여기서 끝낸다 - 예전엔 무조건
      // 프리픽스를 붙여 "나도 모르겠어" 를 최종 답으로 채점시켰다.
      let evalText = text;
      const pendingAskBack = pendingHandwritingAskBackRef.current;
      if (pendingAskBack) {
        if (pendingAskBack.sessionId === sessionRef.current.sessionId) {
          const kind = classifyAskBackReply(text);
          console.log(
            `[FSM] askback reply: kind=${kind} retried=${pendingAskBack.retried} text="${text}"`,
          );
          if (kind === 'answer') {
            pendingHandwritingAskBackRef.current = null;
            console.log('[FSM] askback outcome: resolved');
            evalText = `내가 종이에 쓴 최종 답을 말해줄게: ${text}`;
          } else if (kind === 'confused' && !pendingAskBack.retried) {
            // 재질문은 되묻기당 1회. pending 을 살려둬야 다음 대답도 이 갈래로 온다.
            pendingAskBack.retried = true;
            await speakAskBackFollowUp(
              HANDWRITING_ASKBACK_RETRY,
              pendingAskBack.base,
              myTurnId,
              text,
            );
            if (!isStale(myTurnId)) armAskBackTimer(myTurnId);
            return;
          } else {
            // cant_read 이거나 재질문까지 썼다 - 답 확인을 포기하고 풀이 과정으로
            // 넘긴다. 답 값이 아니라 채점이 목적이라 풀이를 들으면 이어진다.
            pendingHandwritingAskBackRef.current = null;
            console.log('[FSM] askback outcome: explain_fallback');
            await speakAskBackFollowUp(
              HANDWRITING_ASKBACK_FALLBACK,
              pendingAskBack.base,
              myTurnId,
              text,
            );
            return;
          }
        } else {
          // 세션이 갈렸으면 이 대기는 죽은 것 - 조용히 버린다(기존 동작).
          pendingHandwritingAskBackRef.current = null;
        }
      }

      // 다문제 되묻기 대답 인터셉트: 이 발화는 튜터링 입력이 아니라 문제
      // 선택이다. 매칭 성공 -> 해당 bbox 크롭으로 재분석해 세션 시작.
      const pending = pendingProblemChoiceRef.current;
      if (pending) {
        pendingProblemChoiceRef.current = null;
        const matched = matchProblemLabel(text, pending.analysis.problems ?? []);
        if (matched && fetchProblemCropFn) {
          try {
            setPhase('evaluating');
            currentProblemLabelRef.current = matched.label;
            const crop = await fetchProblemCropFn(matched.box_2d);
            if (isStale(myTurnId)) return;
            debugRecordCapture(pending.seed.sessionId, 'problem_choice_crop', crop, matched.box_2d);
            const choiceSystemPrompt = buildSystemPrompt({
              hasProblemImage: true,
              freshPhoto: true,
              directSolveMode: effectiveDirectSolveMode,
            });
            const fresh = await analyzeImageFn(
              crop,
              sessionFromSeed(pending.seed),
              choiceSystemPrompt,
              pending.initialQuestion,
              effectiveDirectSolveMode || undefined,
            );
            if (isStale(myTurnId)) return;
            await startSessionRef.current(
              { ...fresh, problems: undefined },
              {
                ...pending.seed,
                problemImageBase64: crop,
                // 되묻기 전의 풀프레임 분석(call 0) 비용을 승계한다.
                usage: pending.initialUsage
                  ? addTextUsage(EMPTY_USAGE_SUMMARY, pending.initialUsage)
                  : undefined,
                // 실제 발화("몇 번 풀고 있어?")와 학생의 대답("60번")을 이력에
                // 남긴다 - 매칭 성공 경로엔 이게 아예 빠져 있어서(아래 매칭
                // 실패 경로만 기록) export/디버깅에서 이 문답이 통째로
                // 사라지던 문제의 수정.
                history: [
                  ...(pending.seed.history ?? []),
                  { role: 'model', message: PROBLEM_CHOICE_QUESTION, timestamp: Date.now() },
                  { role: 'user', message: text, timestamp: Date.now() },
                ],
              },
              pending.initialQuestion,
              fresh.usage,
            );
            return;
          } catch (err) {
            console.warn('[FSM] problem-choice crop failed - falling back to full frame:', err);
          }
        }

        // 매칭 실패/크롭 실패. 예전엔 여기서 startSession(pending.analysis) 로
        // 되돌아갔는데, 다문제 사진에 대한 Gemini 의 원본 message 는 거의 항상
        // "몇 번 풀어볼까?" 라서 방금 대답한 학생에게 같은 질문을 한 번 더
        // 하는 꼴이었다 (되묻기 2회). 대신 이미 물었던 질문을 대화 이력에
        // 넣어두고, 학생의 이 발화를 풀프레임 사진과 함께 일반 입력으로
        // 그대로 평가한다 - 질문은 언제나 한 번만 나간다.
        setSessionState({
          sessionId: pending.seed.sessionId,
          problemImageBase64: pending.seed.problemImageBase64,
          fsmState: 'HINT_STAGE',
          hintCount: pending.seed.hintCount ?? 0,
          wrongStreak: pending.seed.wrongStreak ?? 0,
          boardRegenerationCount: 0,
          topic: pending.analysis.topic,
          title: pending.analysis.title,
          usage: pending.initialUsage
            ? addTextUsage(EMPTY_USAGE_SUMMARY, pending.initialUsage)
            : EMPTY_USAGE_SUMMARY,
          // 실제로 발화된 것은 PROBLEM_CHOICE_QUESTION 이지 analysis.message 가
          // 아니다 - 이력에도 학생이 들은 대로 남긴다.
          history: [
            ...(pending.seed.history ?? []),
            { role: 'model', message: PROBLEM_CHOICE_QUESTION, timestamp: Date.now() },
          ],
        });
        // 아래 일반 EVAL 턴으로 그대로 흘려보낸다 (return 없음).
      }

      // 대화 중 문제 전환 인터셉트: "59번은 됐으니까 60번 풀어줘". EVAL 첨부는
      // 현재 문제의 전사 판서뿐이라 Gemini 는 60번을 볼 수 없지만, Pi 보관본
      // (풀프레임)은 그대로고 첫 분석의 bbox 도 pageProblemsRef 에 있다 -
      // 물어보지 않고 앱이 해당 크롭으로 새 세션을 연다. 새 문제 = 새 세션
      // (힌트/오답 카운터·이력은 문제 단위 상태라 끌고 가면 안 된다). 직전
      // 세션은 매 턴 backgroundSaveSession 으로 이미 저장돼 있다.
      // 감지가 애매하면(matchProblemSwitch null) 일반 EVAL 로 흘러가고, 그땐
      // ERROR_POLICY 의 구조화 ERROR → 로봇 재촬영 사다리가 받는다.
      if (
        !pending &&
        photoSourceRef.current === 'pi' &&
        fetchProblemCropFn &&
        (pageProblemsRef.current?.length ?? 0) >= 2
      ) {
        const switchTo = matchProblemSwitch(
          text,
          pageProblemsRef.current!,
          currentProblemLabelRef.current,
        );
        if (switchTo) {
          try {
            setPhase('evaluating');
            console.log(
              `[FSM] problem switch: ${currentProblemLabelRef.current ?? '?'} -> ${switchTo.label}`,
            );
            speakFn(PROBLEM_SWITCH_FILLER, undefined, FIXED_PHRASE_RATE).catch(() => {});
            const crop = await fetchProblemCropFn(switchTo.box_2d);
            if (isStale(myTurnId)) return;
            const newSessionId = `session-${Date.now()}`;
            debugRecordCapture(newSessionId, 'problem_choice_crop', crop, switchTo.box_2d);
            const fresh = await analyzeImageFn(
              crop,
              sessionFromSeed({ sessionId: newSessionId, problemImageBase64: crop }),
              buildSystemPrompt({
                hasProblemImage: true,
                freshPhoto: true,
                directSolveMode: effectiveDirectSolveMode,
              }),
              text,
              effectiveDirectSolveMode || undefined,
            );
            if (isStale(myTurnId)) return;
            currentProblemLabelRef.current = switchTo.label;
            await startSessionRef.current(
              { ...fresh, problems: undefined },
              { sessionId: newSessionId, problemImageBase64: crop, photoSource: 'pi' },
              text,
              fresh.usage,
            );
            return;
          } catch (err) {
            // 크롭/분석 실패(보관본이 죽었거나 망 문제) - 일반 EVAL 로 폴백.
            // Gemini 가 "안 보인다" 판단을 ERROR 로 돌려주면 재촬영 사다리가 받는다.
            console.warn('[FSM] problem switch failed - continuing as a normal turn:', err);
          }
        }
      }

      {
        const context = sessionRef.current;
        const systemPrompt = buildSystemPrompt({
          hintCount: context.hintCount,
          wrongStreak: context.wrongStreak,
          noPhotoConceptQuestion:
            !context.problemImageBase64 || context.problemImageBase64.trim().length === 0,
          hasProblemImage:
            !!context.problemImageBase64 && context.problemImageBase64.trim().length > 0,
          directSolveMode: effectiveDirectSolveMode,
          // 전사본이 있으면 EVAL 첨부 이미지가 그것이다 (gemini.service 의
          // evalImage 선택과 같은 조건) - 오버레이 좌표 정책을 연다.
          boardAttached:
            !!context.lastBoardImageBase64 && context.lastBoardImageBase64.trim().length > 0,
        });

        const nextHistory = [
          ...(context.history ?? []),
          { role: 'user' as const, message: text, timestamp: Date.now() },
        ];

        const contextWithHistory = {
          ...context,
          history: nextHistory,
        };

        setPhase('evaluating');
        const response = await evaluateStudentInputFn(evalText, contextWithHistory, systemPrompt);
        if (isStale(myTurnId)) return;

        // 학생 하차 인터셉트: "알았어 꺼져", "이제 가도 돼" - 모델이
        // student_dismissal 로 신호한다 (OUTPUT_FORMAT_POLICY). 모델 메시지
        // 대신 고정 인사만 말하고 세션을 닫는다 - 학생이 들은 말과 자막·이력이
        // 일치하도록 message 를 갈아끼운다 (폰 폴백 거절 종단과 같은 패턴).
        // 구 mock/저장 응답엔 필드가 없을 수 있다 - undefined 는 false 취급.
        if (response.student_dismissal) {
          const dismissedSession: TutoringSession = {
            ...context,
            usage: addTextUsage(
              context.usage ?? EMPTY_USAGE_SUMMARY,
              response.usage ?? EMPTY_TOKEN_USAGE,
            ),
            history: [
              ...nextHistory,
              { role: 'model' as const, message: DISMISSAL_EXIT_PHRASE, timestamp: Date.now() },
            ],
          };
          setSessionState(dismissedSession);
          setConversation(
            toConversationPayload({
              ...response,
              message: DISMISSAL_EXIT_PHRASE,
              requires_board: false,
              board_update_needed: false,
              board_prompt: '',
            }),
          );
          backgroundSaveSession(dismissedSession, response);
          logEvent('conversation', response.fsm_state, { studentDismissal: true });
          await speakAndWait(DISMISSAL_EXIT_PHRASE, 'done', myTurnId, FIXED_PHRASE_RATE);
          onSessionComplete?.();
          return;
        }

        // If Gemini reports an ERROR
        if (response.fsm_state === 'ERROR') {
          // 로봇 세션에서 재촬영은 폰 카메라가 아니라 로봇이 다시 찍는 것이다
          // (폰은 거치돼 있고 학생 앞엔 로봇이 있다). 78c7e35 가 만든 Tier 1/2
          // 사다리는 startSession 에만 있었고 이 분기는 photoSource 검사조차
          // 없이 바로 폰 카메라를 열었다 - 실기기 피드백 2026-07-29.
          // 판정을 errorHistory 구성 전에 하는 이유: 아래에서 response.message 를
          // 갈아끼우는데, 발화·history·저장이 전부 그 뒤에 있어야 학생이 들은
          // 말과 기록이 일치한다 (다문제 폴백이 :805-810 에서 지키는 규칙과 동일).
          // 재촬영 예산은 startSession 의 첫 분석 재촬영과 세션당 1회를
          // 공유한다. 따로 세면 대화 ERROR 재촬영 → 재진입 분석 ERROR →
          // 첫 분석 재촬영이 연달아 돌아 같은 안내("내가 다시 찍어볼게")를
          // 두 번 말하고 촬영도 두 번 돈다 (run-6 problem_switcher, 턴 하나가
          // 발화 4개 연결 + EVAL 29.7초).
          if (piErrorRetakeRef.current.sessionId !== sessionRef.current.sessionId) {
            piErrorRetakeRef.current = { sessionId: sessionRef.current.sessionId, count: 0 };
          }
          const piRetake =
            photoSourceRef.current === 'pi' &&
            !!capturePhotoNowFn &&
            !!fetchPiPhotoFn &&
            piErrorRetakeRef.current.count < 1 &&
            (response.error_type === 'OCR_FAILED' || response.error_type === 'LOW_IMAGE_QUALITY');
          // 로봇 사다리를 다 쓰고 폰 폴백 질문으로 끝나는 경로도 같은 자리에서
          // 판정한다: 예전엔 Gemini 의 ERROR 문구를 말한 직후 곧바로
          // PHONE_FALLBACK_QUESTION 이 또 나가, 학생 대답 없이 묻고 자문자답하는
          // 꼴이었다 (실기기 피드백 2026-08-05, startSession 종단과 같은 결함).
          // 앞 문구는 폰이 거치된 로봇 모드에서 실행 불가능한 지시고 뒷 질문이
          // 같은 내용을 담으므로, 질문 하나만 남긴다. 발화는 requestPhoneFallback
          // 이 하고, 여기선 history·자막이 그 문장과 일치하도록 갈아끼운다.
          const piPhoneFallback =
            !piRetake &&
            photoSourceRef.current === 'pi' &&
            !!onCameraNeeded &&
            (response.error_type === 'OCR_FAILED' || response.error_type === 'LOW_IMAGE_QUALITY');
          if (piRetake) {
            piErrorRetakeRef.current.count += 1;
            // Gemini 의 ERROR 문구는 "네가 사진 찍어서 보여줘" 인데 로봇 모드에선
            // 학생이 실행할 수 없는 지시다. 직접 변형은 아래 SOLVE_STAGE 차단
            // 백스톱이 쓰는 것과 같은 패턴.
            response.message = PI_RETAKE_FILLER;
            // 안내 발화(~3초)를 AF 사이클(실측 5.7초)로 덮는다. await 하지
            // 않는다 - 아래 speakAndWait 이 도는 동안 Pi 가 초점을 맞춰두면
            // 실제 촬영이 AF 를 건너뛴다. 이 경로가 지연을 가장 크게 체감하는
            // 자리다(대화 한복판에서 학생이 기다린다).
            prewarmPiFocusFn?.();
          } else if (piPhoneFallback) {
            response.message = PHONE_FALLBACK_QUESTION;
            response.requires_board = false;
            response.board_update_needed = false;
            response.board_prompt = '';
          }
          const errorHistory = [
            ...nextHistory,
            {
              role: 'model' as const,
              message: forHistory(response.message),
              timestamp: Date.now(),
            },
          ];
          const nextSession: TutoringSession = {
            ...context,
            fsmState: 'ERROR',
            topic: response.topic,
            title: response.title,
            usage: addTextUsage(
              context.usage ?? EMPTY_USAGE_SUMMARY,
              response.usage ?? EMPTY_TOKEN_USAGE,
            ),
            history: errorHistory,
          };
          setSessionState(nextSession);
          setConversation(toConversationPayload(response));

          backgroundSaveSession(nextSession, response);

          logEvent('conversation', 'ERROR', {
            errorType: response.error_type,
            confidence: response.confidence,
          });

          // piRetake 면 phase 를 'done' 이 아니라 'evaluating' 으로 둔다 -
          // 20초 촬영 동안 눈은 processing 이고 마이크는 꺼져 있어야 한다.
          // piPhoneFallback 은 requestPhoneFallback 이 같은 문장을 말하므로
          // 여기서 말하지 않는다 (말하면 같은 질문이 두 번 나간다).
          if (!piPhoneFallback) {
            await speakAndWait(response.message, piRetake ? 'evaluating' : 'done', myTurnId);
          }
          if (isStale(myTurnId)) return;

          // ConversationScreen 의 순서 규약: 안내 발화가 끝난 뒤에만 다음 단계로
          // 넘어간다. speakAndWait 은 실제 재생 완료에 resolve 하므로 여기서
          // 바로 찍으면 된다 (임의 타이머를 넣으면 말하는 중에 촬영이 돈다).
          if (piRetake) {
            try {
              await capturePhotoNowFn!();
              // 새 촬영 = 보관본 교체 (위 첫 분석 재촬영과 동일한 이유).
              pageProblemsRef.current = undefined;
              if (isStale(myTurnId)) return;
              const shot = await fetchPiPhotoFn!();
              if (isStale(myTurnId)) return;
              debugRecordCapture(sessionRef.current.sessionId, 'pi_retake', shot);
              const fresh = await analyzeImageFn(
                shot,
                sessionRef.current,
                buildSystemPrompt({
                  hasProblemImage: true,
                  directSolveMode: effectiveDirectSolveMode,
                }),
                text,
                effectiveDirectSolveMode,
              );
              if (isStale(myTurnId)) return;
              // 같은 세션 계속. resumeSnapshot() 이 방금 갱신된 history(학생
              // 발화 포함)를 들고 있으므로 initialQuestion 은 넘기지 않는다 -
              // 넘기면 같은 발화가 이력에 두 번 들어간다.
              // fresh 의 problems 는 벗기지 않는다: 방금 새로 찍어서 Pi 보관본이
              // 덮였으므로 다문제 되묻기와 크롭 사다리가 새 프레임에서 유효하다.
              await startSessionRef.current(
                fresh,
                {
                  // 같은 세션 계속 - history/usage 승계는 스냅샷이 실어 나른다.
                  ...resumeSnapshot(),
                  problemImageBase64: shot,
                  photoSource: 'pi',
                },
                undefined,
                fresh.usage,
              );
              return;
            } catch (err) {
              // 로봇이 못 찍으면 최후 수단은 폰 카메라 - 아래 기존 흐름 그대로.
              console.warn('[FSM] pi retake failed - falling back to the phone camera:', err);
            }
          }

          if (response.error_type === 'OCR_FAILED' || response.error_type === 'LOW_IMAGE_QUALITY') {
            // D-37: 로봇 세션은 폰 카메라 전에 음성 확인 (startSession 종단과 동일).
            if (photoSourceRef.current === 'pi') {
              // nextSession 이 이미 setSessionState + backgroundSaveSession 으로
              // 확정/저장된 뒤라 sessionRef.current 가 진짜 이번 세션이다.
              await requestPhoneFallback(text, response, myTurnId, sessionRef.current.sessionId);
            } else if (onCameraNeeded) {
              onCameraNeeded(text, resumeSnapshot());
            } else {
              onSessionComplete?.();
            }
          } else {
            onSessionComplete?.();
          }
          return;
        }

        const answerConfirmedCorrect = response.is_on_correct_path === true;

        // Step 3: only let a SOLVE_STAGE / explicit_answer_request response
        // through when it's a LEGITIMATE reveal path - "바로 정답" mode,
        // the student consenting to the wrongStreak>=3 consent question, or
        // confirming a final answer that's actually correct
        // (ANSWER_CONFIRMATION_POLICY). A bare "답 알려줘" with none of
        // these is a hint-mode escalation the prompt is told to refuse, but
        // this is a defensive backstop in case the model still tries to
        // solve anyway - it gets coerced back to HINT_STAGE instead of
        // trusting the model's own state, so "답 알려줘" can never reveal
        // the answer outside an authorized path.
        // wrongStreak>=3 "이라는 사실만" 으로 허가하면 안 된다 - wrongStreak 은
        // 정답을 맞힐 때까지 내려가지 않으므로, 한 번 3에 닿은 뒤로는 무슨 말을
        // 하든(예: 맨입에 "답 알려줘") 백스톱이 영구히 열린 채로 남는다.
        // 동의 질문에 실제로 응한 발화일 때만 연다. 직전 튜터 발화가 그
        // 동의 질문이었으면 "네 알려주세요" 류도 수락으로 본다 (run-8).
        const lastModelMessage =
          [...context.history].reverse().find((h) => h.role === 'model')?.message ?? '';
        const consentGranted =
          context.wrongStreak >= WRONG_STREAK_CONSENT_THRESHOLD &&
          isConsentPhrase(
            text,
            askedConsentQuestion(lastModelMessage) ? CONSENT_WORDS_AFTER_ANSWER_ASK : '',
          );
        const solveJumpAuthorized =
          effectiveDirectSolveMode || consentGranted || answerConfirmedCorrect;

        if (response.explicit_answer_request || response.fsm_state === 'SOLVE_STAGE') {
          if (solveJumpAuthorized) {
            // Only the "student solved it themselves and confirmed the
            // correct final answer" ending auto-returns home - a revealed
            // answer (정답 모드 / 동의) stays on screen so they can study it.
            await finishWithSolution(response, nextHistory, myTurnId, answerConfirmedCorrect);
            return;
          }
          // response.message (and possibly board_prompt) was already written
          // as a full worked solution once Gemini decided SOLVE_STAGE -
          // relabeling fsm_state alone would still leak that text via
          // TTS/subtitles below. Replace it with a fixed refusal instead of
          // trusting anything Gemini wrote for this turn.
          console.warn(
            '[FSM] blocked unauthorized SOLVE_STAGE jump - refusing instead of speaking the leaked solution',
          );
          response.fsm_state = 'HINT_STAGE';
          response.explicit_answer_request = false;
          response.is_on_correct_path = null;
          response.requires_board = false;
          response.board_update_needed = false;
          response.board_prompt = '';
          response.message =
            '정답은 알려줄 수 없어. 대신 힌트를 줄게 - 지금까지 어디까지 풀어봤어?';
        } else if (consentGranted) {
          // 학생이 동의 질문("답을 같이 볼까?")에 실제로 응했는데 Gemini 가 그
          // 턴에 HINT_STAGE + explicit_answer_request=false 를 돌려주면 위
          // 분기에 아예 안 걸려서, 동의가 조용히 버려지고 힌트가 또 나갔다 -
          // 자기가 제안해 놓고 수락을 거절하는 꼴 (run-8 에서 3턴 반복).
          // response.message 는 힌트라 그대로 정답으로 쓸 수 없다. 정답 모드
          // 프롬프트로 한 번 더 물어 진짜 풀이를 받아온다.
          console.warn('[FSM] consent granted but the model stayed in HINT_STAGE - re-asking');
          try {
            const solveResponse = await evaluateStudentInputFn(
              text,
              contextWithHistory,
              buildSystemPrompt({
                hintCount: context.hintCount,
                wrongStreak: context.wrongStreak,
                noPhotoConceptQuestion:
                  !context.problemImageBase64 || context.problemImageBase64.trim().length === 0,
                hasProblemImage:
                  !!context.problemImageBase64 && context.problemImageBase64.trim().length > 0,
                directSolveMode: true,
                boardAttached:
                  !!context.lastBoardImageBase64 && context.lastBoardImageBase64.trim().length > 0,
              }),
            );
            if (isStale(myTurnId)) return;
            // 첫 호출의 usage 가 finishWithSolution 의 합산에서 빠지지 않도록
            // 먼저 세션에 얹는다 (finishWithSolution 은 sessionRef 를 읽는다).
            setSessionState({
              ...sessionRef.current,
              usage: addTextUsage(
                sessionRef.current.usage ?? EMPTY_USAGE_SUMMARY,
                response.usage ?? EMPTY_TOKEN_USAGE,
              ),
            });
            await finishWithSolution(solveResponse, nextHistory, myTurnId);
            return;
          } catch (err) {
            // 재질문이 실패하면 원래 힌트라도 말한다 - 침묵보다는 낫다.
            console.warn('[FSM] direct-solve re-ask failed - falling back to the hint:', err);
          }
        }

        // EVAL branching (Step 6): update wrongStreak/hintCount based on
        // is_on_correct_path. `null` means "not a judgable answer" (e.g.
        // "모르겠어"/"어려워") -> hintCount increments, wrongStreak untouched
        // (완료 기준 2: HINT_STAGE 유지).
        let { hintCount, wrongStreak } = context;
        hintCount += 1;
        let lastMistakeReason = context.lastMistakeReason;
        if (response.is_on_correct_path === true) {
          wrongStreak = 0;
        } else if (response.is_on_correct_path === false) {
          wrongStreak += 1;
          if (response.mistake_reason) {
            lastMistakeReason = response.mistake_reason;
          }
        }

        const updatedHistory = [
          ...nextHistory,
          { role: 'model' as const, message: forHistory(response.message), timestamp: Date.now() },
        ];

        const nextSession: TutoringSession = {
          ...context,
          fsmState: response.fsm_state,
          hintCount,
          wrongStreak,
          lastMistakeReason,
          topic: response.topic,
          title: response.title,
          usage: addTextUsage(
            context.usage ?? EMPTY_USAGE_SUMMARY,
            response.usage ?? EMPTY_TOKEN_USAGE,
          ),
          history: updatedHistory,
        };
        setSessionState(nextSession);
        setConversation(toConversationPayload(response));

        backgroundSaveSession(nextSession, response);

        logEvent('conversation', response.fsm_state, {
          isOnCorrectPath: response.is_on_correct_path,
          explicitAnswerRequest: response.explicit_answer_request,
          requiresBoard: response.requires_board,
          boardUpdateNeeded: response.board_update_needed,
          hintCount,
          wrongStreak,
          boardRegenerationCount: nextSession.boardRegenerationCount,
          confidence: response.confidence,
          errorType: response.error_type,
          misconceptionType: response.misconception_type,
        });

        // Step 7: 3+ consecutive wrong answers -> let Gemini handle the consent naturally.
        const nextPhase: TutoringPhase = 'awaiting_input';

        await speakAndWait(response.message, nextPhase, myTurnId);
      }
    },
    [
      evaluateStudentInputFn,
      finishWithSolution,
      logEvent,
      setSessionState,
      speakAndWait,
      speakAskBackFollowUp,
      requestPhoneFallback,
      stopSpeakingFn,
      isStale,
      onCameraNeeded,
      onSessionComplete,
      backgroundSaveSession,
      directSolveMode,
      resumeSnapshot,
      analyzeImageFn,
      fetchProblemCropFn,
      capturePhotoNowFn,
      fetchPiPhotoFn,
      prewarmPiFocusFn,
      clearAskBackTimer,
      armAskBackTimer,
    ],
  );

  const updateBoardData = useCallback(
    (
      imageBase64: string,
      usage?: TokenUsage,
      opts?: {
        /** 이 판서를 만든 board_prompt - 저장 시 SavedBoardImage.boardPrompt
         * 로 들어간다 (예전엔 이 경로에 프롬프트가 없어 항상 '' 저장). */
        boardPrompt?: string;
        /** 검증 재생성 등 추가 이미지 호출 usage. */
        imageUsages?: TokenUsage[];
        /** 사후검증(텍스트 모델) usage - 과금 분류가 달라 따로 받는다. */
        textUsages?: TokenUsage[];
      },
    ) => {
      let nextUsage = sessionRef.current.usage ?? EMPTY_USAGE_SUMMARY;
      for (const u of [usage, ...(opts?.imageUsages ?? [])]) {
        if (u) nextUsage = addImageUsage(nextUsage, u);
      }
      for (const u of opts?.textUsages ?? []) {
        nextUsage = addTextUsage(nextUsage, u);
      }
      const next = {
        ...sessionRef.current,
        lastBoardImageBase64: imageBase64,
        boardRegenerationCount: sessionRef.current.boardRegenerationCount + 1,
        usage: nextUsage,
      };
      setSessionState(next);
      // Board generation finishes AFTER the turn's text-response save, so
      // without this re-save the board image and its imageCalls usage were
      // never persisted (every viva_sessions row had board_images:[] /
      // imageCalls:0). backgroundSaveSession's regeneration-count guard
      // makes this upload-once-per-new-board, not a duplicate write.
      backgroundSaveSession(next, undefined, opts?.boardPrompt);
    },
    [setSessionState, backgroundSaveSession],
  );

  const addBoardUsage = useCallback(
    (opts: { imageUsages?: TokenUsage[]; textUsages?: TokenUsage[] }) => {
      // 검증이 "통과" 로 끝나 판서 교체가 없을 때의 usage 반영 전용 -
      // updateBoardData 를 재호출하면 boardRegenerationCount 가 허수로 늘고
      // 같은 이미지가 새 판서로 재업로드된다.
      let nextUsage = sessionRef.current.usage ?? EMPTY_USAGE_SUMMARY;
      for (const u of opts.imageUsages ?? []) nextUsage = addImageUsage(nextUsage, u);
      for (const u of opts.textUsages ?? []) nextUsage = addTextUsage(nextUsage, u);
      const next = { ...sessionRef.current, usage: nextUsage };
      setSessionState(next);
      backgroundSaveSession(next);
    },
    [setSessionState, backgroundSaveSession],
  );

  return {
    phase,
    session,
    conversation,
    startSession,
    submitStudentInput,
    updateBoardData,
    addBoardUsage,
    cancel,
  };
}

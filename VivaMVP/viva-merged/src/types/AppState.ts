/**
 * AppState represents the screen/device-level state of the VIVA app.
 * This is intentionally separate from the FSM state, which represents the
 * tutoring conversation policy (HINT_STAGE / EVAL / SOLVE_STAGE / ERROR).
 *
 * See TRD.md section 1.2 ("AppState와 FSM State 분리") for the full
 * state/FSM mapping. This task (Task 1) only scaffolds the AppState shape;
 * FSM integration and Gemini response handling are implemented in later
 * tasks.
 */

/** Screen/device-level status values. ('listening' 은 mic-first 흐름의
 * IntentScreen 과 함께 2026-07-28 삭제 - 호출어/PTT 는 카메라 직행.) */
/**
 * Minimal skeleton of the fields the `conversation` AppState needs from the
 * FSM/Gemini result, per TRD 1.2 ("conversation AppState 내부에서 FSM 결과의
 * message, requires_board, board_update_needed를 처리한다") and pipeline
 * step 5 ("requires_board=true면 BoardView, false면 CharacterView").
 *
 * Full Gemini schema typing (GeminiTutoringResponse) is out of scope for
 * this task; this is just enough shape for ConversationScreen to decide
 * which placeholder view to render.
 */
import type { BoardAnnotation, GeminiTutoringResponse, ResumeSessionSnapshot } from './Tutoring';
import type { TokenUsage } from './ApiUsage';

export type AppStatus =
  'idle' | 'intent' | 'capturing' | 'processing' | 'conversation' | 'history' | 'session_detail';

/**
 * FSM state names, kept here only as a typing convenience for the
 * `conversation` AppState payload. The actual FSM logic (Gemini structured
 * output handling, tail-question flow, etc.) is implemented in a later task.
 */
export type FsmState = 'HINT_STAGE' | 'EVAL' | 'SOLVE_STAGE' | 'ERROR';

export interface ConversationPayload {
  fsmState: FsmState;
  message: string;
  requires_board: boolean;
  board_update_needed: boolean;
  board_prompt?: string;
  /** 힌트 턴의 판서 오버레이 명령 - 전사본 위에 앱이 그린다. 매 턴 교체. */
  annotations?: BoardAnnotation[];
  initialAnalysis: GeminiTutoringResponse;
  problemImageBase64: string;
  initialQuestion?: string;
  initialUsage?: TokenUsage;
  /** 대화 도중 재촬영(ERROR/OCR_FAILED)으로 이 화면이 언마운트됐다가 다시
   * 들어올 때 직전 튜터링 세션을 그대로 이어받기 위한 스냅샷. 없으면 새 세션. */
  resumeSession?: ResumeSessionSnapshot;
  /** 문제 사진 출처. 'pi' 일 때만 FSM 이 보관본 크롭 흐름(다문제 되묻기,
   * 인식 실패 시 크롭 재분석)을 연다 - 폰 사진은 크롭 소스가 없다. */
  photoSource?: 'pi' | 'phone';
  /** 개념 대화(IntentScreen) 도중 "풀어줘"로 이 풀이가 시작된 경우, 그 개념
   * 세션의 id. 저장 시 solve 세션 레코드의 parentConceptSessionId 로 들어가
   * 개념↔풀이 상세 양방향 링크의 키가 된다. 홈에서 바로 촬영이면 undefined. */
  parentConceptSessionId?: string;
}

/**
 * Discriminated union over `status` so each AppState status can carry only
 * the data relevant to it. `conversation` carries a `ConversationPayload`
 * (optional/undefined until the first Gemini response arrives) so
 * ConversationScreen has access to `requires_board`.
 */
export type AppState =
  | { status: 'idle' }
  | { status: 'intent' }
  /** `initialQuestion` carries what the student already said (재촬영 경로),
   * so the eventual analyzeImage() call knows *why* the photo was taken
   * (e.g. "채점해줘" vs "어떻게 풀어") - undefined on a fresh capture. */
  | { status: 'capturing'; initialQuestion?: string }
  | { status: 'processing'; fsmState?: FsmState }
  | { status: 'conversation'; conversation?: ConversationPayload }
  | { status: 'history' }
  | { status: 'session_detail'; sessionId: string };

export const initialAppState: AppState = { status: 'idle' };

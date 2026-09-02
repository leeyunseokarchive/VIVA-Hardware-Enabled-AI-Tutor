import type { FsmState } from './AppState';
import type { SessionUsageSummary } from './ApiUsage';
import type { SessionDebugRecord } from '../services/sessionDebug.service';

/** A single message in a conversation history. */
export interface HistoryMessage {
  role: 'user' | 'model';
  message: string;
  timestamp: number;
}

/** Saved board image reference. */
export interface SavedBoardImage {
  /** Local file path to the saved board image (JPEG). */
  filePath: string;
  /** When this board was generated. */
  timestamp: number;
  /** The board_prompt that generated this image. */
  boardPrompt: string;
}

/** A persisted session history entry. */
export interface SessionHistoryEntry {
  sessionId: string;
  /** 대화 종류. 'solve' = 문제 풀이(useTutoringFSM), 'concept' = 개념 대화
   * (useIntentLoop). 없으면 'solve' (이 필드 생기기 전 저장된 과거 세션). */
  kind?: 'concept' | 'solve';
  /** 이 문제풀이 세션을 낳은 개념 세션의 id (개념 대화 도중 "풀어줘"로 넘어온
   * 경우). 개념 상세의 "이어지는 문제풀이" 역조회 키. solve 세션에만 세팅. */
  parentConceptSessionId?: string;
  /** When the session started. */
  startedAt: number;
  /** When the session ended (SOLVE_STAGE completion or manual exit). */
  endedAt: number;
  /** Final FSM state when the session ended. */
  finalState: FsmState;
  /** Total number of hints given. */
  hintCount: number;
  /** The conversation messages (text only, no images). */
  messages: HistoryMessage[];
  /** Board images saved during this session. */
  boardImages: SavedBoardImage[];
  /** Public URL of the student's captured problem photo (attempt-images
   * bucket), if the session started from a photo. */
  problemImageUrl?: string;
  /** Short summary/preview for the list view (Gemini-generated title). */
  preview: string;
  /** 중학교 3학년 수학 단원 this session's problem was classified into by
   * Gemini. Undefined for sessions saved before this field existed - the UI
   * falls back to the old keyword-guess heuristic in that case. */
  topic?: string;
  usage: SessionUsageSummary;
  /** Short Korean phrase describing the specific mistake the student made
   * in this session (see WRONG_STEP_POLICY in system_prompt.ts). Undefined
   * for sessions with no wrong turn, or saved before this field existed. */
  mistakeReason?: string;
  /** 개발용 디버그 스냅샷 (촬영 폴백 단계, 판서 프롬프트/검증 기록).
   * __DEV__ 의 SessionDetailScreen 디버그 섹션만 읽는다. */
  debug?: SessionDebugRecord;
}

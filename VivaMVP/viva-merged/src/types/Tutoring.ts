/**
 * Gemini structured-output response shape and tutoring session context type,
 * per TRD.md §2.1 ("Gemini 구조화 출력 스키마") and §2.2 ("세션 상태 모델").
 *
 * These are the exact types the task-2 brief specifies verbatim. FSM
 * transition logic that *consumes* these fields (HINT_STAGE/EVAL/SOLVE_STAGE
 * handling, wrongStreak/hintCount updates, etc.) is implemented in Task 5 —
 * this file only defines the shapes.
 */

import type { FsmState } from './AppState';
import type { SessionUsageSummary } from './ApiUsage';

/** Fixed 중학교 3학년 수학 단원 taxonomy - Gemini must classify every session
 * into exactly one of these (or '기타' if truly none fit), replacing the old
 * client-side keyword-regex guess (HistoryScreen.tsx's guessTopic). */
export type MathUnit =
  | '실수와 그 계산'
  | '다항식의 인수분해'
  | '이차방정식'
  | '이차함수'
  | '통계'
  | '피타고라스의 정리'
  | '삼각비'
  | '원의 성질'
  | '기타';

/** 힌트 턴에 판서(전사본) 위에 앱이 직접 그리는 오버레이 명령 하나
 * (스펙 2026-07-29 전사 1회 + 오버레이). box_2d 는 첨부된 판서 이미지
 * 기준 [ymin, xmin, ymax, xmax], 0~1000 정규화. */
export interface BoardAnnotation {
  type: 'circle' | 'underline' | 'arrow' | 'question_mark' | 'label';
  box_2d: number[];
  /** label 타입의 짧은 텍스트 (다른 타입은 무시). */
  text?: string;
}

/** 사진 속에서 감지된 개별 문제 하나. box_2d 는 Gemini 좌표계 그대로
 * [ymin, xmin, ymax, xmax], 0~1000 정규화 - Pi /photo/crop 에 그대로 넘긴다. */
export interface ProblemBox {
  /** 학생이 부를 문제 식별자, 예: "3번". */
  label: string;
  /** [ymin, xmin, ymax, xmax], 0~1000. */
  box_2d: number[];
}

/** Structured JSON response Gemini is forced to produce via responseSchema. */
export interface GeminiTutoringResponse {
  fsm_state: FsmState;
  explicit_answer_request: boolean;
  is_on_correct_path: boolean | null;
  requires_board: boolean;
  board_update_needed: boolean;
  message: string;
  board_prompt: string;
  confidence: number;
  error_type: 'LOW_IMAGE_QUALITY' | 'OUT_OF_SCOPE' | 'OCR_FAILED' | 'UNSUPPORTED_PROBLEM' | 'NONE';
  misconception_type?:
    | 'SIGN_ERROR'
    | 'CALCULATION_ERROR'
    | 'CONCEPT_ERROR'
    | 'STRATEGY_ERROR'
    | 'OCR_UNCERTAIN'
    | 'NONE';
  /** Short specific Korean phrase describing exactly what the student got
   * wrong (see WRONG_STEP_POLICY in system_prompt.ts) - "" whenever
   * is_on_correct_path is not false. Persisted per-session for the
   * 오답노트 detail view ("틀린 이유"). */
  mistake_reason?: string;
  /** Which 중3 수학 단원 this session's problem belongs to. Re-sent every
   * turn (refined as more context arrives) - callers should just take the
   * latest value. */
  topic: MathUnit;
  /** Short Korean session-title summary (e.g. "14번 삼각비 문제", "근의공식에
   * 대한 질문") for history/오답노트 list cards, replacing the old
   * first-user-message slice. Re-sent every turn, latest value wins. */
  title: string;
  /** 사진에서 감지된 문제들(사진 분석 턴에만 올 수 있음). 2개 이상이면
   * FSM 이 "몇 번 풀고 있어?" 를 묻고 해당 bbox 크롭으로 재분석한다.
   * 필수 아님 - 없으면 문제 1개로 간주하고 현행 흐름. */
  problems?: ProblemBox[];
  /** 문제 원문 전사 (PROBLEM_FACTS_POLICY): 문제 텍스트, 도형/표 구조,
   * 라벨·기호·수치를 사진에 적힌 그대로. 판서 생성의 ground truth 로
   * 주입되고, 생성된 판서를 사후검증할 때 대조 기준이 된다. 사진 없는
   * 개념 질문 턴에는 "". */
  problem_facts?: string;
  /** 최종 정답 (FINAL_ANSWER_POLICY): 사진 분석 턴에 문제를 끝까지 풀어
   * 도출한 확정 답 (객관식이면 보기 번호 포함, 예: "③ (x=2)"). 학생에게
   * 노출되지 않는 내부 메타데이터. 사진 없는 턴에는 "". */
  final_answer?: string;
  /** 객관식 self-check 실패 (FINAL_ANSWER_POLICY): 사진 분석 턴에 계산한
   * 답이 전사한 선지 어디에도 없다는 신호 - 선지 오인식 가능성이 커서 FSM
   * 이 재인식 사다리(크롭 재분석/재촬영)를 태운다 (D-30). 사진 분석 턴이
   * 아니면 항상 false. */
  answer_not_in_choices?: boolean;
  /** 힌트 턴의 판서 오버레이 명령 (ANNOTATION_POLICY). 첨부 이미지가
   * 전사본인 EVAL 턴에만 유효 - 매 턴 직전 오버레이를 교체한다. */
  annotations?: BoardAnnotation[];
  /** 학생 하차 신호: VIVA 가 더 이상 필요 없다/가 달라는 의사 표시
   * ("알았어 꺼져", "이제 가도 돼" - 거친 표현 포함). true 면 FSM 이 message
   * 를 버리고 고정 인사(DISMISSAL_EXIT_PHRASE)만 말한 뒤 세션을 닫는다.
   * 구 mock/저장 응답엔 없을 수 있어 optional - undefined 는 false 취급. */
  student_dismissal?: boolean;
}

/** Per-session context passed into Gemini calls (TRD.md §2.2). */
export interface TutoringSession {
  sessionId: string;
  problemImageBase64: string;
  fsmState: FsmState;
  hintCount: number;
  wrongStreak: number;
  boardRegenerationCount: number;
  lastBoardImageBase64?: string;
  /** timestamp 는 발화 시점(ms). Gemini 프롬프트로는 role/message 만 나가고
   * (gemini.service 가 history 를 직렬화 컨텍스트에서 벗겨냄), 저장 시
   * 세션 이벤트 로그와 시간 매칭하는 디버깅 용도로만 쓴다. */
  history?: { role: 'user' | 'model'; message: string; timestamp?: number }[];
  usage?: SessionUsageSummary;
  /** Latest topic/title Gemini classified this session as - carried across
   * turns so a save that isn't itself a fresh Gemini response (e.g. a
   * board-image-only update) can still persist the last known values. */
  topic?: MathUnit;
  title?: string;
  /** Most recent non-empty mistake_reason from a wrong-path turn in this
   * session (see WRONG_STEP_POLICY). Kept even after later correct turns so
   * the session's 오답노트 entry still shows what the student got wrong. */
  lastMistakeReason?: string;
  /** 분석 턴이 준 problem_facts (문제 원문 전사). 판서 생성/검증의 ground
   * truth. Gemini 컨텍스트 직렬화에 포함되는 건 무해하다 - EVAL 턴에도
   * 문제 원문이 근거로 깔리는 셈. */
  problemFacts?: string;
  /** 분석 턴이 준 final_answer (확정 정답). 세션 컨텍스트로 매 턴 주입돼
   * recap·채점의 기준이 되고, SOLVE_STAGE 판서 생성/검증에도 주입된다.
   * 턴마다 답을 독립 재도출하다 서로 어긋나는 문제의 단일 기준점. */
  finalAnswer?: string;
}

/** 대화 도중 재촬영(ERROR/OCR_FAILED)으로 ConversationScreen 이 언마운트됐다가
 * 다시 뜰 때, 같은 튜터링 세션을 이어가기 위해 들고 다니는 최소 스냅샷.
 * 없으면 새 세션으로 시작한다.
 *
 * ponytail: 보드 이미지 목록은 안 싣는다 - 재촬영이면 어차피 새 판서가 그려지고,
 * 목록까지 옮기려면 FSM 내부 업로드 ref 까지 끌고 나와야 한다. 이전 판서 이미지가
 * 히스토리 카드에 남아야 하면 그때 스냅샷에 boardImages 를 추가하면 된다. */
export type ResumeSessionSnapshot = Pick<
  TutoringSession,
  // usage 도 싣는다 - 없던 시절엔 폰 카메라 왕복마다 비용 집계가 0으로
  // 돌아가 세션 비용이 과소보고됐다 (2026-08-05 히스토리 유실 조사에서 발견,
  // textCalls:1 로 저장된 4턴짜리 세션).
  'sessionId' | 'hintCount' | 'wrongStreak' | 'history' | 'usage'
>;

/**
 * 개발용 세션 디버그 수집기.
 *
 * 튜터링 파이프라인의 "콘솔 로그로만 남던" 것들 - 촬영 폴백 단계(Tier1 크롭 /
 * Tier2 재촬영 / 재촬영), 각 단계에서 실제로 전송된 이미지, 판서 생성의
 * 실프롬프트 전문·소요시간·사후검증 판정 - 을 세션별로 모아서
 * `viva_sessions.debug` (jsonb) 컬럼에 함께 저장한다. SessionDetailScreen 의
 * `__DEV__` 디버그 섹션이 읽는다.
 *
 * 모듈 레벨 Map 이라 startSession 재진입(크롭 사다리)이나 재촬영으로 훅이
 * 다시 만들어져도 같은 sessionId 의 기록이 이어진다. 수집·업로드 실패는
 * 절대 튜터링 흐름을 막지 않는다 (fire-and-forget).
 */
import { getOrCreateDeviceId } from '../lib/deviceId';
import { uploadBase64File } from '../lib/uploadFile';

const ATTEMPT_IMAGES_BUCKET = 'attempt-images';
/** 세션 수가 아니라 메모리 보호용 상한 - 개발 중 한 프로세스에서 이보다 많은
 * 세션을 돌 일은 없다. */
const MAX_TRACKED_SESSIONS = 20;

export type CaptureStage =
  | 'initial' // 최초 촬영본 그대로 분석
  | 'tier1_crop' // Pi 보관 원본 bbox 크롭 재분석
  | 'tier2_recapture' // 로봇 카메라 bbox AF 재촬영
  | 'problem_choice_crop' // 다문제 되묻기 후 선택 문제 크롭
  | 'single_problem_crop' // 단일 문제 감지 시 판서 base 용 크롭 (재분석 없음)
  | 'pi_retake' // 대화 중 로봇 재촬영
  | 'phone_retake'; // 대화 중 폰 카메라 재촬영 복귀

export interface CaptureAttemptDebug {
  stage: CaptureStage;
  timestamp: number;
  /** Gemini box_2d [ymin,xmin,ymax,xmax] 0~1000 (크롭 계열 단계만). */
  box2d?: number[];
  /** 업로드 완료 후 채워지는 public URL (실패 시 undefined 유지). */
  imageUrl?: string;
}

export interface BoardVerifyDebug {
  pass: boolean;
  issues: string[];
  verifyMs: number;
}

export interface BoardDebugRecord {
  timestamp: number;
  /** Gemini 가 준 board_prompt (힌트 지시). */
  boardPrompt: string;
  /** 이미지 모델에 실제로 전송된 텍스트 파트 전문. */
  fullPrompt: string;
  genMs: number;
  /** 반환된 판서의 사후검증 판정. 검증 자체가 실패(네트워크 등)하면 undefined. */
  verify?: BoardVerifyDebug;
  /** 시도했지만 채택되지 않은 재생성본의 판정 (재생성본도 불합격한 경우).
   * 이게 있으면 이미지 호출 1회를 더 쓰고 1차본을 유지했다는 뜻이다. */
  regenVerify?: BoardVerifyDebug;
  /** 검증 불합격으로 재생성된 결과물이면 true. */
  regenerated: boolean;
}

export interface SessionDebugRecord {
  photoSource?: 'pi' | 'phone';
  problemFacts?: string;
  finalAnswer?: string;
  captureAttempts: CaptureAttemptDebug[];
  boards: BoardDebugRecord[];
}

const records = new Map<string, SessionDebugRecord>();

function recordFor(sessionId: string): SessionDebugRecord {
  let rec = records.get(sessionId);
  if (!rec) {
    if (records.size >= MAX_TRACKED_SESSIONS) {
      const oldest = records.keys().next().value;
      if (oldest) records.delete(oldest);
    }
    rec = { captureAttempts: [], boards: [] };
    records.set(sessionId, rec);
  }
  return rec;
}

/** 촬영 시도 1건 기록 + 해당 이미지 업로드(fire-and-forget). */
export function debugRecordCapture(
  sessionId: string,
  stage: CaptureStage,
  imageBase64: string,
  box2d?: number[],
): void {
  if (!sessionId) return;
  const attempt: CaptureAttemptDebug = { stage, timestamp: Date.now(), box2d };
  recordFor(sessionId).captureAttempts.push(attempt);

  (async () => {
    try {
      const deviceId = await getOrCreateDeviceId();
      const path = `${deviceId}/${sessionId}/debug-${attempt.timestamp}-${stage}.jpg`;
      attempt.imageUrl = await uploadBase64File(
        ATTEMPT_IMAGES_BUCKET,
        path,
        imageBase64,
        'image/jpeg',
      );
    } catch (err) {
      console.warn('[SessionDebug] capture image upload failed:', err);
    }
  })();
}

export function debugRecordBoard(sessionId: string, board: BoardDebugRecord): void {
  if (!sessionId) return;
  recordFor(sessionId).boards.push(board);
}

export function debugSetSessionInfo(
  sessionId: string,
  info: Pick<SessionDebugRecord, 'photoSource' | 'problemFacts' | 'finalAnswer'>,
): void {
  if (!sessionId) return;
  const rec = recordFor(sessionId);
  if (info.photoSource) rec.photoSource = info.photoSource;
  if (info.problemFacts) rec.problemFacts = info.problemFacts;
  if (info.finalAnswer) rec.finalAnswer = info.finalAnswer;
}

/** 저장 시점 스냅샷 (없으면 undefined - 컬럼도 null 로 나간다). */
export function getSessionDebug(sessionId: string): SessionDebugRecord | undefined {
  return records.get(sessionId);
}

/** 테스트용. */
export function clearSessionDebug(): void {
  records.clear();
}

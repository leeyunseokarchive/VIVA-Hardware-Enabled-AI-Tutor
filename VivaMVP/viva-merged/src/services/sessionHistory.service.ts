import { SessionHistoryEntry, SavedBoardImage } from '../types/SessionHistory';
/**
 * Persists session history to Supabase instead of the device's local
 * filesystem. MVP는 로그인 없이 device_id로 세션을 구분한다.
 *
 * NOTE: this project's Supabase instance already has `sessions` / `attempts` /
 * `hint_logs` tables owned by a different app flow (Repo 2 / charing_viva —
 * photo capture -> attempt -> hint_level 1~3 voice escalation). Their schema
 * does not have room for this app's FSM session model (messages, board
 * images, hintCount/wrongStreak/usage), so we use dedicated tables instead:
 * `viva_sessions` / `viva_session_events` (see
 * supabase/migrations/0001_viva_sessions_and_events.sql for the DDL that
 * must be run once in the Supabase SQL editor).
 *
 * Storage layout:
 *   Supabase table `viva_sessions` — one row per SessionHistoryEntry (upserted by session_id)
 *   Supabase Storage `board-images` bucket — {deviceId}/{sessionId}/{timestamp}.jpg
 *     (public URL is stored in the `board_images` jsonb column, not the raw bytes)
 */
import { supabase } from '../lib/supabase';
import { getOrCreateDeviceId } from '../lib/deviceId';
import { uploadBase64File } from '../lib/uploadFile';

const SESSIONS_TABLE = 'viva_sessions';
const BOARD_IMAGES_BUCKET = 'board-images';
const ATTEMPT_IMAGES_BUCKET = 'attempt-images';
const MAX_SESSIONS = 50;

type SessionRow = {
  session_id: string;
  device_id: string;
  kind?: string | null;
  parent_concept_session_id?: string | null;
  started_at: number;
  ended_at: number;
  final_state: string;
  hint_count: number;
  messages: SessionHistoryEntry['messages'];
  board_images: SavedBoardImage[];
  preview: string;
  topic?: string | null;
  usage: SessionHistoryEntry['usage'];
  problem_image_url?: string | null;
  mistake_reason?: string | null;
  debug?: SessionHistoryEntry['debug'] | null;
};

function rowToEntry(row: SessionRow): SessionHistoryEntry {
  return {
    sessionId: row.session_id,
    kind: (row.kind as SessionHistoryEntry['kind']) ?? 'solve',
    parentConceptSessionId: row.parent_concept_session_id ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    finalState: row.final_state as SessionHistoryEntry['finalState'],
    hintCount: row.hint_count,
    messages: row.messages ?? [],
    boardImages: row.board_images ?? [],
    preview: row.preview,
    topic: row.topic ?? undefined,
    usage: row.usage,
    problemImageUrl: row.problem_image_url ?? undefined,
    mistakeReason: row.mistake_reason ?? undefined,
    debug: row.debug ?? undefined,
  };
}

export async function loadAllSessions(): Promise<SessionHistoryEntry[]> {
  try {
    const deviceId = await getOrCreateDeviceId();
    const { data, error } = await supabase
      .from(SESSIONS_TABLE)
      .select('*')
      .eq('device_id', deviceId)
      .order('started_at', { ascending: false })
      .limit(MAX_SESSIONS);

    if (error) {
      throw error;
    }

    return (data ?? []).map((row) => rowToEntry(row as SessionRow));
  } catch (err) {
    console.error('[SessionHistory] Failed to load sessions:', err);
    return [];
  }
}

export async function saveSession(entry: SessionHistoryEntry): Promise<void> {
  try {
    const deviceId = await getOrCreateDeviceId();

    // 세션 안에서 대화 이력은 자라기만 한다 (resume 도 직전 history 를 통째로
    // 승계한다). 그런데 화면이 낡은 payload 로 재마운트되면(개발 중 Fast
    // Refresh 가 대표 사례) 짧은 이력의 세션이 다시 저장되면서 upsert 가 이미
    // 쌓인 대화를 덮어 지웠다 - 2026-08-05 히스토리 유실의 최종 단계. 기존
    // row 가 더 긴 이력을 들고 있으면 그쪽을 지킨다.
    const { data: existing } = await supabase
      .from(SESSIONS_TABLE)
      .select('messages')
      .eq('session_id', entry.sessionId)
      .maybeSingle();
    if ((existing?.messages?.length ?? 0) > entry.messages.length) {
      console.warn(
        `[SessionHistory] refusing to shrink messages for ${entry.sessionId} ` +
          `(${existing!.messages!.length} saved > ${entry.messages.length} incoming) - keeping saved`,
      );
      entry = { ...entry, messages: existing!.messages! };
    }

    const row: SessionRow = {
      session_id: entry.sessionId,
      device_id: deviceId,
      kind: entry.kind ?? 'solve',
      parent_concept_session_id: entry.parentConceptSessionId ?? null,
      started_at: entry.startedAt,
      ended_at: entry.endedAt,
      final_state: entry.finalState,
      hint_count: entry.hintCount,
      messages: entry.messages,
      board_images: entry.boardImages,
      preview: entry.preview,
      topic: entry.topic ?? null,
      usage: entry.usage,
      problem_image_url: entry.problemImageUrl ?? null,
      mistake_reason: entry.mistakeReason ?? null,
      debug: entry.debug ?? null,
    };

    const { error } = await supabase.from(SESSIONS_TABLE).upsert(row, { onConflict: 'session_id' });

    if (error) {
      // 마이그레이션 0005(debug 컬럼) 미적용 인스턴스 폴백: 디버그 기록
      // 때문에 세션 저장 전체가 죽으면 안 된다 - debug 만 빼고 재시도.
      if (row.debug != null && /debug/i.test(error.message ?? '')) {
        console.warn(
          '[SessionHistory] debug column missing (run migration 0005) - saving without debug',
        );
        const { debug: _omitted, ...withoutDebug } = row;
        const { error: retryError } = await supabase
          .from(SESSIONS_TABLE)
          .upsert(withoutDebug, { onConflict: 'session_id' });
        if (retryError) throw retryError;
        return;
      }
      // 마이그레이션 0007(kind/parent_concept_session_id) 미적용 폴백: 개념
      // 대화 저장이 컬럼 부재로 통째 죽으면 안 된다 - 두 신규 컬럼만 빼고
      // 재시도(개념 세션이면 이 실행 인스턴스에선 구분 없이 저장된다).
      if (/kind|parent_concept_session_id/i.test(error.message ?? '')) {
        console.warn(
          '[SessionHistory] kind/parent columns missing (run migration 0007) - saving without them',
        );
        const { kind: _k, parent_concept_session_id: _p, ...withoutNew } = row;
        const { error: retryError } = await supabase
          .from(SESSIONS_TABLE)
          .upsert(withoutNew, { onConflict: 'session_id' });
        if (retryError) throw retryError;
        return;
      }
      throw error;
    }
  } catch (err) {
    console.error('[SessionHistory] Failed to save session:', err);
  }
}

/** Upload a board image to Supabase Storage and return its public URL metadata. */
export async function saveBoardImage(
  sessionId: string,
  imageBase64: string,
  boardPrompt: string,
): Promise<SavedBoardImage> {
  const deviceId = await getOrCreateDeviceId();
  const timestamp = Date.now();
  const path = `${deviceId}/${sessionId}/${timestamp}.jpg`;

  const publicUrl = await uploadBase64File(BOARD_IMAGES_BUCKET, path, imageBase64, 'image/jpeg');

  return { filePath: publicUrl, timestamp, boardPrompt };
}

/** Upload the student's captured problem photo to the attempt-images bucket
 * and return its public URL. One photo per session:
 * {deviceId}/{sessionId}.jpg (upsert). */
export async function saveProblemImage(sessionId: string, imageBase64: string): Promise<string> {
  const deviceId = await getOrCreateDeviceId();
  const path = `${deviceId}/${sessionId}.jpg`;
  return uploadBase64File(ATTEMPT_IMAGES_BUCKET, path, imageBase64, 'image/jpeg');
}

/** Delete a specific session row. Board images already uploaded to Storage are
 * left in place (best-effort cleanup is out of MVP scope, mirrors the
 * previous local-FS implementation's non-blocking error handling). */
export async function deleteSession(sessionId: string): Promise<void> {
  try {
    const deviceId = await getOrCreateDeviceId();
    const { error } = await supabase
      .from(SESSIONS_TABLE)
      .delete()
      .eq('session_id', sessionId)
      .eq('device_id', deviceId);

    if (error) {
      throw error;
    }
  } catch (err) {
    console.error('[SessionHistory] Failed to delete session:', err);
  }
}

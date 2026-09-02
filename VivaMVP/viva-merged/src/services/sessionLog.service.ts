/**
 * SessionEvent logging service (TRD.md §2.4).
 *
 * Per task-5-brief.md: "SessionEvent 스키마 (TRD.md §2.4, 그대로 사용)" — the
 * schema is used verbatim (see `SessionEvent` below). Events are recorded to
 * an in-memory buffer (`getSessionEvents()`) and mirrored to `console.log`,
 * per the brief's "완료 기준 6: SessionEvent 로그가 콘솔 또는 메모리에
 * 기록됨". No raw image bytes, audio, or full utterance transcripts are ever
 * stored in the event log (TRD.md §2.4 privacy constraint) — only the
 * derived/structured `meta` fields.
 *
 * In addition to the in-memory buffer, each event is now also mirrored
 * (fire-and-forget, best-effort) to the Supabase `viva_session_events` table
 * so hint/grading history survives across devices and app reinstalls.
 *
 * NOTE: this project's Supabase instance already has a `hint_logs` table,
 * but it belongs to a different app flow (Repo 2 / charing_viva) and is keyed
 * by `attempt_id` with an `hint_level` (1~3) escalation model that has no
 * relationship to this app's FSM (HINT_STAGE/SOLVE_STAGE) session events.
 * We log to the dedicated `viva_session_events` table instead (see
 * supabase/migrations/0001_viva_sessions_and_events.sql for the DDL that
 * must be run once in the Supabase SQL editor). A failed insert never blocks
 * or throws for the caller — it only warns to console, matching the same
 * non-blocking philosophy as the local session history migration.
 */
import type { AppStatus, FsmState } from '../types/AppState';
import { supabase } from '../lib/supabase';

const SESSION_EVENTS_TABLE = 'viva_session_events';

export interface SessionEventMeta {
  isOnCorrectPath?: boolean | null;
  explicitAnswerRequest?: boolean;
  requiresBoard?: boolean;
  boardUpdateNeeded?: boolean;
  hintCount?: number;
  wrongStreak?: number;
  boardRegenerationCount?: number;
  confidence?: number;
  errorType?: string;
  misconceptionType?: string;
}

export interface SessionEvent {
  sessionId: string;
  appState: AppStatus;
  fsmState?: FsmState;
  timestamp: number;
  meta?: SessionEventMeta;
}

// In-memory event buffer, per-process. This is deliberately module-level
// (not tied to a React component) so any part of the app (FSM hook, screens)
// can log events and a single test/dev console can inspect the whole
// session history via `getSessionEvents()`.
let events: SessionEvent[] = [];

/** Records a SessionEvent to the in-memory buffer, console, and (best-effort,
 * non-blocking) the Supabase `viva_session_events` table. */
export function logSessionEvent(event: SessionEvent): void {
  events.push(event);
  console.log('[SessionEvent]', event);
  persistToSessionEvents(event);
}

function persistToSessionEvents(event: SessionEvent): void {
  // Fire-and-forget — logging must never slow down or break the tutoring
  // loop. Failures (e.g. schema mismatch, offline) are only warned about.
  supabase
    .from(SESSION_EVENTS_TABLE)
    .insert({
      session_id: event.sessionId,
      app_state: event.appState,
      fsm_state: event.fsmState ?? null,
      hint_count: event.meta?.hintCount ?? null,
      wrong_streak: event.meta?.wrongStreak ?? null,
      board_regeneration_count: event.meta?.boardRegenerationCount ?? null,
      confidence: event.meta?.confidence ?? null,
      error_type: event.meta?.errorType ?? null,
      misconception_type: event.meta?.misconceptionType ?? null,
      meta: event.meta ?? null,
      created_at: new Date(event.timestamp).toISOString(),
    })
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) {
        console.warn('[SessionEvent] viva_session_events insert failed:', error.message);
      }
    });
}

/** Returns all SessionEvents recorded so far (in chronological order). */
export function getSessionEvents(): readonly SessionEvent[] {
  return events;
}

/** 한 세션의 저장된 이벤트를 시간순으로 조회한다. SessionDetailScreen 의
 * __DEV__ 디버그 타임라인이 읽는다 - 이 테이블의 최초이자 유일한 리더. */
export async function loadSessionEvents(sessionId: string): Promise<SessionEvent[]> {
  try {
    const { data, error } = await supabase
      .from(SESSION_EVENTS_TABLE)
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map((row: any) => ({
      sessionId: row.session_id,
      appState: row.app_state,
      fsmState: row.fsm_state ?? undefined,
      timestamp: new Date(row.created_at).getTime(),
      meta: row.meta ?? undefined,
    }));
  } catch (err) {
    console.warn('[SessionEvent] Failed to load events:', err);
    return [];
  }
}

/** Clears the in-memory event buffer (used between sessions/tests). */
export function clearSessionEvents(): void {
  events = [];
}

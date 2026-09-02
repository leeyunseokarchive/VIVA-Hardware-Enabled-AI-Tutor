import { useCallback, useRef, useState } from 'react';
import {
  AppState,
  AppStatus,
  ConversationPayload,
  initialAppState,
} from '../types/AppState';

/**
 * Encapsulates AppState transitions (idle/capturing/processing/conversation)
 * described in TRD 1.2. This is a skeleton for Task 1 only:
 * it exposes generic transition helpers plus one convenience action
 * (`startCapturing`) used by the Push-to-Talk button on HomeScreen.
 *
 * Every transition is logged via console.log for now, per Task 1's
 * completion criteria ("AppState 전환 로그 확인"). Real logging
 * infrastructure (SessionEvent, per TRD 2.4) is a later task.
 */
export interface UseAppStateResult {
  appState: AppState;
  /** Generic transition to any AppState status. */
  transitionTo: (next: AppState) => void;
  /** idle -> capturing (Push-to-Talk or wake word). `initialQuestion`
   * carries what the student already said, if any (재촬영 경로). */
  startCapturing: (initialQuestion?: string) => void;
  /** capturing -> processing (image sent for AI analysis). */
  startProcessing: () => void;
  /** processing -> conversation, optionally carrying the FSM/Gemini result. */
  enterConversation: (conversation?: ConversationPayload) => void;
  /** Return to idle from any state (e.g. SOLVE_STAGE complete, or error). */
  resetToIdle: () => void;
  /** idle -> history (browse past sessions). */
  enterHistory: () => void;
  /** history -> session_detail (view a specific session). */
  viewSessionDetail: (sessionId: string) => void;
}

export interface UseAppStateOptions {
  /** 상태 전이마다 새 status 로 호출된다. 디바이스 셸이 Pi 눈 미러링
   * (eyeSyncService.sendEyeState(STATUS_EYE_STATE[status]))을 등록한다.
   * 폰 셸은 안 넘긴다 - 미러링 대상이 없다. */
  onStatusChange?: (status: AppStatus) => void;
}

export function useAppState(options?: UseAppStateOptions): UseAppStateResult {
  const [appState, setAppState] = useState<AppState>(initialAppState);
  const previousStatusRef = useRef<AppStatus>(initialAppState.status);
  // 렌더마다 갱신 - transitionTo([]) 가 stale 콜백을 부르지 않게.
  const onStatusChangeRef = useRef(options?.onStatusChange);
  onStatusChangeRef.current = options?.onStatusChange;

  const transitionTo = useCallback((next: AppState) => {
    setAppState(() => {
      // status만 남긴다. next 객체 전체를 찍으면 conversation의 base64 이미지
      // 같은 거대한 필드까지 그대로 출력돼 로그가 화면을 도배한다.
      console.log(`[AppState] ${previousStatusRef.current} -> ${next.status}`);
      previousStatusRef.current = next.status;
      onStatusChangeRef.current?.(next.status);
      return next;
    });
  }, []);

  const startCapturing = useCallback(
    (initialQuestion?: string) => {
      transitionTo({ status: 'capturing', initialQuestion });
    },
    [transitionTo],
  );

  const startProcessing = useCallback(() => {
    transitionTo({ status: 'processing' });
  }, [transitionTo]);

  const enterConversation = useCallback(
    (conversation?: ConversationPayload) => {
      transitionTo({ status: 'conversation', conversation });
    },
    [transitionTo],
  );

  const resetToIdle = useCallback(() => {
    transitionTo({ status: 'idle' });
  }, [transitionTo]);

  const enterHistory = useCallback(() => {
    transitionTo({ status: 'history' });
  }, [transitionTo]);

  const viewSessionDetail = useCallback(
    (sessionId: string) => {
      transitionTo({ status: 'session_detail', sessionId });
    },
    [transitionTo],
  );

  return {
    appState,
    transitionTo,
    startCapturing,
    startProcessing,
    enterConversation,
    resetToIdle,
    enterHistory,
    viewSessionDetail,
  };
}

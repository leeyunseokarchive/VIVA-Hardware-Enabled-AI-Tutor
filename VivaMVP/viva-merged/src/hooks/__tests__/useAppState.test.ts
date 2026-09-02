import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { useAppState, UseAppStateOptions, UseAppStateResult } from '../useAppState';
import type { ConversationPayload } from '../../types/AppState';

/**
 * ConversationPayload 는 initialAnalysis(Gemini 분석 결과 전체)와
 * problemImageBase64 가 필수다 - 이 파일이 검증하는 건 status 전이뿐이라
 * 타입을 정직하게 만족시키는 최소 페이로드를 한 번만 만들어 두 호출부가
 * 같이 쓴다. requires_board: true 는 아래 단언이 보는 값이므로 고정.
 */
const CONVERSATION: ConversationPayload = {
  fsmState: 'HINT_STAGE',
  message: 'hi',
  requires_board: true,
  board_update_needed: false,
  initialAnalysis: {
    fsm_state: 'HINT_STAGE',
    explicit_answer_request: false,
    is_on_correct_path: null,
    requires_board: true,
    board_update_needed: false,
    message: 'hi',
    board_prompt: '',
    confidence: 0.9,
    error_type: 'NONE',
    topic: '기타',
    title: 'test session',
  },
  problemImageBase64: 'dGVzdA==',
};

/**
 * Minimal test harness: renders a component that calls useAppState() and
 * exposes the latest hook result via a ref, since @testing-library/react-hooks
 * isn't part of this project's dependency set (kept to what the brief
 * specifies). This is enough to exercise the transition logic in isolation.
 */
function renderUseAppState(options?: UseAppStateOptions) {
  const ref: { current: UseAppStateResult | null } = { current: null };

  function Harness() {
    ref.current = useAppState(options);
    return null;
  }

  act(() => {
    ReactTestRenderer.create(React.createElement(Harness));
  });

  return ref as { current: UseAppStateResult };
}

describe('useAppState', () => {
  it('starts in idle', () => {
    const ref = renderUseAppState();
    expect(ref.current.appState.status).toBe('idle');
  });

  it('transitions idle -> capturing via startCapturing', () => {
    const ref = renderUseAppState();

    act(() => {
      ref.current.startCapturing();
    });

    expect(ref.current.appState.status).toBe('capturing');
  });

  it('transitions capturing -> processing -> conversation', () => {
    const ref = renderUseAppState();

    act(() => {
      ref.current.startCapturing();
    });
    act(() => {
      ref.current.startProcessing();
    });
    act(() => {
      ref.current.enterConversation(CONVERSATION);
    });

    expect(ref.current.appState.status).toBe('conversation');
    if (ref.current.appState.status === 'conversation') {
      expect(ref.current.appState.conversation?.requires_board).toBe(true);
    }
  });

  it('resetToIdle returns to idle from any state', () => {
    const ref = renderUseAppState();

    act(() => {
      ref.current.startCapturing();
    });
    act(() => {
      ref.current.resetToIdle();
    });

    expect(ref.current.appState.status).toBe('idle');
  });

  // 눈 미러링(보드 전송)은 더 이상 이 훅의 책임이 아니다 - onStatusChange
  // 콜백 주입으로 뒤집었다(디바이스 셸이 App.tsx 에서 eyeSyncService 를
  // 배선). 아래 두 테스트가 그 계약(콜백이 불린다 / 콜백 없이도 동작한다)을
  // 고정한다.
  it('전이마다 onStatusChange 콜백을 새 status 로 부른다', () => {
    const onStatusChange = jest.fn();
    const ref = renderUseAppState({ onStatusChange });

    act(() => ref.current.startCapturing());
    expect(onStatusChange).toHaveBeenLastCalledWith('capturing');

    act(() => ref.current.startProcessing());
    act(() => ref.current.enterConversation(CONVERSATION));
    act(() => ref.current.enterHistory());
    act(() => ref.current.resetToIdle());
    expect(onStatusChange).toHaveBeenLastCalledWith('idle');
  });

  it('옵션 없이 호출해도 전이가 동작한다 (폰 셸 경로)', () => {
    const ref = renderUseAppState();

    act(() => ref.current.startProcessing());
    expect(ref.current.appState.status).toBe('processing');
  });
});

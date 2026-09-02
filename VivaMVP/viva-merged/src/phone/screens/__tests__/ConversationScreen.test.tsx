/**
 * Unit tests for ConversationScreen's screen-level logic that doesn't
 * belong to useTutoringFSM or useVoiceInput individually - added after a
 * code review caught a real regression (manual mic-stop being immediately
 * overridden by the auto-resume-listening effect) that had zero coverage.
 *
 * `useTutoringFSM` is mocked statically per test (each test only needs a
 * fixed `phase`/`session`/`conversation` snapshot, not full FSM
 * transitions - those are covered by useTutoringFSM.test.ts). `useVoiceInput`
 * is mocked with a small *stateful* fake (real useState under the hood) so
 * these tests can exercise the real effect/guard interplay in
 * ConversationScreen when `isListening` changes over time - a static mock
 * can't reproduce that.
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import ConversationScreen from '../ConversationScreen';
import type { ConversationPayload } from '../../../types/AppState';
import type { TutoringSession } from '../../../types/Tutoring';

const mockUseTutoringFSM = jest.fn();
jest.mock('../../../hooks/useTutoringFSM', () => ({
  useTutoringFSM: (...args: unknown[]) => mockUseTutoringFSM(...args),
}));

// Stateful fake so tests can drive isListening/mode transitions the same
// way the real hook would (a static mock can't reproduce the auto-resume
// effect re-firing in response to a state change it caused).
let mockVoiceConfig: {
  mode: 'voice' | 'text_fallback';
  isListening: boolean;
  partialText: string;
  /** 학생 발화를 Gemini 로 전사하는 중(0.5~3초). 이 구간에 화면 표현이
   * 없던 게 "대답 끝났는데 방금 질문이 다시 뜬다" 의 원인이었다. */
  isProcessing?: boolean;
} = {
  mode: 'voice',
  isListening: false,
  partialText: '',
};
const MOCK_MIC_LEVEL = 0;
const mockStartListening = jest.fn();
const mockStopListening = jest.fn();
jest.mock('../../../hooks/useVoiceInput', () => {
  const ReactActual = require('react');
  return {
    useVoiceInput: () => {
      const [mode, setMode] = ReactActual.useState(mockVoiceConfig.mode);
      const [isListening, setIsListening] = ReactActual.useState(mockVoiceConfig.isListening);
      const startListening = ReactActual.useRef(async () => {
        mockStartListening();
        setIsListening(true);
      }).current;
      const stopListening = ReactActual.useRef(async () => {
        mockStopListening();
        setIsListening(false);
      }).current;
      return {
        mode,
        isListening,
        isProcessing: mockVoiceConfig.isProcessing ?? false,
        partialText: mockVoiceConfig.partialText,
        micLevel: MOCK_MIC_LEVEL,
        errorMessage: undefined,
        startListening,
        stopListening,
        submitText: jest.fn(),
        switchToTextFallback: () => setMode('text_fallback'),
        switchToVoice: () => setMode('voice'),
      };
    },
  };
});

const mockGenerateBoardImage = jest.fn().mockResolvedValue({
  imageBase64: 'fake-board-base64',
  debug: { timestamp: 0, boardPrompt: '', fullPrompt: '', genMs: 0, regenerated: false },
});
jest.mock('../../../services/board.service', () => ({
  ...jest.requireActual('../../../services/board.service'),
  generateVerifiedBoardImage: (...args: unknown[]) => mockGenerateBoardImage(...args),
}));

const mockSpeak = jest.fn().mockResolvedValue(undefined);
const mockStopSpeaking = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../services/tts.service', () => ({
  speak: (...args: unknown[]) => mockSpeak(...args),
  stopSpeaking: (...args: unknown[]) => mockStopSpeaking(...args),
}));

function baseSession(overrides: Partial<TutoringSession> = {}): TutoringSession {
  return {
    sessionId: 'sess-1',
    problemImageBase64: 'img',
    fsmState: 'HINT_STAGE',
    hintCount: 1,
    wrongStreak: 0,
    boardRegenerationCount: 0,
    ...overrides,
  };
}

function baseConversation(overrides: Partial<ConversationPayload> = {}): ConversationPayload {
  return {
    fsmState: 'HINT_STAGE',
    message: '이 문제에서 구해야 하는 건 뭘까?',
    requires_board: true,
    board_update_needed: false,
    board_prompt: 'draw a hint',
    initialAnalysis: {} as ConversationPayload['initialAnalysis'],
    problemImageBase64: 'img',
    ...overrides,
  };
}

function mockFsm(overrides: {
  phase?: string;
  session?: TutoringSession;
  conversation?: ConversationPayload;
  startSession?: jest.Mock;
}) {
  mockUseTutoringFSM.mockReturnValue({
    phase: overrides.phase ?? 'awaiting_input',
    session: overrides.session ?? baseSession(),
    conversation: overrides.conversation ?? baseConversation(),
    startSession: overrides.startSession ?? jest.fn(),
    submitStudentInput: jest.fn(),
    updateBoardData: jest.fn(),
    addBoardUsage: jest.fn(),
    cancel: jest.fn(),
  });
}

describe('ConversationScreen', () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    mockVoiceConfig = { mode: 'voice', isListening: false, partialText: '' };
  });

  afterEach(() => {
    // EyeAnimation schedules real setTimeout-based blink/breathing loops
    // that clear themselves on unmount - without this, those timers can
    // fire after Jest tears down the module environment and crash the
    // process with an out-of-band error.
    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
  });

  it("keeps showing BoardView (sticky) when a later turn's requires_board comes back false outside SOLVE_STAGE", async () => {
    mockFsm({
      phase: 'awaiting_input',
      session: baseSession({ lastBoardImageBase64: 'cached-board-base64' }),
      // Gemini didn't ask for a board update this specific turn, but we're
      // still mid-conversation (not SOLVE_STAGE) - the board should stay up.
      conversation: baseConversation({ fsmState: 'HINT_STAGE', requires_board: false }),
    });

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ConversationScreen
          onSessionComplete={jest.fn()}
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    expect(renderer!.root.findByProps({ testID: 'board-view' })).toBeTruthy();
    expect(() => renderer!.root.findByProps({ testID: 'character-view' })).toThrow();
  });

  // 정답 공개(SOLVE_STAGE)에서도 판서는 남긴다 - BOARD_PROMPT_POLICY 가
  // SOLVE_STAGE 에서 단계별 풀이를 보드에 그리도록 허용하므로, 이미 그려진
  // 보드를 여기서 치워버리면 학생이 볼 게 사라진다.
  it('keeps BoardView at SOLVE_STAGE when a board image was already generated', async () => {
    mockFsm({
      phase: 'speaking',
      session: baseSession({
        lastBoardImageBase64: 'cached-board-base64',
        fsmState: 'SOLVE_STAGE',
      }),
      conversation: baseConversation({ fsmState: 'SOLVE_STAGE', requires_board: false }),
    });

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ConversationScreen
          onSessionComplete={jest.fn()}
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    expect(renderer!.root.findByProps({ testID: 'board-view' })).toBeTruthy();
    expect(() => renderer!.root.findByProps({ testID: 'character-view' })).toThrow();
  });

  it('falls back to CharacterView at SOLVE_STAGE when no board was ever generated', async () => {
    mockFsm({
      phase: 'speaking',
      session: baseSession({ fsmState: 'SOLVE_STAGE' }),
      conversation: baseConversation({ fsmState: 'SOLVE_STAGE', requires_board: false }),
    });

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ConversationScreen
          onSessionComplete={jest.fn()}
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    expect(renderer!.root.findByProps({ testID: 'character-view' })).toBeTruthy();
    expect(() => renderer!.root.findByProps({ testID: 'board-view' })).toThrow();
  });

  it('manually stopping the mic keeps it stopped instead of the auto-resume effect immediately restarting it', async () => {
    // No board this turn, so CharacterView (and its mic) renders.
    mockFsm({ phase: 'awaiting_input', conversation: baseConversation({ requires_board: false }) });
    mockVoiceConfig = { mode: 'voice', isListening: true, partialText: '' }; // already listening on mount

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ConversationScreen
          onSessionComplete={jest.fn()}
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    // Nothing auto-started on mount since we started out already listening.
    expect(mockStartListening).not.toHaveBeenCalled();

    const micButton = renderer!.root.findByProps({ testID: 'character-mic-button' });
    await act(async () => {
      await micButton.props.onPress();
    });

    expect(mockStopListening).toHaveBeenCalledTimes(1);
    // This is the regression the code review caught: without the manual-stop
    // guard, the auto-resume effect would see isListening flip to false
    // (phase/mode unchanged) and immediately call startListening() again.
    expect(mockStartListening).not.toHaveBeenCalled();
  });

  it('auto-resumes listening normally (no manual stop involved) once phase reaches awaiting_input', async () => {
    mockFsm({ phase: 'awaiting_input', conversation: baseConversation({ requires_board: false }) });
    mockVoiceConfig = { mode: 'voice', isListening: false, partialText: '' };

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ConversationScreen
          onSessionComplete={jest.fn()}
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    expect(mockStartListening).toHaveBeenCalledTimes(1);
  });

  // 실기기 피드백 2026-07-29: 학생이 대답을 마치면 바로 로딩 닷이 떠야 하는데
  // "방금 한 비바의 질문이 큰 검은 자막으로 다시 뜸 -> 입력 화면이 잠깐 -> 그제서야
  // 로딩 닷" 순서로 두 번 깜빡였다. 전사 구간(isProcessing)이 화면 상태기계에
  // 아예 없어서 phase='awaiting_input' 자막 분기로 떨어진 게 원인.
  describe('transcription window (voice.isProcessing)', () => {
    function renderAt(voice: Partial<typeof mockVoiceConfig>, phase = 'awaiting_input') {
      mockFsm({ phase, conversation: baseConversation({ requires_board: false }) });
      mockVoiceConfig = { mode: 'voice', isListening: false, partialText: '', ...voice };
      return act(async () => {
        renderer = ReactTestRenderer.create(
          <ConversationScreen
            onSessionComplete={jest.fn()}
            solveMode={false}
            onToggleSolveMode={jest.fn()}
          />,
        );
      });
    }

    it('shows loading dots while transcribing, not the previous subtitle', async () => {
      await renderAt({ isProcessing: true });
      expect(renderer!.root.findByProps({ testID: 'loading-dots' })).toBeTruthy();
    });

    it('does not re-arm the mic while transcribing', async () => {
      await renderAt({ isProcessing: true });
      expect(mockStartListening).not.toHaveBeenCalled();
    });

    // 자동 재청취가 전사 도중 마이크를 다시 켜버려도(useVoiceInput 쪽에서
    // 막지만, 두 겹으로 둔다) 로딩 닷이 계속 이겨야 한다 - isProcessing 을
    // isListening 보다 먼저 보는 이유.
    it('keeps the dots even if the mic somehow re-armed mid-transcription', async () => {
      await renderAt({ isProcessing: true, isListening: true });
      expect(renderer!.root.findByProps({ testID: 'loading-dots' })).toBeTruthy();
    });

    it('still shows the listening UI when only listening', async () => {
      await renderAt({ isListening: true });
      expect(() => renderer!.root.findByProps({ testID: 'loading-dots' })).toThrow();
    });
  });

  it('interrupts in-progress TTS when the mic is pressed while VIVA is still speaking', async () => {
    mockFsm({ phase: 'speaking', conversation: baseConversation({ requires_board: false }) });
    mockVoiceConfig = { mode: 'voice', isListening: false, partialText: '' };

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ConversationScreen
          onSessionComplete={jest.fn()}
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    // Not auto-listening while she's mid-sentence.
    expect(mockStartListening).not.toHaveBeenCalled();

    const micButton = renderer!.root.findByProps({ testID: 'character-mic-button' });
    await act(async () => {
      await micButton.props.onPress();
    });

    expect(mockStopSpeaking).toHaveBeenCalledTimes(1);
    expect(mockStartListening).toHaveBeenCalledTimes(1);
  });

  // 대화 도중 재촬영을 하면 이 화면이 언마운트됐다 다시 뜬다. 그때 새 세션을
  // 만들면 history/hintCount/wrongStreak 이 날아가고 DB 에 고아 세션이 생긴다.
  it('seeds the FSM from the carried-over session when re-entering after a retake', async () => {
    const startSession = jest.fn();
    const resumeSession = {
      sessionId: 'sess-1',
      hintCount: 4,
      wrongStreak: 2,
      history: [{ role: 'user' as const, message: '앞선 질문' }],
    };
    mockFsm({ startSession, conversation: baseConversation({ resumeSession }) });

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ConversationScreen
          conversation={baseConversation({ resumeSession })}
          onSessionComplete={jest.fn()}
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    expect(startSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining(resumeSession),
      undefined,
      undefined,
    );
  });

  // 재촬영을 유발한 발화는 ERROR 턴에서 이미 history 에 기록됐고 스냅샷이
  // 그걸 승계한다 - initialQuestion 으로 또 넘기면 이력에 두 번 쌓인다.
  it('drops initialQuestion when resuming (already carried inside the snapshot history)', async () => {
    const startSession = jest.fn();
    const resumeSession = {
      sessionId: 'sess-1',
      hintCount: 4,
      wrongStreak: 2,
      history: [{ role: 'user' as const, message: '다시 찍어줘' }],
    };
    const payload = baseConversation({ resumeSession, initialQuestion: '다시 찍어줘' });
    mockFsm({ startSession, conversation: payload });

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ConversationScreen
          conversation={payload}
          onSessionComplete={jest.fn()}
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    expect(startSession.mock.calls[0][2]).toBeUndefined();
  });

  it('mints a fresh session id when nothing was carried over', async () => {
    const startSession = jest.fn();
    mockFsm({ startSession });

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ConversationScreen
          conversation={baseConversation()}
          onSessionComplete={jest.fn()}
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    const seed = startSession.mock.calls[0][1];
    expect(seed.sessionId).toMatch(/^session-\d+$/);
    expect(seed.hintCount).toBeUndefined();
    expect(seed.history).toBeUndefined();
  });

  it('forwards the FSM resume snapshot up through onCameraNeeded', async () => {
    mockFsm({});
    const onCameraNeeded = jest.fn();

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ConversationScreen
          conversation={baseConversation()}
          onSessionComplete={jest.fn()}
          onCameraNeeded={onCameraNeeded}
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    const fsmOptions = mockUseTutoringFSM.mock.calls[0][0] as any;
    const snapshot = { sessionId: 'sess-1', hintCount: 2, wrongStreak: 1, history: [] };
    act(() => {
      fsmOptions.onCameraNeeded('사진 찍을게', snapshot);
    });

    expect(onCameraNeeded).toHaveBeenCalledWith('사진 찍을게', snapshot);
  });

  it('renders the solve-mode toggle and passes directSolveMode into useTutoringFSM', async () => {
    mockFsm({ phase: 'awaiting_input' });
    const onToggleSolveMode = jest.fn();

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ConversationScreen
          conversation={undefined}
          solveMode={true}
          onToggleSolveMode={onToggleSolveMode}
        />,
      );
    });

    const toggle = renderer!.root.findByProps({ testID: 'solve-mode-toggle' });
    await act(async () => {
      toggle.props.onPress();
    });
    expect(onToggleSolveMode).toHaveBeenCalledTimes(1);

    expect(mockUseTutoringFSM).toHaveBeenCalledWith(
      expect.objectContaining({ directSolveMode: true }),
    );
  });
});

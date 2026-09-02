/**
 * 디바이스 연동판 ConversationScreen 의 화면 전용 로직 - 폰 단독판/구 통합
 * 화면과 공유하는 FSM·음성입력 배선 회귀는 각각 useTutoringFSM.test.ts /
 * useVoiceInput.test.ts(및 이관 전 src/screens/__tests__/ConversationScreen.test.tsx)
 * 가 이미 덮는다. 여기는 이 변종에만 있는 것만 검증한다:
 *  - 끊김(disconnected) 시 오버레이가 뜨고 마이크·Pi 재생/녹음이 멎는다.
 *  - robotAudio 로 무폴백 AudioSink 가 등록된다 - 재생 실패해도 폰으로 새지 않는다.
 *  - 오버레이엔 "휴대폰으로 계속하기" 탈출구가 없다 (Task 6).
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

// Stateful fake so tests can drive isListening transitions like the real hook.
let mockVoiceConfig: {
  mode: 'voice' | 'text_fallback';
  isListening: boolean;
  partialText: string;
  isProcessing?: boolean;
} = {
  mode: 'voice',
  isListening: false,
  partialText: '',
};
const MOCK_MIC_LEVEL = 0;
const mockStartListening = jest.fn();
const mockStopListening = jest.fn();
const mockUseVoiceInput = jest.fn();
jest.mock('../../../hooks/useVoiceInput', () => {
  const ReactActual = require('react');
  return {
    useVoiceInput: (options: unknown) => {
      mockUseVoiceInput(options);
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
        mode: mockVoiceConfig.mode,
        isListening,
        isProcessing: mockVoiceConfig.isProcessing ?? false,
        partialText: mockVoiceConfig.partialText,
        micLevel: MOCK_MIC_LEVEL,
        errorMessage: undefined,
        startListening,
        stopListening,
        submitText: jest.fn(),
        switchToTextFallback: () => {},
        switchToVoice: () => {},
      };
    },
  };
});

let mockPiStatus: 'connected' | 'connecting' | 'disconnected' = 'connected';
jest.mock('../../hooks/usePiConnection', () => ({
  usePiConnection: () => mockPiStatus,
}));

const mockPlayAudioOnPi = jest.fn().mockResolvedValue(undefined);
const mockStopPiPlayback = jest.fn().mockResolvedValue(undefined);
const mockStopPiRecording = jest.fn().mockResolvedValue(undefined);
jest.mock('../../services/piBridge.service', () => ({
  ...jest.requireActual('../../services/piBridge.service'),
  playAudioOnPi: (...args: unknown[]) => mockPlayAudioOnPi(...args),
  stopPiPlayback: (...args: unknown[]) => mockStopPiPlayback(...args),
  stopPiRecording: (...args: unknown[]) => mockStopPiRecording(...args),
}));
jest.mock('../../services/eyeSync.service', () => ({
  ...jest.requireActual('../../services/eyeSync.service'),
  eyeSyncService: {
    sendEyeState: jest.fn(),
    setSuppressed: jest.fn(),
    stop: jest.fn(),
    onConnectionChange: jest.fn(() => () => {}),
  },
}));

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
const mockSetAudioSink = jest.fn();
jest.mock('../../../services/tts.service', () => ({
  speak: (...args: unknown[]) => mockSpeak(...args),
  stopSpeaking: (...args: unknown[]) => mockStopSpeaking(...args),
  setAudioSink: (...args: unknown[]) => mockSetAudioSink(...args),
  TTS_PAUSE_MARKER: '[[PAUSE]]',
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
    requires_board: false,
    board_update_needed: false,
    board_prompt: '',
    initialAnalysis: {} as ConversationPayload['initialAnalysis'],
    problemImageBase64: 'img',
    ...overrides,
  };
}

function mockFsm(overrides: {
  phase?: string;
  session?: TutoringSession;
  conversation?: ConversationPayload;
}) {
  mockUseTutoringFSM.mockReturnValue({
    phase: overrides.phase ?? 'awaiting_input',
    session: overrides.session ?? baseSession(),
    conversation: overrides.conversation ?? baseConversation(),
    startSession: jest.fn(),
    submitStudentInput: jest.fn(),
    updateBoardData: jest.fn(),
    addBoardUsage: jest.fn(),
    cancel: jest.fn(),
  });
}

describe('ConversationScreen (디바이스 연동판)', () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPlayAudioOnPi.mockResolvedValue(undefined);
    mockStopPiPlayback.mockResolvedValue(undefined);
    mockStopPiRecording.mockResolvedValue(undefined);
    mockVoiceConfig = { mode: 'voice', isListening: false, partialText: '' };
    mockPiStatus = 'connected';
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
  });

  // 끊김 시 조용한 폰 폴백 금지 (스펙 원칙). Pi 끊김이면 자동 재청취가 절대
  // 폰 마이크를 열면 안 되고, 오버레이가 뜨고 Pi 재생/녹음도 정리돼야 한다.
  it('shows the disconnect overlay and tears down Pi audio/mic when disconnected', async () => {
    mockPiStatus = 'disconnected';
    mockFsm({ phase: 'awaiting_input', conversation: baseConversation({ requires_board: false }) });

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ConversationScreen
          onSessionComplete={jest.fn()}
          robotAudio
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    expect(renderer!.root.findByProps({ testID: 'disconnect-overlay' })).toBeTruthy();
    // 자동 재청취가 폰 마이크를 열지 않는다.
    expect(mockStartListening).not.toHaveBeenCalled();
    expect(mockStopPiPlayback).toHaveBeenCalled();
    expect(mockStopPiRecording).toHaveBeenCalled();
  });

  // Task 6: [휴대폰으로 계속하기] 탈출구가 없다.
  it('the disconnect overlay has no "휴대폰으로 계속" escape hatch', async () => {
    mockPiStatus = 'disconnected';
    mockFsm({ phase: 'awaiting_input', conversation: baseConversation({ requires_board: false }) });

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ConversationScreen
          onSessionComplete={jest.fn()}
          robotAudio
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    expect(renderer!.root.findByProps({ testID: 'disconnect-overlay' })).toBeTruthy();
    const treeJson = JSON.stringify(renderer!.toJSON());
    expect(treeJson).not.toContain('휴대폰으로 계속');
    expect(() => renderer!.root.findByProps({ testID: 'continue-app-mode-button' })).toThrow();
  });

  // robotAudio=true 면 useVoiceInput 에 allowPhoneMicFallback:false 로 마이크가
  // 로봇 전용임을 알리고, setAudioSink 에 무폴백 sink 를 등록한다.
  it('registers a no-phone-fallback AudioSink and blocks phone mic fallback when robotAudio', async () => {
    mockFsm({ phase: 'awaiting_input' });

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ConversationScreen
          onSessionComplete={jest.fn()}
          robotAudio
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    expect(mockUseVoiceInput).toHaveBeenCalledWith(
      expect.objectContaining({ allowPhoneMicFallback: false }),
    );
    expect(mockSetAudioSink).toHaveBeenCalledWith(
      expect.objectContaining({ play: expect.any(Function), stop: expect.any(Function) }),
    );
  });

  // 재생 실패가 폰 스피커 폴백으로 새지 않는다 - 삼키고 조용히 끝난다.
  it('swallows a Pi playback failure instead of falling back to the phone speaker', async () => {
    mockFsm({ phase: 'awaiting_input' });
    mockPlayAudioOnPi.mockRejectedValue(new Error('pi playback failed'));

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ConversationScreen
          onSessionComplete={jest.fn()}
          robotAudio
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    const sink = mockSetAudioSink.mock.calls[0][0];
    await act(async () => {
      await expect(sink.play('base64-audio')).resolves.toBeUndefined();
    });
    // 두 번째 인자는 자막 시계용 onStarted 콜백 - sink 가 그대로 관통시킨다.
    expect(mockPlayAudioOnPi).toHaveBeenCalledWith('base64-audio', undefined);
  });
});

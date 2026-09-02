import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Image } from 'react-native';
import IntentScreen from '../IntentScreen';

const mockUseIntentLoop = jest.fn();
jest.mock('../../hooks/useIntentLoop', () => ({
  useIntentLoop: () => mockUseIntentLoop(),
}));

describe('IntentScreen (스모크)', () => {
  it('useIntentLoop 의 subtitle 을 렌더한다', async () => {
    mockUseIntentLoop.mockReturnValue({
      begin: jest.fn(),
      phase: 'greeting',
      subtitle: '안녕! 무엇이 궁금해?',
      boardImageBase64: null,
      micLevel: 0,
      inputMode: 'voice',
      switchToText: jest.fn(),
      switchToVoice: jest.fn(),
      submitText: jest.fn(),
    });

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <IntentScreen
          robotAudio={false}
          session={{
            sessionId: 'session-test',
            problemImageBase64: '',
            fsmState: 'HINT_STAGE',
            hintCount: 0,
            wrongStreak: 0,
            boardRegenerationCount: 0,
          }}
          solveMode={false}
          onAnalyzed={jest.fn()}
          onPhoneCamera={jest.fn()}
          onExit={jest.fn()}
        />,
      );
    });

    expect(renderer!.root.findByProps({ children: '안녕! 무엇이 궁금해?' })).toBeTruthy();

    act(() => {
      renderer!.unmount();
    });
  });

  it('boardAsset 이 있으면 asset 소스로 렌더한다', async () => {
    mockUseIntentLoop.mockReturnValue({
      begin: jest.fn(),
      phase: 'greeting',
      subtitle: '',
      boardImageBase64: null,
      boardAsset: 99887,
      micLevel: 0,
      inputMode: 'voice',
      switchToText: jest.fn(),
      switchToVoice: jest.fn(),
      submitText: jest.fn(),
    });

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <IntentScreen
          robotAudio={false}
          session={{
            sessionId: 'session-test',
            problemImageBase64: '',
            fsmState: 'HINT_STAGE',
            hintCount: 0,
            wrongStreak: 0,
            boardRegenerationCount: 0,
          }}
          solveMode={false}
          onAnalyzed={jest.fn()}
          onPhoneCamera={jest.fn()}
          onExit={jest.fn()}
        />,
      );
    });

    const boardImages = renderer!.root.findAll(
      (node) => node.type === Image && node.props.source === 99887,
    );
    expect(boardImages.length).toBe(1);

    act(() => {
      renderer!.unmount();
    });
  });
});

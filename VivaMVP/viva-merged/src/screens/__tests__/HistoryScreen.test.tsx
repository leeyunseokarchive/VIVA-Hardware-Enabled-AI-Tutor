import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import HistoryScreen from '../HistoryScreen';
import type { SessionHistoryEntry } from '../../types/SessionHistory';

const mockLoadAllSessions = jest.fn();
jest.mock('../../services/sessionHistory.service', () => ({
  loadAllSessions: (...args: unknown[]) => mockLoadAllSessions(...args),
}));

function makeEntry(overrides: Partial<SessionHistoryEntry> = {}): SessionHistoryEntry {
  return {
    sessionId: 'sess-1',
    startedAt: 1700000000000,
    endedAt: 1700000001000,
    finalState: 'SOLVE_STAGE',
    hintCount: 2,
    messages: [],
    boardImages: [],
    preview: '이차방정식 문제',
    usage: {
      textCalls: 3,
      imageCalls: 1,
      promptTokens: 1000,
      candidateTokens: 500,
      totalTokens: 1500,
      costUsd: 0.012,
    },
    ...overrides,
  };
}

describe('HistoryScreen usage badge', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows the formatted USD cost badge for a session with usage', async () => {
    mockLoadAllSessions.mockResolvedValueOnce([makeEntry()]);

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <HistoryScreen onBack={jest.fn()} onSelectSession={jest.fn()} />,
      );
    });

    const costText = renderer!.root.findByProps({ testID: 'session-cost-badge-sess-1' });
    expect(costText.props.children).toBe('$0.0120');
  });

  it('omits the cost badge for a legacy session with no usage recorded', async () => {
    mockLoadAllSessions.mockResolvedValueOnce([makeEntry({ usage: undefined as never })]);

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <HistoryScreen onBack={jest.fn()} onSelectSession={jest.fn()} />,
      );
    });

    expect(() => renderer!.root.findByProps({ testID: 'session-cost-badge-sess-1' })).toThrow();
  });
});

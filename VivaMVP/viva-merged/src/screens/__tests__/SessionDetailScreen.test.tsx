import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import SessionDetailScreen from '../SessionDetailScreen';
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
    messages: [{ role: 'model', message: '안녕', timestamp: 1700000000500 }],
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

describe('SessionDetailScreen usage card', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders token counts, call counts, and formatted cost', async () => {
    mockLoadAllSessions.mockResolvedValueOnce([makeEntry()]);

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <SessionDetailScreen sessionId="sess-1" onBack={jest.fn()} onSelectSession={jest.fn()} />,
      );
    });

    const section = renderer!.root.findByProps({ testID: 'session-usage-section' });
    expect(section).toBeTruthy();
    const costValue = renderer!.root.findByProps({ testID: 'session-usage-cost-value' });
    expect(costValue.props.children).toBe('$0.0120');
  });

  it('does not render the usage section when there is no recorded usage', async () => {
    mockLoadAllSessions.mockResolvedValueOnce([makeEntry({ usage: undefined as never })]);

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <SessionDetailScreen sessionId="sess-1" onBack={jest.fn()} onSelectSession={jest.fn()} />,
      );
    });

    expect(() => renderer!.root.findByProps({ testID: 'session-usage-section' })).toThrow();
  });

  it('renders a follow-up button for a concept session with a child solve', async () => {
    const concept = makeEntry({ sessionId: 'concept-1', kind: 'concept', usage: undefined as never });
    const solve = makeEntry({
      sessionId: 'solve-1',
      kind: 'solve',
      parentConceptSessionId: 'concept-1',
      preview: '이어진 문제',
    });
    mockLoadAllSessions.mockResolvedValueOnce([concept, solve]);

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <SessionDetailScreen sessionId="concept-1" onBack={jest.fn()} onSelectSession={jest.fn()} />,
      );
    });

    const button = renderer!.root.findByProps({ testID: 'session-detail-followup-solve-1' });
    expect(button).toBeTruthy();
  });
});

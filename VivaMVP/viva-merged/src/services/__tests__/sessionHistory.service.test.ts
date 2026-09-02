/**
 * saveSession 의 이력 축소 방지 가드 (2026-08-05 히스토리 유실).
 * 세션 안에서 대화 이력은 자라기만 한다 - 낡은 payload 로 재마운트된 화면이
 * 짧은 이력을 다시 저장하며 upsert 로 쌓인 대화를 덮어 지우는 걸 막는다.
 */
import { saveSession } from '../sessionHistory.service';
import { supabase } from '../../lib/supabase';
import type { SessionHistoryEntry } from '../../types/SessionHistory';

jest.mock('../../lib/supabase', () => ({ supabase: { from: jest.fn() } }));
jest.mock('../../lib/deviceId', () => ({
  getOrCreateDeviceId: jest.fn().mockResolvedValue('device-1'),
}));

const mockedFrom = supabase.from as jest.Mock;

function mockTable(existingMessages: SessionHistoryEntry['messages'] | null) {
  const upsert = jest.fn().mockResolvedValue({ error: null });
  mockedFrom.mockReturnValue({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        maybeSingle: jest
          .fn()
          .mockResolvedValue({ data: existingMessages ? { messages: existingMessages } : null }),
      }),
    }),
    upsert,
  });
  return upsert;
}

function entry(messages: SessionHistoryEntry['messages']): SessionHistoryEntry {
  return {
    sessionId: 's1',
    startedAt: 1,
    endedAt: 2,
    finalState: 'HINT_STAGE',
    hintCount: 1,
    messages,
    boardImages: [],
    preview: 'p',
    usage: {
      costUsd: 0,
      textCalls: 0,
      imageCalls: 0,
      totalTokens: 0,
      promptTokens: 0,
      candidateTokens: 0,
    },
  };
}

const LONG = [
  { role: 'model' as const, message: 'q', timestamp: 1 },
  { role: 'user' as const, message: '응', timestamp: 2 },
  { role: 'model' as const, message: 'hint', timestamp: 3 },
];
const SHORT = [{ role: 'model' as const, message: 'q', timestamp: 1 }];

describe('saveSession no-shrink guard', () => {
  beforeEach(() => mockedFrom.mockReset());

  it('기존 row 가 더 긴 이력을 들고 있으면 덮어쓰지 않고 지킨다', async () => {
    const upsert = mockTable(LONG);
    await saveSession(entry(SHORT));
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ messages: LONG }),
      expect.anything(),
    );
  });

  it('정상 성장(더 긴 이력)은 그대로 저장한다', async () => {
    const upsert = mockTable(SHORT);
    await saveSession(entry(LONG));
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ messages: LONG }),
      expect.anything(),
    );
  });

  it('기존 row 가 없으면(첫 저장) 그대로 저장한다', async () => {
    const upsert = mockTable(null);
    await saveSession(entry(SHORT));
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ messages: SHORT }),
      expect.anything(),
    );
  });
});

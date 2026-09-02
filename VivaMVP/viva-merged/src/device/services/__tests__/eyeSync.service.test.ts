/**
 * 호출어 비트(`calling`)의 최소 노출 보장 (2026-08-07).
 *
 * beginCapture 는 예전에도 'calling' 을 보냈지만 마이크 teardown 직후
 * transitionTo 가 수백 ms 만에 덮어써서 사람이 못 본다. 홀드는 고정 지연이
 * 아니라 **최소 보장**이라, 그 사이 도착한 상태는 버리지 않고 마지막 것만
 * 만료 시점에 반영해야 한다.
 *
 * WS 소켓은 안 띄운다 - `EXPO_PUBLIC_EYE_SYNC_WS_URL` 은 babel 이 빌드
 * 시점에 인라인해서 테스트가 값을 못 바꾼다. 홀드는 "무엇을 보내기로 했나"
 * 의 문제라 `currentState` 로 검증한다.
 */
import { CALLING_HOLD_MS, eyeSyncService } from '../eyeSync.service';

describe('eyeSyncService calling hold', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // 싱글턴이라 이전 테스트의 홀드 타이머가 남지 않게 초기화한다.
    eyeSyncService.stop();
    eyeSyncService.sendEyeState('idle');
  });
  afterEach(() => {
    eyeSyncService.stop();
    jest.useRealTimers();
  });

  it('holds calling and then applies only the latest queued state', () => {
    eyeSyncService.sendEyeState('calling', { holdMs: CALLING_HOLD_MS });
    expect(eyeSyncService.currentState).toBe('calling');

    // 촬영 → 분석. 홀드 중이라 둘 다 보드로 나가면 안 된다.
    eyeSyncService.sendEyeState('idle');
    eyeSyncService.sendEyeState('listening');
    expect(eyeSyncService.currentState).toBe('calling');

    jest.advanceTimersByTime(CALLING_HOLD_MS);
    // 중간의 'idle' 은 건너뛰고 가장 최근 상태만 반영된다.
    expect(eyeSyncService.currentState).toBe('listening');
  });

  it('passes states straight through when no hold is active', () => {
    eyeSyncService.sendEyeState('conversation');
    expect(eyeSyncService.currentState).toBe('conversation');
    eyeSyncService.sendEyeState('idle');
    expect(eyeSyncService.currentState).toBe('idle');
  });

  it('keeps the held state when nothing arrives during the hold', () => {
    eyeSyncService.sendEyeState('calling', { holdMs: CALLING_HOLD_MS });
    jest.advanceTimersByTime(CALLING_HOLD_MS);

    expect(eyeSyncService.currentState).toBe('calling');
  });

  it('restarts the hold when the wake word fires again mid-hold', () => {
    eyeSyncService.sendEyeState('calling', { holdMs: CALLING_HOLD_MS });
    eyeSyncService.sendEyeState('listening');

    jest.advanceTimersByTime(CALLING_HOLD_MS / 2);
    // 다시 불렸다 - 앞 홀드에 쌓인 대기 상태는 버리고 새 비트를 처음부터.
    eyeSyncService.sendEyeState('calling', { holdMs: CALLING_HOLD_MS });

    jest.advanceTimersByTime(CALLING_HOLD_MS);
    expect(eyeSyncService.currentState).toBe('calling');
  });
});

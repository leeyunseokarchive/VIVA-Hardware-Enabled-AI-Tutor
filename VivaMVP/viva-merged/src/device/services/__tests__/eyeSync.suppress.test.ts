/**
 * setSuppressed(false) 복귀 경로(sendEyeState -> start())가 실제
 * EXPO_PUBLIC_EYE_SYNC_WS_URL(.env 의 실기기 IP)로 소켓을 열려고 시도해
 * `npm test` 로그에 "[EyeSync] Starting sync" 노이즈가 찍혔다.
 *
 * process.env 를 테스트 안에서 다시 대입해도 소용없다 - babel-preset-expo 가
 * EXPO_PUBLIC_* 를 빌드(transform) 시점에 이미 리터럴로 인라인해버리고, 그
 * 변환 결과가 jest 캐시에 남아 런타임 대입을 못 따라간다(eyeSync.service.test.ts
 * 상단 코멘트, jest.config.js 상단 코멘트와 동일한 제약 - 직접 재현 확인:
 * --no-cache 없이 돌리면 실제 IP 로 접속을 시도한다). 그래서 URL 을 지우는
 * 대신 이 repo 의 기존 관례(piWakeStream.service.test.ts)를 따라
 * global.WebSocket 을 FakeWebSocket 으로 갈아 끼워 실제 연결 시도 자체를
 * 막는다. "Starting sync" 로그 한 줄은 소켓 생성과 무관하게 무조건 찍히므로
 * console.log 도 이 파일 범위에서만 죽인다.
 */
class FakeWebSocket {
  url: string;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  send(): void {}
  close(): void {}
}
(global as any).WebSocket = FakeWebSocket;

// eslint-disable-next-line import/first
import { eyeSyncService } from '../eyeSync.service';

describe('eyeSyncService.setSuppressed', () => {
  let logSpy: jest.SpyInstance;

  beforeAll(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(() => {
    logSpy.mockRestore();
  });

  afterEach(() => {
    eyeSyncService.setSuppressed(false);
    eyeSyncService.stop();
  });

  it('suppressed 상태에서 sendEyeState 는 lastState 기록만 남긴다', () => {
    eyeSyncService.setSuppressed(true);
    eyeSyncService.sendEyeState('conversation');
    // 기록은 남는다 (모드 복귀 시 flush 용)
    expect(eyeSyncService.currentState).toBe('conversation');
    // start() 가 불리지 않았으므로 소켓/재연결 루프가 없다 - 내부 enabled 가
    // 꺼진 채인지는 stop() 이 no-op 으로 지나가는 것으로 간접 확인된다.
  });

  it('setSuppressed(false) 복귀 시 마지막 상태를 다시 흘린다', () => {
    eyeSyncService.setSuppressed(true);
    eyeSyncService.sendEyeState('listening');
    eyeSyncService.setSuppressed(false);
    expect(eyeSyncService.currentState).toBe('listening');
  });
});

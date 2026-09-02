/**
 * piWakeStream.service 단위 테스트.
 *
 * Jest 환경에 WebSocket 이 없으므로 수동 FakeWebSocket 을 global 에 꽂고,
 * open/message 헬퍼로 Pi 쪽 이벤트를 흉내낸다.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  url: string;
  sent: string[] = [];
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.onclose?.();
  }

  // --- 테스트 헬퍼 (Pi 쪽 이벤트 흉내) ---
  open() {
    this.onopen?.();
  }

  message(data: string | ArrayBuffer) {
    this.onmessage?.({ data });
  }
}

(global as any).WebSocket = FakeWebSocket;

// eslint-disable-next-line import/first
import { createPiWakeStream } from '../piWakeStream.service';

function lastSocket(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

describe('piWakeStream.service', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
  });

  it('forwards binary pcm as base64 and resolves pause only after paused acknowledgement', async () => {
    const stream = createPiWakeStream();
    const onPcm = jest.fn();
    const started = stream.start(onPcm);
    const socket = lastSocket();
    socket.open();
    expect(socket.binaryType).toBe('arraybuffer');
    // Pi 는 PCM 을 raw 바이너리 프레임으로 보낸다 - base64 로 변환돼 전달돼야 한다.
    const pcm = new Uint8Array([1, 2, 3, 4]);
    socket.message(pcm.buffer);
    await started;
    expect(onPcm).toHaveBeenCalledWith(Buffer.from(pcm).toString('base64'));
    expect(socket.sent).toContain(JSON.stringify({ type: 'subscribe' }));

    // 깨진 JSON 과 모르는 타입은 조용히 무시한다.
    socket.message('not-json');
    socket.message(JSON.stringify({ type: 'mystery' }));
    expect(onPcm).toHaveBeenCalledTimes(1);

    const paused = stream.pause();
    expect(socket.sent).toContain(JSON.stringify({ type: 'pause' }));
    socket.message(JSON.stringify({ type: 'paused' }));
    await expect(paused).resolves.toBeUndefined();

    await stream.stop();
  });

  it('rejects an unsettled acknowledgement when stopped', async () => {
    const stream = createPiWakeStream();
    const started = stream.start(jest.fn());
    lastSocket().open();
    await started;

    const paused = stream.pause();
    await stream.stop();
    await expect(paused).rejects.toThrow();
  });

  describe('pcm stall watchdog', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('drops the socket and resubscribes when no pcm arrives for the stall window', async () => {
      const stream = createPiWakeStream();
      const onPcm = jest.fn();
      const started = stream.start(onPcm);
      const socket = lastSocket();
      socket.open();
      await started;
      socket.message(new Uint8Array([1]).buffer); // 정상 흐름 확인

      expect(FakeWakeWebSocketCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(5000);

      // 죽은 소켓은 닫히고, 새 소켓이 다시 연결을 시도한다.
      expect(FakeWakeWebSocketCount()).toBe(2);
      const newSocket = lastSocket();
      expect(newSocket).not.toBe(socket);
      newSocket.open();
      expect(newSocket.sent).toContain(JSON.stringify({ type: 'subscribe' }));

      await stream.stop();
    });

    it('re-resumes after resubscribing so the pi restarts a stuck capture', async () => {
      const stream = createPiWakeStream();
      const started = stream.start(jest.fn());
      lastSocket().open();
      await started;

      await jest.advanceTimersByTimeAsync(5000);
      const newSocket = lastSocket();
      newSocket.open();
      newSocket.message(JSON.stringify({ type: 'resumed' }));
      await jest.advanceTimersByTimeAsync(0);

      expect(newSocket.sent).toContain(JSON.stringify({ type: 'resume' }));

      await stream.stop();
    });

    it('logs recovery once pcm flows again after a stall-triggered resubscribe', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const stream = createPiWakeStream();
      const started = stream.start(jest.fn());
      lastSocket().open();
      await started;

      await jest.advanceTimersByTimeAsync(5000);
      const newSocket = lastSocket();
      newSocket.open();
      newSocket.message(new Uint8Array([9]).buffer);

      expect(logSpy).toHaveBeenCalledWith('[PiWakeStream] pcm flowing again');
      logSpy.mockRestore();
      await stream.stop();
    });

    it('does not resubscribe while paused', async () => {
      const stream = createPiWakeStream();
      const started = stream.start(jest.fn());
      const socket = lastSocket();
      socket.open();
      await started;

      const paused = stream.pause();
      socket.message(JSON.stringify({ type: 'paused' }));
      await paused;

      await jest.advanceTimersByTimeAsync(20000);
      expect(FakeWakeWebSocketCount()).toBe(1); // 새 소켓 없음 - paused 동안엔 워치독 비활성

      await stream.stop();
    });

    it('does not fire before the first start()', async () => {
      // start() 를 부르지 않고도 워치독 타이머가 돌면 안 된다.
      await jest.advanceTimersByTimeAsync(20000);
      expect(FakeWebSocket.instances.length).toBe(0);
    });

    it('does not resume after a stall recovery if pause() lands mid-recovery', async () => {
      // C1: 워치독 복구 창(소켓 null / connect 진행 중) 동안 pause() 가 불리면
      // sendCommand 가 이른 리턴으로 조용히 resolve 돼 Pi 엔 아무것도 안 간다.
      // 그렇다고 복구가 끝나고 resume 을 보내버리면 세션이 잡고 있는 마이크와
      // 충돌하며 Pi 의 wake arecord 가 강제로 재기동된다 - resume 은 스킵돼야 한다.
      const stream = createPiWakeStream();
      const started = stream.start(jest.fn());
      lastSocket().open();
      await started;

      await jest.advanceTimersByTimeAsync(5000); // 스톨 감지 - closeSocket 후 재연결 시작
      const newSocket = lastSocket();
      expect(newSocket).not.toBe(FakeWebSocket.instances[0]);

      const paused = stream.pause(); // 복구 창 도중 pause() 호출 - 소켓이 없어 즉시 resolve
      await expect(paused).resolves.toBeUndefined();

      newSocket.open(); // 복구용 start() 가 resolve
      await jest.advanceTimersByTimeAsync(0); // 복구의 .then 체인 flush

      expect(newSocket.sent).not.toContain(JSON.stringify({ type: 'resume' }));

      // 워치독이 다시 켜져 재연결을 또 시도하면 안 된다 - disarmed 상태 유지.
      await jest.advanceTimersByTimeAsync(20000);
      expect(FakeWakeWebSocketCount()).toBe(2);

      await stream.stop();
    });

    it('ignores pcm and connect-timeout from a stale socket after an overlapping start()', async () => {
      // C2: 두 start() 호출이 겹치면 (예: idle 복귀 경로가 스톨 복구와 경합)
      // socket 변수가 동기적으로 덮어써져 첫 소켓이 고아가 되고, 그 핸들러가
      // 여전히 살아있어 PCM 을 이중으로 흘려보낼 수 있다. 세대 토큰으로 막는다.
      const stream = createPiWakeStream();
      const onPcm = jest.fn();
      const started1 = stream.start(onPcm);
      const staleSocket = lastSocket();
      const started2 = stream.start(onPcm); // 겹쳐 부른 start() - 새 세대
      const freshSocket = lastSocket();
      expect(freshSocket).not.toBe(staleSocket);

      staleSocket.open(); // 낡은 세대의 open - 공유 상태를 건드리면 안 된다
      freshSocket.open(); // 현재 세대의 open - 이게 진짜 active 소켓이 된다
      await started2;

      staleSocket.message(new Uint8Array([9]).buffer); // 낡은 소켓의 PCM - 무시돼야 한다
      expect(onPcm).not.toHaveBeenCalled();

      // 워치독을 꺼 둬서(pause) 낡은 start() 의 connect-timeout 발화 지점을
      // 워치독의 5초 스톨 창과 겹치지 않게 격리한다 - 여기서 확인할 건
      // "낡은 connect-timeout 이 fresh 소켓을 건드리는지" 하나뿐이다.
      const paused = stream.pause();
      freshSocket.message(JSON.stringify({ type: 'paused' }));
      await expect(paused).resolves.toBeUndefined();
      expect(freshSocket.sent).toContain(JSON.stringify({ type: 'pause' }));

      // 낡은 start() 의 connect-timeout (staleSocket 몫) 이 발화하는 시점.
      // 구코드는 여기서 공유 `socket` 변수(=freshSocket)를 닫아버렸다.
      await jest.advanceTimersByTimeAsync(5000);
      expect(FakeWakeWebSocketCount()).toBe(2); // 낡은 타임아웃이 재연결을 만들지 않는다

      // freshSocket 이 여전히 active 소켓이어야 resume 프레임이 나간다 -
      // 낡은 timeout 에 잘못 닫혔다면 sendCommand 가 조용히 early-return 한다.
      const resumed = stream.resume();
      freshSocket.message(JSON.stringify({ type: 'resumed' }));
      await expect(resumed).resolves.toBeUndefined();
      expect(freshSocket.sent).toContain(JSON.stringify({ type: 'resume' }));

      void started1; // 낡은 start() 의 promise 는 의도적으로 정착되지 않는다

      await stream.stop();
    });
  });
});

function FakeWakeWebSocketCount(): number {
  return FakeWebSocket.instances.length;
}

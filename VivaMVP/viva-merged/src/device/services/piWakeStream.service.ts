/**
 * Pi 호출어 PCM 스트림 (pi-server/wake.py, ws://<PI_HOST>:8788).
 *
 * viva-wake.service 가 INMP441 을 arecord 로 읽어 16kHz mono S16_LE PCM 을
 * 3200B raw 바이너리 WS 프레임으로 흘려보낸다 (Pi Zero CPU 절약 - base64/JSON
 * 래핑 없음). 제어(subscribe/pause/resume 와 paused/resumed ack)는 텍스트 JSON.
 * 앱은 바이너리 프레임을 base64 로 바꿔 기존 OpenWakeWordEngine.feedBase64 에
 * 넣는다 (인코딩은 폰 CPU 몫 - 넉넉하다). 호출어 감지 후 Pi 촬영/녹음 전에는
 * 반드시 pause() 의 `paused` ack 을 기다려 Pi 마이크(arecord) 경합을 막는다.
 */
import { encode as encodeBase64 } from 'base64-arraybuffer';
import { getPiBaseUrl } from './piBridge.service';
import type { PiWakeStream } from '../../hooks/useWakeWord';

const WAKE_PORT = 8788;
const START_TIMEOUT_MS = 5000;
// Pi 가 죽어 ack 이 영영 안 오면 beginCapture 가 pause() 에서 무한 대기해
// 버튼이 안 눌린 것처럼 보인다 - 상한을 걸고 reject 해 폰 폴백으로 넘긴다.
const ACK_TIMEOUT_MS = 5000;
// 튜닝 노브: 구독 중인데 PCM 이 이 시간 동안 한 조각도 안 오면 소켓을 죽은
// 것으로 본다. wake resume 직후 Pi 쪽 재기동 백오프를 흡수할 여유를 준다 -
// 너무 짧으면 정상적인 지터에도 재연결을 반복한다.
const WAKE_PCM_STALL_MS = 5000;

/** http://<host>:5000 -> ws://<host>:8788 */
function wakeStreamUrl(): string {
  const host = getPiBaseUrl()
    .replace(/^https?:\/\//, '')
    .replace(/:.*$/, '');
  return `ws://${host}:${WAKE_PORT}`;
}

export function createPiWakeStream(): PiWakeStream {
  let socket: WebSocket | null = null;
  let isOpen = false;
  let onPcmCb: ((base64: string) => void) | null = null;
  let failStart: ((err: Error) => void) | null = null;
  let pendingAck: {
    type: 'paused' | 'resumed';
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  // PCM 무데이터 워치독. watchdogActive 는 "지금 PCM 이 흘러야 하는 상태"
  // (구독 중 & paused 아님) 를 뜻한다 - paused 중이거나 첫 start() 전엔 절대
  // 돌지 않는다.
  let lastChunkAt = 0;
  let watchdogActive = false;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let stalledSinceRecovery = false; // "pcm flowing again" 로그 1회용 가드

  // 세션이 pause() 를 요청했는지 여부. 워치독 복구(handleStall)가 이 창을
  // 가로질러 resume 을 보내면 세션이 잡고 있는 마이크와 경합해 Pi 의 wake
  // arecord 를 강제로 재기동시킨다 - resume 직전/직후 반드시 다시 확인한다.
  let pauseRequested = false;
  // 세대 토큰. 겹쳐 불린 start() 가 서로의 소켓/콜백을 밟지 않게 막는다 -
  // 자기 gen 이 최신 generation 과 다르면 그 커넥트는 이미 버려진 것이다.
  let generation = 0;

  const armWatchdog = () => {
    watchdogActive = true;
    lastChunkAt = Date.now();
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      if (!watchdogActive) return;
      if (Date.now() - lastChunkAt < WAKE_PCM_STALL_MS) return;
      handleStall();
    }, WAKE_PCM_STALL_MS);
  };

  const disarmWatchdog = () => {
    watchdogActive = false;
  };

  /** 소켓 핸들러를 떼고 닫는다. stop() 과 워치독 재연결이 공유. */
  const closeSocket = () => {
    generation++; // 진행 중인 커넥트(있다면) 를 스스로 무효화시킨다
    const ws = socket;
    socket = null;
    isOpen = false;
    if (ws) {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  };

  /** PCM 이 WAKE_PCM_STALL_MS 동안 안 왔다 - 좀비 소켓(가짜 생존)을 버리고
   * connect/subscribe 를 재사용해 재연결한 뒤, resume 을 다시 보내 Pi 쪽
   * arecord 를 강제로 재기동시킨다(wake.py resume 은 _stop_capture 후
   * _start_capture - subscribe 만으론 좀비 arecord 를 못 죽인다). 계속
   * 막혀 있으면 다음 WAKE_PCM_STALL_MS 뒤 워치독이 그대로 다시 잡는다.
   */
  const handleStall = () => {
    // 세션이 pause 를 요청한 상태라면 복구 자체를 시작하지 않는다 - 세션이
    // 잡고 있는 마이크를 워치독이 되찾으려 들면 안 된다 (C1).
    if (pauseRequested) return;
    // pause/resume ack 대기 중이면 Pi 가 느릴 뿐 죽은 게 아닐 수 있다 - 두
    // 경로가 동시에 소켓을 만지면 경합만 커진다 (I3).
    if (pendingAck) return;
    console.log('[PiWakeStream] pcm stalled - dropping socket and resubscribing');
    stalledSinceRecovery = true;
    lastChunkAt = Date.now(); // 재시도 사이클 리셋 - 여전히 막혀 있으면 다음 주기에 다시 잡힌다
    const cb = onPcmCb;
    closeSocket();
    if (!cb) return;
    start(cb)
      .then(() => {
        // 복구가 연결하는 동안 pause() 가 들어왔을 수 있다 - 다시 확인하고,
        // 그렇다면 resume 을 보내지 않고 워치독도 꺼둔다.
        if (pauseRequested) {
          disarmWatchdog();
          return;
        }
        return sendCommand('resume', 'resumed');
      })
      .catch((err) => console.warn('[PiWakeStream] watchdog resubscribe failed:', err));
  };

  const rejectPendingAck = (err: Error) => {
    if (!pendingAck) return;
    const ack = pendingAck;
    pendingAck = null;
    clearTimeout(ack.timer);
    ack.reject(err);
  };

  const resolvePendingAck = (type: 'paused' | 'resumed') => {
    if (pendingAck?.type !== type) return; // 기다리지 않는 ack 은 무시
    const ack = pendingAck;
    pendingAck = null;
    clearTimeout(ack.timer);
    ack.resolve();
  };

  const sendCommand = (command: 'pause' | 'resume', ackType: 'paused' | 'resumed') =>
    new Promise<void>((resolve, reject) => {
      if (!socket || !isOpen) {
        // 스트림이 붙어 있지 않으면 Pi 마이크를 잡고 있지도 않다 - 놓을 것도
        // 재개할 것도 없으므로 성공으로 본다. (폰 마이크 경로에서 beginCapture
        // 가 pause() 를 불러도 Pi 촬영이 막히면 안 된다.)
        resolve();
        return;
      }
      rejectPendingAck(new Error(`[piWakeStream] superseded by ${command}`));
      const timer = setTimeout(
        () => rejectPendingAck(new Error(`[piWakeStream] ${ackType} ack timeout`)),
        ACK_TIMEOUT_MS,
      );
      pendingAck = { type: ackType, resolve, reject, timer };
      socket.send(JSON.stringify({ type: command }));
    });

  const start = (onPcm: (base64: string) => void): Promise<void> => {
    onPcmCb = onPcm;
    // idle 복귀 후 재시작: 살아 있는 소켓을 재사용하고 콜백만 갈아끼운다
    // (resume 은 App 쪽 책임 - 여기서 또 subscribe 하면 이중 구독이 된다).
    if (socket && isOpen) {
      armWatchdog(); // 재사용한 소켓이 실은 죽어있을 수 있다 - 워치독이 확인한다
      return Promise.resolve();
    }

    // 이 커넥트만의 세대 토큰. 이후 모든 핸들러는 자기 gen 이 최신
    // generation 과 같을 때만 공유 상태(socket/isOpen/onPcmCb)를 건드린다 -
    // 겹쳐 불린 start() 가 서로를 덮어써 소켓을 고아로 만들지 못하게 막는다.
    const gen = ++generation;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        failStart = null;
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        if (gen !== generation) {
          // 이미 버려진 커넥트 - 최신 소켓은 안 건드리되, OS 계층에서 영영
          // 안 풀리는 커넥트가 남지 않게 자기 소켓은 직접 닫는다 (재리뷰 마이너).
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          return;
        }
        settle(new Error('[piWakeStream] connect timeout'));
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }, START_TIMEOUT_MS);
      failStart = settle;

      let ws: WebSocket;
      try {
        ws = new WebSocket(wakeStreamUrl());
      } catch (err) {
        settle(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      ws.binaryType = 'arraybuffer'; // PCM 바이너리 프레임을 ArrayBuffer 로 받는다

      ws.onopen = () => {
        if (gen !== generation) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          return;
        }
        socket = ws;
        isOpen = true;
        ws.send(JSON.stringify({ type: 'subscribe' }));
        armWatchdog();
        settle();
      };
      ws.onerror = () => {
        if (gen !== generation) return;
        settle(new Error('[piWakeStream] socket error'));
      };
      ws.onclose = () => {
        if (gen !== generation) return;
        isOpen = false;
        socket = null;
        settle(new Error('[piWakeStream] socket closed before open'));
        rejectPendingAck(new Error('[piWakeStream] socket closed'));
      };
      ws.onmessage = (event) => {
        if (gen !== generation) return; // 낡은 세대의 PCM/ack - 무시 (이중 피드 방지)
        if (event.data instanceof ArrayBuffer) {
          lastChunkAt = Date.now();
          if (stalledSinceRecovery) {
            stalledSinceRecovery = false;
            console.log('[PiWakeStream] pcm flowing again');
          }
          onPcmCb?.(encodeBase64(event.data)); // raw PCM 프레임
          return;
        }
        if (typeof event.data !== 'string') return;
        let msg: { type?: unknown };
        try {
          msg = JSON.parse(event.data);
        } catch {
          return; // 깨진 프레임은 무시
        }
        if (msg?.type === 'paused' || msg?.type === 'resumed') {
          resolvePendingAck(msg.type as 'paused' | 'resumed');
          // paused 동안엔 Pi 가 arecord 를 꺼 PCM 이 안 온다 - 정상이니 워치독을
          // 끈다. resumed 는 다시 흘러야 하니 켠다(재연결 루프의 resume 도 포함).
          if (msg.type === 'paused') disarmWatchdog();
          else armWatchdog();
        }
        // 그 외 타입은 무시
      };
    });
  };

  // ponytail: stop() 은 현재 프로덕션 호출부가 없다(테스트 전용) - 워치독
  // 인터벌은 앱 수명 내내 도는 게 의도이므로 정리 로직은 그대로 둔다.
  const stop = (): Promise<void> => {
    rejectPendingAck(new Error('[piWakeStream] stopped'));
    failStart?.(new Error('[piWakeStream] stopped'));
    disarmWatchdog();
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    onPcmCb = null;
    closeSocket(); // 닫힌 뒤 늦게 도착하는 이벤트가 새 상태를 건드리지 않게 핸들러도 끊는다
    return Promise.resolve();
  };

  return {
    start,
    pause: () => {
      // 주의: 이 플래그는 resume() 만이 푼다 - pause 만 부르고 resume 을 안
      // 부르는 호출자가 생기면 워치독이 영구 비활성화된다 (현 호출자는
      // App.device 의 pause→resume 쌍 하나뿐).
      pauseRequested = true;
      disarmWatchdog(); // ack 을 기다리지 않고 즉시 끈다 - Pi 가 죽어 ack 이 안 와도 워치독이 되살리면 안 된다
      return sendCommand('pause', 'paused');
    },
    resume: () => {
      pauseRequested = false;
      return sendCommand('resume', 'resumed');
    },
    stop,
  };
}

/**
 * Eye-state sync service (mirrors CharacterView's EyeState to the physical
 * VIVA display board over WebSocket).
 *
 * Scope: the phone remains the "brain" (wake word, mic, Gemini, TTS, camera,
 * FSM). This service only pushes lightweight state notifications - it never
 * streams audio/video/frames. The board owns its own animation loop and
 * just needs to know which of the 4 states to play.
 *
 * Board is optional: if it's unreachable, this fails silently (retrying in
 * the background) and never blocks or affects the phone-side experience.
 */
import type { EyeState } from '../../components/EyeAnimation';
import type { AppStatus } from '../../types/AppState';

const Config = {
  // Point this at the board once it has a fixed IP / mDNS name, e.g.
  // ws://192.168.0.42:8787 or ws://viva.local:8787. For local testing run
  // tools/eyeSyncTestServer.js and set ws://localhost:8787 in .env.
  //
  // 미설정이면 서비스 전체가 꺼진다. 예전엔 localhost 로 기본값을 줬는데,
  // 보드가 없는 폰에서 localhost 는 절대 안 붙으므로 대화 진입 순간부터
  // 앱이 살아 있는 내내 3초마다 WS 연결 실패/재시도를 무한 반복했다
  // (sendEyeState 가 자동으로 start 하고, stop 호출부는 없다).
  EYE_SYNC_WS_URL: process.env.EXPO_PUBLIC_EYE_SYNC_WS_URL || '',
};

const RECONNECT_DELAY_MS = 3000;

/**
 * 호출어 감지 직후 'calling' 을 붙잡아 두는 시간 (2026-08-07 사용자 지정).
 *
 * App.beginCapture 는 예전에도 'calling' 을 보냈지만, 마이크 teardown 이
 * 끝나는 수백 ms 뒤 startCapturing/startProcessing 의 transitionTo 가 곧바로
 * 덮어써서 사람이 인지하기 전에 사라졌다 - 학생 눈엔 idle 에서 곧장 촬영
 * 표정으로 건너뛰는 것으로 보인다. 촬영+분석은 12초가 넘는데 그 구간이 단일
 * 무표정 블록이라 더 길게 읽힌다.
 *
 * 이 홀드는 아무것도 빠르게 만들지 않는다 - 대기를 "불렀구나!" 와 "일하는
 * 중" 두 비트로 쪼개 체감 길이를 줄이는 연출이다. 눈은 순수 표시 채널이라
 * 촬영·업로드·분석 파이프라인은 이 값과 무관하게 그대로 돈다.
 */
export const CALLING_HOLD_MS = 2500;

// capturing/history/session_detail 은 board 쪽엔 별도 표정이 없으니 idle -
// 대화 중(conversation) 세부 표정은 ConversationScreen 의 getEyeState() 가 이
// 초기값 위에 더 정확한 값으로 곧장 덮어쓴다(아래 transitionTo 참고).
//
// 사진 분석 대기(processing, 5~19초)는 'listening' 눈이다: 정면 고정 + 버스트
// 끄덕임. 부호('?')를 20초 가까이 띄워두는 것보다 "일하고 있다"로 읽힌다
// (2026-08-07 사용자 지정). 눈 상태 이름은 대화 쪽 의미에서 온 것이라 여기
// 문맥과는 어긋나 보이지만, 이름이 아니라 연출로 고른 값이다.
export const STATUS_EYE_STATE: Record<AppStatus, EyeState> = {
  idle: 'idle',
  // 의도파악 루프 — 진입 직후 한 순간의 초기값. 루프가 곧바로
  // processing(학생 말)/listening(비바 말) 으로 덮어쓴다 (ConversationScreen 과 동일 구조).
  intent: 'conversation',
  capturing: 'idle',
  processing: 'listening',
  conversation: 'conversation',
  history: 'idle',
  session_detail: 'idle',
};

type ConnectionListener = (connected: boolean) => void;

class EyeSyncService {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastState: EyeState | null = null;
  /** 홀드 만료까지 남은 타이머. null 이면 홀드 없음. */
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** 홀드 중 도착한 가장 최근 상태 (만료 시 이것만 반영). */
  private pendingState: EyeState | null = null;
  private enabled = false;
  /** APP 모드: 보드가 대상에서 빠진 상태. 송신·재연결 루프를 멈춘다. */
  private suppressed = false;
  private connectionListeners = new Set<ConnectionListener>();

  /** Call once (e.g. app start) to begin trying to reach the board.
   * EXPO_PUBLIC_EYE_SYNC_WS_URL 이 없으면 no-op - 보드 자체가 없는 것. */
  start(): void {
    if (this.enabled || !Config.EYE_SYNC_WS_URL) return;
    this.enabled = true;
    console.log(`[EyeSync] Starting sync to ${Config.EYE_SYNC_WS_URL}`);
    this.connect();
  }

  /** Call on app teardown to stop reconnect attempts and close the socket. */
  stop(): void {
    this.enabled = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
      this.pendingState = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  /** APP 모드 진입/이탈. 진입 시 소켓·재연결을 내리고, 이탈 시 마지막
   * 상태를 다시 흘려 보드가 즉시 따라잡게 한다. */
  setSuppressed(suppressed: boolean): void {
    this.suppressed = suppressed;
    if (suppressed) {
      this.stop();
    } else {
      this.resendLast();
    }
  }

  /** 마지막 상태를 재송신해 (필요하면) 연결 루프를 다시 살린다.
   * connectionMonitor 가 connected 복귀 엣지에서 부른다 - disconnected 판정
   * 때 stop() 으로 내려간 WS 를 여기서 되살린다. 아직 아무 상태도 안 보낸
   * 콜드 스타트면 idle 로 시작한다 (보드 기본 표정과 동일). */
  resendLast(): void {
    this.sendEyeState(this.lastState ?? 'idle');
  }

  /** 보드에 마지막으로 내보낸 상태. 홀드 중이면 홀드 중인 상태가 남아 있다
   * (대기 중인 상태는 아직 이 값이 아니다). 보드가 없거나 WS 가 끊겨 있어도
   * 갱신되는, "무엇을 보내기로 했나" 의 단일 관측점 - EXPO_PUBLIC_* 는 babel
   * 이 빌드 시점에 인라인해서 테스트가 WS URL 을 못 바꾸기 때문에 홀드 계약은
   * 이 값으로 검증한다. */
  get currentState(): EyeState | null {
    return this.lastState;
  }

  onConnectionChange(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  /**
   * Send the current eye state to the board. Safe to call on every state
   * change, even if the board is offline - this just no-ops (and remembers
   * the state to resend once/if a connection is established).
   */
  sendEyeState(state: EyeState, opts?: { holdMs?: number }): void {
    if (opts?.holdMs) {
      // 새 홀드가 이전 홀드를 대체한다 (다시 불린 것).
      if (this.holdTimer) clearTimeout(this.holdTimer);
      this.pendingState = null;
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        const queued = this.pendingState;
        this.pendingState = null;
        if (queued) this.sendEyeState(queued);
      }, opts.holdMs);
    } else if (this.holdTimer) {
      // 홀드 중 - 최소 보장이라 고정 지연이 아니다. 그 사이 들어온 상태는
      // 마지막 것만 남겼다가 만료 시 반영한다. lastState 는 건드리지 않아
      // 홀드 중 재연결이 일어나도 보드는 홀드 중인 표정을 받는다.
      this.pendingState = state;
      return;
    }
    this.lastState = state;
    if (this.suppressed) return; // 기록만 - APP 모드에선 보드가 없다
    if (!this.enabled) this.start();
    this.flush();
  }

  private flush(): void {
    // socket 을 먼저 명시적으로 거른다 - optional chaining 만 쓰면 WebSocket
    // 구현이 static OPEN 을 안 가진 환경(테스트 FakeWebSocket)에서
    // undefined === undefined 로 뚫려 null.send() 가 터진다.
    if (this.socket && this.socket.readyState === WebSocket.OPEN && this.lastState) {
      this.socket.send(JSON.stringify({ eyeState: this.lastState, ts: Date.now() }));
    }
  }

  private connect(): void {
    if (!this.enabled) return;
    try {
      const socket = new WebSocket(Config.EYE_SYNC_WS_URL);
      this.socket = socket;

      socket.onopen = () => {
        console.log('[EyeSync] Connected to board');
        this.connectionListeners.forEach((l) => l(true));
        this.flush(); // resend the last known state so the board catches up
      };

      socket.onclose = () => {
        this.connectionListeners.forEach((l) => l(false));
        this.scheduleReconnect();
      };

      socket.onerror = () => {
        // onclose fires right after in RN's WebSocket impl; reconnect is
        // scheduled there. Swallow here to avoid an unhandled error log
        // flooding the console while the board is powered off.
      };
    } catch (err) {
      console.warn('[EyeSync] Failed to open socket:', err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.enabled || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }
}

/** Singleton - one physical board, one connection, for the app's lifetime. */
export const eyeSyncService = new EyeSyncService();

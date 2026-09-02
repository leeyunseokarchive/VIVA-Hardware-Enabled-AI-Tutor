/**
 * Pi 연결 상태 단일 판정자 (2026-08-10 역할 분리 스펙).
 *
 * 판정은 GET /health 주기 폴링 하나로만 한다. 눈 WS 끊김이나 piBridge 호출
 * 실패는 상태를 직접 바꾸지 않고 "지금 당장 재프로브" 트리거로만 쓴다 -
 * 채널별 liveness 를 그대로 노출하면 예전의 3파편(piReadyRef/눈WS/웨이크WS)
 * 문제를 화면 수만큼 복제하게 된다.
 *
 * 디바이스 모드에서만 start(). APP 모드는 stop() - 정지 중 상태는
 * 'connecting'(판정 보류)이다.
 */
import { AppState } from 'react-native';
import { fetchPiHealth, PiHealth } from './piBridge.service';
import { eyeSyncService } from './eyeSync.service';
import { backgroundKeepAlive } from './backgroundKeepAlive.service';

export type PiConnectionStatus = 'connected' | 'connecting' | 'disconnected';
export type { PiHealth } from './piBridge.service';

const POLL_INTERVAL_MS = 5000;
/** 끊김이 이만큼 지속되면 keepalive 를 내린다 (배터리 방어). 즉시 내리면
 * 백그라운드 순간 끊김에 앱이 suspend 돼 로봇 복귀를 영영 감지 못 한다. */
const KEEPALIVE_STOP_GRACE_MS = 3 * 60_000; // 튜닝 노브

type StatusListener = (status: PiConnectionStatus) => void;

class ConnectionMonitorService {
  private _status: PiConnectionStatus = 'connecting';
  private _health: PiHealth | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private probing = false;
  /** 2-strike(08-14): 절전 off 후에도 남는 단발 /health 타임아웃이 connected
   * 를 플랩시켜 진행 중 턴의 발화를 삼켰다(ConversationScreen customSpeak 의
   * disconnected 가드). connected 에서만 2연속 실패를 요구한다 - connecting/
   * disconnected 에선 기존대로 즉시 판정(시작 시 피드백 지연 없음). 판정
   * 지연 최대 10초로 끊김 전파 12초 스펙 안. */
  private failStreak = 0;
  private listeners = new Set<StatusListener>();
  private eyeWsUnsub: (() => void) | null = null;
  private keepAliveStopTimer: ReturnType<typeof setTimeout> | null = null;
  private appStateSub: { remove(): void } | null = null;

  get status(): PiConnectionStatus {
    return this._status;
  }

  /** 마지막 성공 프로브의 하드웨어 상태. 미연결·정지 중엔 null. */
  get health(): PiHealth | null {
    return this._health;
  }

  start(): void {
    if (this.pollTimer) return;
    void this.probe();
    this.pollTimer = setInterval(() => void this.probe(), POLL_INTERVAL_MS);

    // 눈 WS 끊김 = "Pi 가 이상하다" 힌트. 판정은 안 바꾸고 즉시 재프로브만
    // 트리거한다 (스펙 §2). 재연결 성공(true)은 신호로 안 쓴다 - /health 가 진실.
    // ponytail: piBridge 호출 실패 트리거는 유예 - fetchWithTimeout 에 넣으면
    // /health 실패가 재프로브를 재귀 유발한다. 세션 중 끊김은 5초 폴링이 잡는다.
    this.eyeWsUnsub = eyeSyncService.onConnectionChange((connected) => {
      if (!connected) this.reportFailure();
    });

    // foreground 복귀 보험: iOS 가 인터럽트(전화 등)로 오디오 세션을 뺏었거나
    // suspend 직전이었다면, 돌아온 즉시 판정을 새로 하고 무음 루프를 되살린다.
    this.appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void this.probe();
        void backgroundKeepAlive.ensurePlaying();
      }
    });
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.eyeWsUnsub?.();
    this.eyeWsUnsub = null;
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.clearKeepAliveStopTimer();
    void backgroundKeepAlive.stop();
    this.failStreak = 0;
    // 정지 후 stale 판정이 UI에 남지 않도록 보류 상태로 되돌린다.
    this.commit('connecting', null);
  }

  /** piBridge 호출 실패 등 "Pi 가 이상하다" 신호. 판정은 probe 가 한다. */
  reportFailure(): void {
    if (!this.pollTimer) return; // 정지 중(APP 모드)엔 무시
    void this.probe();
  }

  /** 지금 즉시 프로브하고 결과를 돌려준다 (beginCapture 실패 분기용).
   * 2-strike 디바운스와 무관하게 방금 프로브의 진실을 준다 - 여기서 상태
   * 판정(_status)을 읽으면 단발 실패가 connected 로 남아 죽은 Pi 로 세션을
   * 시작한다. 다른 프로브가 in-flight 면 그 결과를 기다리지 않고 현재
   * 판정을 준다 - 5초 안에 두 번 물을 만큼 급한 호출부는 없다. */
  async probeNow(): Promise<boolean> {
    const fresh = await this.probe();
    return fresh ?? this._status === 'connected';
  }

  onStatusChange(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 성공 여부를 돌려준다 (probeNow 용). in-flight 로 스킵되면 undefined. */
  private async probe(): Promise<boolean | undefined> {
    if (this.probing) return undefined;
    this.probing = true;
    try {
      const health = await fetchPiHealth(); // 절대 throw 안 함 (piBridge)
      // await 도중 stop() 이 오면(APP 모드 전환) 늦게 도착한 판정이
      // stop() 이 세팅한 'connecting' 계약을 덮어쓰면 안 된다.
      if (!this.pollTimer) return health != null;
      if (health) {
        this.failStreak = 0;
        this.commit('connected', health);
      } else {
        this.failStreak += 1;
        if (this._status !== 'connected' || this.failStreak >= 2) {
          this.commit('disconnected', null);
        }
      }
      return health != null;
    } finally {
      this.probing = false;
    }
  }

  /** 상태 **또는** 헬스가 바뀌었을 때만 통지한다. status 만 보고 게이팅하면
   * 연결을 유지한 채 마이크나 카메라가 죽는 경우가 화면에 안 뜬다. */
  // ponytail: micOk/speakerOk/camOk/displayOk 를 하드코딩 비교한다. 오늘은
  // 안전하다 - commit 은 ('connected', null) 로는 절대 안 불린다(probe 의
  // 유일한 호출부가 health ? 'connected' : 'disconnected' 로 짝짓는다).
  // 천장 둘: (1) PiHealth 에 필드가 또 늘면 여기 안 늘려도 조용히 통지가
  // 빠진다(2026-08-10에 camOk/displayOk 추가 때 실제로 이 자리를 고쳤다),
  // (2) 미래에 누가 ('connected', null) 로 부르면 optional chaining 때문에
  // null 과 전부 undefined 인 객체가 같다고 읽혀 아무도 통지 못 받는다.
  // 업그레이드 경로: health 객체를 얕은 비교(Object.keys)로 바꾼다.
  private commit(status: PiConnectionStatus, health: PiHealth | null): void {
    const changed =
      this._status !== status ||
      this._health?.micOk !== health?.micOk ||
      this._health?.speakerOk !== health?.speakerOk ||
      this._health?.camOk !== health?.camOk ||
      this._health?.displayOk !== health?.displayOk;
    if (this._status !== status) {
      console.log(`[ConnectionMonitor] ${this._status} -> ${status}`);
      // 로봇 디스플레이의 '연결 끊김' 화면은 눈 WS 무클라이언트 판정으로
      // 뜬다 (eyes.py). 판정자는 여기 하나여야 하므로, disconnected 면 눈
      // WS 재접속 루프를 의도적으로 내려 보드가 스스로 끊김을 알게 하고,
      // connected 복귀 시 마지막 표정을 재송신해 되살린다. 예전엔 앱이
      // "연결 안 됨"을 띄우는 동안에도 3초 재접속 루프가 계속 돌아 보드
      // 입장에선 클라이언트가 늘 있었다 - 그래서 영원히 안 잤다.
      if (status === 'disconnected') {
        eyeSyncService.stop();
        if (!this.keepAliveStopTimer) {
          this.keepAliveStopTimer = setTimeout(() => {
            this.keepAliveStopTimer = null;
            void backgroundKeepAlive.stop();
          }, KEEPALIVE_STOP_GRACE_MS);
        }
      } else if (status === 'connected') {
        eyeSyncService.resendLast();
        this.clearKeepAliveStopTimer();
        void backgroundKeepAlive.start();
      }
    }
    this._status = status;
    this._health = health;
    if (changed) this.listeners.forEach((l) => l(status));
  }

  private clearKeepAliveStopTimer(): void {
    if (this.keepAliveStopTimer) {
      clearTimeout(this.keepAliveStopTimer);
      this.keepAliveStopTimer = null;
    }
  }
}

/** 싱글턴 - Pi 는 하나, 판정자도 하나. */
export const connectionMonitor = new ConnectionMonitorService();

/**
 * iOS/Android 백그라운드 생존 (2026-08-14 설계).
 *
 * 화면 꺼짐/앱 전환 시 iOS 가 앱을 suspend 하면 health 폴링·눈 WS·호출어
 * PCM 이 전부 얼어붙는다. UIBackgroundModes: audio + 무음 루프가 재생되는
 * 동안은 suspend 가 유예되므로 로봇 연동이 유지된다.
 * Android 는 OEM 킬·Doze 대응으로 포그라운드 서비스(connectedDevice)를
 * 무음 루프와 병행한다 (2026-08-14 증보).
 *
 * 라이프사이클은 connectionMonitor 가 소유한다 - 여기서는 절대 스스로
 * start/stop 하지 않는다. mixWithOthers 라 사용자가 다른 앱에서 트는
 * 강의 영상 소리를 죽이지 않는다.
 */
import { Platform } from 'react-native';
import { Audio, InterruptionModeIOS } from 'expo-av';
import BackgroundService, { BackgroundTaskOptions } from 'react-native-background-actions';

/** Android FGS 알림. connectedDevice = "네트워크로 외부 기기와 상호작용" -
 * 로컬 WS/폴링 유지가 정확히 이 용도다. plugins/withBackgroundActions.js 의
 * 매니페스트 선언과 반드시 일치해야 한다. */
const FGS_OPTIONS: BackgroundTaskOptions = {
  taskName: 'VivaKeepAlive',
  taskTitle: '비바와 연결 유지 중',
  taskDesc: '로봇과의 연결을 유지하고 있어요',
  taskIcon: { name: 'ic_launcher', type: 'mipmap' },
  color: '#FAF7F0',
  foregroundServiceType: ['connectedDevice'],
};

const FGS_TICK_MS = 5000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class BackgroundKeepAliveService {
  private sound: Audio.Sound | null = null;
  /** 마지막 의도. await 중에 start/stop 이 겹치면 이 값이 이긴다. */
  private desired = false;
  /** Android FGS 의도. stop() 버그(#201: 실행 중 태스크를 즉시 못 죽임)
   * 대비 - 태스크 루프가 이 플래그를 보고 스스로 내려온다. */
  private fgsDesired = false;
  /** 직렬화 큐 - start/stop/ensure 가 인터리브되면 sound 가 샌다. */
  private queue: Promise<void> = Promise.resolve();

  /** 실제 재생 세션 보유 여부 */
  get active(): boolean {
    return this.sound !== null;
  }

  start(): Promise<void> {
    this.desired = true;
    return this.enqueue(() => this.acquire());
  }

  stop(): Promise<void> {
    this.desired = false;
    return this.enqueue(async () => {
      if (this.desired) return;
      if (Platform.OS === 'android') await this.stopFgs();
      if (!this.sound) return;
      const sound = this.sound;
      this.sound = null;
      try {
        await sound.unloadAsync();
      } catch (e) {
        // connectionMonitor 가 void 로 부르는 계약 - throw 전파 금지
        console.warn('[BackgroundKeepAlive] stop 실패:', e instanceof Error ? e.message : String(e));
      }
    });
  }

  /** foreground 복귀 보험: 전화 등 인터럽트로 멈춘 재생을 되살린다. sound 가
   * 없는데(예: 직전 start() 가 로드 실패) 여전히 desired 면 재획득도 여기서
   * 시도한다 - foreground 복귀 시점은 Android FGS 시작이 합법인 시점이라
   * 다음 연결 엣지까지 기다릴 필요가 없다. */
  ensurePlaying(): Promise<void> {
    return this.enqueue(async () => {
      if (this.desired && !this.sound) return this.acquire();
      if (!this.desired || !this.sound) return;
      try {
        const status = await this.sound.getStatusAsync();
        if (status.isLoaded && !status.isPlaying) await this.sound.playAsync();
      } catch (e) {
        console.warn('[BackgroundKeepAlive] ensurePlaying 실패:', e instanceof Error ? e.message : String(e));
      }
    });
  }

  /** start()/ensurePlaying() 공유 획득 로직 - 큐 잡 안에서만 호출한다. */
  private async acquire(): Promise<void> {
    if (!this.desired) return;
    if (Platform.OS === 'android') await this.startFgs();
    if (this.sound) return;
    try {
      await Audio.setAudioModeAsync({
        staysActiveInBackground: true,
        playsInSilentModeIOS: true,
        interruptionModeIOS: InterruptionModeIOS.MixWithOthers,
        allowsRecordingIOS: false,
        shouldDuckAndroid: false,
      });
      const { sound } = await Audio.Sound.createAsync(
        require('../../../assets/silence.wav'),
        { isLooping: true, volume: 0 },
      );
      if (!this.desired) {
        // 로딩 중에 stop 이 왔다 - 새지 않게 즉시 되물린다.
        await sound.unloadAsync();
        return;
      }
      this.sound = sound;
      await sound.playAsync();
    } catch (e) {
      // connectionMonitor 가 void 로 부르는 계약 - throw 전파 금지
      console.warn('[BackgroundKeepAlive] start 실패:', e instanceof Error ? e.message : String(e));
    }
  }

  private async startFgs(): Promise<void> {
    if (this.fgsDesired) return;
    this.fgsDesired = true;
    try {
      // 태스크 프라미스가 resolve 되면 라이브러리가 스스로 stop() 을 호출해
      // FGS 를 내린다 - 이 루프는 fgsDesired 가 꺼지는 시점(stopFgs)에 맞춰
      // 스스로 resolve 됨으로써 그 하강 타이밍을 통제한다. stopFgs() 가
      // 부르는 명시적 stop() 과 라이브러리의 자동 stop() 이 겹치면 native
      // stop 이 이중 호출되지만 멱등이라 무해하다.
      await BackgroundService.start(async () => {
        while (this.fgsDesired && BackgroundService.isRunning()) {
          await sleep(FGS_TICK_MS);
        }
      }, FGS_OPTIONS);
    } catch (e) {
      this.fgsDesired = false;
      console.warn('[BackgroundKeepAlive] FGS 시작 실패:', e instanceof Error ? e.message : String(e));
    }
  }

  private async stopFgs(): Promise<void> {
    if (!this.fgsDesired) return;
    this.fgsDesired = false;
    try {
      await BackgroundService.stop();
    } catch (e) {
      console.warn('[BackgroundKeepAlive] FGS 정지 실패:', e instanceof Error ? e.message : String(e));
    }
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.queue.then(job, job);
    // 한 작업의 실패가 큐 전체를 영원히 막으면 안 된다.
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** 싱글턴 - 오디오 세션은 프로세스에 하나. */
export const backgroundKeepAlive = new BackgroundKeepAliveService();

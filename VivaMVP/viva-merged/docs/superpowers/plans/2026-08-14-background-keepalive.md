# iOS 백그라운드 생존 (무음 오디오 세션) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 아이폰 화면 꺼짐/앱 전환 중에도 VIVA for Device 앱이 suspend 되지 않고 로봇(Pi)과의 3개 통신 채널을 유지한다.

**Architecture:** `UIBackgroundModes: ["audio"]` 선언 + 로봇 연결 중에만 무음 WAV 를 volume 0 / mixWithOthers 로 루프 재생하는 `backgroundKeepAlive` 서비스를 신설하고, 라이프사이클은 기존 단일 판정자 `connectionMonitor` 가 소유한다 (connected → start, disconnected 3분 지속 → stop, APP 모드 → 즉시 stop). Pi 쪽 변경 없음.

**Tech Stack:** React Native 0.74 + Expo SDK 51, expo-av 14 (이미 설치됨 — 신규 의존성 금지), jest-expo.

스펙: `docs/superpowers/specs/2026-08-14-background-keepalive-design.md`

## Global Constraints

- 작업 디렉토리: 저장소 루트의 `viva-merged/` (모든 경로는 그 기준).
- 신규 npm 의존성 추가 금지 — expo-av 14 만 사용.
- 주석·로그·문서는 기존 코드베이스처럼 한국어. 코드 스타일은 주변 파일 따름 (세미콜론, single quote, 2-space).
- device variant 전용 기능 — phone variant (`APP_VARIANT=phone`) 빌드에는 UIBackgroundModes 가 들어가면 안 된다.
- 테스트 실행: `npm test -- <파일경로>` (dotenv 래퍼 필수, 직접 jest 호출 금지).
- 마지막 태스크에서 `docs/process.md` 갱신 (AGENTS.md 필수 규칙 — 문서 맨 위 "문서 갱신 규칙" 절을 따를 것).

---

### Task 1: 무음 WAV 에셋 + backgroundKeepAlive 서비스

**Files:**
- Create: `assets/silence.wav` (스크립트로 생성)
- Create: `src/device/services/backgroundKeepAlive.service.ts`
- Create: `src/device/services/__tests__/backgroundKeepAlive.service.test.ts`
- Modify: `jest.config.js` (moduleNameMapper 에 .wav 스텁 1줄)
- Create: `test-mocks/asset-stub.js`

**Interfaces:**
- Consumes: expo-av `Audio`, `InterruptionModeIOS`.
- Produces: 싱글턴 `backgroundKeepAlive` — `start(): Promise<void>`, `stop(): Promise<void>`, `ensurePlaying(): Promise<void>`, `active: boolean` (getter). Task 2 가 이 네 멤버를 그대로 import 한다.

- [ ] **Step 1: 무음 WAV 생성 (1초, 8kHz mono 16-bit, 약 16KB)**

```bash
cd viva-merged && node -e "
const fs = require('fs');
const sr = 8000, n = sr * 1;
const data = Buffer.alloc(n * 2);
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28);
h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
h.write('data', 36); h.writeUInt32LE(data.length, 40);
fs.writeFileSync('assets/silence.wav', Buffer.concat([h, data]));
console.log('wrote', 44 + data.length, 'bytes');
"
```

Expected: `wrote 16044 bytes`, `assets/silence.wav` 생성.

- [ ] **Step 2: jest 에서 .wav require 가 풀리도록 스텁 매핑**

`test-mocks/asset-stub.js` 생성:

```js
// RN 에셋 require 는 번들러가 숫자 ID 로 치환한다 - 테스트에선 아무 숫자면 된다.
module.exports = 1;
```

`jest.config.js` 의 `moduleNameMapper` 에 추가:

```js
  moduleNameMapper: {
    '^@react-native-async-storage/async-storage$':
      '<rootDir>/node_modules/@react-native-async-storage/async-storage/jest/async-storage-mock.js',
    '\\.wav$': '<rootDir>/test-mocks/asset-stub.js',
  },
```

- [ ] **Step 3: 실패하는 테스트 작성**

`src/device/services/__tests__/backgroundKeepAlive.service.test.ts`:

```ts
/**
 * backgroundKeepAlive: 무음 루프의 시작/정지 멱등성과 직렬화.
 * expo-av 는 전부 모킹 - 실제 오디오 검증은 실기기 체크리스트(스펙 §테스트).
 */
const mockSound = {
  playAsync: jest.fn().mockResolvedValue(undefined),
  unloadAsync: jest.fn().mockResolvedValue(undefined),
  getStatusAsync: jest.fn().mockResolvedValue({ isLoaded: true, isPlaying: true }),
};

jest.mock('expo-av', () => ({
  InterruptionModeIOS: { MixWithOthers: 0 },
  Audio: {
    setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
    Sound: { createAsync: jest.fn(() => Promise.resolve({ sound: mockSound })) },
  },
}));

import { Audio } from 'expo-av';
import { backgroundKeepAlive } from '../backgroundKeepAlive.service';

beforeEach(async () => {
  await backgroundKeepAlive.stop();
  jest.clearAllMocks();
});

describe('backgroundKeepAlive', () => {
  it('start 는 오디오 모드 설정 후 무음 루프를 재생한다', async () => {
    await backgroundKeepAlive.start();
    expect(Audio.setAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        staysActiveInBackground: true,
        playsInSilentModeIOS: true,
      }),
    );
    expect(Audio.Sound.createAsync).toHaveBeenCalledWith(expect.anything(), {
      isLooping: true,
      volume: 0,
    });
    expect(mockSound.playAsync).toHaveBeenCalled();
    expect(backgroundKeepAlive.active).toBe(true);
  });

  it('start 두 번은 사운드를 한 번만 만든다 (멱등)', async () => {
    await backgroundKeepAlive.start();
    await backgroundKeepAlive.start();
    expect(Audio.Sound.createAsync).toHaveBeenCalledTimes(1);
  });

  it('stop 은 unload 하고 active 를 내린다. 두 번 불러도 안전', async () => {
    await backgroundKeepAlive.start();
    await backgroundKeepAlive.stop();
    await backgroundKeepAlive.stop();
    expect(mockSound.unloadAsync).toHaveBeenCalledTimes(1);
    expect(backgroundKeepAlive.active).toBe(false);
  });

  it('start 직후 await 없이 stop 하면 최종 상태는 정지 (마지막 의도 승리)', async () => {
    const p1 = backgroundKeepAlive.start();
    const p2 = backgroundKeepAlive.stop();
    await Promise.all([p1, p2]);
    expect(backgroundKeepAlive.active).toBe(false);
    // 만들었다면 반드시 되물렸어야 한다
    if ((Audio.Sound.createAsync as jest.Mock).mock.calls.length > 0) {
      expect(mockSound.unloadAsync).toHaveBeenCalled();
    }
  });

  it('ensurePlaying 은 멈춘 재생을 되살린다', async () => {
    await backgroundKeepAlive.start();
    mockSound.playAsync.mockClear();
    mockSound.getStatusAsync.mockResolvedValueOnce({ isLoaded: true, isPlaying: false });
    await backgroundKeepAlive.ensurePlaying();
    expect(mockSound.playAsync).toHaveBeenCalledTimes(1);
  });

  it('ensurePlaying 은 정지 상태에선 아무것도 안 한다', async () => {
    await backgroundKeepAlive.ensurePlaying();
    expect(mockSound.getStatusAsync).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: 테스트가 실패하는지 확인**

Run: `cd viva-merged && npm test -- src/device/services/__tests__/backgroundKeepAlive.service.test.ts`
Expected: FAIL — `Cannot find module '../backgroundKeepAlive.service'`

- [ ] **Step 5: 서비스 구현**

`src/device/services/backgroundKeepAlive.service.ts`:

```ts
/**
 * iOS 백그라운드 생존 - 무음 오디오 루프 (2026-08-14 설계).
 *
 * 화면 꺼짐/앱 전환 시 iOS 가 앱을 suspend 하면 health 폴링·눈 WS·호출어
 * PCM 이 전부 얼어붙는다. UIBackgroundModes: audio + 무음 루프가 재생되는
 * 동안은 suspend 가 유예되므로 로봇 연동이 유지된다.
 *
 * 라이프사이클은 connectionMonitor 가 소유한다 - 여기서는 절대 스스로
 * start/stop 하지 않는다. mixWithOthers 라 사용자가 다른 앱에서 트는
 * 강의 영상 소리를 죽이지 않는다.
 */
import { Audio, InterruptionModeIOS } from 'expo-av';

class BackgroundKeepAliveService {
  private sound: Audio.Sound | null = null;
  /** 마지막 의도. await 중에 start/stop 이 겹치면 이 값이 이긴다. */
  private desired = false;
  /** 직렬화 큐 - start/stop/ensure 가 인터리브되면 sound 가 샌다. */
  private queue: Promise<void> = Promise.resolve();

  get active(): boolean {
    return this.desired;
  }

  start(): Promise<void> {
    this.desired = true;
    return this.enqueue(async () => {
      if (!this.desired || this.sound) return;
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
    });
  }

  stop(): Promise<void> {
    this.desired = false;
    return this.enqueue(async () => {
      if (this.desired || !this.sound) return;
      const sound = this.sound;
      this.sound = null;
      await sound.unloadAsync();
    });
  }

  /** foreground 복귀 보험: 전화 등 인터럽트로 멈춘 재생을 되살린다. */
  ensurePlaying(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.desired || !this.sound) return;
      const status = await this.sound.getStatusAsync();
      if (status.isLoaded && !status.isPlaying) await this.sound.playAsync();
    });
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
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `cd viva-merged && npm test -- src/device/services/__tests__/backgroundKeepAlive.service.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 7: 커밋**

```bash
cd viva-merged && git add assets/silence.wav src/device/services/backgroundKeepAlive.service.ts src/device/services/__tests__/backgroundKeepAlive.service.test.ts jest.config.js test-mocks/asset-stub.js
git commit -m "feat: 무음 오디오 루프 keepalive 서비스 — iOS 백그라운드 생존 1/3

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: connectionMonitor 가 keepalive 라이프사이클 소유

**Files:**
- Modify: `src/device/services/connectionMonitor.service.ts`
- Modify: `src/device/services/__tests__/connectionMonitor.service.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `backgroundKeepAlive` (`start()`, `stop()`, `ensurePlaying()`).
- Produces: 외부 인터페이스 변화 없음 (`connectionMonitor` 시그니처 유지). 새 튜닝 노브 `KEEPALIVE_STOP_GRACE_MS = 3 * 60_000` (파일 상단 상수).

- [ ] **Step 1: 기존 테스트 파일 구조 파악**

`src/device/services/__tests__/connectionMonitor.service.test.ts` 를 읽고 기존 모킹 방식(piBridge, eyeSync 모킹과 타이머 사용법)을 확인한다. 아래 새 테스트는 기존 스타일에 맞춰 병합한다.

- [ ] **Step 2: 실패하는 테스트 추가**

기존 테스트 파일에 backgroundKeepAlive 모킹과 케이스 추가. 모킹 (파일 상단, 기존 jest.mock 옆):

```ts
jest.mock('../backgroundKeepAlive.service', () => ({
  backgroundKeepAlive: {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    ensurePlaying: jest.fn().mockResolvedValue(undefined),
  },
}));
```

react-native AppState 모킹이 없다면 추가 (jest-expo 가 기본 제공하는 AppState.addEventListener 는 실제 구독이 되므로 spy 로 충분):

```ts
import { AppState } from 'react-native';
import { backgroundKeepAlive } from '../backgroundKeepAlive.service';
```

테스트 케이스 (기존 describe 에 추가, 기존 헬퍼로 connected/disconnected 전이 유도):

```ts
describe('backgroundKeepAlive 라이프사이클', () => {
  it('connected 전이 시 keepalive start', async () => {
    // 기존 패턴대로 fetchPiHealth 가 health 객체를 주게 하고 start() + 프로브 대기
    // ... (기존 헬퍼 사용)
    expect(backgroundKeepAlive.start).toHaveBeenCalled();
  });

  it('disconnected 전이 후 3분 유예가 지나야 keepalive stop', async () => {
    // connected 로 만든 뒤 fetchPiHealth 를 null 로 바꾸고 프로브 → disconnected
    expect(backgroundKeepAlive.stop).not.toHaveBeenCalled();
    jest.advanceTimersByTime(3 * 60_000);
    expect(backgroundKeepAlive.stop).toHaveBeenCalledTimes(1);
  });

  it('유예 중 재연결되면 stop 타이머 취소', async () => {
    // disconnected → 1분 경과 → connected 복귀 → 다시 3분 경과
    jest.advanceTimersByTime(60_000);
    // (connected 복귀 유도)
    jest.advanceTimersByTime(3 * 60_000);
    expect(backgroundKeepAlive.stop).not.toHaveBeenCalled();
  });

  it('monitor.stop() 은 즉시 keepalive stop + 유예 타이머 취소', () => {
    // connected 상태에서 monitor.stop()
    expect(backgroundKeepAlive.stop).toHaveBeenCalled();
  });

  it('AppState active 복귀 시 즉시 재프로브 + ensurePlaying', () => {
    // AppState 리스너를 잡아 'active' 를 흘려보낸다
    expect(backgroundKeepAlive.ensurePlaying).toHaveBeenCalled();
  });
});
```

(주석 표시 부분은 기존 테스트 파일의 프로브 유도 헬퍼·모킹 관례에 맞춰 완성한다. fake timers 는 기존 파일 방식을 따른다.)

- [ ] **Step 3: 테스트 실패 확인**

Run: `cd viva-merged && npm test -- src/device/services/__tests__/connectionMonitor.service.test.ts`
Expected: 새 케이스들 FAIL (start/stop 호출 안 됨)

- [ ] **Step 4: connectionMonitor 수정**

`src/device/services/connectionMonitor.service.ts` 변경점:

임포트 추가:

```ts
import { AppState } from 'react-native';
import { backgroundKeepAlive } from './backgroundKeepAlive.service';
```

상수 추가 (`POLL_INTERVAL_MS` 옆):

```ts
/** 끊김이 이만큼 지속되면 keepalive 를 내린다 (배터리 방어). 즉시 내리면
 * 백그라운드 순간 끊김에 앱이 suspend 돼 로봇 복귀를 영영 감지 못 한다. */
const KEEPALIVE_STOP_GRACE_MS = 3 * 60_000; // 튜닝 노브
```

필드 추가:

```ts
  private keepAliveStopTimer: ReturnType<typeof setTimeout> | null = null;
  private appStateSub: { remove(): void } | null = null;
```

`start()` 끝에 추가:

```ts
    // foreground 복귀 보험: iOS 가 인터럽트(전화 등)로 오디오 세션을 뺏었거나
    // suspend 직전이었다면, 돌아온 즉시 판정을 새로 하고 무음 루프를 되살린다.
    this.appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void this.probe();
        void backgroundKeepAlive.ensurePlaying();
      }
    });
```

`stop()` 에 추가 (`this.eyeWsUnsub` 정리 옆):

```ts
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.clearKeepAliveStopTimer();
    void backgroundKeepAlive.stop();
```

`commit()` 의 상태 전이 블록 수정:

```ts
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
```

private 메서드 추가:

```ts
  private clearKeepAliveStopTimer(): void {
    if (this.keepAliveStopTimer) {
      clearTimeout(this.keepAliveStopTimer);
      this.keepAliveStopTimer = null;
    }
  }
```

- [ ] **Step 5: 전체 서비스 테스트 통과 확인**

Run: `cd viva-merged && npm test -- src/device/services/__tests__/`
Expected: PASS (기존 + 신규 전부. 기존 케이스가 keepalive 모킹 부재로 깨지면 해당 파일 모킹 누락 — Step 2 의 jest.mock 확인)

- [ ] **Step 6: 커밋**

```bash
cd viva-merged && git add src/device/services/connectionMonitor.service.ts src/device/services/__tests__/connectionMonitor.service.test.ts
git commit -m "feat: connectionMonitor 가 keepalive 소유 — 연결 시 시작, 끊김 3분 유예 후 정지 2/3

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: UIBackgroundModes 선언 + process.md 갱신

**Files:**
- Modify: `app.config.js` (device variant infoPlist)
- Modify: `ios/VIVAforDevice/Info.plist`
- Modify: `docs/process.md`

**Interfaces:**
- Consumes: 없음 (선언만).
- Produces: device 빌드에 `UIBackgroundModes: ["audio"]`. phone variant 는 불변.

- [ ] **Step 1: app.config.js 수정**

`app.config.js` 의 device 전용 `infoPlist` 블록(`NSLocationWhenInUseUsageDescription` 위)에 추가:

```js
            infoPlist: {
              // 무음 오디오 루프로 백그라운드 생존 (backgroundKeepAlive.service.ts).
              // 화면 꺼짐/앱 전환 중에도 Pi 연동 유지 - 2026-08-14 설계.
              UIBackgroundModes: ['audio'],
              NSLocationWhenInUseUsageDescription:
```

phone variant 분기(`phone ? {} : {...}`)는 그대로 — phone 에 들어가면 안 된다.

- [ ] **Step 2: Info.plist 수정**

`ios/VIVAforDevice/Info.plist` 를 읽고 (prebuild 산물이라 직접도 고쳐야 실기기 빌드에 반영) 최상위 `<dict>` 안에 추가:

```xml
	<key>UIBackgroundModes</key>
	<array>
		<string>audio</string>
	</array>
```

알파벳 순서상 `UIAppFonts`/`UILaunchStoryboardName` 류 키 근처, 기존 들여쓰기(탭) 유지.

- [ ] **Step 3: 검증**

```bash
cd viva-merged && APP_VARIANT=phone node -e "const c=require('./app.config.js'); console.log('phone:', JSON.stringify(c.expo.ios.infoPlist?.UIBackgroundModes))" && node -e "const c=require('./app.config.js'); console.log('device:', JSON.stringify(c.expo.ios.infoPlist.UIBackgroundModes))" && plutil -lint ios/VIVAforDevice/Info.plist && /usr/libexec/PlistBuddy -c 'Print :UIBackgroundModes' ios/VIVAforDevice/Info.plist
```

Expected: `phone: undefined`, `device: ["audio"]`, `Info.plist: OK`, 배열에 `audio`.

주의: `APP_VARIANT` 환경변수가 `node -e` 프로세스에 남지 않게 위처럼 개별 실행. phone 쪽이 `undefined` 가 아니면 실패.

- [ ] **Step 4: 전체 테스트 (회귀 확인)**

Run: `cd viva-merged && npm test`
Expected: 전부 PASS

- [ ] **Step 5: docs/process.md 갱신**

`docs/process.md` 맨 위 "문서 갱신 규칙" 절을 읽고 그 규칙대로, 이번 작업(iOS 백그라운드 생존 — 무음 오디오 keepalive, 연결 기반 라이프사이클, UIBackgroundModes)을 해당 섹션에 기록한다. 튜닝 노브 `KEEPALIVE_STOP_GRACE_MS` 도 기존 튜닝 노브 목록 관례가 있으면 거기에 추가. 실기기 체크리스트(스펙 §테스트 ①~④)를 향후 계획/검증 항목으로 남긴다.

- [ ] **Step 6: 커밋**

```bash
cd viva-merged && git add app.config.js ios/VIVAforDevice/Info.plist docs/process.md
git commit -m "feat: UIBackgroundModes audio 선언 — iOS 백그라운드 생존 3/3

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(집행 노트 2026-08-14: 커밋 3a51196 의 CNG 전환으로 ios/ 는 gitignore 대상 —
Step 2 는 실행 불가·불필요, app.config.js 가 유일한 소스. Task 3 은
app.config.js + docs/process.md 만으로 완결됨.)

---

### Task 4: Android 포그라운드 서비스 (스코프 증보 2026-08-14)

스펙 근거: `docs/superpowers/specs/2026-08-14-background-keepalive-design.md`
의 "증보: Android 대응" 절. Global Constraints 의 "신규 의존성 금지"는 이
태스크에 한해 해제 — `react-native-background-actions@4.1.0` 하나만 추가
허용 (사용자 승인됨).

**Files:**
- Modify: `package.json` + `package-lock.json` (의존성 1개)
- Create: `plugins/withBackgroundActions.js`
- Modify: `app.config.js` (device variant 에만 plugin 등록)
- Modify: `src/device/services/backgroundKeepAlive.service.ts`
- Modify: `src/device/services/__tests__/backgroundKeepAlive.service.test.ts`
- Modify: `docs/process.md`

**Interfaces:**
- Consumes: Task 1 의 `backgroundKeepAlive` 내부 구조 (enqueue 직렬화 큐,
  desired 플래그, never-reject 계약).
- Produces: 외부 인터페이스 불변 — `start()`/`stop()` 이 Android 에선 FGS
  도 함께 올리고 내린다. 새 파일 `plugins/withBackgroundActions.js`.

- [ ] **Step 1: 의존성 설치**

```bash
cd viva-merged && npm install react-native-background-actions@4.1.0 --save --no-audit --no-fund
```

Expected: package.json dependencies 에 `"react-native-background-actions": "^4.1.0"` 추가.

- [ ] **Step 2: config plugin 작성**

`plugins/withBackgroundActions.js` 생성:

```js
// Android FGS(connectedDevice) 매니페스트 주입 - CNG(3a51196) 이후
// app.config.js 가 유일한 소스라 커스텀 plugin 으로 넣는다.
// expo-build-properties 는 임의 권한/service 속성 주입을 지원하지 않는다.
const { withAndroidManifest } = require('@expo/config-plugins');

// react-native-background-actions 가 번들한 service. 같은 이름으로 재선언해
// foregroundServiceType 을 매니페스트 머저가 병합하게 한다 (targetSdk 34 필수).
const SERVICE_NAME = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';

const PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE',
  // connectedDevice 타입의 전제조건 권한 (런타임 다이얼로그 없음)
  'android.permission.CHANGE_NETWORK_STATE',
  // Android 13+ 알림 표시용. 미허용이어도 FGS 자체는 동작한다.
  'android.permission.POST_NOTIFICATIONS',
];

module.exports = function withBackgroundActions(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const app = manifest.manifest.application[0];

    manifest.manifest['uses-permission'] = manifest.manifest['uses-permission'] || [];
    for (const name of PERMISSIONS) {
      if (!manifest.manifest['uses-permission'].some((p) => p.$['android:name'] === name)) {
        manifest.manifest['uses-permission'].push({ $: { 'android:name': name } });
      }
    }

    app.service = app.service || [];
    const existing = app.service.find((s) => s.$['android:name'] === SERVICE_NAME);
    if (existing) {
      existing.$['android:foregroundServiceType'] = 'connectedDevice';
    } else {
      app.service.push({
        $: {
          'android:name': SERVICE_NAME,
          'android:foregroundServiceType': 'connectedDevice',
        },
      });
    }
    return config;
  });
};
```

- [ ] **Step 3: app.config.js 에 plugin 등록 (device variant 만)**

`plugins` 배열 끝에 추가:

```js
    plugins: [
      ['@react-native-voice/voice', { microphonePermission: 'Allow VIVA to access your microphone for voice tutoring.' }],
      ['react-native-vision-camera', { cameraPermissionText: 'Allow VIVA to access your camera to scan math problems.', enableMicrophonePermission: false }],
      'expo-dev-client',
      ['expo-splash-screen', { image: './assets/splash-icon.png', imageWidth: 200, resizeMode: 'contain', backgroundColor: '#FAF7F0' }],
      // Android 백그라운드 생존: FGS(connectedDevice) 매니페스트 주입 - device 전용
      ...(phone ? [] : ['./plugins/withBackgroundActions.js']),
    ],
```

- [ ] **Step 4: 실패하는 테스트 추가**

`src/device/services/__tests__/backgroundKeepAlive.service.test.ts` 에 모킹 추가 (파일 상단 기존 jest.mock 옆):

```ts
const mockBackgroundService = {
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  isRunning: jest.fn().mockReturnValue(false),
};

jest.mock('react-native-background-actions', () => ({
  __esModule: true,
  default: mockBackgroundService,
}));
```

테스트 케이스 추가 (기존 describe 안, `import { Platform } from 'react-native';` 필요):

```ts
describe('Android FGS', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('android 에선 start 가 FGS 도 올린다 (connectedDevice)', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    await backgroundKeepAlive.start();
    expect(mockBackgroundService.start).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        taskName: 'VivaKeepAlive',
        foregroundServiceType: ['connectedDevice'],
      }),
    );
  });

  it('android 에선 stop 이 FGS 도 내린다', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    await backgroundKeepAlive.start();
    await backgroundKeepAlive.stop();
    expect(mockBackgroundService.stop).toHaveBeenCalledTimes(1);
  });

  it('ios 에선 FGS 를 건드리지 않는다', async () => {
    await backgroundKeepAlive.start();
    await backgroundKeepAlive.stop();
    expect(mockBackgroundService.start).not.toHaveBeenCalled();
    expect(mockBackgroundService.stop).not.toHaveBeenCalled();
  });

  it('FGS start 가 reject 해도 start 는 throw 하지 않는다', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockBackgroundService.start.mockRejectedValueOnce(new Error('FGS 거부'));
      await expect(backgroundKeepAlive.start()).resolves.toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
```

주의: 기존 `beforeEach` 의 `await backgroundKeepAlive.stop(); jest.clearAllMocks();` 가 FGS 상태도 초기화하도록, stop 경로가 Platform 기본값(ios)에서 FGS 를 안 건드리는 것과 android 테스트 간 격리를 확인하라 — 필요하면 각 android 테스트 끝에 `await backgroundKeepAlive.stop()` 를 넣어 fgsDesired 를 내린다.

- [ ] **Step 5: 테스트 실패 확인**

Run: `cd viva-merged && npm test -- src/device/services/__tests__/backgroundKeepAlive.service.test.ts`
Expected: 새 android 케이스들 FAIL (mockBackgroundService.start 호출 안 됨)

- [ ] **Step 6: 서비스 구현**

`backgroundKeepAlive.service.ts` 수정. 임포트:

```ts
import { Platform } from 'react-native';
import BackgroundService from 'react-native-background-actions';
```

파일 상단 상수 (클래스 밖):

```ts
/** Android FGS 알림. connectedDevice = "네트워크로 외부 기기와 상호작용" -
 * 로컬 WS/폴링 유지가 정확히 이 용도다. plugins/withBackgroundActions.js 의
 * 매니페스트 선언과 반드시 일치해야 한다. */
const FGS_OPTIONS = {
  taskName: 'VivaKeepAlive',
  taskTitle: '비바와 연결 유지 중',
  taskDesc: '로봇과의 연결을 유지하고 있어요',
  taskIcon: { name: 'ic_launcher', type: 'mipmap' },
  color: '#FAF7F0',
  foregroundServiceType: ['connectedDevice'],
};

const FGS_TICK_MS = 5000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
```

클래스에 필드 추가:

```ts
  /** Android FGS 의도. stop() 버그(#201: 실행 중 태스크를 즉시 못 죽임)
   * 대비 - 태스크 루프가 이 플래그를 보고 스스로 내려온다. */
  private fgsDesired = false;
```

`start()` 의 큐 잡 첫머리(기존 `if (!this.desired || this.sound) return;` 를 분해):

```ts
    return this.enqueue(async () => {
      if (!this.desired) return;
      if (Platform.OS === 'android') await this.startFgs();
      if (this.sound) return;
      try {
        // ... 기존 오디오 모드 + createAsync + playAsync 그대로 ...
```

`stop()` 의 큐 잡:

```ts
    return this.enqueue(async () => {
      if (this.desired) return;
      if (Platform.OS === 'android') await this.stopFgs();
      if (!this.sound) return;
      const sound = this.sound;
      this.sound = null;
      await sound.unloadAsync();
    });
```

private 메서드 추가:

```ts
  private async startFgs(): Promise<void> {
    if (this.fgsDesired) return;
    this.fgsDesired = true;
    try {
      // 이 프라미스가 살아있는 동안만 FGS 가 유지된다 (라이브러리 계약).
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
```

파일 헤더 주석도 갱신: "iOS 백그라운드 생존" → "iOS/Android 백그라운드 생존", Android 는 FGS(connectedDevice) + 무음 루프 병행이라는 한 줄 추가.

- [ ] **Step 7: 테스트 통과 확인**

Run: `cd viva-merged && npm test -- src/device/services/__tests__/backgroundKeepAlive.service.test.ts`
Expected: PASS (기존 7 + 신규 4 = 11)

- [ ] **Step 8: prebuild 로 매니페스트 실검증**

```bash
cd viva-merged && npx expo prebuild --platform android --no-install 2>&1 | tail -3
grep -o 'FOREGROUND_SERVICE_CONNECTED_DEVICE\|CHANGE_NETWORK_STATE\|POST_NOTIFICATIONS\|foregroundServiceType="connectedDevice"' android/app/src/main/AndroidManifest.xml | sort -u
rm -rf android
```

Expected: grep 이 4개 항목 전부 출력. (android/ 는 gitignore 대상 산물이라 검증 후 삭제.)
phone variant 오염 검사: `APP_VARIANT=phone npx expo prebuild --platform android --no-install` 후 같은 grep 이 **아무것도 안 나와야** 함, 검증 후 `rm -rf android`.

- [ ] **Step 9: 전체 테스트 + 타입 체크**

Run: `cd viva-merged && npm test && npx tsc --noEmit`
Expected: 전부 PASS, 타입 에러 0

- [ ] **Step 10: docs/process.md 갱신**

문서 맨 위 "문서 갱신 규칙" 절 규칙대로, Android FGS 대응(라이브러리 선택 근거, connectedDevice 타입, config plugin, 알려진 한계: wake-lock 미확보/stop 버그 완화)을 기록. 실기기 체크리스트 ⑤⑥ (삼성 화면 끄고 5분 후 호출, 30분 방치 연결 유지) 추가.

- [ ] **Step 11: 커밋**

```bash
cd viva-merged && git add package.json package-lock.json plugins/withBackgroundActions.js app.config.js src/device/services/backgroundKeepAlive.service.ts src/device/services/__tests__/backgroundKeepAlive.service.test.ts docs/process.md
git commit -m "feat: Android FGS(connectedDevice) 백그라운드 생존 — iOS/Android 모두 대응

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

# 앱·디바이스 역할 분리 + 연결 상태 표면화 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱을 보조 칠판(풀이 이미지·자막·기록·연결 상태)으로, 디바이스를 얼굴(눈)·마이크·스피커·카메라로 역할 분리하고, Pi 연결 상태를 단일 판정자(ConnectionMonitor)로 통합해 UI에 표면화한다.

**Architecture:** `connectionMonitor` 모듈 싱글턴이 `/health` 5초 폴링으로 `connected|connecting|disconnected`를 판정한다(눈 WS 끊김·piBridge 실패는 재프로브 트리거만). `useAppMode`가 `'device'|'app'` 모드를 소유하고, 흩어진 robotMic/robotSpeaker/robotAudio 플래그가 전부 모드+연결상태에서 파생된다. 디바이스 모드에서 앱 눈을 숨기고(`showEyes` prop), 세션 중 끊김은 전체 오버레이로 처리한다. Pi 쪽은 `eyes.py`가 무클라이언트 30초 후 스스로 '연결 끊김' 얼굴을 띄운다.

**Tech Stack:** Expo 57 / RN, plain React hooks(전역 상태 라이브러리 없음), 모듈 싱글턴 서비스 패턴, jest + react-test-renderer, pygame(eyes.py).

**Spec:** `docs/superpowers/specs/2026-08-10-app-device-role-separation-design.md`

## Global Constraints

- Expo 문서는 반드시 버전 고정본을 본다: https://docs.expo.dev/versions/v57.0.0/
- 테스트 실행: `npm test -- <경로>` (package.json: `node -r dotenv/config node_modules/.bin/jest`)
- **베이스라인: `npm test` 390/395 (기존 실패 5개), `npx tsc --noEmit` 기존 에러 5개.** 새 실패/에러만 회귀로 취급한다. 기존 실패를 고치려 들지 않는다.
- **git: 이 저장소는 병렬 Claude 세션이 같은 체크아웃을 공유한다. 실행 시작 시 전용 worktree를 만들어(superpowers:using-git-worktrees) 그 안에서만 작업·커밋한다. `git add -A` 금지 — 명시 파일만 add.**
- 새 코드의 색·폰트는 `src/theme.ts` 토큰만 사용 (`board.service.ts` 재수출 경로 금지).
- UI 문구는 기존 앱 보이스와 같은 반말 (예: "찍은 사진을 자세히 보고 있어!").
- 이모지 아이콘 금지 — 기존 패턴대로 CSS-only 도형 또는 png 에셋.
- 새 환경 변수 추가 금지 (`EXPO_PUBLIC_*`는 빌드 시점 인라인이라 이 기능과 안 맞는다).
- 각 태스크 완료 시마다 커밋. 마지막 태스크에서 `docs/process.md` 갱신(AGENTS.md 필수 규칙).

---

## 파일 구조

**신설**
| 파일 | 책임 |
|---|---|
| `src/services/connectionMonitor.service.ts` | Pi 연결 상태 단일 판정자 (폴링 + 재프로브 트리거) |
| `src/hooks/useAppMode.ts` | `'device' \| 'app'` 모드 소유 (useSolveMode 패턴) |
| `src/hooks/usePiConnection.ts` | connectionMonitor 구독 훅 |
| `src/components/ModeToggle.tsx` | 좌상단 모드 전환 필 |
| `src/components/ConnectionStatusChip.tsx` | ● 연결됨/연결 중/연결 안 됨 칩 |
| `src/components/ConnectionGuideCard.tsx` | 전원→와이파이→재부팅 체크리스트 카드 (홈+오버레이 공용) |
| `src/components/DisconnectOverlay.tsx` | 세션 중 끊김 전체 오버레이 |

**수정**
| 파일 | 변경 |
|---|---|
| `src/services/eyeSync.service.ts` | `setSuppressed()` — APP 모드에서 송신·재연결 정지 |
| `App.tsx` | 모드 소유, monitor 생명주기, `piReadyRef` 대체, beginCapture 게이팅, props 배선 |
| `src/screens/HomeScreen.tsx` | 모드별 2변형 (디바이스=미니멀, APP=현행 눈+마이크), 디버그 버튼 제거 |
| `src/screens/ConversationScreen.tsx` | `appMode` prop, 눈 표시 게이팅, 중앙 자막, 끊김 오버레이 |
| `src/components/CharacterView.tsx` | `showEyes`/`centerSubtitle` prop |
| `src/components/ProcessingView.tsx` | `showEyes` prop |
| `src/components/BoardView.tsx` | `showEyes` prop (판서 대기 플레이스홀더) |
| `src/screens/CameraScreen.tsx` | `showEyes` prop (분석 중 화면) |
| `pi-server/eyes.py` | 무클라이언트 30초 → 'disconnected' 얼굴 + selftest |
| `docs/process.md` | §1/§4 갱신 (마지막 태스크) |

---

### Task 1: connectionMonitor.service.ts

**Files:**
- Create: `src/services/connectionMonitor.service.ts`
- Test: `src/services/__tests__/connectionMonitor.service.test.ts`

**Interfaces:**
- Consumes: `checkPiConnection(): Promise<boolean>` (`src/services/piBridge.service.ts:42` — 절대 throw 하지 않고 false 반환)
- Produces: `connectionMonitor` 싱글턴 — `status: PiConnectionStatus`, `start()`, `stop()`, `reportFailure()`, `probeNow(): Promise<boolean>`, `onStatusChange(l): () => void`. `export type PiConnectionStatus = 'connected' | 'connecting' | 'disconnected'`.

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/services/__tests__/connectionMonitor.service.test.ts
jest.mock('../piBridge.service', () => ({
  checkPiConnection: jest.fn(),
}));

import { checkPiConnection } from '../piBridge.service';
import { connectionMonitor } from '../connectionMonitor.service';

const mockCheck = checkPiConnection as jest.Mock;

/** probe 의 await 체인(마이크로태스크)을 비운다. */
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('connectionMonitor', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockCheck.mockReset();
    connectionMonitor.stop(); // 싱글턴 초기화: 폴링 해제 + 'connecting' 복귀
  });

  afterEach(() => {
    connectionMonitor.stop();
    jest.useRealTimers();
  });

  it('starts as connecting, then connected on successful probe', async () => {
    mockCheck.mockResolvedValue(true);
    connectionMonitor.start();
    expect(connectionMonitor.status).toBe('connecting');
    await flush();
    expect(connectionMonitor.status).toBe('connected');
  });

  it('goes disconnected when the probe fails', async () => {
    mockCheck.mockResolvedValue(false);
    connectionMonitor.start();
    await flush();
    expect(connectionMonitor.status).toBe('disconnected');
  });

  it('keeps polling every 5s and notifies only on change', async () => {
    mockCheck.mockResolvedValue(true);
    const seen: string[] = [];
    const unsub = connectionMonitor.onStatusChange((s) => seen.push(s));
    connectionMonitor.start();
    await flush();
    expect(seen).toEqual(['connected']);

    // 같은 결과가 반복돼도 리스너는 다시 안 불린다
    jest.advanceTimersByTime(5000);
    await flush();
    expect(seen).toEqual(['connected']);

    // Pi 가 죽으면 다음 폴링에서 disconnected
    mockCheck.mockResolvedValue(false);
    jest.advanceTimersByTime(5000);
    await flush();
    expect(seen).toEqual(['connected', 'disconnected']);
    unsub();
  });

  it('reportFailure triggers an immediate re-probe', async () => {
    mockCheck.mockResolvedValue(true);
    connectionMonitor.start();
    await flush();
    expect(connectionMonitor.status).toBe('connected');

    mockCheck.mockResolvedValue(false);
    connectionMonitor.reportFailure(); // 5초 안 기다리고 즉시
    await flush();
    expect(connectionMonitor.status).toBe('disconnected');
  });

  it('reportFailure is a no-op while stopped (APP mode)', async () => {
    mockCheck.mockResolvedValue(false);
    connectionMonitor.reportFailure();
    await flush();
    expect(mockCheck).not.toHaveBeenCalled();
    expect(connectionMonitor.status).toBe('connecting');
  });

  it('stop() halts polling and resets to connecting', async () => {
    mockCheck.mockResolvedValue(true);
    connectionMonitor.start();
    await flush();
    connectionMonitor.stop();
    expect(connectionMonitor.status).toBe('connecting');
    mockCheck.mockClear();
    jest.advanceTimersByTime(20000);
    await flush();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('probeNow returns the fresh verdict', async () => {
    mockCheck.mockResolvedValue(true);
    connectionMonitor.start();
    await flush();
    mockCheck.mockResolvedValue(false);
    await expect(connectionMonitor.probeNow()).resolves.toBe(false);
    expect(connectionMonitor.status).toBe('disconnected');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/services/__tests__/connectionMonitor.service.test.ts`
Expected: FAIL — `Cannot find module '../connectionMonitor.service'`

- [ ] **Step 3: 구현**

```ts
// src/services/connectionMonitor.service.ts
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
import { checkPiConnection } from './piBridge.service';

export type PiConnectionStatus = 'connected' | 'connecting' | 'disconnected';

const POLL_INTERVAL_MS = 5000;

type StatusListener = (status: PiConnectionStatus) => void;

class ConnectionMonitorService {
  private _status: PiConnectionStatus = 'connecting';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private probing = false;
  private listeners = new Set<StatusListener>();

  get status(): PiConnectionStatus {
    return this._status;
  }

  start(): void {
    if (this.pollTimer) return;
    void this.probe();
    this.pollTimer = setInterval(() => void this.probe(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    // 정지 후 stale 판정이 UI에 남지 않도록 보류 상태로 되돌린다.
    this.setStatus('connecting');
  }

  /** piBridge 호출 실패 등 "Pi 가 이상하다" 신호. 판정은 probe 가 한다. */
  reportFailure(): void {
    if (!this.pollTimer) return; // 정지 중(APP 모드)엔 무시
    void this.probe();
  }

  /** 지금 즉시 프로브하고 결과를 돌려준다 (beginCapture 실패 분기용).
   * 다른 프로브가 in-flight 면 그 결과를 기다리지 않고 현재 판정을 준다 -
   * 5초 안에 두 번 물을 만큼 급한 호출부는 없다. */
  async probeNow(): Promise<boolean> {
    await this.probe();
    return this._status === 'connected';
  }

  onStatusChange(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async probe(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      const ok = await checkPiConnection(); // 절대 throw 안 함 (piBridge)
      this.setStatus(ok ? 'connected' : 'disconnected');
    } finally {
      this.probing = false;
    }
  }

  private setStatus(next: PiConnectionStatus): void {
    if (this._status === next) return;
    console.log(`[ConnectionMonitor] ${this._status} -> ${next}`);
    this._status = next;
    this.listeners.forEach((l) => l(next));
  }
}

/** 싱글턴 - Pi 는 하나, 판정자도 하나. */
export const connectionMonitor = new ConnectionMonitorService();
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- src/services/__tests__/connectionMonitor.service.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: 커밋**

```bash
git add src/services/connectionMonitor.service.ts src/services/__tests__/connectionMonitor.service.test.ts
git commit -m "feat: Pi 연결 상태 단일 판정자 connectionMonitor 추가"
```

---

### Task 2: useAppMode + usePiConnection 훅

**Files:**
- Create: `src/hooks/useAppMode.ts`, `src/hooks/usePiConnection.ts`
- Test: `src/hooks/__tests__/useAppMode.test.ts`, `src/hooks/__tests__/usePiConnection.test.ts`

**Interfaces:**
- Consumes: `connectionMonitor`, `PiConnectionStatus` (Task 1)
- Produces: `useAppMode(): { mode: AppMode; setMode(m): void; toggleMode(): void }` with `export type AppMode = 'device' | 'app'`; `usePiConnection(): PiConnectionStatus`

- [ ] **Step 1: 실패하는 테스트 작성** (기존 `useSolveMode.test.ts:5` 하네스 패턴 복제)

```ts
// src/hooks/__tests__/useAppMode.test.ts
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { useAppMode, UseAppModeResult } from '../useAppMode';

function renderUseAppMode() {
  const ref: { current: UseAppModeResult | null } = { current: null };
  function Harness() {
    ref.current = useAppMode();
    return null;
  }
  act(() => {
    ReactTestRenderer.create(React.createElement(Harness));
  });
  return ref as { current: UseAppModeResult };
}

describe('useAppMode', () => {
  it('starts in device mode (실행 시 항상 디바이스 모드)', () => {
    const ref = renderUseAppMode();
    expect(ref.current.mode).toBe('device');
  });

  it('toggles device <-> app', () => {
    const ref = renderUseAppMode();
    act(() => ref.current.toggleMode());
    expect(ref.current.mode).toBe('app');
    act(() => ref.current.toggleMode());
    expect(ref.current.mode).toBe('device');
  });

  it('setMode sets directly (끊김 오버레이의 "휴대폰으로 계속하기")', () => {
    const ref = renderUseAppMode();
    act(() => ref.current.setMode('app'));
    expect(ref.current.mode).toBe('app');
  });
});
```

```ts
// src/hooks/__tests__/usePiConnection.test.ts
jest.mock('../../services/piBridge.service', () => ({
  checkPiConnection: jest.fn().mockResolvedValue(true),
}));

import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { connectionMonitor } from '../../services/connectionMonitor.service';
import { usePiConnection } from '../usePiConnection';
import type { PiConnectionStatus } from '../../services/connectionMonitor.service';

function renderUsePiConnection() {
  const ref: { current: PiConnectionStatus | null } = { current: null };
  function Harness() {
    ref.current = usePiConnection();
    return null;
  }
  act(() => {
    ReactTestRenderer.create(React.createElement(Harness));
  });
  return ref as { current: PiConnectionStatus };
}

describe('usePiConnection', () => {
  afterEach(() => connectionMonitor.stop());

  it('returns the monitor status and follows changes', async () => {
    const ref = renderUsePiConnection();
    expect(ref.current).toBe('connecting');
    await act(async () => {
      connectionMonitor.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(ref.current).toBe('connected');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/hooks/__tests__/useAppMode.test.ts src/hooks/__tests__/usePiConnection.test.ts`
Expected: FAIL — `Cannot find module '../useAppMode'` / `'../usePiConnection'`

- [ ] **Step 3: 구현**

```ts
// src/hooks/useAppMode.ts
import { useCallback, useState } from 'react';

export type AppMode = 'device' | 'app';

export interface UseAppModeResult {
  /** 'device' = 마이크·스피커·카메라·눈 전부 Pi (기본).
   * 'app' = 전부 폰, Pi 완전 무시.
   *
   * robotMic/robotSpeaker/robotAudio 는 전부 이 값(+연결 상태)에서 파생된다 -
   * 개별 플래그를 직접 만지는 코드를 새로 만들지 않는다 (2026-08-10 스펙). */
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  toggleMode: () => void;
}

export function useAppMode(): UseAppModeResult {
  // ponytail: 영속화 없음 - 실행마다 디바이스 모드. 디바이스 없는 사용자가
  // 늘면 AsyncStorage 저장 추가.
  const [mode, setMode] = useState<AppMode>('device');

  const toggleMode = useCallback(() => {
    setMode((prev) => (prev === 'device' ? 'app' : 'device'));
  }, []);

  return { mode, setMode, toggleMode };
}
```

```ts
// src/hooks/usePiConnection.ts
import { useEffect, useState } from 'react';
import {
  connectionMonitor,
  PiConnectionStatus,
} from '../services/connectionMonitor.service';

/** connectionMonitor 구독. 판정은 서비스가 하고 여기는 리렌더만 잇는다. */
export function usePiConnection(): PiConnectionStatus {
  const [status, setStatus] = useState<PiConnectionStatus>(connectionMonitor.status);

  useEffect(() => {
    setStatus(connectionMonitor.status); // 마운트 전 변화 반영
    return connectionMonitor.onStatusChange(setStatus);
  }, []);

  return status;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- src/hooks/__tests__/useAppMode.test.ts src/hooks/__tests__/usePiConnection.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/hooks/useAppMode.ts src/hooks/usePiConnection.ts src/hooks/__tests__/useAppMode.test.ts src/hooks/__tests__/usePiConnection.test.ts
git commit -m "feat: useAppMode(디바이스/APP 모드) + usePiConnection 훅"
```

---

### Task 3: eyeSync.service 억제 스위치

**Files:**
- Modify: `src/services/eyeSync.service.ts` (클래스에 필드 1개 + 메서드 1개 + `sendEyeState` 1줄)
- Test: `src/services/__tests__/eyeSync.suppress.test.ts` (신규 파일 — 기존 `eyeSync.service.test.ts` 는 건드리지 않는다)

**Interfaces:**
- Produces: `eyeSyncService.setSuppressed(suppressed: boolean): void`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/services/__tests__/eyeSync.suppress.test.ts
import { eyeSyncService } from '../eyeSync.service';

describe('eyeSyncService.setSuppressed', () => {
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
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/services/__tests__/eyeSync.suppress.test.ts`
Expected: FAIL — `eyeSyncService.setSuppressed is not a function`

- [ ] **Step 3: 구현** — `eyeSync.service.ts` 3군데 수정

`EyeSyncService` 클래스 필드에 추가 (`private enabled = false;` 아래, `eyeSync.service.ts:54` 부근):

```ts
  /** APP 모드: 보드가 대상에서 빠진 상태. 송신·재연결 루프를 멈춘다. */
  private suppressed = false;
```

`stop()` 아래에 메서드 추가:

```ts
  /** APP 모드 진입/이탈. 진입 시 소켓·재연결을 내리고, 이탈 시 마지막
   * 상태를 다시 흘려 보드가 즉시 따라잡게 한다. */
  setSuppressed(suppressed: boolean): void {
    this.suppressed = suppressed;
    if (suppressed) {
      this.stop();
    } else if (this.lastState) {
      this.sendEyeState(this.lastState);
    }
  }
```

`sendEyeState()` 끝부분(`eyeSync.service.ts:119-121`)을 다음으로 교체:

```ts
    this.lastState = state;
    if (this.suppressed) return; // 기록만 - APP 모드에선 보드가 없다
    if (!this.enabled) this.start();
    this.flush();
```

- [ ] **Step 4: 통과 확인 (기존 eyeSync 테스트 포함)**

Run: `npm test -- src/services/__tests__/eyeSync.suppress.test.ts src/services/__tests__/eyeSync.service.test.ts`
Expected: PASS (기존 홀드 계약 테스트 무손상)

- [ ] **Step 5: 커밋**

```bash
git add src/services/eyeSync.service.ts src/services/__tests__/eyeSync.suppress.test.ts
git commit -m "feat: eyeSync setSuppressed - APP 모드에서 보드 송신 정지"
```

---

### Task 4: 연결 상태 UI 부품 3종 (ModeToggle, ConnectionStatusChip, ConnectionGuideCard)

**Files:**
- Create: `src/components/ModeToggle.tsx`, `src/components/ConnectionStatusChip.tsx`, `src/components/ConnectionGuideCard.tsx`
- Test: `src/components/__tests__/connectionUi.test.tsx`

**Interfaces:**
- Consumes: `AppMode` (Task 2), `PiConnectionStatus` (Task 1), theme 토큰
- Produces: `<ModeToggle mode onToggle safeTop? />`, `<ConnectionStatusChip status safeTop? />`, `<ConnectionGuideCard />`

- [ ] **Step 1: 실패하는 테스트 작성**

```tsx
// src/components/__tests__/connectionUi.test.tsx
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import ModeToggle from '../ModeToggle';
import ConnectionStatusChip from '../ConnectionStatusChip';
import ConnectionGuideCard from '../ConnectionGuideCard';

function render(el: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(el);
  });
  return tree;
}

describe('ModeToggle', () => {
  it('shows the current mode label and fires onToggle', () => {
    const onToggle = jest.fn();
    const tree = render(<ModeToggle mode="device" onToggle={onToggle} />);
    const btn = tree.root.findByProps({ testID: 'mode-toggle' });
    expect(btn.props.accessibilityState).toEqual({ checked: false });
    act(() => btn.props.onPress());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('marks APP mode as checked', () => {
    const tree = render(<ModeToggle mode="app" onToggle={() => {}} />);
    const btn = tree.root.findByProps({ testID: 'mode-toggle' });
    expect(btn.props.accessibilityState).toEqual({ checked: true });
  });
});

describe('ConnectionStatusChip', () => {
  it.each([
    ['connected', '비바 연결됨'],
    ['connecting', '비바 찾는 중'],
    ['disconnected', '연결 안 됨'],
  ] as const)('%s -> "%s"', (status, label) => {
    const tree = render(<ConnectionStatusChip status={status} />);
    const texts = tree.root
      .findAllByType(require('react-native').Text)
      .map((t) => t.props.children);
    expect(texts).toContain(label);
  });
});

describe('ConnectionGuideCard', () => {
  it('renders the 3 recovery steps in order', () => {
    const tree = render(<ConnectionGuideCard />);
    const joined = JSON.stringify(tree.toJSON());
    expect(joined).toContain('전원이 켜져 있는지');
    expect(joined).toContain('같은 와이파이');
    expect(joined).toContain('뽑았다 다시 꽂아');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/components/__tests__/connectionUi.test.tsx`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

```tsx
// src/components/ModeToggle.tsx
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SURFACE_COLOR, SURFACE_BORDER_COLOR, INK, INK_MUTED, FONT } from '../theme';
import type { AppMode } from '../hooks/useAppMode';

interface ModeToggleProps {
  mode: AppMode;
  onToggle: () => void;
  /** Safe-area top inset (HomeScreen 의 safeTop 과 동일 값). */
  safeTop?: number;
}

/**
 * 좌상단 고정 모드 전환 필. SolveModeToggle(우상단)과 같은 필 문법이지만
 * 애니메이션 없는 정적 라벨 - 모드 전환은 드문 조작이라 스위치 연출이
 * 과하다. 라벨이 곧 현재 모드다.
 */
export default function ModeToggle({ mode, onToggle, safeTop }: ModeToggleProps): React.JSX.Element {
  const isApp = mode === 'app';
  return (
    <View style={[styles.container, safeTop !== undefined && { top: safeTop }]} pointerEvents="box-none">
      <Pressable
        accessibilityRole="switch"
        accessibilityLabel={isApp ? 'APP 모드 (디바이스 없이 사용 중)' : '디바이스 모드'}
        accessibilityState={{ checked: isApp }}
        testID="mode-toggle"
        style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
        onPress={onToggle}
      >
        <Text style={[styles.label, isApp ? styles.labelApp : styles.labelDevice]}>
          {isApp ? 'APP 모드' : '디바이스 모드'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 18,
    left: 12,
    zIndex: 40,
  },
  pill: {
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: SURFACE_COLOR,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillPressed: {
    opacity: 0.8,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: FONT,
  },
  labelDevice: {
    color: INK,
  },
  labelApp: {
    color: INK_MUTED,
  },
});
```

```tsx
// src/components/ConnectionStatusChip.tsx
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { GREEN, ORANGE, INK_MUTED, FONT, SURFACE_COLOR, SURFACE_BORDER_COLOR } from '../theme';
import type { PiConnectionStatus } from '../services/connectionMonitor.service';

interface ConnectionStatusChipProps {
  status: PiConnectionStatus;
  safeTop?: number;
}

const LABELS: Record<PiConnectionStatus, string> = {
  connected: '비바 연결됨',
  connecting: '비바 찾는 중',
  disconnected: '연결 안 됨',
};

const DOT_COLORS: Record<PiConnectionStatus, string> = {
  connected: GREEN,
  connecting: INK_MUTED,
  disconnected: ORANGE,
};

/** 디바이스 모드 홈의 좌상단, ModeToggle 옆에 붙는 상태 칩.
 * 색만으로 구분하지 않는다 - 라벨이 항상 같이 간다 (color-not-only). */
export default function ConnectionStatusChip({
  status,
  safeTop,
}: ConnectionStatusChipProps): React.JSX.Element {
  return (
    <View
      style={[styles.chip, safeTop !== undefined && { top: safeTop }]}
      testID="connection-status-chip"
      accessibilityLabel={`디바이스 연결 상태: ${LABELS[status]}`}
    >
      <View style={[styles.dot, { backgroundColor: DOT_COLORS[status] }]} />
      <Text style={styles.label}>{LABELS[status]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    position: 'absolute',
    top: 18,
    // ModeToggle(left:12, 가변폭) 오른쪽. 겹치지 않게 넉넉히 띄운다.
    left: 132,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    backgroundColor: SURFACE_COLOR,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    zIndex: 40,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: FONT,
    color: INK_MUTED,
  },
});
```

```tsx
// src/components/ConnectionGuideCard.tsx
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SURFACE_COLOR, SURFACE_BORDER_COLOR, INK, INK_MUTED, FONT } from '../theme';

/** 홈(미연결)과 끊김 오버레이 공용 복구 체크리스트. 순서가 곧 시도 순서다. */
const GUIDE_ITEMS = [
  '비바 전원이 켜져 있는지 확인해줘',
  '휴대폰과 비바가 같은 와이파이에 있어야 해',
  '그래도 안 되면 비바 전원을 뽑았다 다시 꽂아줘',
];

export default function ConnectionGuideCard(): React.JSX.Element {
  return (
    <View style={styles.card} testID="connection-guide-card">
      {GUIDE_ITEMS.map((item, i) => (
        <View key={item} style={styles.row}>
          <Text style={styles.index}>{i + 1}</Text>
          <Text style={styles.text}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: SURFACE_COLOR,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    borderRadius: 16,
    paddingVertical: 18,
    paddingHorizontal: 20,
    gap: 14,
    alignSelf: 'stretch',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  index: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: INK_MUTED,
    color: INK_MUTED,
    fontSize: 12,
    fontWeight: '700',
    fontFamily: FONT,
    textAlign: 'center',
    lineHeight: 19,
  },
  text: {
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
    color: INK,
    fontFamily: FONT,
  },
});
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- src/components/__tests__/connectionUi.test.tsx`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/components/ModeToggle.tsx src/components/ConnectionStatusChip.tsx src/components/ConnectionGuideCard.tsx src/components/__tests__/connectionUi.test.tsx
git commit -m "feat: 모드 토글·연결 상태 칩·복구 가이드 카드 컴포넌트"
```

---

### Task 5: HomeScreen 모드별 재편

**Files:**
- Modify: `src/screens/HomeScreen.tsx` (전면 개편)
- Test: `src/components/__tests__/HomeScreen.modes.test.tsx`

**Interfaces:**
- Consumes: Task 2 `AppMode`, Task 1 `PiConnectionStatus`, Task 4 컴포넌트 3종
- Produces: 새 props — `mode: AppMode; onToggleMode: () => void; piStatus: PiConnectionStatus;` 유지 — `onPressToTalk, onPressHistory, solveMode, onToggleSolveMode`. **제거 — `onPressPiTest`** (디버그 버튼 소멸: 코드 주석 "로봇 모드가 기본으로 검증되면 버튼째 지운다"의 그 시점).

- [ ] **Step 1: 실패하는 테스트 작성**

```tsx
// src/components/__tests__/HomeScreen.modes.test.tsx
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import HomeScreen from '../../screens/HomeScreen';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const baseProps = {
  onPressToTalk: jest.fn(),
  onPressHistory: jest.fn(),
  solveMode: false,
  onToggleSolveMode: jest.fn(),
  onToggleMode: jest.fn(),
};

function render(el: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(el);
  });
  return tree;
}

describe('HomeScreen 디바이스 모드', () => {
  it('연결됨: 눈 없음, 웨이크 안내 문구, 시작 버튼 활성', () => {
    const tree = render(<HomeScreen {...baseProps} mode="device" piStatus="connected" />);
    expect(tree.root.findAllByProps({ testID: 'home-eyes' })).toHaveLength(0);
    expect(JSON.stringify(tree.toJSON())).toContain('비바야');
    const mic = tree.root.findByProps({ testID: 'push-to-talk-button' });
    expect(mic.props.accessibilityState).toEqual({ disabled: false });
  });

  it('연결 안 됨: 가이드 카드 표시, 시작 버튼 비활성', () => {
    const tree = render(<HomeScreen {...baseProps} mode="device" piStatus="disconnected" />);
    expect(tree.root.findAllByProps({ testID: 'connection-guide-card' }).length).toBeGreaterThan(0);
    const mic = tree.root.findByProps({ testID: 'push-to-talk-button' });
    expect(mic.props.accessibilityState).toEqual({ disabled: true });
  });
});

describe('HomeScreen APP 모드', () => {
  it('눈 표시, 상태 칩 없음', () => {
    const tree = render(<HomeScreen {...baseProps} mode="app" piStatus="connecting" />);
    expect(tree.root.findAllByProps({ testID: 'home-eyes' }).length).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ testID: 'connection-status-chip' })).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/components/__tests__/HomeScreen.modes.test.tsx`
Expected: FAIL (새 props 미지원, home-eyes testID 없음)

- [ ] **Step 3: HomeScreen 재작성**

전체 교체 (기존 `HistoryIcon` 스타일·`bottomControls`·`controlButton` 스타일은 그대로 재사용, `PiCameraIcon`과 관련 스타일 5개(`piIconWrapper/Body/Lens/Bump`)는 삭제):

```tsx
import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import EyeAnimation from '../components/EyeAnimation';
import ModeToggle from '../components/ModeToggle';
import ConnectionStatusChip from '../components/ConnectionStatusChip';
import ConnectionGuideCard from '../components/ConnectionGuideCard';
import LoadingDots from '../components/LoadingDots';
import { APP_BACKGROUND_COLOR, SURFACE_BORDER_COLOR, INK, INK_MUTED, FONT } from '../theme';
import SolveModeToggle from '../components/SolveModeToggle';
import type { AppMode } from '../hooks/useAppMode';
import type { PiConnectionStatus } from '../services/connectionMonitor.service';

// CSS-only clock icon for history (기존 그대로)
const HistoryIcon = () => (
  <View style={styles.historyIconWrapper}>
    <View style={styles.historyClockFace} />
    <View style={styles.historyClockHand} />
    <View style={styles.historyClockHandMinute} />
  </View>
);

interface HomeScreenProps {
  mode: AppMode;
  onToggleMode: () => void;
  /** 디바이스 모드에서만 의미 있다. APP 모드에선 무시. */
  piStatus: PiConnectionStatus;
  onPressToTalk: () => void;
  onPressHistory: () => void;
  solveMode: boolean;
  onToggleSolveMode: () => void;
}

export default function HomeScreen({
  mode,
  onToggleMode,
  piStatus,
  onPressToTalk,
  onPressHistory,
  solveMode,
  onToggleSolveMode,
}: HomeScreenProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const safeTop = Math.max(insets.top + 12, 18);

  const deviceMode = mode === 'device';
  // 디바이스 모드의 세션 시작은 로봇 마이크·카메라 전제 - 미연결이면 막는다.
  const startDisabled = deviceMode && piStatus !== 'connected';

  return (
    <View style={styles.container} testID="home-screen">
      <ModeToggle mode={mode} onToggle={onToggleMode} safeTop={safeTop} />
      {deviceMode && <ConnectionStatusChip status={piStatus} safeTop={safeTop + 44} />}
      <SolveModeToggle
        enabled={solveMode}
        onToggle={onToggleSolveMode}
        transparent
        safeTop={safeTop}
      />

      {/* 중앙: 모드/연결 상태에 따라 하나만 */}
      <View style={styles.centerArea}>
        {!deviceMode ? (
          // APP 모드: 폰이 곧 비바 - 눈이 얼굴이다.
          <View testID="home-eyes">
            <EyeAnimation state="idle" />
          </View>
        ) : piStatus === 'connected' ? (
          <View style={styles.wakeGuide}>
            <Text style={styles.wakeTitle}>“비바야”라고 불러보세요</Text>
            <Text style={styles.wakeSub}>풀고 싶은 문제를 비바에게 보여주면 돼</Text>
          </View>
        ) : piStatus === 'connecting' ? (
          <View style={styles.wakeGuide}>
            <LoadingDots />
            <Text style={styles.wakeSub}>비바를 찾는 중이야</Text>
          </View>
        ) : (
          <View style={styles.guideWrap}>
            <Text style={styles.wakeTitle}>비바와 연결이 안 돼</Text>
            <ConnectionGuideCard />
          </View>
        )}
      </View>

      <View style={styles.bottomControls}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="눌러서 말하기"
          accessibilityState={{ disabled: startDisabled }}
          disabled={startDisabled}
          testID="push-to-talk-button"
          style={({ pressed }) => [
            styles.controlButton,
            startDisabled && styles.controlButtonDisabled,
            pressed && styles.controlButtonPressed,
          ]}
          onPress={onPressToTalk}
        >
          <Image source={require('../assets/icons/mic.png')} style={styles.micIconImage} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="대화 기록"
          testID="history-button"
          style={({ pressed }) => [styles.controlButton, pressed && styles.controlButtonPressed]}
          onPress={onPressHistory}
        >
          <HistoryIcon />
        </Pressable>
      </View>
    </View>
  );
}
```

스타일: 기존 `container/bottomControls/controlButton/controlButtonPressed/micIconImage/history*` 유지, `eyeContainer`와 `piIcon*` 4종 삭제, 추가:

```tsx
  centerArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
    paddingHorizontal: 36,
  },
  controlButtonDisabled: {
    opacity: 0.38,
  },
  wakeGuide: {
    alignItems: 'center',
    gap: 12,
  },
  wakeTitle: {
    fontSize: 24,
    fontWeight: '700',
    fontFamily: FONT,
    color: INK,
    textAlign: 'center',
  },
  wakeSub: {
    fontSize: 15,
    fontFamily: FONT,
    color: INK_MUTED,
    textAlign: 'center',
  },
  guideWrap: {
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: 20,
  },
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- src/components/__tests__/HomeScreen.modes.test.tsx`
Expected: PASS. `App.tsx`는 아직 옛 props를 넘겨 tsc 에러가 나는 상태여도 된다 — Task 8에서 배선한다 (이 시점 커밋은 컴포넌트+테스트만 본다).

- [ ] **Step 5: 커밋**

```bash
git add src/screens/HomeScreen.tsx src/components/__tests__/HomeScreen.modes.test.tsx
git commit -m "feat: HomeScreen 모드별 재편 - 디바이스=미니멀+연결상태, APP=눈"
```

---

### Task 6: 눈 표시 게이팅 (CharacterView·ProcessingView·BoardView·CameraScreen)

**Files:**
- Modify: `src/components/CharacterView.tsx`, `src/components/ProcessingView.tsx`, `src/components/BoardView.tsx:149`, `src/screens/CameraScreen.tsx:361`
- Test: `src/components/__tests__/showEyes.test.tsx`

**Interfaces:**
- Produces: 각 컴포넌트에 `showEyes?: boolean` (default `true`) — CharacterView 는 추가로 `centerSubtitle?: string`. 호출부 배선은 Task 7·8.

- [ ] **Step 1: 실패하는 테스트 작성**

```tsx
// src/components/__tests__/showEyes.test.tsx
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import CharacterView from '../CharacterView';
import ProcessingView from '../ProcessingView';
import EyeAnimation from '../EyeAnimation';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

function render(el: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(el);
  });
  return tree;
}

describe('showEyes 게이팅', () => {
  it('CharacterView showEyes=false: 눈 없음 + 중앙 자막 표시', () => {
    const tree = render(
      <CharacterView showEyes={false} centerSubtitle="루트 25는 뭘까?" showMic={false} />,
    );
    expect(tree.root.findAllByType(EyeAnimation)).toHaveLength(0);
    expect(JSON.stringify(tree.toJSON())).toContain('루트 25는 뭘까?');
  });

  it('CharacterView 기본값: 눈 표시 (기존 동작 무손상)', () => {
    const tree = render(<CharacterView showMic={false} />);
    expect(tree.root.findAllByType(EyeAnimation)).toHaveLength(1);
  });

  it('ProcessingView showEyes=false: 눈 없이 문구만', () => {
    const tree = render(<ProcessingView showEyes={false} />);
    expect(tree.root.findAllByType(EyeAnimation)).toHaveLength(0);
    expect(JSON.stringify(tree.toJSON())).toContain('찍은 사진');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/components/__tests__/showEyes.test.tsx`
Expected: FAIL (`showEyes`/`centerSubtitle` prop 없음 — 눈이 항상 렌더된다)

- [ ] **Step 3: 구현**

**CharacterView.tsx** — props 확장 + 렌더 분기 (`import`에 `Text` 추가, theme 토큰은 `../theme`에서):

```tsx
import { INK, FONT } from '../theme';

interface CharacterViewProps {
  state?: EyeState;
  isListening?: boolean;
  onMicPress?: () => void;
  showMic?: boolean;
  bottom?: number;
  /** false = 디바이스 모드: 눈은 로봇 얼굴에 있으니 앱은 자막이 주인공. */
  showEyes?: boolean;
  /** showEyes=false 일 때 중앙에 크게 띄울 현재 자막. */
  centerSubtitle?: string;
}
```

렌더의 `<EyeAnimation state={state} />` (CharacterView.tsx:30)를 다음으로 교체:

```tsx
      {showEyes ? (
        <EyeAnimation state={state} />
      ) : (
        <View style={styles.centerSubtitleWrap} pointerEvents="none">
          {centerSubtitle ? (
            <Text style={styles.centerSubtitleText}>{centerSubtitle}</Text>
          ) : null}
        </View>
      )}
```

함수 시그니처 기본값에 `showEyes = true, centerSubtitle` 추가. 스타일 추가:

```tsx
  centerSubtitleWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 36,
  },
  centerSubtitleText: {
    fontSize: 22,
    lineHeight: 34,
    fontWeight: '600',
    fontFamily: FONT,
    color: INK,
    textAlign: 'center',
  },
```

**ProcessingView.tsx** — props 추가:

```tsx
interface ProcessingViewProps {
  /** false = 디바이스 모드 (로봇 눈이 'listening' 으로 일하는 중을 표현한다). */
  showEyes?: boolean;
}

export default function ProcessingView({ showEyes = true }: ProcessingViewProps): React.JSX.Element {
```

렌더 (`ProcessingView.tsx:55-56`): `<EyeAnimation state="processing" />`를 `{showEyes && <EyeAnimation state="processing" />}`로, statusRow 를 눈이 없을 땐 중앙으로:

```tsx
      <View
        style={showEyes ? [styles.statusRow, { bottom: safeBottom }] : styles.statusCenter}
        pointerEvents="none"
      >
```

스타일 추가:

```tsx
  statusCenter: {
    paddingHorizontal: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
```

**BoardView.tsx:149** — `showEyes?: boolean` prop 추가(default true), `import LoadingDots from './LoadingDots';` 추가, 교체:

```tsx
      ) : showEyes ? (
        <EyeAnimation state="processing" />
      ) : (
        <View style={styles.boardLoadingCenter}>
          <LoadingDots label="칠판을 그리는 중이야" />
        </View>
      )}
```

스타일 추가: `boardLoadingCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' }` (BoardView 의 해당 분기가 이미 flex 컨테이너 안이면 `alignSelf: 'stretch'` 만으로 충분한지 렌더 확인).

**CameraScreen.tsx:361** — props에 `showEyes?: boolean` (default true) 추가, analyzing 분기의 `<EyeAnimation state="processing" />`를 `{showEyes && <EyeAnimation state="processing" />}`로.

- [ ] **Step 4: 통과 확인 (기존 BoardView 테스트 포함)**

Run: `npm test -- src/components/__tests__/showEyes.test.tsx src/components/__tests__/BoardView.test.tsx`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/components/CharacterView.tsx src/components/ProcessingView.tsx src/components/BoardView.tsx src/screens/CameraScreen.tsx src/components/__tests__/showEyes.test.tsx
git commit -m "feat: showEyes prop - 디바이스 모드에서 앱 눈 숨김 게이팅"
```

---

### Task 7: DisconnectOverlay + ConversationScreen 끊김·모드 배선

**Files:**
- Create: `src/components/DisconnectOverlay.tsx`
- Modify: `src/screens/ConversationScreen.tsx`
- Test: `src/components/__tests__/DisconnectOverlay.test.tsx`

**Interfaces:**
- Consumes: Task 4 `ConnectionGuideCard`, Task 2 `usePiConnection`/`AppMode`, 기존 `stopSpeaking`(tts.service), `voice.stopListening`
- Produces: `<DisconnectOverlay onContinueInAppMode onEndSession />`; ConversationScreen 새 props — `appMode: AppMode; onSwitchToAppMode: () => void;`

- [ ] **Step 1: 실패하는 테스트 작성**

```tsx
// src/components/__tests__/DisconnectOverlay.test.tsx
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import DisconnectOverlay from '../DisconnectOverlay';

function render(el: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(el);
  });
  return tree;
}

describe('DisconnectOverlay', () => {
  it('가이드 카드 + 두 버튼, 콜백 연결', () => {
    const onContinue = jest.fn();
    const onEnd = jest.fn();
    const tree = render(
      <DisconnectOverlay onContinueInAppMode={onContinue} onEndSession={onEnd} />,
    );
    expect(tree.root.findAllByProps({ testID: 'connection-guide-card' }).length).toBeGreaterThan(0);
    act(() => tree.root.findByProps({ testID: 'continue-app-mode-button' }).props.onPress());
    expect(onContinue).toHaveBeenCalledTimes(1);
    act(() => tree.root.findByProps({ testID: 'end-session-button' }).props.onPress());
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- src/components/__tests__/DisconnectOverlay.test.tsx`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: DisconnectOverlay 구현**

```tsx
// src/components/DisconnectOverlay.tsx
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import ConnectionGuideCard from './ConnectionGuideCard';
import LoadingDots from './LoadingDots';
import { APP_BACKGROUND_COLOR, INK, INK_MUTED, GREEN, FONT, SURFACE_COLOR, SURFACE_BORDER_COLOR } from '../theme';

interface DisconnectOverlayProps {
  /** [휴대폰으로 계속하기] - APP 모드 전환, 세션은 폰 마이크·스피커로 이어간다. */
  onContinueInAppMode: () => void;
  /** [세션 종료] - 기록 저장 후 홈으로. */
  onEndSession: () => void;
}

/**
 * 디바이스 모드 세션 중 연결이 끊기면 세션 전체를 덮는다. 재연결 시도는
 * 별도 로직이 없다 - connectionMonitor 폴링이 계속 돌고, 부모가 상태를
 * 구독하다가 connected 로 돌아오면 이 오버레이를 내린다.
 */
export default function DisconnectOverlay({
  onContinueInAppMode,
  onEndSession,
}: DisconnectOverlayProps): React.JSX.Element {
  return (
    <View style={styles.overlay} testID="disconnect-overlay">
      <Text style={styles.title}>비바와 연결이 끊겼어</Text>
      <View style={styles.spinnerRow}>
        <LoadingDots />
        <Text style={styles.spinnerLabel}>다시 연결하는 중이야</Text>
      </View>
      <ConnectionGuideCard />
      <View style={styles.buttons}>
        <Pressable
          accessibilityRole="button"
          testID="continue-app-mode-button"
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
          onPress={onContinueInAppMode}
        >
          <Text style={styles.primaryLabel}>휴대폰으로 계속하기</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          testID="end-session-button"
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          onPress={onEndSession}
        >
          <Text style={styles.secondaryLabel}>세션 종료</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: APP_BACKGROUND_COLOR, // 불투명 - 뒤 세션 UI 조작 차단
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 24,
    zIndex: 100,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    fontFamily: FONT,
    color: INK,
    textAlign: 'center',
  },
  spinnerRow: {
    alignItems: 'center',
    gap: 8,
  },
  spinnerLabel: {
    fontSize: 13,
    fontFamily: FONT,
    color: INK_MUTED,
  },
  buttons: {
    alignSelf: 'stretch',
    gap: 12,
  },
  primaryButton: {
    height: 52,
    borderRadius: 26,
    backgroundColor: GREEN,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryLabel: {
    fontSize: 16,
    fontWeight: '700',
    fontFamily: FONT,
    color: '#FFFFFF',
  },
  secondaryButton: {
    height: 52,
    borderRadius: 26,
    backgroundColor: SURFACE_COLOR,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryLabel: {
    fontSize: 16,
    fontWeight: '600',
    fontFamily: FONT,
    color: INK,
  },
  pressed: {
    opacity: 0.8,
  },
});
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- src/components/__tests__/DisconnectOverlay.test.tsx`
Expected: PASS

- [ ] **Step 5: ConversationScreen 배선**

변경 5곳:

(a) props (`ConversationScreen.tsx:65-77`):

```tsx
import type { AppMode } from '../hooks/useAppMode';
import { usePiConnection } from '../hooks/usePiConnection';
import DisconnectOverlay from '../components/DisconnectOverlay';

interface ConversationScreenProps {
  conversation?: ConversationPayload;
  onSessionComplete?: () => void;
  onCameraNeeded?: (question?: string, resume?: ResumeSessionSnapshot) => void;
  robotAudio?: boolean;
  /** 'device' = 눈·자막 역할 분리 레이아웃. 'app' = 현행(눈 포함). */
  appMode?: AppMode;
  /** 끊김 오버레이의 [휴대폰으로 계속하기]. */
  onSwitchToAppMode?: () => void;
  solveMode: boolean;
  onToggleSolveMode: () => void;
}
```

함수 시그니처에 `appMode = 'app', onSwitchToAppMode` 추가 (default `'app'` = 기존 동작 보존, App 배선 전까지 무해).

(b) 끊김 감지 (`robotMode` 선언부 아래, `ConversationScreen.tsx:96` 부근):

```tsx
  const piStatus = usePiConnection();
  const disconnected = appMode === 'device' && piStatus === 'disconnected';

  // 끊김 순간 일시정지: 말하던 TTS 를 멈추고 마이크를 닫는다. 재개는
  // 오버레이가 내려간 뒤 학생이 마이크를 다시 누르는 것으로 한다.
  // ponytail: 복귀 시 마지막 튜터 발화 자동 re-speak 은 미구현 - 실기기에서
  // 필요성이 확인되면 useTutoringFSM 에 재발화 API 를 추가한다.
  useEffect(() => {
    if (!disconnected) return;
    stopSpeaking();
    if (voice.isListening) voice.stopListening();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disconnected]);
```

주의: `voice` 는 이 시점(96행)엔 아직 선언 전이다 — 이 effect 는 `useVoiceInput` 호출(약 298행) **아래**에 둔다.

(c) 눈 게이팅 (렌더, `ConversationScreen.tsx:744-761`):

```tsx
        {requiresBoard ? (
          <BoardView
            boardImageBase64={session.lastBoardImageBase64}
            annotations={fsmConversation?.annotations}
            isListening={voice.isListening}
            onMicPress={handleMicPress}
            showMic={voice.mode === 'voice'}
            bottom={safeBottom}
            showEyes={appMode === 'app'}
          />
        ) : (
          <CharacterView
            state={eyeState}
            isListening={voice.isListening}
            onMicPress={handleMicPress}
            showMic={voice.mode === 'voice'}
            bottom={safeBottom}
            showEyes={appMode === 'app'}
            centerSubtitle={
              statusSlot.kind === 'subtitle' ? cleanTextForSubtitle(statusSlot.text) : undefined
            }
          />
        )}
```

(d) 하단 자막 중복 억제 — `statusSlot.kind === 'subtitle'` 렌더 블록(`ConversationScreen.tsx:866`)의 조건을 다음으로:

```tsx
        {statusSlot.kind === 'subtitle' && !(appMode === 'device' && !requiresBoard) && (
```

(디바이스 모드 + 칠판 없음 = 자막이 이미 중앙에 크게 떠 있다. 칠판이 있으면 칠판이 주인공이므로 하단 자막 유지.)

(e) 오버레이 (렌더 최하단, 닫는 `</Pressable>` 직전):

```tsx
        {disconnected && (
          <DisconnectOverlay
            onContinueInAppMode={() => onSwitchToAppMode?.()}
            onEndSession={() => onSessionComplete?.()}
          />
        )}
```

- [ ] **Step 6: 전체 테스트로 회귀 확인**

Run: `npm test`
Expected: 기존 베이스라인(실패 5개) 외 새 실패 없음

- [ ] **Step 7: 커밋**

```bash
git add src/components/DisconnectOverlay.tsx src/components/__tests__/DisconnectOverlay.test.tsx src/screens/ConversationScreen.tsx
git commit -m "feat: 세션 중 끊김 오버레이 + ConversationScreen 모드 배선"
```

---

### Task 8: App.tsx 통합 — 모드 소유·monitor 생명주기·piReadyRef 대체

**Files:**
- Modify: `App.tsx`

**Interfaces:**
- Consumes: Task 1-7 전부. `stopPiPlayback`/`stopPiRecording` (piBridge.service.ts).
- Produces: 최종 배선. `piReadyRef` 소멸.

- [ ] **Step 1: 모드·연결 상태 도입**

`AppContent` 상단 (`App.tsx:93-94` 부근):

```tsx
import { useAppMode } from './src/hooks/useAppMode';
import { usePiConnection } from './src/hooks/usePiConnection';
import { connectionMonitor } from './src/services/connectionMonitor.service';
import { stopPiPlayback, stopPiRecording } from './src/services/piBridge.service';

  const { mode, setMode, toggleMode } = useAppMode();
  const piStatus = usePiConnection();
  // beginCapture 같은 콜백이 stale closure 없이 현재 모드를 읽기 위한 ref.
  const modeRef = useRef(mode);
  modeRef.current = mode;
```

- [ ] **Step 2: 모드 생명주기 effect** (카메라 권한 effect 아래):

```tsx
  // 모드가 곧 단일 소스다: 디바이스 모드 = monitor 폴링 + 보드 송신,
  // APP 모드 = 전부 정지 + Pi 쪽 진행 중 자원 정리(best-effort - Pi 재부팅
  // 시 어차피 초기화되므로 실패는 무시).
  useEffect(() => {
    if (mode === 'device') {
      eyeSyncService.setSuppressed(false);
      connectionMonitor.start();
      return;
    }
    connectionMonitor.stop();
    eyeSyncService.setSuppressed(true);
    piWakeStream.pause().catch(() => {});
    stopPiPlayback().catch(() => {});
    stopPiRecording().catch(() => {});
  }, [mode, piWakeStream]);
```

- [ ] **Step 3: piReadyRef 제거, wakePiSource 게이팅 교체** (`App.tsx:130-160`)

`piReadyRef` 선언(주석 포함, `App.tsx:132-136`)을 삭제하고 `wakePiSource` 를:

```tsx
  // useWakeWord 에 주는 소스. APP 모드거나 monitor 가 연결을 확인 못 했으면
  // start 를 거부해 기존 폰 마이크 경로로 흘린다.
  const wakePiSource = useMemo<PiWakeStream>(
    () => ({
      ...piWakeStream,
      start: async (onPcm) => {
        if (modeRef.current === 'app' || connectionMonitor.status !== 'connected') {
          throw new Error('pi disabled - using phone mic');
        }
        return piWakeStream.start(onPcm);
      },
    }),
    [piWakeStream],
  );
```

- [ ] **Step 4: beginCapture 게이팅** (`App.tsx:194-306`)

`console.log` 줄을 `console.log(\`[App] beginCapture: mode=${modeRef.current} pi=${connectionMonitor.status}\`);` 로. `if (!piReadyRef.current)` 분기(App.tsx:246-249)를:

```tsx
    const usePi = modeRef.current === 'device' && connectionMonitor.status === 'connected';
    if (!usePi) {
      // APP 모드의 정상 경로. 디바이스 모드 미연결은 홈이 시작을 막고 웨이크도
      // 안 돌므로 원칙적으로 도달하지 않는다 - 도달하면 폰 카메라가 안전값.
      await openPhoneCamera();
      return;
    }
```

catch 블록(App.tsx:289-305)의 `checkPiConnection()...` 재판정을 monitor 로 교체:

```tsx
    } catch (err) {
      console.error('[App] pi capture failed:', err);
      // 카메라 실패 ≠ Pi 다운 (2026-08-04 원칙). monitor 로 재판정해서
      // Pi 가 살아 있으면(카메라만 문제) 폰 카메라로 잇고, 죽었으면 홈으로
      // 돌려보내 연결 안내 카드를 보여준다 - 조용한 폴백은 하지 않는다.
      const stillAlive = await connectionMonitor.probeNow();
      if (stillAlive) {
        await openPhoneCamera();
      } else {
        handleResetToIdle();
      }
    }
```

(`beginCapture` 의 useCallback deps 에 `handleResetToIdle` 추가.)

- [ ] **Step 5: idle 웨이크 effect 를 모드·연결 인지형으로** (`App.tsx:315-337` 교체):

```tsx
  useEffect(() => {
    if (appState.status !== 'idle') {
      stopListening();
      piWakeStream.pause().catch(() => {});
      return;
    }
    if (mode === 'device') {
      if (piStatus === 'connected') {
        piWakeStream
          .resume()
          .catch((err) => console.warn('[App] pi wake stream resume failed:', err))
          .then(() => startListening());
      } else {
        // 디바이스 모드 미연결: 웨이크는 로봇 마이크 전제라 올리지 않는다.
        // monitor 가 connected 로 바뀌면 이 effect 가 다시 돌아 올라간다.
        stopListening();
      }
    } else {
      // APP 모드: wakePiSource 가 start 를 거부해 폰 마이크로 흐른다.
      startListening();
    }
  }, [appState.status, mode, piStatus, startListening, stopListening, piWakeStream]);
```

- [ ] **Step 6: 렌더 props 배선** (`App.tsx:350-395`)

```tsx
      {appState.status === 'idle' && (
        <HomeScreen
          mode={mode}
          onToggleMode={toggleMode}
          piStatus={piStatus}
          onPressToTalk={beginCapture}
          onPressHistory={enterHistory}
          solveMode={solveMode}
          onToggleSolveMode={toggleSolveMode}
        />
      )}
```

`processing`: `<ProcessingView showEyes={mode === 'app'} />`
`capturing`: CameraScreen 에 `showEyes={mode === 'app'}` 추가.
`conversation`:

```tsx
        <ConversationScreen
          conversation={appState.conversation}
          robotAudio={mode === 'device' && piStatus === 'connected'}
          appMode={mode}
          onSwitchToAppMode={() => setMode('app')}
          onSessionComplete={handleResetToIdle}
          onCameraNeeded={handleCameraNeeded}
          solveMode={solveMode}
          onToggleSolveMode={toggleSolveMode}
        />
```

- [ ] **Step 7: 검증**

Run: `npx tsc --noEmit` — 기존 5개 외 새 에러 없음 (piReadyRef 참조 잔재가 있으면 여기서 걸린다)
Run: `npm test` — 베이스라인 외 새 실패 없음

- [ ] **Step 8: 커밋**

```bash
git add App.tsx
git commit -m "feat: App 모드·연결 상태 통합 배선 - piReadyRef 를 connectionMonitor 로 대체"
```

---

### Task 9: eyes.py — 무클라이언트 30초 후 '연결 끊김' 얼굴

**Files:**
- Modify: `pi-server/eyes.py`

**Interfaces:**
- Produces: `effective_state(now: float) -> str` (메인 루프가 `_state["eye"]` 대신 호출), 렌더 상태 `"disconnected"` (WS 로는 못 보낸다 — `VALID_STATES` 불변, 보드 자가 판단 전용)

- [ ] **Step 1: 상태 추적 추가** (`eyes.py:117` `_clients = set()` 아래):

```python
# 앱 WS 가 하나도 안 붙은 채 이 시간이 지나면 스스로 '연결 끊김' 얼굴을
# 띄운다 (2026-08-10 역할 분리 스펙). 유예를 두는 이유: 폰 화면 잠깐 꺼짐/
# 앱 전환으로 WS 가 수 초 끊길 때마다 표정이 요동치면 안 된다.
# "마지막 클라이언트가 나가면 idle 리셋"(2026-08-07)의 확장이다 - 앱이 죽어
# 못 보내는 상황은 보드가 스스로 판단할 수밖에 없다.
DISCONNECT_GRACE_S = 30.0
# None = 클라이언트 있음. 값 = 비어있기 시작한 monotonic 시각.
# 부팅 직후부터 카운트를 시작한다 - 폰이 한 번도 안 붙었어도 30초 뒤 '끊김'
# 이 맞다 (연결된 적 없음 == 연결 안 됨).
_clients_empty_since = {"t": time.monotonic()}


def effective_state(now: float) -> str:
    """렌더 루프가 실제로 그릴 상태. 무클라이언트 유예 초과 시 disconnected."""
    empty_t = _clients_empty_since["t"]
    if empty_t is not None and now - empty_t >= DISCONNECT_GRACE_S:
        return "disconnected"
    return _state["eye"]
```

`_handler` 수정 — 진입부 `_clients.add(ws)` 다음 줄에 `_clients_empty_since["t"] = None`, finally 의 `if not _clients ...` 블록에 한 줄 추가:

```python
        _clients.discard(ws)
        if not _clients:
            _clients_empty_since["t"] = time.monotonic()
            if _state["eye"] != "idle":
                print(f"[viva-eyes] no clients: {_state['eye']} -> idle")
                _state["eye"] = "idle"
```

(기존 `if not _clients and _state["eye"] != "idle":` 구조를 위처럼 중첩으로 바꾼다 — 타임스탬프는 표정과 무관하게 항상 찍혀야 한다.)

- [ ] **Step 2: 렌더 분기** — `Renderer.draw` (`eyes.py:395`) 의 `surface.fill(BG)` / `cx, cy` 계산 직후에:

```python
        # 연결 끊김: 반쯤 감긴 눈 + 느린 숨 + 'z'. 사케이드 없음 - 자고 있다.
        # 앱이 재접속해 상태를 보내면 메인 루프의 크로스페이드로 자연 복귀.
        if state == "disconnected":
            self.mark = None
            self.nodding = False
            blink = 0.42
            breathe = BREATH * 1.5 * ease(tri(now / 5.2))
            for side in (-1, 1):
                sprite = self.sprites.get("normal", blink, side)
                center = (cx + side * (GAP + EYE_W) / 2, cy + breathe)
                surface.blit(sprite, sprite.get_rect(center=center))
            self._draw_sleep_glyph(surface, cx, cy, now)
            return
```

`_draw_mark` 아래에 메서드 추가 (`_fonts` 캐시 재사용):

```python
    def _draw_sleep_glyph(self, surface, cx, cy, now: float):
        """우상단 'z' - '연결 끊김/자는 중' 표시. _draw_mark 와 같은 폰트 캐시."""
        size = int(EYE_H * 0.34 * (1.0 + 0.06 * ease(tri(now / 2.4))))
        font = self._fonts.get(size)
        if font is None:
            try:
                font = pygame.font.SysFont("dejavusans", size, bold=True)
            except Exception:
                font = False
            self._fonts[size] = font
        if font:
            glyph = font.render("z", True, FG)
            surface.blit(glyph, glyph.get_rect(
                center=(cx + GAP / 2 + EYE_W * 0.75, cy - EYE_H / 2 - EYE_H * 0.10)))
```

- [ ] **Step 3: 메인 루프 연결** — `main()` 의 `target = _state["eye"]` (`eyes.py:602`)를:

```python
        # 창 모드는 WS 클라이언트가 원래 없으니 무클라이언트 판정을 끈다 -
        # 키보드(1~6)로만 상태를 바꾼다.
        target = _state["eye"] if WINDOW else effective_state(now)
```

`KEY_STATES` (`eyes.py:105`)에 `pygame.K_6: "disconnected",` 추가, 창 캡션 문자열에 `6:disconnected` 추가.

- [ ] **Step 4: selftest 확장** (`eyes.py:481` `selftest()`)

패널 이탈 검사 루프의 상태 집합을 `VALID_STATES | {"disconnected"}` 로:

```python
    for state, now in ((s, t) for s in VALID_STATES | {"disconnected"}
                       for t in (0.0, NOD_PERIOD / 2, 1.8, 2.7)):
```

`_ws_case` 뒤에 추가:

```python
    # 무클라이언트 유예 판정
    _clients_empty_since["t"] = None
    assert effective_state(100.0) == _state["eye"], "클라이언트가 있는데 disconnected"
    _clients_empty_since["t"] = 50.0
    assert effective_state(50.0 + DISCONNECT_GRACE_S - 1) == _state["eye"], "유예 중인데 disconnected"
    assert effective_state(50.0 + DISCONNECT_GRACE_S + 1) == "disconnected", "유예 초과인데 미전환"
    _clients_empty_since["t"] = time.monotonic()
```

또한 `_ws_case` 안에서 handler 종료 후 타임스탬프가 찍혔는지 확인:

```python
        assert _clients_empty_since["t"] is not None, "마지막 클라이언트가 나갔는데 empty 시각 미기록"
```

- [ ] **Step 5: 검증** (Mac 로컬)

Run: `python3 pi-server/eyes.py --selftest`
Expected: `[viva-eyes] selftest OK`
Run(수동, 선택): `python3 pi-server/eyes.py --window` → 6 키로 끊김 얼굴 확인

- [ ] **Step 6: 커밋**

```bash
git add pi-server/eyes.py
git commit -m "feat: eyes.py 무클라이언트 30초 후 연결 끊김 얼굴 (z + 반개안)"
```

---

### Task 10: process.md 갱신 + 최종 검증

**Files:**
- Modify: `docs/process.md`

- [ ] **Step 1: 전체 검증**

Run: `npm test` → 베이스라인(390/395) 외 새 실패 없음 확인, 새 테스트들 포함 통과 수 기록
Run: `npx tsc --noEmit` → 기존 5개 외 새 에러 없음
Run: `python3 pi-server/eyes.py --selftest` → OK

- [ ] **Step 2: process.md 갱신** — 문서 맨 위 "문서 갱신 규칙" 절의 지시에 따라 §1(현재 상태)·§4(히스토리, D-n 결정 인덱스 포함)에 기록. 반드시 포함할 내용:

- 역할 분리: 앱 눈은 APP 모드 전용이 됐다 (디바이스 모드 = 보조 칠판). D-n 신규 결정 번호 부여.
- connectionMonitor 가 유일 판정자 — piReadyRef 소멸. 눈 WS/piBridge 실패는 재프로브 트리거.
- eyes.py 의 disconnected 는 보드 자가 판단 (VALID_STATES 밖, D-42 single-writer 원칙과의 관계는 스펙 §4 참조).
- **실기기 미검증 항목으로 명시**: 끊김 오버레이 발동/복귀, 디바이스 모드 홈의 웨이크 게이팅, 복귀 시 자동 re-speak 미구현(ponytail 유예), APP 모드 전환 시 Pi 자원 정리.
- 스펙/플랜 경로 링크.

- [ ] **Step 3: 커밋**

```bash
git add docs/process.md
git commit -m "docs: 역할 분리·연결 상태 작업 process.md 반영"
```

---

## Self-Review 결과 (작성 시 수행)

- 스펙 §1 모드 시스템 → Task 2·8. §2 ConnectionMonitor → Task 1. §3 화면 재편 → Task 4·5·6·7. §4 디바이스 끊김 표정 → Task 9. 에러 처리(camera dead ≠ Pi dead) → Task 8 Step 4. 테스트 절 → 각 태스크 + Task 10.
- 스펙의 "복귀 시 진행 중이던 턴 재시작"은 ponytail 유예로 축소(마이크 재탭으로 재개) — Task 7 (b) 주석과 Task 10 미검증 항목에 명시. 실기기 확인 후 필요 시 후속.
- 타입 일관성: `PiConnectionStatus`/`AppMode`/`showEyes`/`onSwitchToAppMode` 명칭이 태스크 간 동일함을 확인.

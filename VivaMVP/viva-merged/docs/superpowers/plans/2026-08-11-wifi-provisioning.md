# WiFi 프로비저닝 (QR + 로봇 카메라) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** VIVA 앱에서 SSID/비번을 QR로 만들어 로봇 카메라에 비추면 로봇이 WiFi에 등록된다 — 초기 세팅(언박싱)과 네트워크 변경을 앱만으로 끝낸다.

**Architecture:** 앱은 표준 WiFi QR(`WIFI:T:WPA;S:..;P:..;;`)을 순수 JS로 생성해 풀스크린 표시. Pi 쪽 새 서비스 `provision.py`가 WiFi 상태를 감시하다 미연결이면 eyes.py에 로컬 WS 클라이언트로 화면 상태(`provision_new`/`provision_fail`)를 밀고, picamera2+pyzbar로 QR을 스캔해 nmcli로 등록한다. 성공 감지는 앱의 기존 connectionMonitor connected 엣지 재사용. 스펙: `docs/superpowers/specs/2026-08-11-wifi-provisioning-design.md`.

**Tech Stack:** RN/Expo v57, qrcode-generator(순수 JS), react-test-renderer, Python(pygame/websockets/picamera2/pyzbar/evdev), NetworkManager(nmcli).

## Global Constraints

- **병렬 세션 파일 금지**: 다른 세션이 호출어(헤이 비바→비바야) 작업 중. 다음 파일 절대 수정 금지: `src/lib/openWakeWord.ts`, `src/prompts/system_prompt.ts`, `src/screens/*`, `src/device/screens/ConversationScreen.tsx`, `src/components/SolveModeToggle.tsx`, `src/utils/mathTextProcessor.ts`, `src/device/components/ConnectionStatusChip.tsx`.
- **커밋 규칙**: `git add -A` 절대 금지. **신규 파일만** 경로 지정 add로 커밋한다. 이미 dirty한 기존 파일(`pi-server/eyes.py`, `src/device/components/ConnectionGuideCard.tsx`, `src/device/screens/HomeScreen.tsx`, `pi-server/README.md`)은 수정하되 **커밋하지 않는다** (타 세션/이전 작업 미커밋분 혼재).
- **명칭**: 사용자 노출 문구에서 앱은 항상 "VIVA 앱" (그냥 "앱" 금지).
- 기존 실패 테스트 무시: `src/utils/__tests__/captureDecision.test.ts`, `src/hooks/__tests__/useTutoringFSM.problemChoice.test.ts` 5건 + 타 파일 tsc 에러 4건은 병렬 세션 소관 — 내 변경 파일만 깨끗하면 통과로 간주.
- 테스트 실행: `cd viva-merged && npx jest <경로>` (jest는 react-test-renderer 관례, FaultBadge.test.tsx 참고).
- Python 검증: `cd viva-merged/pi-server && python3 <파일> --selftest` (맥에서 pygame 있음, picamera2/evdev/pyzbar 없음 — 하드웨어 import는 지연 import로).
- **의도적 보류 (스펙 §5 중)**: 스캔 30초 미인식 힌트 줄, 비번 오류 QR의 "비밀번호를 확인해주세요" 화면 — 둘 다 실기기 스캔 실측 후 추가한다 (P2 상태 라인이 임시 커버). Task 8 기록에 보류로 명시할 것.

---

### Task 1: wifiQr.ts — 페이로드 + QR 매트릭스

**Files:**
- Create: `viva-merged/src/utils/wifiQr.ts`
- Test: `viva-merged/src/utils/__tests__/wifiQr.test.ts`
- Modify: `viva-merged/package.json` (qrcode-generator 추가 — `npm install` 커맨드로)

**Interfaces:**
- Produces: `buildWifiQrPayload(ssid: string, psk: string): string`, `buildWifiQrMatrix(payload: string): boolean[][]` (정사각, true=검정 모듈)

- [ ] **Step 1: 의존성 설치**

```bash
cd viva-merged && npm install qrcode-generator
```

- [ ] **Step 2: 실패 테스트 작성**

`src/utils/__tests__/wifiQr.test.ts`:

```ts
import { buildWifiQrPayload, buildWifiQrMatrix } from '../wifiQr';

describe('buildWifiQrPayload', () => {
  it('표준 WIFI: 포맷으로 만든다', () => {
    expect(buildWifiQrPayload('MyHome', 'pass1234')).toBe('WIFI:T:WPA;S:MyHome;P:pass1234;;');
  });

  it('특수문자(\\ ; , : ")를 이스케이프한다', () => {
    expect(buildWifiQrPayload('a;b', 'p:w,"x\\y')).toBe(
      'WIFI:T:WPA;S:a\\;b;P:p\\:w\\,\\"x\\\\y;;',
    );
  });
});

describe('buildWifiQrMatrix', () => {
  it('정사각 boolean 매트릭스를 만들고 파인더 패턴(좌상단 7x7 테두리)이 검정이다', () => {
    const m = buildWifiQrMatrix(buildWifiQrPayload('MyHome', 'pass1234'));
    expect(m.length).toBeGreaterThanOrEqual(21); // QR 최소 버전 크기
    m.forEach((row) => expect(row.length).toBe(m.length));
    for (let i = 0; i < 7; i++) {
      expect(m[0][i]).toBe(true); // 파인더 상변
      expect(m[i][0]).toBe(true); // 파인더 좌변
    }
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `cd viva-merged && npx jest src/utils/__tests__/wifiQr.test.ts`
Expected: FAIL (`Cannot find module '../wifiQr'`)

- [ ] **Step 4: 구현**

`src/utils/wifiQr.ts`:

```ts
/** 표준 WiFi QR 페이로드 + 매트릭스 생성 (프로비저닝 스펙 §2).
 * 표준 포맷이라 폰 기본 카메라로도 페이로드 검증 가능. 비번은 호출자
 * 메모리에만 존재 - 여기서든 어디서든 저장하지 않는다. */
import qrcode from 'qrcode-generator';

/** WIFI: 포맷 예약문자 이스케이프 (\ ; , : ") - 백슬래시를 맨 먼저. */
function escapeField(v: string): string {
  return v.replace(/([\\;,:"])/g, '\\$1');
}

export function buildWifiQrPayload(ssid: string, psk: string): string {
  return `WIFI:T:WPA;S:${escapeField(ssid)};P:${escapeField(psk)};;`;
}

/** true = 검정 모듈. 버전 자동(0), 오류정정 M - 페이로드가 짧아 저버전
 * (~29x29)으로 나와 로봇 고정초점 카메라 인식 마진이 크다. */
export function buildWifiQrMatrix(payload: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(payload);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) =>
    Array.from({ length: n }, (_, c) => qr.isDark(r, c)),
  );
}
```

주의: `qrcode-generator`는 자체 `.d.ts`를 포함한다. default import가 tsc에서 안 잡히면 `import qrcode = require('qrcode-generator');`로 교체.

- [ ] **Step 5: 통과 확인**

Run: `cd viva-merged && npx jest src/utils/__tests__/wifiQr.test.ts`
Expected: PASS

- [ ] **Step 6: 커밋 (신규 파일 + package.json/lock)**

package.json/package-lock.json은 dirty 아님(이 변경 전 clean)이므로 함께 커밋 가능:

```bash
cd viva-merged && git add src/utils/wifiQr.ts src/utils/__tests__/wifiQr.test.ts package.json package-lock.json
git commit -m "feat: WiFi QR 페이로드·매트릭스 생성 유틸 (qrcode-generator, 순수 JS)"
```

---

### Task 2: QrCodeView — 네이티브 의존성 없는 QR 렌더

**Files:**
- Create: `viva-merged/src/device/components/QrCodeView.tsx`
- Test: `viva-merged/src/device/components/__tests__/QrCodeView.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `boolean[][]` 매트릭스
- Produces: `<QrCodeView matrix={boolean[][]} size={number} />` — size는 quiet zone 포함 한 변 px

- [ ] **Step 1: 실패 테스트 작성**

`src/device/components/__tests__/QrCodeView.test.tsx` (render 헬퍼는 FaultBadge.test.tsx 관례):

```tsx
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import QrCodeView from '../QrCodeView';

function render(el: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(el);
  });
  return tree;
}

// 5x5 십자 패턴 - run-length 병합이 행마다 다르게 일어난다
const M = [
  [false, false, true, false, false],
  [false, false, true, false, false],
  [true, true, true, true, true],
  [false, false, true, false, false],
  [false, false, true, false, false],
];

describe('QrCodeView', () => {
  it('행 수만큼 row View, 행마다 run 수만큼 셀 View를 만든다', () => {
    const tree = render(<QrCodeView matrix={M} size={200} />);
    const rows = tree.root.findAll((n) => n.props.testID === 'qr-row');
    expect(rows).toHaveLength(5);
    // 3행(전부 검정)은 run 1개, 1행(백2/흑1/백2)은 run 3개
    expect(rows[2].findAll((n) => n.props.testID === 'qr-run')).toHaveLength(1);
    expect(rows[0].findAll((n) => n.props.testID === 'qr-run')).toHaveLength(3);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd viva-merged && npx jest src/device/components/__tests__/QrCodeView.test.tsx`
Expected: FAIL (`Cannot find module '../QrCodeView'`)

- [ ] **Step 3: 구현**

`src/device/components/QrCodeView.tsx`:

```tsx
import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

/** 순수 View 격자 QR 렌더 - react-native-svg 등 네이티브 모듈 없이 그린다
 * (프로비저닝 스펙 §4). 행별 같은 색 연속 구간(run)을 하나의 View로 합쳐
 * 29x29 기준 셀 841개 대신 run 수백 개만 만든다. 스캐너 규격상 QR 주변엔
 * 4모듈 quiet zone(흰 여백)이 필요해 패딩으로 확보한다. */
const QUIET_MODULES = 4;

interface Props {
  matrix: boolean[][];
  /** quiet zone 포함 전체 한 변(px) */
  size: number;
}

function rowRuns(row: boolean[]): { dark: boolean; len: number }[] {
  const runs: { dark: boolean; len: number }[] = [];
  for (const dark of row) {
    const last = runs[runs.length - 1];
    if (last && last.dark === dark) last.len += 1;
    else runs.push({ dark, len: 1 });
  }
  return runs;
}

export default function QrCodeView({ matrix, size }: Props): React.JSX.Element {
  const n = matrix.length;
  const cell = size / (n + QUIET_MODULES * 2);
  const runsByRow = useMemo(() => matrix.map(rowRuns), [matrix]);
  return (
    <View style={[styles.box, { width: size, height: size, padding: cell * QUIET_MODULES }]}>
      {runsByRow.map((runs, r) => (
        <View key={r} testID="qr-row" style={[styles.row, { height: cell }]}>
          {runs.map((run, i) => (
            <View
              key={i}
              testID="qr-run"
              style={{
                width: run.len * cell,
                backgroundColor: run.dark ? '#000000' : '#FFFFFF',
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // 흰 배경 필수 - 카드가 아니라 스캔 대상이라 대비가 규격이다.
  box: { backgroundColor: '#FFFFFF', borderRadius: 12 },
  row: { flexDirection: 'row' },
});
```

- [ ] **Step 4: 통과 확인**

Run: `cd viva-merged && npx jest src/device/components/__tests__/QrCodeView.test.tsx`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
cd viva-merged && git add src/device/components/QrCodeView.tsx src/device/components/__tests__/QrCodeView.test.tsx
git commit -m "feat: QrCodeView - 순수 View run-length QR 렌더러"
```

---

### Task 3: WifiProvisionScreen — 입력 → QR → 연결 성공 자동 감지

**Files:**
- Create: `viva-merged/src/device/screens/WifiProvisionScreen.tsx`
- Test: `viva-merged/src/device/screens/__tests__/WifiProvisionScreen.test.tsx`

**Interfaces:**
- Consumes: Task 1 `buildWifiQrPayload`/`buildWifiQrMatrix`, Task 2 `QrCodeView`, 기존 `usePiConnection()` (`src/device/hooks/usePiConnection.ts` — `PiConnectionStatus` 반환, connectionMonitor 구독)
- Produces: `<WifiProvisionScreen onClose={() => void} />` — 풀스크린(absolute fill) 컴포넌트. Task 4의 HomeScreen이 조건부 렌더.

- [ ] **Step 1: 실패 테스트 작성**

`src/device/screens/__tests__/WifiProvisionScreen.test.tsx`:

```tsx
import React from 'react';
import { Text, TextInput } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';

// connectionMonitor를 조작 가능한 목으로 - usePiConnection이 이걸 구독한다.
const listeners = new Set<(s: string) => void>();
let mockStatus = 'disconnected';
jest.mock('../../services/connectionMonitor.service', () => ({
  connectionMonitor: {
    get status() {
      return mockStatus;
    },
    onStatusChange: (l: (s: string) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  },
}));

import WifiProvisionScreen from '../WifiProvisionScreen';

function render(el: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(el);
  });
  return tree;
}

const textOf = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text).map((t) => String(t.props.children)).join('\n');

describe('WifiProvisionScreen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockStatus = 'disconnected';
    listeners.clear();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('SSID·비밀번호 입력 후 QR 생성 - QR 화면으로 전환된다', () => {
    const tree = render(<WifiProvisionScreen onClose={jest.fn()} />);
    const [ssid, psk] = tree.root.findAllByType(TextInput);
    act(() => {
      ssid.props.onChangeText('MyHome');
      psk.props.onChangeText('pass1234');
    });
    const makeBtn = tree.root.find((n) => n.props.testID === 'wifi-qr-make');
    act(() => makeBtn.props.onPress());
    expect(tree.root.findAll((n) => n.props.testID === 'qr-row').length).toBeGreaterThan(0);
    expect(textOf(tree)).toContain('비바');
  });

  it('입력이 비어 있으면 생성 버튼이 비활성이다', () => {
    const tree = render(<WifiProvisionScreen onClose={jest.fn()} />);
    const makeBtn = tree.root.find((n) => n.props.testID === 'wifi-qr-make');
    expect(makeBtn.props.accessibilityState?.disabled).toBe(true);
  });

  it('QR 표시 중 connected 엣지가 오면 성공 표시 후 자동으로 onClose', () => {
    const onClose = jest.fn();
    const tree = render(<WifiProvisionScreen onClose={onClose} />);
    const [ssid, psk] = tree.root.findAllByType(TextInput);
    act(() => {
      ssid.props.onChangeText('MyHome');
      psk.props.onChangeText('pass1234');
    });
    act(() => tree.root.find((n) => n.props.testID === 'wifi-qr-make').props.onPress());

    act(() => {
      mockStatus = 'connected';
      listeners.forEach((l) => l('connected'));
    });
    expect(textOf(tree)).toContain('연결됐어');
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('닫기 버튼이 onClose를 부른다', () => {
    const onClose = jest.fn();
    const tree = render(<WifiProvisionScreen onClose={onClose} />);
    act(() => tree.root.find((n) => n.props.testID === 'wifi-provision-close').props.onPress());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd viva-merged && npx jest src/device/screens/__tests__/WifiProvisionScreen.test.tsx`
Expected: FAIL (`Cannot find module '../WifiProvisionScreen'`)

- [ ] **Step 3: 구현**

`src/device/screens/WifiProvisionScreen.tsx`:

```tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import QrCodeView from '../components/QrCodeView';
import { buildWifiQrPayload, buildWifiQrMatrix } from '../../utils/wifiQr';
import { usePiConnection } from '../hooks/usePiConnection';
import {
  APP_BACKGROUND_COLOR,
  GREEN,
  SURFACE_COLOR,
  SURFACE_BORDER_COLOR,
  INK,
  INK_MUTED,
  FONT,
} from '../../theme';

/** WiFi 등록 화면 (프로비저닝 스펙 §4). SSID/비번 → 표준 WiFi QR 풀스크린.
 * 성공 확인은 별도 폴링 없이 connectionMonitor connected 엣지 재사용 -
 * 로봇이 새 WiFi에 붙으면 mDNS로 발견되고 이 화면은 그걸 구독만 한다.
 * 비번은 state에만 있다가 화면을 떠나면 사라진다 - 저장하지 않는다. */
const CLOSE_AFTER_SUCCESS_MS = 1500;

interface Props {
  onClose: () => void;
}

export default function WifiProvisionScreen({ onClose }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [ssid, setSsid] = useState('');
  const [psk, setPsk] = useState('');
  const [showQr, setShowQr] = useState(false);
  const status = usePiConnection();
  const succeeded = showQr && status === 'connected';

  // QR 표시 중 connected 엣지 → 성공 문구 잠깐 → 자동 닫힘
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!succeeded) return;
    closeTimer.current = setTimeout(onClose, CLOSE_AFTER_SUCCESS_MS);
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, [succeeded, onClose]);

  const matrix = useMemo(
    () => (showQr ? buildWifiQrMatrix(buildWifiQrPayload(ssid, psk)) : null),
    [showQr, ssid, psk],
  );

  const makeDisabled = !ssid.trim() || !psk;

  return (
    <View style={[styles.fill, { paddingTop: Math.max(insets.top + 12, 18) }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="닫기"
        testID="wifi-provision-close"
        onPress={onClose}
        style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.6 }]}
      >
        <Text style={styles.closeGlyph}>✕</Text>
      </Pressable>

      {!showQr ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.center}
        >
          <Text style={styles.title}>비바를 새 와이파이에 연결해요</Text>
          <Text style={styles.sub}>연결할 와이파이 이름과 비밀번호를 입력해줘</Text>
          <TextInput
            style={styles.input}
            placeholder="와이파이 이름 (SSID)"
            placeholderTextColor={INK_MUTED}
            autoCapitalize="none"
            autoCorrect={false}
            value={ssid}
            onChangeText={setSsid}
          />
          <TextInput
            style={styles.input}
            placeholder="비밀번호"
            placeholderTextColor={INK_MUTED}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            value={psk}
            onChangeText={setPsk}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: makeDisabled }}
            disabled={makeDisabled}
            testID="wifi-qr-make"
            onPress={() => setShowQr(true)}
            style={({ pressed }) => [
              styles.makeBtn,
              makeDisabled && { opacity: 0.38 },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={styles.makeBtnText}>QR 만들기</Text>
          </Pressable>
        </KeyboardAvoidingView>
      ) : (
        <View style={styles.center}>
          {succeeded ? (
            <>
              <Text style={styles.title}>비바가 연결됐어!</Text>
              <Text style={styles.sub}>이제 비바랑 같이 공부할 수 있어</Text>
            </>
          ) : (
            <>
              <Text style={styles.title}>비바에게 QR을 보여줘</Text>
              <Text style={styles.sub}>
                화면 밝기를 최대로 하고{'\n'}비바 카메라에 15~25cm 거리로 비춰줘
              </Text>
            </>
          )}
          {matrix && <QrCodeView matrix={matrix} size={260} />}
          {!succeeded && (
            <Pressable
              accessibilityRole="button"
              testID="wifi-qr-back"
              onPress={() => setShowQr(false)}
              style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
            >
              <Text style={styles.backBtnText}>입력 고치기</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: APP_BACKGROUND_COLOR,
    zIndex: 60, // topRightRow(40)·SolveModeToggle 위
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    paddingHorizontal: 36,
  },
  closeBtn: {
    position: 'absolute',
    top: 18,
    right: 20,
    zIndex: 1,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeGlyph: { fontSize: 20, color: INK_MUTED, fontFamily: FONT },
  title: {
    fontSize: 24,
    fontWeight: '700',
    fontFamily: FONT,
    color: INK,
    textAlign: 'center',
  },
  sub: {
    fontSize: 15,
    lineHeight: 22,
    fontFamily: FONT,
    color: INK_MUTED,
    textAlign: 'center',
    marginBottom: 6,
  },
  input: {
    alignSelf: 'stretch',
    backgroundColor: SURFACE_COLOR,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    fontFamily: FONT,
    color: INK,
  },
  makeBtn: {
    alignSelf: 'stretch',
    backgroundColor: GREEN,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 6,
  },
  makeBtnText: { fontSize: 16, fontWeight: '700', fontFamily: FONT, color: '#FFFFFF' },
  backBtn: { paddingVertical: 10, paddingHorizontal: 16 },
  backBtnText: { fontSize: 14, fontFamily: FONT, color: INK_MUTED },
});
```

주의: theme에 위 이름들이 실제 있는지 확인 (`src/theme.ts`) — GREEN/INK/INK_MUTED/FONT/SURFACE_COLOR/SURFACE_BORDER_COLOR/APP_BACKGROUND_COLOR는 ConnectionGuideCard·HomeScreen이 이미 쓰는 이름. 없는 게 있으면 그 파일들이 쓰는 실제 이름으로 맞춘다.

- [ ] **Step 4: 통과 확인**

Run: `cd viva-merged && npx jest src/device/screens/__tests__/WifiProvisionScreen.test.tsx`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
cd viva-merged && git add src/device/screens/WifiProvisionScreen.tsx src/device/screens/__tests__/WifiProvisionScreen.test.tsx
git commit -m "feat: WifiProvisionScreen - SSID/비번 입력 → WiFi QR 풀스크린, connected 엣지 자동 성공"
```

---

### Task 4: 디바이스 설정 가이드 연결 (ConnectionGuideCard + HomeScreen)

**Files:**
- Modify: `viva-merged/src/device/components/ConnectionGuideCard.tsx` (**커밋 금지 — dirty**)
- Modify: `viva-merged/src/device/screens/HomeScreen.tsx` (**커밋 금지 — dirty**)
- Test: `viva-merged/src/device/components/__tests__/ConnectionGuideCard.test.tsx` (신규 — 커밋 가능)

**Interfaces:**
- Consumes: Task 3 `WifiProvisionScreen`
- Produces: `ConnectionGuideCard`에 optional prop `onRegisterWifi?: () => void` — 주면 4번째 안내 행 + "WiFi 등록하기" 버튼 노출

- [ ] **Step 1: 실패 테스트 작성**

`src/device/components/__tests__/ConnectionGuideCard.test.tsx`:

```tsx
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import ConnectionGuideCard from '../ConnectionGuideCard';

function render(el: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(el);
  });
  return tree;
}

describe('ConnectionGuideCard', () => {
  it('onRegisterWifi가 없으면 WiFi 등록 버튼이 없다', () => {
    const tree = render(<ConnectionGuideCard />);
    expect(tree.root.findAll((n) => n.props.testID === 'wifi-register-button')).toHaveLength(0);
  });

  it('onRegisterWifi를 주면 버튼이 보이고 탭 시 호출된다', () => {
    const onRegisterWifi = jest.fn();
    const tree = render(<ConnectionGuideCard onRegisterWifi={onRegisterWifi} />);
    const btn = tree.root.find((n) => n.props.testID === 'wifi-register-button');
    act(() => btn.props.onPress());
    expect(onRegisterWifi).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd viva-merged && npx jest src/device/components/__tests__/ConnectionGuideCard.test.tsx`
Expected: FAIL (`wifi-register-button` 없음)

- [ ] **Step 3: ConnectionGuideCard 수정**

기존 구조 유지(GUIDE_ITEMS + 스태거). 변경 3곳:

(a) 컴포넌트 시그니처와 4번째 행 — `export default function ConnectionGuideCard(): ...`를 다음으로:

```tsx
interface Props {
  /** 주면 QR 등록 안내 행 + "WiFi 등록하기" 버튼이 붙는다 (프로비저닝 스펙 §4). */
  onRegisterWifi?: () => void;
}

export default function ConnectionGuideCard({ onRegisterWifi }: Props = {}): React.JSX.Element {
```

(b) GUIDE_ITEMS에 4번째 항목 추가 + QrIcon (기존 CSS 아이콘 관례 — 모서리 브래킷 4개):

```tsx
const GUIDE_ITEMS = [
  { key: 'power', text: '비바 전원이 켜져 있는지 확인해줘', Icon: PowerIcon },
  { key: 'wifi', text: '휴대폰과 비바가 같은 와이파이에 있어야 해', Icon: WifiIcon },
  { key: 'replug', text: '그래도 안 되면 비바 전원을 뽑았다 다시 꽂아줘', Icon: ReplugIcon },
  { key: 'qr', text: '비바 화면에 QR 안내가 보이면 와이파이를 등록해줘', Icon: QrIcon },
];

/** QR 스캔 - 네 모서리 브래킷 + 중앙 점. */
function QrIcon() {
  return (
    <View style={iconStyles.box}>
      {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
        <View key={c} style={[iconStyles.qrCorner, iconStyles[`qrCorner_${c}`]]} />
      ))}
      <View style={iconStyles.qrDot} />
    </View>
  );
}
```

iconStyles 추가:

```tsx
  qrCorner: {
    position: 'absolute',
    width: 7,
    height: 7,
    borderColor: GREEN,
  },
  qrCorner_tl: { top: 1, left: 1, borderTopWidth: 2, borderLeftWidth: 2 },
  qrCorner_tr: { top: 1, right: 1, borderTopWidth: 2, borderRightWidth: 2 },
  qrCorner_bl: { bottom: 1, left: 1, borderBottomWidth: 2, borderLeftWidth: 2 },
  qrCorner_br: { bottom: 1, right: 1, borderBottomWidth: 2, borderRightWidth: 2 },
  qrDot: { width: 6, height: 6, borderRadius: 1.5, backgroundColor: GREEN },
```

(c) 카드 JSX 마지막(map 아래)에 버튼 — `onRegisterWifi`가 없으면 4번째 행도 숨긴다 (row map 전에 `const items = onRegisterWifi ? GUIDE_ITEMS : GUIDE_ITEMS.filter((it) => it.key !== 'qr');` 로 필터하고 map은 `items` 사용, `enters`도 `GUIDE_ITEMS.map(...)` 그대로 두고 인덱스만 맞으면 됨 — items[i]와 enters[i] 짝이 어긋나지 않게 `enters` 길이는 GUIDE_ITEMS 기준 유지):

```tsx
      {onRegisterWifi && (
        <Pressable
          accessibilityRole="button"
          testID="wifi-register-button"
          onPress={onRegisterWifi}
          style={({ pressed }) => [styles.registerBtn, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.registerBtnText}>WiFi 등록하기</Text>
        </Pressable>
      )}
```

styles 추가 (+ `Pressable` import):

```tsx
  registerBtn: {
    marginTop: 4,
    alignSelf: 'stretch',
    backgroundColor: GREEN,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  registerBtnText: { fontSize: 15, fontWeight: '700', fontFamily: FONT, color: '#FFFFFF' },
```

- [ ] **Step 4: HomeScreen 오버레이 연결**

`src/device/screens/HomeScreen.tsx` — App.device.tsx는 건드리지 않는다(idle 상태에서만 홈이 뜨므로 홈 내부 오버레이로 충분).

(a) import 추가:

```tsx
import WifiProvisionScreen from './WifiProvisionScreen';
```

(b) 컴포넌트 안 state 추가 (`const [connectedSince, ...]` 근처):

```tsx
  const [showWifiProvision, setShowWifiProvision] = useState(false);
```

(c) `<ConnectionGuideCard />` → `<ConnectionGuideCard onRegisterWifi={() => setShowWifiProvision(true)} />`

(d) 컨테이너 마지막 자식(bottomControls 아래)에:

```tsx
      {showWifiProvision && (
        <WifiProvisionScreen onClose={() => setShowWifiProvision(false)} />
      )}
```

- [ ] **Step 5: 테스트 + 타입 확인**

Run: `cd viva-merged && npx jest src/device && npx tsc --noEmit 2>&1 | grep -v "useAppState.test\|CameraScreen\|tts.service" | head`
Expected: device 테스트 전부 PASS, tsc는 기존 4건(무시 목록) 외 신규 에러 0

- [ ] **Step 6: 신규 테스트 파일만 커밋**

```bash
cd viva-merged && git add src/device/components/__tests__/ConnectionGuideCard.test.tsx
git commit -m "test: ConnectionGuideCard WiFi 등록 버튼 노출/탭 검증"
```

ConnectionGuideCard.tsx·HomeScreen.tsx는 dirty — **커밋하지 않는다**.

---

### Task 5: eyes.py — provision_new / provision_fail 화면

**Files:**
- Modify: `viva-merged/pi-server/eyes.py` (**커밋 금지 — 타 세션 미커밋 작업 혼재. 수정은 최소 diff로**)

**Interfaces:**
- Consumes: 없음 (독립)
- Produces: WS로 `{"eyeState": "provision_new" | "provision_fail"}` 수신 시 해당 화면 렌더. Task 6·7의 provision.py가 이 두 문자열을 보낸다. 재연결 버튼 중심 y = `PV_BTN_CY = 395` (터치 존 계산에 Task 7이 사용).

- [ ] **Step 1: 상수 + 베이크 함수 추가** (DC_* 상수 블록 아래, `VALID_STATES` 위)

```python
# --- 프로비저닝 화면 상수 (2026-08-11 wifi-provisioning 스펙 §1·§3) --------
# P1(provision_new): 저장된 WiFi 없음 - 즉시 QR 안내.
# P2(provision_fail): 저장된 WiFi 연결 실패 - 안내 + 재연결 터치 버튼.
# provision.py 가 로컬 WS 클라이언트로 이 상태를 밀어넣는다.
PV_NEW_TEXT = ("VIVA 앱에 표시된", "QR 코드를 보여주세요")
PV_FAIL_TEXT = ("WiFi 연결에 실패했어요", "VIVA 앱의 디바이스 설정", "가이드에 따라 QR 코드를 스캔해주세요")
PV_TEXT_SIZE, PV_TEXT_LINE_H = 24, 34
PV_ICON_CY = 150          # QR 스캔 아이콘 중심 y
PV_ICON_SIZE = 110        # 아이콘 한 변
PV_NEW_TEXT_Y = 300       # P1 문구 시작 y (2줄, 큰 아이콘)
PV_FAIL_TEXT_Y = 240      # P2 문구 시작 y (3줄 + 버튼이 아래 필요)
PV_BTN_CY, PV_BTN_W, PV_BTN_H = 395, 190, 54   # 재연결 버튼 (터치 존 기준값)
PV_STATUS_TEXT = "재연결 시도 중…"
PV_STATUS_SIZE, PV_STATUS_Y = 16, 448          # 원 하단 - 짧아서 chord 안에 든다


def bake_scan_icon() -> pygame.Surface:
    """QR 스캔 아이콘 - 네 모서리 브래킷 + 중앙 QR 축약(파인더 3개).
    disconnect 아이콘과 같은 4배 수퍼샘플 베이크."""
    s = PV_ICON_SIZE * SS
    surf = pygame.Surface((s, s))
    surf.fill(BG)
    b, t = int(s * 0.24), 6 * SS  # 브래킷 길이·두께
    for x0, y0, dx, dy in ((0, 0, 1, 1), (s, 0, -1, 1), (0, s, 1, -1), (s, s, -1, -1)):
        pygame.draw.line(surf, FG, (x0, y0 + dy * (t // 2)), (x0 + dx * b, y0 + dy * (t // 2)), t)
        pygame.draw.line(surf, FG, (x0 + dx * (t // 2), y0), (x0 + dx * (t // 2), y0 + dy * b), t)
    # 중앙 QR 축약: 파인더 3개 + 점 하나
    q = int(s * 0.42)
    qx, qy = (s - q) // 2, (s - q) // 2
    f = int(q * 0.38)
    for fx, fy in ((qx, qy), (qx + q - f, qy), (qx, qy + q - f)):
        pygame.draw.rect(surf, FG, (fx, fy, f, f), width=3 * SS)
        pygame.draw.rect(surf, FG, (fx + f // 3, fy + f // 3, f // 3, f // 3))
    pygame.draw.rect(surf, FG, (qx + q - f // 2, qy + q - f // 2, f // 3, f // 3))
    return pygame.transform.smoothscale(surf, (s // SS, s // SS))


def bake_retry_glyph() -> pygame.Surface:
    """원형 화살표(재시도 관례) - 오른쪽 위가 트인 링 + 화살촉."""
    d = 28 * SS
    surf = pygame.Surface((d, d))
    surf.fill(BG)
    r = d // 2 - 3 * SS
    pygame.draw.arc(surf, FG, (d // 2 - r, d // 2 - r, r * 2, r * 2),
                    math.radians(30), math.radians(300), 4 * SS)
    # 화살촉: 아크 끝(30°) 근처 삼각형
    ax = d // 2 + int(r * math.cos(math.radians(30)))
    ay = d // 2 - int(r * math.sin(math.radians(30)))
    a = 7 * SS
    pygame.draw.polygon(surf, FG, ((ax - a, ay - a), (ax + a, ay), (ax - a // 2, ay + a)))
    return pygame.transform.smoothscale(surf, (d // SS, d // SS))
```

- [ ] **Step 2: 상태 수용** — `VALID_STATES` 정의 바로 아래에:

```python
# provision.py(로컬 WS 클라이언트)만 보내는 상태 - 폰 앱은 모른다.
PROVISION_STATES = {"provision_new", "provision_fail"}
```

`_handler`의 `if eye in VALID_STATES` → `if eye in (VALID_STATES | PROVISION_STATES)`.

`KEY_STATES`에 창 모드 확인 키 추가: `pygame.K_7: "provision_new", pygame.K_8: "provision_fail",`

- [ ] **Step 3: Renderer 확장**

`__init__` (dc_lines 아래):

```python
        # 프로비저닝 화면 - 역시 시작 시 한 번만 굽는다.
        self.pv_icon = bake_scan_icon()
        self.pv_retry = bake_retry_glyph()
        pv_font = _load_kr_font(PV_TEXT_SIZE)
        self.pv_new_lines = [pv_font.render(t, True, FG) for t in PV_NEW_TEXT] if pv_font else []
        self.pv_fail_lines = [pv_font.render(t, True, FG) for t in PV_FAIL_TEXT] if pv_font else []
        st_font = _load_kr_font(PV_STATUS_SIZE)
        self.pv_status = st_font.render(PV_STATUS_TEXT, True, FG) if st_font else None
        self.pv_btn_label = _load_kr_font(20).render("재연결", True, FG) if pv_font else None
```

`draw()`의 `if state == "disconnected":` 분기 **위**에:

```python
        if state in ("provision_new", "provision_fail"):
            self.mark = None
            self.nodding = False
            # 스캔 아이콘은 disconnect 아이콘과 같은 호흡 펄스
            self.pv_icon.set_alpha(int(255 * (0.72 + 0.28 * ease(tri(now / 4.0)))))
            surface.blit(self.pv_icon, self.pv_icon.get_rect(center=(cx, PV_ICON_CY)))
            lines = self.pv_new_lines if state == "provision_new" else self.pv_fail_lines
            text_y = PV_NEW_TEXT_Y if state == "provision_new" else PV_FAIL_TEXT_Y
            for i, line in enumerate(lines):
                surface.blit(line, line.get_rect(center=(cx, text_y + i * PV_TEXT_LINE_H)))
            if state == "provision_fail":
                # 재연결 버튼 - 테두리 알약 + 원형 화살표 + 라벨. 터치 존은
                # provision.py 가 PV_BTN_* 로 계산한다 (import 해서 단일 출처).
                rect = pygame.Rect(0, 0, PV_BTN_W, PV_BTN_H)
                rect.center = (int(cx), PV_BTN_CY)
                pygame.draw.rect(surface, FG, rect, width=2, border_radius=PV_BTN_H // 2)
                gx = rect.left + 18
                surface.blit(self.pv_retry, self.pv_retry.get_rect(
                    midleft=(gx, rect.centery)))
                if self.pv_btn_label:
                    surface.blit(self.pv_btn_label, self.pv_btn_label.get_rect(
                        midleft=(gx + self.pv_retry.get_width() + 10, rect.centery)))
                if self.pv_status:
                    self.pv_status.set_alpha(150)
                    surface.blit(self.pv_status, self.pv_status.get_rect(center=(cx, PV_STATUS_Y)))
            return
```

- [ ] **Step 4: selftest 확장**

(a) 비공백 검증 — disconnected 검증 블록 아래에:

```python
    for pv in ("provision_new", "provision_fail"):
        renderer.draw(surface, pv, 0.0)
        surface.set_colorkey(BG)
        assert surface.get_bounding_rect().width > 0, f"{pv} 화면이 비어 있다"
        surface.set_colorkey(None)
```

(b) 패널 원 이탈 검사 상태 집합 확장 — `VALID_STATES | {"disconnected"}` → `VALID_STATES | {"disconnected"} | PROVISION_STATES`.

(c) `_handler` 상태 수용 검증이 있으면 provision 상태도 한 줄 추가 (`_FakeWS([json.dumps({"eyeState": "provision_fail"})])` 흘려 `_state["eye"] == "provision_fail"` 확인).

- [ ] **Step 5: 셀프테스트 실행**

Run: `cd viva-merged/pi-server && python3 eyes.py --selftest`
Expected: 기존 통과 + 신규 assert 통과. **PV_FAIL_TEXT 3줄이 원형 패널 chord를 벗어나면 여기 원 이탈 검사가 잡는다** — 잡히면 PV_TEXT_SIZE를 22로 내리거나 줄바꿈 재배치.

- [ ] **Step 6: 렌더 캡처** (리뷰용, 커밋 안 함)

```bash
cd viva-merged/pi-server && python3 - <<'EOF'
import os
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
import pygame
pygame.init()
import eyes
r = eyes.Renderer()
for st in ("provision_new", "provision_fail"):
    s = pygame.Surface((eyes.SIZE, eyes.SIZE))
    r.draw(s, st, 0.0)
    pygame.image.save(s, f"/tmp/{st}.png")
    print("saved", st)
EOF
```

Expected: `/tmp/provision_new.png`, `/tmp/provision_fail.png` 생성 — 두 파일을 워크스페이스 루트에 `provision-new-preview.png`/`provision-fail-preview.png`로 복사해 사용자 확인용으로 남긴다.

- [ ] **Step 7: 커밋하지 않는다** — eyes.py는 dirty(타 세션 혼재). 작업 로그에만 기록.

---

### Task 6: provision.py 로직 코어 (파서 + 화면 판정) — 하드웨어 무관

**Files:**
- Create: `viva-merged/pi-server/provision.py` (이 태스크에서는 로직 + selftest만, 하드웨어 루프는 Task 7)

**Interfaces:**
- Produces: `parse_wifi_qr(data: str) -> tuple[str, str] | None` (ssid, psk), `decide_screen(saved_count: int, connected: bool, now: float, boot_t: float, last_ok_t: float | None) -> str | None` (`None`=화면 불필요 | `"provision_new"` | `"provision_fail"`), 상수 `BOOT_GRACE_S = 30.0`, `RUNTIME_LOSS_S = 180.0`

- [ ] **Step 1: 파일 생성 (로직 + selftest)**

`pi-server/provision.py`:

```python
#!/usr/bin/env python3
"""WiFi 프로비저닝 (D-XX, 2026-08-11 wifi-provisioning 스펙 §3).

WiFi 미연결이면 eyes.py 에 화면 상태를 밀고(provision_new/provision_fail),
카메라로 표준 WiFi QR 을 스캔해 nmcli 로 등록한다. P2 화면에선 터치
재연결 버튼도 받는다. 하드웨어(카메라·터치·nmcli·WS)는 지연 import -
개발 머신에서 --selftest 는 로직만 검증한다.
"""
import sys
import time

BOOT_GRACE_S = 30.0     # 부팅 후 저장 네트워크 연결 유예
RUNTIME_LOSS_S = 180.0  # 운영 중 끊김이 이보다 길면 P2 (공유기 재부팅 오탐 방지)
POLL_S = 5.0            # nmcli 상태 폴링 주기


def parse_wifi_qr(data: str):
    """표준 WiFi QR(WIFI:T:WPA;S:..;P:..;;) 파싱. (ssid, psk) 또는 None.

    이스케이프(\\; \\, \\: \\" \\\\)를 풀면서 세미콜론 분리 - 단순 split 은
    'a\\;b' 같은 SSID 를 자른다.
    """
    if not data.startswith("WIFI:"):
        return None
    body = data[5:]
    fields = {}
    key, buf, i = None, [], 0
    while i < len(body):
        ch = body[i]
        if ch == "\\" and i + 1 < len(body):
            buf.append(body[i + 1])
            i += 2
            continue
        if ch == ":" and key is None:
            key = "".join(buf)
            buf = []
        elif ch == ";":
            if key is not None:
                fields[key] = "".join(buf)
            key, buf = None, []
        else:
            buf.append(ch)
        i += 1
    ssid, psk = fields.get("S"), fields.get("P")
    if not ssid or psk is None:
        return None
    return ssid, psk


def decide_screen(saved_count, connected, now, boot_t, last_ok_t):
    """어떤 프로비저닝 화면이 필요한가. None = 정상(화면 개입 없음).

    P1: 저장 네트워크가 하나도 없다 - 시도할 게 없으니 유예 없이 즉시.
    P2: 저장 네트워크가 있는데 실패 - 부팅 후 BOOT_GRACE_S, 또는 마지막
        연결 성공 후 RUNTIME_LOSS_S 를 넘겼을 때만 (짧은 끊김 오탐 방지).
    """
    if connected:
        return None
    if saved_count == 0:
        return "provision_new"
    if last_ok_t is None:
        return "provision_fail" if now - boot_t >= BOOT_GRACE_S else None
    return "provision_fail" if now - last_ok_t >= RUNTIME_LOSS_S else None


def selftest():
    # 파서
    assert parse_wifi_qr("WIFI:T:WPA;S:MyHome;P:pass1234;;") == ("MyHome", "pass1234")
    assert parse_wifi_qr('WIFI:T:WPA;S:a\\;b;P:p\\:w\\,\\"x\\\\y;;') == ("a;b", 'p:w,"x\\y')
    assert parse_wifi_qr("WIFI:T:nopass;S:Open;P:;;") is None      # 빈 비번은 거부
    assert parse_wifi_qr("http://example.com") is None             # 무관 QR
    assert parse_wifi_qr("WIFI:T:WPA;P:pw;;") is None              # SSID 없음

    # 화면 판정
    assert decide_screen(0, False, 1.0, 0.0, None) == "provision_new"          # 첫 부팅 즉시
    assert decide_screen(2, False, 10.0, 0.0, None) is None                    # 부팅 유예 중
    assert decide_screen(2, False, 31.0, 0.0, None) == "provision_fail"        # 부팅 실패
    assert decide_screen(2, True, 999.0, 0.0, None) is None                    # 연결됨
    assert decide_screen(2, False, 100.0, 0.0, 50.0) is None                   # 짧은 끊김
    assert decide_screen(2, False, 300.0, 0.0, 100.0) == "provision_fail"      # 장기 끊김
    print("provision selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    from provision_runtime_guard import main  # noqa: F401 - Task 7 에서 main 루프로 교체
```

마지막 2줄(`from provision_runtime_guard ...`)은 Task 7에서 실제 `main()`으로 교체된다 — Task 6 시점엔 selftest만 돌면 된다. import 에러 방지를 위해 Task 6에서는 그냥 `print("main loop: Task 7 에서 구현")` 한 줄로 둬도 된다.

- [ ] **Step 2: 셀프테스트 실행**

Run: `cd viva-merged/pi-server && python3 provision.py --selftest`
Expected: `provision selftest ok`

- [ ] **Step 3: 커밋 (신규 파일)**

```bash
cd viva-merged && git add pi-server/provision.py
git commit -m "feat: provision.py 로직 코어 - WiFi QR 파서 + 화면 판정 상태 머신"
```

---

### Task 7: provision.py 하드웨어 루프 + systemd + README

**Files:**
- Modify: `viva-merged/pi-server/provision.py` (Task 6에서 만든 파일 — 커밋 가능, 이 세션 소유)
- Create: `viva-merged/pi-server/viva-provision.service`
- Modify: `viva-merged/pi-server/README.md` (**커밋 금지 — dirty**)

**Interfaces:**
- Consumes: Task 5의 eyes.py 상수 (`PV_BTN_CY`, `PV_BTN_H`, `SIZE` — `import eyes`는 pygame 초기화를 끌고 오므로 **하지 말고** 값 복제 + 주석으로 출처 명시), Task 6의 `parse_wifi_qr`/`decide_screen`
- Produces: `main()` — systemd가 실행하는 무한 루프

- [ ] **Step 1: 하드웨어 헬퍼 + 메인 루프 추가**

provision.py 에 추가 (selftest 위):

```python
# --- 하드웨어 계층 (Pi 전용 - 전부 지연 import) ------------------------------
EYES_WS_URL = "ws://localhost:8787"
SCAN_INTERVAL_S = 0.4        # ~2.5fps - Zero W 에서 pyzbar 여유
# 터치 존: 화면 아래쪽 전체를 버튼으로 친다. eyes.py PV_BTN_CY(395)-PV_BTN_H
# (54) 기준 - 버튼 상단(368)보다 살짝 위부터. 값 복제: eyes 를 import 하면
# pygame 초기화가 딸려온다. eyes.py 쪽 상수를 바꾸면 여기도 맞출 것.
TOUCH_ZONE_Y_MIN = 350
PANEL_SIZE = 480


def _run(cmd):
    import subprocess
    return subprocess.run(cmd, capture_output=True, text=True, timeout=30)


def saved_wifi_count() -> int:
    out = _run(["nmcli", "-t", "-f", "TYPE", "connection", "show"])
    return out.stdout.count("802-11-wireless")


def wifi_connected() -> bool:
    out = _run(["nmcli", "-t", "-f", "TYPE,STATE", "device", "status"])
    return any(line.startswith("wifi:connected") for line in out.stdout.splitlines())


def try_connect(ssid: str, psk: str) -> bool:
    return _run(["nmcli", "device", "wifi", "connect", ssid, "password", psk]).returncode == 0


def retry_saved() -> None:
    """저장 네트워크 재시도 - NM 자동연결을 찌른다. 실패해도 루프가 계속 본다."""
    _run(["nmcli", "device", "wifi", "rescan"])


class EyesPusher:
    """eyes.py 로 화면 상태를 미는 WS 클라이언트 (백그라운드 스레드).

    원하는 상태를 set() 으로 갱신하면 연결이 살아있는 한 밀어넣고, 끊기면
    3초 간격 재접속. None 이면 접속 자체를 끊는다 - eyes.py 는 클라이언트가
    사라지면 기존 규칙(disconnect 유예)으로 수렴한다.
    """

    def __init__(self):
        import threading
        self._want = None
        self._lock = threading.Lock()
        threading.Thread(target=self._thread, daemon=True).start()

    def set(self, state):
        with self._lock:
            self._want = state

    def _thread(self):
        import asyncio
        import json

        async def loop():
            import websockets
            while True:
                with self._lock:
                    want = self._want
                if want is None:
                    await asyncio.sleep(1.0)
                    continue
                try:
                    async with websockets.connect(EYES_WS_URL) as ws:
                        sent = None
                        while True:
                            with self._lock:
                                want = self._want
                            if want is None:
                                break  # 접속 종료 - eyes 가 스스로 복귀
                            if want != sent:
                                await ws.send(json.dumps({"eyeState": want}))
                                sent = want
                            await asyncio.sleep(0.5)
                except Exception:
                    await asyncio.sleep(3.0)

        asyncio.run(loop())


class TouchReader:
    """USB 터치 이벤트 - P2 화면 하단 탭이면 True. 장치 없으면 조용히 무시."""

    def __init__(self):
        self.dev = None
        try:
            import evdev
            for path in evdev.list_devices():
                d = evdev.InputDevice(path)
                caps = d.capabilities()
                if evdev.ecodes.EV_ABS in caps:
                    self.dev = d
                    self.max_y = dict(caps[evdev.ecodes.EV_ABS]).get(
                        evdev.ecodes.ABS_Y)
                    break
        except Exception:
            pass

    def tapped_retry_zone(self) -> bool:
        if not self.dev:
            return False
        import evdev
        tapped, y = False, None
        try:
            while True:
                ev = self.dev.read_one()
                if ev is None:
                    break
                if ev.type == evdev.ecodes.EV_ABS and ev.code == evdev.ecodes.ABS_Y:
                    y = ev.value
                if ev.type == evdev.ecodes.EV_KEY and \
                        ev.code == evdev.ecodes.BTN_TOUCH and ev.value == 1:
                    tapped = True
        except Exception:
            return False
        if not (tapped and y is not None and self.max_y):
            return False
        return y * PANEL_SIZE / self.max_y.max >= TOUCH_ZONE_Y_MIN


def scan_qr_once(cam):
    """카메라 한 프레임에서 WiFi QR 을 찾는다. (ssid, psk) 또는 None."""
    from pyzbar import pyzbar
    frame = cam.capture_array()
    for code in pyzbar.decode(frame):
        parsed = parse_wifi_qr(code.data.decode("utf-8", "replace"))
        if parsed:
            return parsed
    return None


def main():
    pusher = EyesPusher()
    touch = TouchReader()
    cam = None
    boot_t = time.monotonic()
    last_ok_t = None
    last_poll = 0.0
    saved = 0
    connected = False

    while True:
        now = time.monotonic()
        if now - last_poll >= POLL_S:
            last_poll = now
            saved = saved_wifi_count()
            connected = wifi_connected()
            if connected:
                last_ok_t = now
        screen = decide_screen(saved, connected, now, boot_t, last_ok_t)
        pusher.set(screen)

        if screen is None:
            if cam:
                cam.stop()
                cam = None
            time.sleep(1.0)
            continue

        if cam is None:
            from picamera2 import Picamera2
            cam = Picamera2()
            cam.configure(cam.create_still_configuration(
                main={"size": (640, 480), "format": "RGB888"}))
            cam.start()
            print("[viva-provision] scan mode:", screen)

        if screen == "provision_fail" and touch.tapped_retry_zone():
            print("[viva-provision] retry tapped")
            retry_saved()

        found = scan_qr_once(cam)
        if found:
            ssid, psk = found
            print(f"[viva-provision] QR ok: {ssid}")
            if try_connect(ssid, psk):
                print("[viva-provision] connected")
                # 다음 폴에서 connected 반영 - 카메라는 위 screen None 분기가 끈다
            else:
                print("[viva-provision] connect failed (비번 오류?)")
        time.sleep(SCAN_INTERVAL_S)
```

`if __name__ == "__main__":` 블록의 Task 6 자리표시 줄을 다음으로 교체:

```python
if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    main()
```

- [ ] **Step 2: selftest 재실행 (회귀 확인)**

Run: `cd viva-merged/pi-server && python3 provision.py --selftest`
Expected: `provision selftest ok` (하드웨어 import는 지연이라 맥에서도 통과)

- [ ] **Step 3: systemd 유닛 생성**

`pi-server/viva-provision.service` (viva-eyes.service 를 읽고 User/경로 관례를 맞출 것 — 아래는 기본형):

```ini
[Unit]
Description=VIVA WiFi provisioning (QR scan)
After=NetworkManager.service

[Service]
ExecStart=/usr/bin/python3 /home/viva/pi-server/provision.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

주의: nmcli 제어·/dev/input 접근 때문에 root 실행이 기본. viva-eyes.service 가 `User=` 를 지정하면 동일하게 맞추되 nmcli 권한(polkit)을 README 에 명기.

- [ ] **Step 4: README 설치 절 추가**

`pi-server/README.md` 눈 렌더러 절 아래에 새 절:

```markdown
## WiFi 프로비저닝 (provision.py)

WiFi 미연결이면 눈 화면에 QR 안내를 띄우고 카메라로 VIVA 앱의 WiFi QR
(표준 WIFI: 포맷)을 읽어 nmcli 로 등록한다. 저장 네트워크가 없으면 즉시,
있는데 실패하면 부팅 30초/운영 180초 유예 후 안내가 뜬다. 실패 화면의
"재연결" 터치 버튼은 저장 네트워크 재시도를 즉시 찌른다.

```bash
sudo apt install -y python3-pyzbar python3-evdev
cp provision.py /home/viva/pi-server/
sudo cp viva-provision.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now viva-provision
```

전제: NetworkManager(bookworm 기본). `nmcli --version` 이 없으면 bullseye -
provision.py 의 nmcli 헬퍼 4개를 wpa_cli 로 바꿔야 한다. 스캔 중 카메라
가동으로 화면이 깜빡이는 것은 정상(SDRAM 경합 - 위 눈 렌더러 절 참고).
```

- [ ] **Step 5: 커밋 (provision.py + service만 — README 는 dirty라 제외)**

```bash
cd viva-merged && git add pi-server/provision.py pi-server/viva-provision.service
git commit -m "feat: provision.py 하드웨어 루프 - 카메라 QR 스캔, nmcli 등록, 터치 재연결, eyes WS 푸시"
```

---

### Task 8: 문서 갱신 (process.md)

**Files:**
- Modify: `viva-merged/docs/process.md` (맨 위 "문서 갱신 규칙" 절을 먼저 읽고 따를 것)

- [ ] **Step 1: §4 8주차에 08-11 항목 append** — 서술형(문제/해결/결과) 포맷으로 WiFi 프로비저닝 구현 기록. 커밋 여부(신규 파일 커밋 / dirty 파일 보류) 명시.

- [ ] **Step 2: §1 현재 상태 갱신** — 프로비저닝 동작 설명(P1/P2/D 화면, provision.py, 앱 WiFi 등록 플로우) 추가. §2 실기기 검증 항목 추가: QR 인식 거리 캘리브레이션, nmcli 등록 실측, 터치 존 실측, 부팅 30초/운영 180초 임계값 체감.

- [ ] **Step 3: process.md 커밋 여부 판단** — process.md 가 이미 dirty 면 보류(기록만), clean 이면 단독 커밋:

```bash
cd viva-merged && git status --short docs/process.md
# clean 이었다면:
git add docs/process.md && git commit -m "docs: WiFi 프로비저닝 구현 기록 (§1 현재 상태 + §4 8주차)"
```

# WiFi 프로비저닝 UX 2차 구현 계획 (좌우 분할 QR + 플랫폼 지름길)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** WifiProvisionScreen 을 좌(폼)·우(대형 QR) 단일 화면으로 재구성하고, 비번 토글·플랫폼별 안내·입력 저장으로 첫 설정 마찰을 최소화한다.

**Architecture:** 화면 상태를 2단계(폼→QR)에서 단일 화면 + 우측 3상태(플레이스홀더/QR/성공)로 바꾼다. QR 은 useMemo 로 입력에 라이브 반응. 저장은 AsyncStorage 래퍼 유틸(wifiCredsStore) 하나.

**Tech Stack:** React Native(Expo 57), react-test-renderer + jest, @react-native-async-storage/async-storage 1.23.1(설치됨 — 새 의존성 0).

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-08-11-wifi-provisioning-ux2-design.md`
- 색·폰트는 `src/theme.ts` 토큰만 사용. 새 색 금지 (GREEN 틴트 `rgba(54, 155, 117, 0.10)` 은 기존 관례라 허용).
- 사용자 노출 문구: 앱은 "VIVA 앱", 로봇은 "비바". 반말 톤 유지 (기존 화면과 동일).
- 터치 타깃 minHeight 44pt 이상.
- iOS 딥링크(`App-Prefs:*`) 금지. Android 는 `Linking.sendIntent('android.settings.WIFI_SETTINGS')` 허용 (공식 인텐트).
- **커밋 정책 (세션 규칙): `git add -A` 절대 금지, 명시 경로만. 신규 파일만 커밋한다. 기존 파일 수정(WifiProvisionScreen.tsx, 그 테스트, docs/process.md)은 미커밋으로 남긴다** — 병렬 세션 커밋 보류 정책. 검증은 테스트 통과로 한다.
- 테스트 컨벤션: react-test-renderer, `jest.mock` 팩토리 안 변수는 `mock` 접두사 필수.
- 기존 실패 베이스라인(무시): captureDecision 2건 + useTutoringFSM.problemChoice 3건. tsc 기존 에러 3파일(useAppState.test.ts, CameraScreen.tsx, tts.service.ts).
- 테스트 실행: 리포 루트가 아니라 `viva-merged/` 에서 `npx jest <경로>`.

---

### Task 1: wifiCredsStore 유틸 (저장·복원)

**Files:**
- Create: `src/utils/wifiCredsStore.ts`
- Test: `src/utils/__tests__/wifiCredsStore.test.ts`

**Interfaces:**
- Produces: `interface WifiCreds { ssid: string; psk: string }`, `loadWifiCreds(): Promise<WifiCreds | null>`, `saveWifiCreds(creds: WifiCreds): Promise<void>` — Task 3 이 import.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/utils/__tests__/wifiCredsStore.test.ts`:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadWifiCreds, saveWifiCreds } from '../wifiCredsStore';

// 공식 in-memory 목 - 네이티브 모듈 없이 get/set 동작.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('wifiCredsStore', () => {
  beforeEach(() => AsyncStorage.clear());

  it('저장한 SSID/비번을 그대로 돌려준다', async () => {
    await saveWifiCreds({ ssid: 'MyHome', psk: 'pass1234' });
    expect(await loadWifiCreds()).toEqual({ ssid: 'MyHome', psk: 'pass1234' });
  });

  it('저장한 적 없으면 null', async () => {
    expect(await loadWifiCreds()).toBeNull();
  });

  it('깨진 JSON 이 저장돼 있으면 null (throw 안 한다)', async () => {
    await AsyncStorage.setItem('viva.wifiCreds', '{broken');
    expect(await loadWifiCreds()).toBeNull();
  });

  it('형태가 다른 값이 저장돼 있으면 null', async () => {
    await AsyncStorage.setItem('viva.wifiCreds', JSON.stringify({ ssid: 1 }));
    expect(await loadWifiCreds()).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/utils/__tests__/wifiCredsStore.test.ts`
Expected: FAIL — "Cannot find module '../wifiCredsStore'"

- [ ] **Step 3: 구현**

`src/utils/wifiCredsStore.ts`:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';

/** 마지막으로 QR 을 만든 SSID/비번 (UX 2차 스펙 §입력 저장·복원).
 * 재설정·재시도 때 재입력을 없애는 용도.
 * ponytail: 평문 AsyncStorage - 집 와이파이 비번, 기기 로컬, MVP.
 * 민감도가 올라가면 expo-secure-store 로 승격. */
const KEY = 'viva.wifiCreds';

export interface WifiCreds {
  ssid: string;
  psk: string;
}

export async function loadWifiCreds(): Promise<WifiCreds | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { ssid?: unknown; psk?: unknown };
    if (typeof v?.ssid === 'string' && typeof v?.psk === 'string') {
      return { ssid: v.ssid, psk: v.psk };
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveWifiCreds(creds: WifiCreds): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(creds));
  } catch {
    // 저장 실패는 조용히 - 다음에 다시 입력하면 된다.
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/utils/__tests__/wifiCredsStore.test.ts`
Expected: PASS 4/4

- [ ] **Step 5: 커밋 (신규 파일 2개만)**

```bash
git add src/utils/wifiCredsStore.ts src/utils/__tests__/wifiCredsStore.test.ts
git commit -m "feat: WiFi 자격 저장 유틸 (재입력 제거용, AsyncStorage)"
```

---

### Task 2: WifiProvisionScreen 좌우 분할 재구성

**Files:**
- Modify: `src/device/screens/WifiProvisionScreen.tsx` (전면 교체)
- Test: `src/device/screens/__tests__/WifiProvisionScreen.test.tsx`

**Interfaces:**
- Consumes: 기존 `QrCodeView({ matrix, size })`, `buildWifiQrPayload/buildWifiQrMatrix`, `fetchCurrentSsid`, `usePiConnection`.
- Produces: 화면 구조 — Task 3·4 가 이 파일을 이어서 수정. testID: `wifi-psk`, `wifi-psk-toggle`, `wifi-qr-make`, `wifi-provision-close` 유지·추가.

동작 요약 (스펙 §화면 구조): 단일 화면. 좌 폼(제목·sub·SSID·비번+보기 토글·플랫폼별 helper·QR 만들기). 우 3상태 — ① QR 이전: 점선 프레임 안에 순서 3단계, ② QR: GREEN 코너 틱 뷰파인더 프레임 + 대형 QR + 힌트 1줄, ③ 성공: 같은 프레임에 체크 + "비바가 연결됐어!". QR 은 생성 후 입력 수정에 라이브 반영(입력이 비면 플레이스홀더로 복귀). "입력 고치기" 버튼 삭제.

- [ ] **Step 1: 테스트 갱신 (실패 먼저)**

`src/device/screens/__tests__/WifiProvisionScreen.test.tsx` — 기존 목·헬퍼(mockListeners/mockStatus/mockFetchCurrentSsid/render/textOf)는 유지. describe 본문을 아래로 교체:

```tsx
describe('WifiProvisionScreen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockStatus = 'disconnected';
    mockListeners.clear();
    mockFetchCurrentSsid.mockResolvedValue(null);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('QR 만들기 전에는 오른쪽에 자리 표시와 사용 순서가 보인다', () => {
    const tree = render(<WifiProvisionScreen onClose={jest.fn()} />);
    expect(tree.root.findAll((n) => n.props.testID === 'qr-row').length).toBe(0);
    expect(textOf(tree)).toContain('비바 전원을 켜줘');
  });

  it('QR 만들기를 누르면 QR과 스캔 힌트가 뜨고 폼은 그대로 남는다', () => {
    const tree = render(<WifiProvisionScreen onClose={jest.fn()} />);
    const [ssid, psk] = tree.root.findAllByType(TextInput);
    act(() => {
      ssid.props.onChangeText('MyHome');
      psk.props.onChangeText('pass1234');
    });
    act(() => tree.root.find((n) => n.props.testID === 'wifi-qr-make').props.onPress());
    expect(tree.root.findAll((n) => n.props.testID === 'qr-row').length).toBeGreaterThan(0);
    expect(textOf(tree)).toContain('15~25cm');
    expect(tree.root.findAllByType(TextInput).length).toBe(2); // 폼 유지
  });

  it('입력이 비어 있으면 생성 버튼이 비활성이다', () => {
    const tree = render(<WifiProvisionScreen onClose={jest.fn()} />);
    const makeBtn = tree.root.find((n) => n.props.testID === 'wifi-qr-make');
    expect(makeBtn.props.accessibilityState?.disabled).toBe(true);
  });

  it('QR 표시 후 입력을 지우면 QR이 내려가고 안내가 돌아온다 (라이브)', () => {
    const tree = render(<WifiProvisionScreen onClose={jest.fn()} />);
    const [ssid, psk] = tree.root.findAllByType(TextInput);
    act(() => {
      ssid.props.onChangeText('MyHome');
      psk.props.onChangeText('pass1234');
    });
    act(() => tree.root.find((n) => n.props.testID === 'wifi-qr-make').props.onPress());
    act(() => ssid.props.onChangeText(''));
    expect(tree.root.findAll((n) => n.props.testID === 'qr-row').length).toBe(0);
    expect(textOf(tree)).toContain('비바 전원을 켜줘');
  });

  it('비밀번호 보기 토글이 secureTextEntry를 뒤집는다', () => {
    const tree = render(<WifiProvisionScreen onClose={jest.fn()} />);
    const psk = tree.root.find(
      (n) => n.props.testID === 'wifi-psk' && n.type === TextInput,
    );
    expect(psk.props.secureTextEntry).toBe(true);
    act(() => tree.root.find((n) => n.props.testID === 'wifi-psk-toggle').props.onPress());
    expect(psk.props.secureTextEntry).toBe(false);
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
      mockListeners.forEach((l) => l('connected'));
    });
    expect(textOf(tree)).toContain('연결됐어');
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('성공 대기 중 언마운트되면 타이머가 정리돼 onClose가 안 불린다', () => {
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
      mockListeners.forEach((l) => l('connected'));
    });
    act(() => tree.unmount());
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('성공 대기 중 onClose prop이 바뀌어도 타이머가 리셋되지 않고 최신 콜백 하나만 불린다', () => {
    const onCloseA = jest.fn();
    const onCloseB = jest.fn();
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(<WifiProvisionScreen onClose={onCloseA} />);
    });
    const [ssid, psk] = tree.root.findAllByType(TextInput);
    act(() => {
      ssid.props.onChangeText('MyHome');
      psk.props.onChangeText('pass1234');
    });
    act(() => tree.root.find((n) => n.props.testID === 'wifi-qr-make').props.onPress());
    act(() => {
      mockStatus = 'connected';
      mockListeners.forEach((l) => l('connected'));
    });
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    act(() => {
      tree.update(<WifiProvisionScreen onClose={onCloseB} />);
    });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(onCloseA).not.toHaveBeenCalled();
    expect(onCloseB).toHaveBeenCalledTimes(1);
  });

  it('열리면 현재 WiFi SSID를 자동으로 채운다', async () => {
    mockFetchCurrentSsid.mockResolvedValue('HomeWifi');
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(<WifiProvisionScreen onClose={jest.fn()} />);
    });
    const [ssid] = tree.root.findAllByType(TextInput);
    expect(ssid.props.value).toBe('HomeWifi');
    expect(textOf(tree)).toContain('가져왔어');
  });

  it('사용자가 먼저 입력했으면 자동 채움이 덮어쓰지 않는다', async () => {
    let resolveSsid!: (s: string | null) => void;
    mockFetchCurrentSsid.mockReturnValue(new Promise((r) => (resolveSsid = r)));
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(<WifiProvisionScreen onClose={jest.fn()} />);
    });
    const [ssid] = tree.root.findAllByType(TextInput);
    act(() => ssid.props.onChangeText('Typed'));
    await act(async () => {
      resolveSsid('HomeWifi');
    });
    expect(ssid.props.value).toBe('Typed');
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

Run: `npx jest src/device/screens/__tests__/WifiProvisionScreen.test.tsx`
Expected: FAIL — 플레이스홀더·토글·라이브 테스트가 깨진다 (기존 화면은 2단계 구조).

- [ ] **Step 3: 화면 전면 교체**

`src/device/screens/WifiProvisionScreen.tsx` 전체를 아래로:

```tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import QrCodeView from '../components/QrCodeView';
import { buildWifiQrPayload, buildWifiQrMatrix } from '../../utils/wifiQr';
import { fetchCurrentSsid } from '../../utils/currentSsid';
import { usePiConnection } from '../hooks/usePiConnection';
import {
  APP_BACKGROUND_COLOR,
  GREEN,
  SURFACE_COLOR,
  SURFACE_BORDER_COLOR,
  INK,
  INK_MUTED,
  FONT,
  ON_ACCENT,
} from '../../theme';

/** WiFi 등록 화면 (UX 2차 스펙 §화면 구조). 좌 폼 + 우 대형 QR 단일 화면.
 * QR 은 생성 후 입력 수정에 라이브 반응 - 입력이 비면 자리 안내로 돌아간다.
 * 성공 확인은 별도 폴링 없이 connectionMonitor connected 엣지 재사용.
 * 비밀번호 자동 추출은 iOS/Android 모두 불가(플랫폼 제약) - 붙여넣기 안내와
 * 저장·복원(Task 3)으로 마찰만 줄인다. */
const CLOSE_AFTER_SUCCESS_MS = 1500;

/** QR 이전 자리 안내의 사용 순서. 실제 시도 순서라 번호가 정보다. */
const QR_STEPS = [
  '스마트폰을 와이파이에 연결하거나 휴대용 핫스팟을 켜줘',
  '비바 전원을 켜줘',
  'QR 코드를 만들어 비바에게 보여줘',
];

const PSK_HELPER = Platform.select({
  ios: 'iPhone 설정 > Wi-Fi > ⓘ > 비밀번호에서 복사해 붙여넣을 수 있어',
  default: '공유기 스티커나 와이파이 설정에서 비밀번호를 확인해줘',
});

interface Props {
  onClose: () => void;
}

/** 로봇 카메라 뷰파인더 코너 틱 - 이 화면의 시그니처. 부모는 position 기준. */
function CornerTicks(): React.JSX.Element {
  return (
    <>
      <View pointerEvents="none" style={[styles.tick, styles.tickTL]} />
      <View pointerEvents="none" style={[styles.tick, styles.tickTR]} />
      <View pointerEvents="none" style={[styles.tick, styles.tickBL]} />
      <View pointerEvents="none" style={[styles.tick, styles.tickBR]} />
    </>
  );
}

export default function WifiProvisionScreen({ onClose }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [ssid, setSsid] = useState('');
  const [psk, setPsk] = useState('');
  const [showPsk, setShowPsk] = useState(false);
  const [autoFilled, setAutoFilled] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const status = usePiConnection();
  const succeeded = showQr && status === 'connected';

  // 현재 WiFi SSID 자동 채움 - 사용자가 먼저 타이핑했으면 덮어쓰지 않는다.
  const ssidTouchedRef = useRef(false);
  useEffect(() => {
    let alive = true;
    fetchCurrentSsid().then((s) => {
      if (!alive || !s || ssidTouchedRef.current) return;
      setSsid(s);
      setAutoFilled(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  // HomeScreen이 넘기는 onClose는 인라인 콜백이라 리렌더마다 새 레퍼런스 -
  // deps에 직접 넣으면 타이머가 계속 리셋된다. ref로 최신 값만 읽는다.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!succeeded) return;
    const t = setTimeout(() => onCloseRef.current(), CLOSE_AFTER_SUCCESS_MS);
    return () => clearTimeout(t);
  }, [succeeded]);

  // 생성 후엔 입력에 라이브 반응. 입력이 비면 null - 자리 안내로 복귀.
  const matrix = useMemo(
    () =>
      showQr && ssid.trim() && psk ? buildWifiQrMatrix(buildWifiQrPayload(ssid, psk)) : null,
    [showQr, ssid, psk],
  );

  // 로봇 카메라 인식 대비 - 세로 공간이 허락하는 최대 크기 (상한 320).
  const qrSize = Math.max(200, Math.min(320, height - 120));
  const frameSize = qrSize + 28; // 코너 틱 프레임 패딩 14*2

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

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <View style={styles.split}>
          <View style={styles.formPane}>
            <Text style={styles.title}>비바를 새 와이파이에 연결해요</Text>
            <Text style={styles.sub}>
              {autoFilled
                ? '지금 연결된 와이파이 이름을 가져왔어'
                : '연결할 와이파이 이름과 비밀번호를 입력해줘'}
            </Text>
            <TextInput
              style={styles.input}
              placeholder="와이파이 이름 (SSID)"
              placeholderTextColor={INK_MUTED}
              autoCapitalize="none"
              autoCorrect={false}
              value={ssid}
              onChangeText={(t) => {
                ssidTouchedRef.current = true;
                setSsid(t);
              }}
            />
            <View style={styles.pskRow}>
              <TextInput
                style={[styles.input, styles.pskInput]}
                placeholder="비밀번호"
                placeholderTextColor={INK_MUTED}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry={!showPsk}
                testID="wifi-psk"
                value={psk}
                onChangeText={setPsk}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={showPsk ? '비밀번호 가리기' : '비밀번호 보기'}
                testID="wifi-psk-toggle"
                onPress={() => setShowPsk((v) => !v)}
                style={({ pressed }) => [styles.pskToggle, pressed && { opacity: 0.6 }]}
              >
                <Text style={styles.pskToggleText}>{showPsk ? '가리기' : '보기'}</Text>
              </Pressable>
            </View>
            <Text style={styles.helper}>{PSK_HELPER}</Text>
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
          </View>

          <View style={styles.qrPane}>
            {succeeded ? (
              <View style={[styles.qrFrame, { width: frameSize, height: frameSize }]}>
                <CornerTicks />
                <View style={styles.successBadge}>
                  <Text style={styles.successCheck}>✓</Text>
                </View>
                <Text style={styles.successTitle}>비바가 연결됐어!</Text>
                <Text style={styles.sub}>이제 비바랑 같이 공부할 수 있어</Text>
              </View>
            ) : matrix ? (
              <>
                <View style={[styles.qrFrame, { width: frameSize, height: frameSize }]}>
                  <CornerTicks />
                  <QrCodeView matrix={matrix} size={qrSize} />
                </View>
                <Text style={styles.qrHint}>화면 밝기 최대 · 비바에게 15~25cm 거리로 보여줘</Text>
              </>
            ) : (
              <View
                style={[styles.placeholder, { width: frameSize, height: frameSize }]}
              >
                {QR_STEPS.map((text, i) => (
                  <View key={text} style={styles.stepRow}>
                    <View style={styles.stepNum}>
                      <Text style={styles.stepNumText}>{i + 1}</Text>
                    </View>
                    <Text style={styles.stepText}>{text}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: APP_BACKGROUND_COLOR,
    zIndex: 60, // topRightRow(40)·SolveModeToggle 위
  },
  flex: { flex: 1 },
  split: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 36,
    paddingHorizontal: 28,
  },
  formPane: {
    flexShrink: 1,
    width: '100%',
    maxWidth: 380,
    gap: 12,
  },
  closeBtn: {
    position: 'absolute',
    top: 18,
    right: 20,
    zIndex: 1,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeGlyph: { fontSize: 20, color: INK_MUTED, fontFamily: FONT },
  title: {
    fontSize: 22,
    fontWeight: '700',
    fontFamily: FONT,
    color: INK,
  },
  sub: {
    fontSize: 14,
    lineHeight: 21,
    fontFamily: FONT,
    color: INK_MUTED,
  },
  input: {
    alignSelf: 'stretch',
    backgroundColor: SURFACE_COLOR,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    borderRadius: 14,
    paddingHorizontal: 16,
    minHeight: 48, // 터치 타깃 44pt+
    paddingVertical: 12,
    fontSize: 16,
    fontFamily: FONT,
    color: INK,
  },
  pskRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pskInput: { flex: 1, alignSelf: 'auto' },
  pskToggle: {
    minHeight: 48,
    minWidth: 56,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    backgroundColor: SURFACE_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  pskToggleText: { fontSize: 13, fontFamily: FONT, color: INK_MUTED },
  helper: {
    fontSize: 12,
    lineHeight: 17,
    fontFamily: FONT,
    color: INK_MUTED,
    marginTop: -4,
    marginLeft: 4,
  },
  makeBtn: {
    alignSelf: 'stretch',
    backgroundColor: GREEN,
    borderRadius: 14,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  makeBtnText: { fontSize: 16, fontWeight: '700', fontFamily: FONT, color: ON_ACCENT },
  qrPane: {
    alignItems: 'center',
    gap: 10,
  },
  // 시그니처: 로봇 카메라 뷰파인더 프레임. QR 은 흰 카드(QrCodeView 자체 배경).
  qrFrame: {
    padding: 14,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  tick: { position: 'absolute', width: 26, height: 26, borderColor: GREEN },
  tickTL: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 10 },
  tickTR: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 10 },
  tickBL: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 10 },
  tickBR: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 10 },
  placeholder: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: SURFACE_BORDER_COLOR,
    borderRadius: 22,
    justifyContent: 'center',
    padding: 22,
    gap: 14,
  },
  qrHint: {
    fontSize: 12,
    fontFamily: FONT,
    color: INK_MUTED,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  stepNum: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(54, 155, 117, 0.10)', // GREEN 10% 틴트 (가이드 카드와 동일)
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumText: { fontSize: 14, fontWeight: '700', fontFamily: FONT, color: GREEN },
  stepText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: FONT,
    color: INK,
  },
  successBadge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: GREEN,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successCheck: { fontSize: 30, fontWeight: '700', color: ON_ACCENT, fontFamily: FONT },
  successTitle: {
    fontSize: 20,
    fontWeight: '700',
    fontFamily: FONT,
    color: INK,
    marginTop: 4,
  },
});
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/device/screens/__tests__/WifiProvisionScreen.test.tsx`
Expected: PASS 11/11

- [ ] **Step 5: 커밋 없음** — 기존 파일 수정, 세션 커밋 보류 정책 (Global Constraints).

---

### Task 3: 저장·복원 통합 (wifiCredsStore ↔ 화면)

**Files:**
- Modify: `src/device/screens/WifiProvisionScreen.tsx`
- Test: `src/device/screens/__tests__/WifiProvisionScreen.test.tsx`

**Interfaces:**
- Consumes: Task 1 의 `loadWifiCreds/saveWifiCreds/WifiCreds`.

동작: 열릴 때 저장분 있으면 SSID·비번 둘 다 프리필 + sub "지난번 입력을 불러왔어" (SSID 자동 채움보다 우선 — 저장분 있으면 fetchCurrentSsid 호출 안 함). "QR 만들기" 누를 때마다 현재 입력 저장.

- [ ] **Step 1: 테스트 추가 (실패 먼저)**

테스트 파일 상단, `currentSsid` 목 아래에 추가:

```tsx
// 저장·복원은 AsyncStorage 의존이라 유틸째 목 - 기본은 저장분 없음.
const mockLoadWifiCreds = jest.fn<Promise<{ ssid: string; psk: string } | null>, []>();
const mockSaveWifiCreds = jest.fn<Promise<void>, [{ ssid: string; psk: string }]>();
jest.mock('../../../utils/wifiCredsStore', () => ({
  loadWifiCreds: () => mockLoadWifiCreds(),
  saveWifiCreds: (c: { ssid: string; psk: string }) => mockSaveWifiCreds(c),
}));
```

beforeEach 에 추가:

```tsx
    mockLoadWifiCreds.mockResolvedValue(null);
    mockSaveWifiCreds.mockResolvedValue(undefined);
```

describe 끝에 테스트 3개 추가:

```tsx
  it('저장된 입력이 있으면 둘 다 미리 채우고 자동 채움은 건너뛴다', async () => {
    mockLoadWifiCreds.mockResolvedValue({ ssid: 'Saved', psk: 'savedpw' });
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(<WifiProvisionScreen onClose={jest.fn()} />);
    });
    const [ssid] = tree.root.findAllByType(TextInput);
    const psk = tree.root.find((n) => n.props.testID === 'wifi-psk' && n.type === TextInput);
    expect(ssid.props.value).toBe('Saved');
    expect(psk.props.value).toBe('savedpw');
    expect(textOf(tree)).toContain('불러왔어');
    expect(mockFetchCurrentSsid).not.toHaveBeenCalled();
  });

  it('저장분을 불러오기 전에 사용자가 입력했으면 덮어쓰지 않는다', async () => {
    let resolveCreds!: (c: { ssid: string; psk: string } | null) => void;
    mockLoadWifiCreds.mockReturnValue(new Promise((r) => (resolveCreds = r)));
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = ReactTestRenderer.create(<WifiProvisionScreen onClose={jest.fn()} />);
    });
    const [ssid] = tree.root.findAllByType(TextInput);
    act(() => ssid.props.onChangeText('Typed'));
    await act(async () => {
      resolveCreds({ ssid: 'Saved', psk: 'savedpw' });
    });
    expect(ssid.props.value).toBe('Typed');
  });

  it('QR 만들기를 누르면 현재 입력을 저장한다', () => {
    const tree = render(<WifiProvisionScreen onClose={jest.fn()} />);
    const [ssid, psk] = tree.root.findAllByType(TextInput);
    act(() => {
      ssid.props.onChangeText('MyHome');
      psk.props.onChangeText('pass1234');
    });
    act(() => tree.root.find((n) => n.props.testID === 'wifi-qr-make').props.onPress());
    expect(mockSaveWifiCreds).toHaveBeenCalledWith({ ssid: 'MyHome', psk: 'pass1234' });
  });
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/device/screens/__tests__/WifiProvisionScreen.test.tsx`
Expected: FAIL — 신규 3개 (모듈 목은 있지만 화면이 아직 안 씀).

- [ ] **Step 3: 화면 수정**

import 추가:

```tsx
import { loadWifiCreds, saveWifiCreds } from '../../utils/wifiCredsStore';
```

`const [autoFilled, setAutoFilled] = useState(false);` 를 다음으로 교체:

```tsx
  // 'saved' = 지난 입력 복원, 'ssid' = 현재 WiFi 이름 자동 채움
  const [prefill, setPrefill] = useState<'saved' | 'ssid' | null>(null);
```

기존 SSID 자동 채움 useEffect 전체를 다음으로 교체 (저장분 우선, 순차 체인이라 경합 없음):

```tsx
  // 프리필: 저장분(비번까지) > 현재 WiFi SSID > 없음. 사용자가 먼저
  // 타이핑했으면 덮어쓰지 않는다. 순차 체인이라 둘이 경합하지 않는다.
  const ssidTouchedRef = useRef(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const saved = await loadWifiCreds();
      if (!alive) return;
      if (saved) {
        if (ssidTouchedRef.current) return;
        setSsid(saved.ssid);
        setPsk((p) => p || saved.psk);
        setPrefill('saved');
        return;
      }
      const s = await fetchCurrentSsid();
      if (!alive || !s || ssidTouchedRef.current) return;
      setSsid(s);
      setPrefill('ssid');
    })();
    return () => {
      alive = false;
    };
  }, []);
```

sub 문구 분기 교체:

```tsx
            <Text style={styles.sub}>
              {prefill === 'saved'
                ? '지난번 입력을 불러왔어'
                : prefill === 'ssid'
                  ? '지금 연결된 와이파이 이름을 가져왔어'
                  : '연결할 와이파이 이름과 비밀번호를 입력해줘'}
            </Text>
```

makeBtn onPress 교체 (누를 때마다 저장 — 스펙 §왼쪽 폼):

```tsx
              onPress={() => {
                setShowQr(true);
                void saveWifiCreds({ ssid, psk });
              }}
```

파일 상단 doc 주석의 "비번은 state에만 있다가 화면을 떠나면 사라진다" 류 문장이 남아 있으면 삭제 (스펙이 저장으로 바뀜 — Task 2 의 주석엔 이미 없음).

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/device/screens/__tests__/WifiProvisionScreen.test.tsx`
Expected: PASS 14/14

- [ ] **Step 5: 커밋 없음** — 세션 커밋 보류 정책.

---

### Task 4: Android 지름길 카드

**Files:**
- Modify: `src/device/screens/WifiProvisionScreen.tsx`
- Test: `src/device/screens/__tests__/WifiProvisionScreen.test.tsx`

동작: Android 에서만 폼 상단(제목·sub 아래, SSID 위)에 카드 — "더 빠른 방법 — Wi-Fi 설정의 QR 공유 화면을 비바에게 바로 보여줘도 돼" + "Wi-Fi 설정 열기" 버튼(`Linking.sendIntent('android.settings.WIFI_SETTINGS')`). iOS 미렌더.

- [ ] **Step 1: 테스트 추가 (실패 먼저)**

describe 끝에 추가 (테스트 환경 기본 Platform.OS 는 'ios'):

```tsx
  it('iOS에서는 지름길 카드가 안 뜬다', () => {
    const tree = render(<WifiProvisionScreen onClose={jest.fn()} />);
    expect(tree.root.findAll((n) => n.props.testID === 'wifi-open-settings').length).toBe(0);
  });

  it('Android에서는 지름길 카드가 뜨고 버튼이 Wi-Fi 설정 인텐트를 보낸다', () => {
    const platformSpy = jest.replaceProperty(Platform, 'OS', 'android');
    const sendIntentSpy = jest
      .spyOn(Linking, 'sendIntent')
      .mockResolvedValue(undefined as never);
    try {
      const tree = render(<WifiProvisionScreen onClose={jest.fn()} />);
      const btn = tree.root.find((n) => n.props.testID === 'wifi-open-settings');
      act(() => btn.props.onPress());
      expect(sendIntentSpy).toHaveBeenCalledWith('android.settings.WIFI_SETTINGS');
      expect(textOf(tree)).toContain('더 빠른 방법');
    } finally {
      platformSpy.restore();
      sendIntentSpy.mockRestore();
    }
  });
```

테스트 파일 import 에 `Platform`, `Linking` 추가:

```tsx
import { Linking, Platform, Text, TextInput } from 'react-native';
```

주의: `PSK_HELPER` 등 `Platform.select` 는 모듈 로드 시 평가되므로 replaceProperty 로 안 바뀐다 — 이 테스트는 카드 렌더 분기(렌더 시 `Platform.OS` 참조)만 검증한다. 화면 구현도 카드 분기는 렌더 시점 `Platform.OS === 'android'` 로 써야 이 테스트가 성립한다.

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/device/screens/__tests__/WifiProvisionScreen.test.tsx`
Expected: FAIL — Android 테스트 (`wifi-open-settings` 없음).

- [ ] **Step 3: 화면 수정**

react-native import 에 `Linking` 추가. sub `<Text>` 와 SSID `<TextInput>` 사이에:

```tsx
            {Platform.OS === 'android' && (
              <View style={styles.shortcutCard}>
                <Text style={styles.shortcutText}>
                  더 빠른 방법 — Wi-Fi 설정의 QR 공유 화면을 비바에게 바로 보여줘도 돼
                </Text>
                <Pressable
                  accessibilityRole="button"
                  testID="wifi-open-settings"
                  onPress={() => {
                    Linking.sendIntent('android.settings.WIFI_SETTINGS').catch(() => {
                      // 일부 제조사 롬에서 인텐트가 없을 수 있다 - 조용히 무시.
                    });
                  }}
                  style={({ pressed }) => [styles.shortcutBtn, pressed && { opacity: 0.6 }]}
                >
                  <Text style={styles.shortcutBtnText}>Wi-Fi 설정 열기</Text>
                </Pressable>
              </View>
            )}
```

styles 추가:

```tsx
  shortcutCard: {
    alignSelf: 'stretch',
    backgroundColor: 'rgba(54, 155, 117, 0.10)', // GREEN 10% 틴트
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  shortcutText: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: FONT,
    color: INK,
  },
  shortcutBtn: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  shortcutBtnText: { fontSize: 14, fontWeight: '700', fontFamily: FONT, color: GREEN },
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/device/screens/__tests__/WifiProvisionScreen.test.tsx`
Expected: PASS 16/16

- [ ] **Step 5: 전체 회귀 확인**

Run: `npx jest`
Expected: 기존 베이스라인 실패(captureDecision 2 + problemChoice 3)만. `npx tsc --noEmit` 은 기존 3파일 에러만.

- [ ] **Step 6: 커밋 없음** — 세션 커밋 보류 정책.

---

### Task 5: 문서 갱신

**Files:**
- Modify: `docs/process.md`
- Modify: `.superpowers/sdd/progress.md`

- [ ] **Step 1: process.md 갱신** (문서 맨 위 "문서 갱신 규칙" 절 준수)

- §1 프로비저닝 절: UX 2차(좌우 분할 화면·저장·플랫폼 지름길) 반영, "1차 실기기 피드백" bullet 의 iOS 엔타이틀먼트 서술을 "무료 Personal Team 불가 → iOS gate off, 유료 전환 시 복구 경로 주석" 사실로 정정.
- §4 8주차: 항목 append — 문제(수동 입력 번거로움 피드백)/해결(접근 1: 좌우 분할 + 비번 토글 + 저장·복원 + Android 지름길, BLE 등 대안 비교 후 제외)/결과(테스트 16/16) 서술형. 기존 항목 11 의 "엔타이틀먼트 적용 완료" 서술도 같은 사실로 정정.

- [ ] **Step 2: 레저 갱신**

`.superpowers/sdd/progress.md` 에 UX 2차 태스크 완료 항목 append.

- [ ] **Step 3: 커밋 없음** — process.md 는 커밋 보류 목록. 사용자 승인 후 일괄 커밋.

---

## 마무리 (사용자 확인 후)

- iPhone 재빌드·설치 (`APP_VARIANT=device npx expo run:ios --configuration Release --device`) — 세션 진행 중이던 빌드 5와 별개로, 이 작업 반영분.
- 실기기 확인 포인트: 좌우 분할 비율, QR 크기(로봇 15~25cm 인식), 키보드 열림 시 폼 가림 여부.
- 커밋: 병렬 세션 정리 후 명시 경로로 일괄 (Task 1 신규 파일은 이미 커밋됨).

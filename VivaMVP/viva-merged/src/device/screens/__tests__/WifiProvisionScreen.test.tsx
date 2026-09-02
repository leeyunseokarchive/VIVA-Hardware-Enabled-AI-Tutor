import React from 'react';
import { Linking, Platform, Text, TextInput } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';

// connectionMonitor를 조작 가능한 목으로 - usePiConnection이 이걸 구독한다.
// ponytail: jest.mock 팩토리는 호이스팅돼서 스코프 밖 변수를 못 읽는다 -
// "mock" 접두사가 붙은 이름만 예외로 허용된다. listeners도 그래서
// mockListeners로 이름 붙였다 (mockStatus는 원래부터 이 규칙을 만족했다).
const mockListeners = new Set<(s: string) => void>();
let mockStatus = 'disconnected';
jest.mock('../../services/connectionMonitor.service', () => ({
  connectionMonitor: {
    get status() {
      return mockStatus;
    },
    onStatusChange: (l: (s: string) => void) => {
      mockListeners.add(l);
      return () => mockListeners.delete(l);
    },
  },
}));

// SSID 자동 채움은 네이티브(netinfo/expo-location) 의존이라 모듈째 목 -
// 기본은 null(자동 채움 실패 = 수동 입력 플로)로 두고 필요한 테스트만 바꾼다.
const mockFetchCurrentSsid = jest.fn<Promise<string | null>, []>();
jest.mock('../../../utils/currentSsid', () => ({
  fetchCurrentSsid: () => mockFetchCurrentSsid(),
}));

// 저장·복원은 AsyncStorage 의존이라 유틸째 목 - 기본은 저장분 없음.
const mockLoadWifiCreds = jest.fn<Promise<{ ssid: string; psk: string } | null>, []>();
const mockSaveWifiCreds = jest.fn<Promise<void>, [{ ssid: string; psk: string }]>();
jest.mock('../../../utils/wifiCredsStore', () => ({
  loadWifiCreds: () => mockLoadWifiCreds(),
  saveWifiCreds: (c: { ssid: string; psk: string }) => mockSaveWifiCreds(c),
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
    mockListeners.clear();
    mockFetchCurrentSsid.mockClear().mockResolvedValue(null);
    mockLoadWifiCreds.mockClear().mockResolvedValue(null);
    mockSaveWifiCreds.mockClear().mockResolvedValue(undefined);
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

  it('이미 연결된 상태에서 열면 QR을 만들어도 성공 처리로 닫히지 않는다 (재등록)', () => {
    mockStatus = 'connected';
    const onClose = jest.fn();
    const tree = render(<WifiProvisionScreen onClose={onClose} />);
    const [ssid, psk] = tree.root.findAllByType(TextInput);
    act(() => {
      ssid.props.onChangeText('MyHome');
      psk.props.onChangeText('pass1234');
    });
    act(() => tree.root.find((n) => n.props.testID === 'wifi-qr-make').props.onPress());
    expect(tree.root.findAll((n) => n.props.testID === 'qr-row').length).toBeGreaterThan(0);
    expect(textOf(tree)).not.toContain('연결됐어');
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('재등록 중 끊겼다 다시 붙는 엣지는 성공으로 친다', () => {
    mockStatus = 'connected';
    const onClose = jest.fn();
    const tree = render(<WifiProvisionScreen onClose={onClose} />);
    const [ssid, psk] = tree.root.findAllByType(TextInput);
    act(() => {
      ssid.props.onChangeText('MyHome');
      psk.props.onChangeText('pass1234');
    });
    act(() => tree.root.find((n) => n.props.testID === 'wifi-qr-make').props.onPress());
    act(() => {
      mockStatus = 'disconnected';
      mockListeners.forEach((l) => l('disconnected'));
    });
    act(() => {
      mockStatus = 'connected';
      mockListeners.forEach((l) => l('connected'));
    });
    expect(textOf(tree)).toContain('연결됐어');
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
    // 부모(HomeScreen)가 리렌더되며 새 onClose 레퍼런스를 내려준다 - 1500ms
    // 타이머가 이미 도는 중이어야 한다(리셋되면 안 된다).
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

  it('iOS에서는 지름길 카드가 안 뜬다', () => {
    const tree = render(<WifiProvisionScreen onClose={jest.fn()} />);
    expect(tree.root.findAll((n) => n.props.testID === 'wifi-open-settings').length).toBe(0);
  });

  it('Android에서는 지름길 카드가 뜨고 버튼이 Wi-Fi 설정 인텐트를 보낸다', () => {
    // PSK_HELPER 등 모듈 로드 시점 Platform.select 는 안 바뀐다 - 렌더 시점
    // Platform.OS 분기(카드)만 검증한다.
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
});

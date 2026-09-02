import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import HomeScreen, { graceHealth, MIC_GRACE_MS } from '../HomeScreen';

const mockUsePiDeviceHealth = jest.fn();
jest.mock('../../hooks/usePiConnection', () => ({
  usePiDeviceHealth: () => mockUsePiDeviceHealth(),
}));

// WifiProvisionScreen 은 자체 테스트가 따로 있다 - 여기선 배선(버튼→표시)만 본다.
jest.mock('../WifiProvisionScreen', () => {
  const { View } = require('react-native');
  return ({ onClose }: { onClose: () => void }) => (
    <View testID="wifi-provision-screen" onClose={onClose} />
  );
});

describe('graceHealth (F1: 연결 엣지 mic_ok 오탐 디바운스)', () => {
  it('연결 직후 grace 안의 micOk:false 는 undefined 로 강등한다', () => {
    const g = graceHealth({ micOk: false, speakerOk: true }, 1000, 1000 + MIC_GRACE_MS - 1);
    expect(g).toEqual({ micOk: undefined, speakerOk: true });
  });
  it('grace 가 지나면 micOk:false 를 그대로 통과시킨다', () => {
    const g = graceHealth({ micOk: false, speakerOk: true }, 1000, 1000 + MIC_GRACE_MS);
    expect(g).toEqual({ micOk: false, speakerOk: true });
  });
  it('micOk:true·null health·미연결(connectedSince null)은 손대지 않는다', () => {
    expect(graceHealth({ micOk: true }, 1000, 1001)).toEqual({ micOk: true });
    expect(graceHealth(null, 1000, 1001)).toBeNull();
    expect(graceHealth({ micOk: false }, null, 1001)).toEqual({ micOk: false });
  });
});

describe('HomeScreen (디바이스 연동판)', () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

  beforeEach(() => {
    mockUsePiDeviceHealth.mockReset();
    mockUsePiDeviceHealth.mockReturnValue(null);
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
  });

  it('연결됨 + 정상 health 면 고장 배지는 아무것도 안 그린다 (정상은 조용히)', async () => {
    mockUsePiDeviceHealth.mockReturnValue({ micOk: true, speakerOk: true });
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <HomeScreen
          piStatus="connected"
          onPressToTalk={jest.fn()}
          onPressHistory={jest.fn()}
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    expect(renderer!.root.findAllByProps({ testID: 'fault-badge' })).toHaveLength(0);
  });

  it('연결됨 + 스피커 고장이면 고장 배지가 뜬다', async () => {
    // micOk:false 는 연결 직후 grace(F1, MIC_GRACE_MS)에 걸려 undefined 로
    // 강등되므로 grace 영향이 없는 speakerOk 로 배선을 검증한다.
    mockUsePiDeviceHealth.mockReturnValue({ micOk: true, speakerOk: false });
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <HomeScreen
          piStatus="connected"
          onPressToTalk={jest.fn()}
          onPressHistory={jest.fn()}
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    expect(renderer!.root.findByProps({ testID: 'fault-badge' })).toBeTruthy();
  });

  it('미연결이면 연결 가이드 카드가 뜨고 하단 버튼(마이크·기록)은 숨는다', async () => {
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <HomeScreen
          piStatus="disconnected"
          onPressToTalk={jest.fn()}
          onPressHistory={jest.fn()}
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    expect(renderer!.root.findByProps({ testID: 'connection-guide-card' })).toBeTruthy();
    // 가이드 카드와 겹쳐 보이던 하단 버튼은 가이드 표시 중 아예 렌더하지 않는다.
    expect(renderer!.root.findAllByProps({ testID: 'push-to-talk-button' })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ testID: 'history-button' })).toHaveLength(0);
  });

  it('연결되면 하단 버튼(마이크·기록)이 다시 보인다', async () => {
    mockUsePiDeviceHealth.mockReturnValue({ micOk: true, speakerOk: true });
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <HomeScreen
          piStatus="connected"
          onPressToTalk={jest.fn()}
          onPressHistory={jest.fn()}
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    expect(renderer!.root.findByProps({ testID: 'push-to-talk-button' })).toBeTruthy();
    expect(renderer!.root.findByProps({ testID: 'history-button' })).toBeTruthy();
  });

  it('연결 중에도 설정 버튼으로 WiFi 등록 화면을 열고 닫을 수 있다', async () => {
    mockUsePiDeviceHealth.mockReturnValue({ micOk: true, speakerOk: true });
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <HomeScreen
          piStatus="connected"
          onPressToTalk={jest.fn()}
          onPressHistory={jest.fn()}
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    expect(renderer!.root.findAllByProps({ testID: 'wifi-provision-screen' })).toHaveLength(0);
    await act(async () => {
      renderer!.root.findByProps({ testID: 'wifi-settings-button' }).props.onPress();
    });
    const provision = renderer!.root.findByProps({ testID: 'wifi-provision-screen' });
    await act(async () => {
      provision.props.onClose();
    });
    expect(renderer!.root.findAllByProps({ testID: 'wifi-provision-screen' })).toHaveLength(0);
  });
});

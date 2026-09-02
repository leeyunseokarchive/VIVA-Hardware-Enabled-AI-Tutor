import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import DisconnectOverlay from '../DisconnectOverlay';

describe('DisconnectOverlay', () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
  });

  it('가이드 카드 + 세션 종료 버튼, 콜백 연결 - 휴대폰으로 계속하기 탈출구는 없다', () => {
    const onEnd = jest.fn();
    act(() => {
      renderer = ReactTestRenderer.create(<DisconnectOverlay onEndSession={onEnd} />);
    });
    const tree = renderer!;
    expect(tree.root.findAllByProps({ testID: 'connection-guide-card' }).length).toBeGreaterThan(0);
    expect(() => tree.root.findByProps({ testID: 'continue-app-mode-button' })).toThrow();
    act(() => tree.root.findByProps({ testID: 'end-session-button' }).props.onPress());
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import ConnectionStatusChip from '../ConnectionStatusChip';
import ConnectionGuideCard from '../ConnectionGuideCard';

const trees: ReactTestRenderer.ReactTestRenderer[] = [];

function render(el: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(el);
  });
  trees.push(tree);
  return tree;
}

// 칩은 connected 라벨 자동 접힘용 setTimeout(2.6초)을 들고 있다 - unmount 로
// 이펙트 클린업(clearTimeout)을 돌리지 않으면 jest 환경 해체 후에 타이머가
// 터진다.
afterEach(() => {
  act(() => {
    trees.splice(0).forEach((t) => t.unmount());
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

describe('ConnectionStatusChip 탭 재생', () => {
  it('접힘 뒤에도 탭하면 라벨 시퀀스가 다시 돈다 (크래시 없이 라벨 유지)', () => {
    const tree = render(<ConnectionStatusChip status="connected" />);
    // Pressable 컴포짓 노드가 onPress prop 을 그대로 들고 있다 - host 가 아니라
    // 이쪽을 눌러야 한다 (host 엔 responder 콜백으로 풀려 들어간다).
    const chip = tree.root
      .findAllByProps({ testID: 'connection-status-chip' })
      .find((n) => typeof n.props.onPress === 'function')!;
    act(() => {
      chip.props.onPress();
    });
    const texts = tree.root
      .findAllByType(require('react-native').Text)
      .map((t) => t.props.children);
    expect(texts).toContain('비바 연결됨');
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

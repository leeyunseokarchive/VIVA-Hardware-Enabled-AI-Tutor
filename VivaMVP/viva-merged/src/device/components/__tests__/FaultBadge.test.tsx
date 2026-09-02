import React from 'react';
import { StyleSheet, Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import FaultBadge from '../FaultBadge';
import { INK, ORANGE } from '../../../theme';

const trees: ReactTestRenderer.ReactTestRenderer[] = [];

function render(el: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(el);
  });
  trees.push(tree);
  return tree;
}

// 배지는 자동 접힘용 setTimeout(4초)을 들고 있다 - unmount 로 이펙트
// 클린업(clearTimeout)을 돌리지 않으면 jest 환경 해체 후에 타이머가 터진다.
afterEach(() => {
  act(() => {
    trees.splice(0).forEach((t) => t.unmount());
  });
});

function labels(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findAllByType(Text).map((t) => t.props.children);
}

/** RN 0.74 의 View 는 forwardRef 라 testID 가 composite 와 host 양쪽에 잡힌다.
 *  실제로 렌더되는 host 노드만 센다 (type 이 문자열인 쪽). */
function byTestID(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll((n) => typeof n.type === 'string' && n.props.testID === id);
}

const HEALTHY = { micOk: true, speakerOk: true, camOk: true, displayOk: true };

describe('FaultBadge (2026-08-11 개편: 연결 칩 왼쪽 접이식 배지 하나)', () => {
  it('연결됨 + 전부 정상: 아무것도 안 그린다', () => {
    const tree = render(<FaultBadge status="connected" health={HEALTHY} />);
    expect(tree.toJSON()).toBeNull();
  });

  it('health 가 null 이어도 아무것도 안 그린다', () => {
    const tree = render(<FaultBadge status="connected" health={null} />);
    expect(tree.toJSON()).toBeNull();
  });

  it('구버전 Pi(필드 없음, 전부 undefined): 아무것도 안 그린다 - 모름은 정상이 아니다', () => {
    const tree = render(<FaultBadge status="connected" health={{}} />);
    expect(tree.toJSON()).toBeNull();
  });

  it.each([
    ['micOk', '마이크 이상', 'fault-badge-mic'],
    ['speakerOk', '스피커 이상', 'fault-badge-speaker'],
    ['camOk', '카메라 이상', 'fault-badge-camera'],
    ['displayOk', '화면 이상', 'fault-badge-display'],
  ] as const)('%s 고장: "%s" 한 줄만 뜬다', (field, label, testId) => {
    const tree = render(
      <FaultBadge status="connected" health={{ ...HEALTHY, [field]: false }} />,
    );
    expect(labels(tree)).toEqual([label]);
    expect(byTestID(tree, testId)).toHaveLength(1);
    // 배지는 하나다 - 부품 수만큼 필이 늘어나지 않는다.
    expect(byTestID(tree, 'fault-badge')).toHaveLength(1);
  });

  it('여러 부품 동시 고장: 배지 하나 안에 목록으로 주르륵', () => {
    const tree = render(
      <FaultBadge
        status="connected"
        health={{ micOk: false, speakerOk: false, camOk: false, displayOk: false }}
      />,
    );
    expect(labels(tree)).toEqual(['마이크 이상', '스피커 이상', '카메라 이상', '화면 이상']);
    expect(byTestID(tree, 'fault-badge')).toHaveLength(1);
    expect(byTestID(tree, 'fault-badge-dot')).toHaveLength(1);
  });

  it('undefined(모름) 필드는 목록에 안 낀다 - false 인 것만 남는다', () => {
    const tree = render(
      <FaultBadge status="connected" health={{ micOk: false, speakerOk: true }} />,
    );
    expect(labels(tree)).toEqual(['마이크 이상']);
  });

  it('점은 항상 ORANGE, 라벨 색은 항상 INK', () => {
    // ORANGE 는 크림 배경에서 12px 소형 텍스트 대비 미달이라 라벨엔 못 쓴다.
    const tree = render(
      <FaultBadge status="connected" health={{ ...HEALTHY, micOk: false, speakerOk: false }} />,
    );
    const dot = byTestID(tree, 'fault-badge-dot')[0];
    expect(StyleSheet.flatten(dot.props.style).backgroundColor).toBe(ORANGE);
    const labelColors = tree.root
      .findAllByType(Text)
      .map((t) => StyleSheet.flatten(t.props.style).color);
    expect(labelColors).toEqual([INK, INK]);
  });

  it.each(['connecting', 'disconnected'] as const)(
    '%s: 하드웨어가 다 고장이어도 아무것도 안 그린다',
    (status) => {
      const tree = render(
        <FaultBadge
          status={status}
          health={{ micOk: false, speakerOk: false, camOk: false, displayOk: false }}
        />,
      );
      expect(tree.toJSON()).toBeNull();
    },
  );

  it('탭하면 라벨 시퀀스가 다시 돈다 (크래시 없이 라벨 유지)', () => {
    const tree = render(
      <FaultBadge status="connected" health={{ ...HEALTHY, micOk: false }} />,
    );
    // Pressable 컴포짓 노드가 onPress prop 을 그대로 들고 있다 - host 가 아니라
    // 이쪽을 눌러야 한다 (host 엔 responder 콜백으로 풀려 들어간다).
    const badge = tree.root
      .findAllByProps({ testID: 'fault-badge' })
      .find((n) => typeof n.props.onPress === 'function')!;
    act(() => {
      badge.props.onPress();
    });
    expect(labels(tree)).toEqual(['마이크 이상']);
  });

  it('스크린리더 문구는 고장 목록을 그대로 잇는다', () => {
    const tree = render(
      <FaultBadge status="connected" health={{ micOk: false, speakerOk: false }} />,
    );
    const badge = byTestID(tree, 'fault-badge')[0];
    expect(badge.props.accessibilityLabel).toBe('비바 부품 이상: 마이크 이상, 스피커 이상');
  });
});

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

/** RN 0.74 의 View 는 forwardRef 라 testID 가 composite 와 host 양쪽에 잡힌다.
 *  실제로 렌더되는 host 노드만 센다 (type 이 문자열인 쪽). */
function byTestID(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll((n) => typeof n.type === 'string' && n.props.testID === id);
}

describe('QrCodeView', () => {
  it('행 수만큼 row View, 행마다 run 수만큼 셀 View를 만든다', () => {
    const tree = render(<QrCodeView matrix={M} size={200} />);
    const rows = byTestID(tree, 'qr-row');
    expect(rows).toHaveLength(5);
    // 3행(전부 검정)은 run 1개, 1행(백2/흑1/백2)은 run 3개
    expect(
      rows[2].findAll((n) => typeof n.type === 'string' && n.props.testID === 'qr-run'),
    ).toHaveLength(1);
    expect(
      rows[0].findAll((n) => typeof n.type === 'string' && n.props.testID === 'qr-run'),
    ).toHaveLength(3);
  });
});

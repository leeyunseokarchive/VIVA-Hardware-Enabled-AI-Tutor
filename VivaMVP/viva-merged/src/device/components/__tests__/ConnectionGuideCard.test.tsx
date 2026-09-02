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

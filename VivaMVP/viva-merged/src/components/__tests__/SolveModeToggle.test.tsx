import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import SolveModeToggle from '../SolveModeToggle';

describe('SolveModeToggle', () => {
  it('calls onToggle when pressed', () => {
    const onToggle = jest.fn();
    let renderer: any;
    act(() => {
      renderer = ReactTestRenderer.create(<SolveModeToggle enabled={false} onToggle={onToggle} />);
    });

    const button = renderer.root.findByProps({ testID: 'solve-mode-toggle' });
    act(() => {
      button.props.onPress();
    });

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('reflects the enabled state via accessibilityState', () => {
    let renderer: any;
    act(() => {
      renderer = ReactTestRenderer.create(<SolveModeToggle enabled={true} onToggle={jest.fn()} />);
    });

    const button = renderer.root.findByProps({ testID: 'solve-mode-toggle' });
    expect(button.props.accessibilityState).toEqual({ checked: true });
  });

  it('defaults to unselected accessibilityState when disabled', () => {
    let renderer: any;
    act(() => {
      renderer = ReactTestRenderer.create(<SolveModeToggle enabled={false} onToggle={jest.fn()} />);
    });

    const button = renderer.root.findByProps({ testID: 'solve-mode-toggle' });
    expect(button.props.accessibilityState).toEqual({ checked: false });
  });
});

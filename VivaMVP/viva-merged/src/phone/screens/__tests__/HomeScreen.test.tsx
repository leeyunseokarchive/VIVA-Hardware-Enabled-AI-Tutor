import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import HomeScreen from '../HomeScreen';

describe('HomeScreen', () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

  afterEach(() => {
    // EyeAnimation schedules real setTimeout-based blink/breathing loops
    // that clear themselves on unmount - without this, those timers can
    // fire after Jest tears down the module environment and crash the
    // process with an out-of-band error (see ConversationScreen.test.tsx).
    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
  });

  it('renders a single idle eye - the phone is the face, no mode/device UI', () => {
    act(() => {
      renderer = ReactTestRenderer.create(
        <HomeScreen
          onPressToTalk={jest.fn()}
          onPressHistory={jest.fn()}
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    expect(renderer!.root.findByProps({ testID: 'home-eyes' })).toBeTruthy();
  });

  it('renders the push-to-talk and history buttons and calls their handlers', () => {
    const onPressToTalk = jest.fn();
    const onPressHistory = jest.fn();
    act(() => {
      renderer = ReactTestRenderer.create(
        <HomeScreen
          onPressToTalk={onPressToTalk}
          onPressHistory={onPressHistory}
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    act(() => {
      renderer!.root.findByProps({ testID: 'push-to-talk-button' }).props.onPress();
    });
    expect(onPressToTalk).toHaveBeenCalledTimes(1);

    act(() => {
      renderer!.root.findByProps({ testID: 'history-button' }).props.onPress();
    });
    expect(onPressHistory).toHaveBeenCalledTimes(1);
  });

  it('push-to-talk is always enabled - there is no device connection to gate it', () => {
    act(() => {
      renderer = ReactTestRenderer.create(
        <HomeScreen
          onPressToTalk={jest.fn()}
          onPressHistory={jest.fn()}
          solveMode={false}
          onToggleSolveMode={jest.fn()}
        />,
      );
    });

    const button = renderer!.root.findByProps({ testID: 'push-to-talk-button' });
    expect(button.props.disabled).toBeFalsy();
  });

  it('renders the solve-mode toggle fixed top-right and forwards presses', () => {
    const onToggleSolveMode = jest.fn();
    act(() => {
      renderer = ReactTestRenderer.create(
        <HomeScreen
          onPressToTalk={jest.fn()}
          onPressHistory={jest.fn()}
          solveMode={true}
          onToggleSolveMode={onToggleSolveMode}
        />,
      );
    });

    const toggle = renderer!.root.findByProps({ testID: 'solve-mode-toggle' });
    expect(toggle.props.accessibilityState).toEqual({ checked: true });

    act(() => {
      toggle.props.onPress();
    });
    expect(onToggleSolveMode).toHaveBeenCalledTimes(1);
  });
});

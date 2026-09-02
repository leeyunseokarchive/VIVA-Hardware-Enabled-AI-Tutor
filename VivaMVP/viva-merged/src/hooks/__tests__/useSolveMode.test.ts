import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { useSolveMode, UseSolveModeResult } from '../useSolveMode';

function renderUseSolveMode() {
  const ref: { current: UseSolveModeResult | null } = { current: null };
  function Harness() {
    ref.current = useSolveMode();
    return null;
  }
  act(() => {
    ReactTestRenderer.create(React.createElement(Harness));
  });
  return ref as { current: UseSolveModeResult };
}

describe('useSolveMode', () => {
  it('starts disabled', () => {
    const ref = renderUseSolveMode();
    expect(ref.current.solveMode).toBe(false);
  });

  it('toggles on then off', () => {
    const ref = renderUseSolveMode();

    act(() => {
      ref.current.toggleSolveMode();
    });
    expect(ref.current.solveMode).toBe(true);

    act(() => {
      ref.current.toggleSolveMode();
    });
    expect(ref.current.solveMode).toBe(false);
  });
});

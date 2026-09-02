jest.mock('../../services/piBridge.service', () => ({
  fetchPiHealth: jest.fn().mockResolvedValue({ micOk: true, speakerOk: true }),
}));

import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { connectionMonitor } from '../../services/connectionMonitor.service';
import { usePiConnection, usePiDeviceHealth } from '../usePiConnection';
import type { PiConnectionStatus } from '../../services/connectionMonitor.service';

let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

function renderUsePiConnection() {
  const ref: { current: PiConnectionStatus | null } = { current: null };
  function Harness() {
    ref.current = usePiConnection();
    return null;
  }
  act(() => {
    renderer = ReactTestRenderer.create(React.createElement(Harness));
  });
  return ref as { current: PiConnectionStatus };
}

describe('usePiConnection', () => {
  // stop() 이 구독 리스너에 상태 변화를 흘리므로, 마운트가 남아 있으면
  // act() 밖 setState 경고가 난다 - 언마운트 먼저.
  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
    connectionMonitor.stop();
  });

  it('returns the monitor status and follows changes', async () => {
    const ref = renderUsePiConnection();
    expect(ref.current).toBe('connecting');
    await act(async () => {
      connectionMonitor.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(ref.current).toBe('connected');
  });
});

describe('usePiDeviceHealth', () => {
  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
    connectionMonitor.stop();
  });

  it('follows the monitor health and clears on stop()', async () => {
    const ref: { current: unknown } = { current: undefined };
    function Harness() {
      ref.current = usePiDeviceHealth();
      return null;
    }
    act(() => {
      renderer = ReactTestRenderer.create(React.createElement(Harness));
    });
    expect(ref.current).toBeNull();

    await act(async () => {
      connectionMonitor.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(ref.current).toEqual({ micOk: true, speakerOk: true });

    act(() => {
      connectionMonitor.stop();
    });
    expect(ref.current).toBeNull();
  });
});

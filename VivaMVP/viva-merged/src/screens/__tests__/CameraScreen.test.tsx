/**
 * CameraScreen tests (Task 4, task-4-brief.md 완료 기준 1).
 *
 * Per the brief's simulator-limitation override, live shutter capture
 * cannot be exercised under Jest (no camera hardware/native module) — that
 * is real-device-only and tracked as a report TODO. What IS meaningfully
 * testable here without hardware:
 *   - the permission-request screen renders when hasPermission is false
 *     (confirms "Push-to-Talk -> capturing -> CameraScreen renders" per
 *     완료 기준 1), and pressing the permission button calls
 *     requestPermission().
 *   - the "no device" fallback screen renders when useCameraDevice returns
 *     undefined (the actual iOS Simulator condition, since there is no
 *     camera hardware).
 * react-native-vision-camera itself is mocked (see __mocks__/react-native-
 * vision-camera.js) since the native module doesn't exist under Jest.
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import CameraScreen from '../CameraScreen';
import type { TutoringSession } from '../../types/Tutoring';

const mockRequestPermission = jest.fn().mockResolvedValue(true);
const mockUseCameraPermission = jest.fn(() => ({
  hasPermission: false,
  requestPermission: mockRequestPermission,
}));
const mockUseCameraDevice = jest.fn<unknown, []>(() => undefined);
const mockUseCameraDevices = jest.fn<unknown[], []>(() => []);

jest.mock('react-native-vision-camera', () => {
  const ReactActual = require('react');
  const CameraMock = ReactActual.forwardRef((_props: any, _ref: any) => null);
  return {
    Camera: CameraMock,
    useCameraDevice: () => mockUseCameraDevice(),
    useCameraDevices: () => mockUseCameraDevices(),
    useCameraFormat: () => undefined,
    useCameraPermission: () => mockUseCameraPermission(),
  };
});

jest.mock('../../services/gemini.service', () => ({
  analyzeImage: jest.fn(),
}));

function makeSession(): TutoringSession {
  return {
    sessionId: 'test-session',
    problemImageBase64: '',
    fsmState: 'HINT_STAGE',
    hintCount: 0,
    wrongStreak: 0,
    boardRegenerationCount: 0,
  };
}

describe('CameraScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseCameraPermission.mockReturnValue({
      hasPermission: false,
      requestPermission: mockRequestPermission,
    });
    mockUseCameraDevice.mockReturnValue(undefined);
  });

  it('renders the permission-request screen when hasPermission is false (완료 기준 1)', async () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <CameraScreen systemPrompt="test prompt" session={makeSession()} onAnalyzed={jest.fn()} />,
      );
    });

    const permissionScreen = renderer!.root.findByProps({
      testID: 'camera-permission-screen',
    });
    expect(permissionScreen).toBeTruthy();
  });

  it('calls requestPermission() when the permission button is pressed', async () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <CameraScreen systemPrompt="test prompt" session={makeSession()} onAnalyzed={jest.fn()} />,
      );
    });

    const button = renderer!.root.findByProps({
      testID: 'camera-permission-button',
    });
    await act(async () => {
      button.props.onPress();
    });

    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
  });

  it('renders the no-device fallback when permission is granted but no camera device is found (simulator condition)', async () => {
    mockUseCameraPermission.mockReturnValue({
      hasPermission: true,
      requestPermission: mockRequestPermission,
    });
    mockUseCameraDevice.mockReturnValue(undefined);

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <CameraScreen systemPrompt="test prompt" session={makeSession()} onAnalyzed={jest.fn()} />,
      );
    });

    const noDeviceScreen = renderer!.root.findByProps({
      testID: 'camera-no-device-screen',
    });
    expect(noDeviceScreen).toBeTruthy();
  });

  it('renders the camera preview + shutter when permission is granted and a device is found', async () => {
    mockUseCameraPermission.mockReturnValue({
      hasPermission: true,
      requestPermission: mockRequestPermission,
    });
    mockUseCameraDevice.mockReturnValue({ id: 'back-camera' });

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <CameraScreen systemPrompt="test prompt" session={makeSession()} onAnalyzed={jest.fn()} />,
      );
    });

    expect(renderer!.root.findByProps({ testID: 'camera-screen' })).toBeTruthy();
    expect(renderer!.root.findByProps({ testID: 'camera-shutter-button' })).toBeTruthy();
  });

  it('calls onCancel when the cancel button is pressed', async () => {
    const onCancel = jest.fn();
    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <CameraScreen
          systemPrompt="test prompt"
          session={makeSession()}
          onAnalyzed={jest.fn()}
          onCancel={onCancel}
        />,
      );
    });

    const cancelButton = renderer!.root.findByProps({
      testID: 'camera-cancel-button',
    });
    await act(async () => {
      cancelButton.props.onPress();
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

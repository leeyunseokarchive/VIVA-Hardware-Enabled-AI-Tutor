jest.mock('react-native-safe-area-context', () =>
  require('react-native-safe-area-context/jest/mock').default,
);

// src/lib/supabase.ts throws at import time when EXPO_PUBLIC_SUPABASE_* are
// missing (fail-fast in the app). Under Jest that made every suite which
// transitively imports it - useTutoringFSM, screens - fail to load at all.
// A chainable no-op stub keeps those suites runnable without real creds.
jest.mock('./src/lib/supabase', () => {
  const RESULT = { data: [], error: null };
  const chain = {
    then: (resolve) => Promise.resolve(RESULT).then(resolve),
  };
  for (const method of [
    'select', 'insert', 'upsert', 'update', 'delete', 'eq', 'order', 'limit', 'single',
  ]) {
    chain[method] = () => chain;
  }
  return {
    supabase: {
      from: () => chain,
      storage: {
        from: () => ({
          upload: () => Promise.resolve({ data: {}, error: null }),
          getPublicUrl: () => ({ data: { publicUrl: 'https://test.invalid/image.png' } }),
        }),
      },
    },
  };
});

// @react-native-voice/voice's real module constructs a NativeEventEmitter
// around a native module that doesn't exist under Jest - mock its public
// API surface (methods + settable event-handler properties) directly.
jest.mock('@react-native-voice/voice', () => ({
  removeAllListeners: jest.fn(),
  destroy: jest.fn().mockResolvedValue(undefined),
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  cancel: jest.fn().mockResolvedValue(undefined),
  isAvailable: jest.fn().mockResolvedValue(1),
  isRecognizing: jest.fn().mockResolvedValue(0),
  onSpeechStart: null,
  onSpeechRecognized: null,
  onSpeechEnd: null,
  onSpeechError: null,
  onSpeechResults: null,
  onSpeechPartialResults: null,
  onSpeechVolumeChanged: null,
}));

// react-native-background-actions's real module also builds a NativeEventEmitter
// around a missing native module under Jest (same failure mode as Voice above) -
// any suite that transitively imports backgroundKeepAlive.service.ts needs this.
// Test files that assert on FGS calls (backgroundKeepAlive.service.test.ts)
// override this with their own jest.fn()-based factory.
jest.mock('react-native-background-actions', () => ({
  __esModule: true,
  default: {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    isRunning: jest.fn().mockReturnValue(false),
  },
}));

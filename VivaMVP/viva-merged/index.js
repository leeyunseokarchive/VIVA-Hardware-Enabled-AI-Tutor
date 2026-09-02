import 'react-native-url-polyfill/auto';
import { LogBox } from 'react-native';
import { registerRootComponent } from 'expo';

import App from '@app';

// @react-native-voice/voice and react-native-live-audio-stream don't
// implement addListener/removeListeners on their Android native modules.
// This is a known, harmless upstream issue — safe to silence.
LogBox.ignoreLogs([
  "new NativeEventEmitter()` was called with a non-null argument without the required `addListener` method.",
  "new NativeEventEmitter()` was called with a non-null argument without the required `removeListeners` method.",
]);

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);

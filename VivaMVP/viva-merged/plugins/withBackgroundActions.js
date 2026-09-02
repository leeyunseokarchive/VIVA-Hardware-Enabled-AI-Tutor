// Android FGS(connectedDevice) 매니페스트 주입 - CNG(3a51196) 이후
// app.config.js 가 유일한 소스라 커스텀 plugin 으로 넣는다.
// expo-build-properties 는 임의 권한/service 속성 주입을 지원하지 않는다.
const { withAndroidManifest } = require('@expo/config-plugins');

// react-native-background-actions 가 번들한 service. 같은 이름으로 재선언해
// foregroundServiceType 을 매니페스트 머저가 병합하게 한다 (targetSdk 34 필수).
const SERVICE_NAME = 'com.asterinet.react.bgactions.RNBackgroundActionsTask';

const PERMISSIONS = [
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE',
  // connectedDevice 타입의 전제조건 권한 (런타임 다이얼로그 없음)
  'android.permission.CHANGE_NETWORK_STATE',
  // Android 13+ 알림 표시용. 미허용이어도 FGS 자체는 동작한다.
  'android.permission.POST_NOTIFICATIONS',
];

module.exports = function withBackgroundActions(config, { phone = false } = {}) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const app = manifest.manifest.application[0];

    manifest.manifest['uses-permission'] = manifest.manifest['uses-permission'] || [];
    app.service = app.service || [];

    if (phone) {
      // react-native-background-actions 는 오토링킹 대상이라 JS 쪽에서
      // 이 plugin 을 등록하지 않아도 라이브러리가 번들한 AndroidManifest.xml
      // (FOREGROUND_SERVICE 권한 + 무조건부 <service .RNBackgroundActionsTask>)
      // 이 Gradle 매니페스트 머저 단계에서 그대로 병합돼버린다 - phone 앱은
      // FGS 를 쓰지 않으므로 tools:node="remove" 로 머저 단계에서 명시적으로
      // 걷어낸다. (이 파일 자체는 device/phone 두 variant 에 항상 등록된다.)
      // 천장: FOREGROUND_SERVICE 는 매니페스트 전역 권한이라 이 remove 는
      // phone variant 전체에 적용된다 - 나중에 phone 쪽에 FGS 가 필요한
      // 다른 라이브러리가 추가되면 이 줄이 그 권한을 조용히 지워버린다.
      manifest.manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';

      if (!manifest.manifest['uses-permission'].some((p) => p.$['android:name'] === 'android.permission.FOREGROUND_SERVICE')) {
        manifest.manifest['uses-permission'].push({
          $: { 'android:name': 'android.permission.FOREGROUND_SERVICE', 'tools:node': 'remove' },
        });
      }
      if (!app.service.some((s) => s.$['android:name'] === SERVICE_NAME)) {
        app.service.push({ $: { 'android:name': SERVICE_NAME, 'tools:node': 'remove' } });
      }
      return config;
    }

    for (const name of PERMISSIONS) {
      if (!manifest.manifest['uses-permission'].some((p) => p.$['android:name'] === name)) {
        manifest.manifest['uses-permission'].push({ $: { 'android:name': name } });
      }
    }

    const existing = app.service.find((s) => s.$['android:name'] === SERVICE_NAME);
    if (existing) {
      existing.$['android:foregroundServiceType'] = 'connectedDevice';
    } else {
      app.service.push({
        $: {
          'android:name': SERVICE_NAME,
          'android:foregroundServiceType': 'connectedDevice',
        },
      });
    }
    return config;
  });
};

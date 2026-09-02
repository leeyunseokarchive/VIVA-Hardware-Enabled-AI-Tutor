// APP_VARIANT=phone|device (기본 device - 기존 워크플로 유지).
// 폰 단독판은 Pi 로컬넷 관련 권한·예외가 전부 빠진다: NSLocalNetworkUsageDescription,
// NSBonjourServices, viva.local ATS 예외, android usesCleartextTraffic.
const phone = process.env.APP_VARIANT === 'phone';

module.exports = {
  expo: {
    name: phone ? 'VIVA for App' : 'VIVA for Device',
    slug: phone ? 'viva-phone' : 'viva-merged',
    version: '1.0.0',
    orientation: 'landscape',
    icon: phone ? './assets/icon.png' : './assets/icon-device.png',
    userInterfaceStyle: 'light',
    ios: {
      supportsTablet: true,
      bundleIdentifier: phone ? 'com.vivamvp.phone' : 'com.vivamvp.app',
      ...(phone
        ? {}
        : {
            // WiFi 프로비저닝 SSID 자동 채움(currentSsid.ts): iOS 는
            // Access WiFi Information 엔타이틀먼트 + 위치 권한 없이는 SSID 를
            // 못 읽는데, 무료 개발자 계정(Personal Team)은 그 엔타이틀먼트를
            // 발급받을 수 없다(2026-08-11 빌드 실측) - 유료 프로그램 전환 시
            // entitlements: { 'com.apple.developer.networking.wifi-info': true }
            // 를 여기와 ios/VIVAforDevice/VIVAforDevice.entitlements 에 넣고
            // currentSsid.ts 의 iOS gate 를 지울 것. 위치 권한 문구는 그때를
            // 위해 미리 남겨둔다.
            infoPlist: {
              // 무음 오디오 루프로 백그라운드 생존 (backgroundKeepAlive.service.ts).
              // 화면 꺼짐/앱 전환 중에도 Pi 연동 유지 - 2026-08-14 설계.
              UIBackgroundModes: ['audio'],
              NSLocationWhenInUseUsageDescription:
                '현재 연결된 와이파이 이름을 자동으로 채우기 위해 위치 권한이 필요합니다.',
              NSLocalNetworkUsageDescription:
                'VIVA가 로봇 헤드(라즈베리파이)와 같은 와이파이에서 통신하기 위해 로컬 네트워크 접근이 필요합니다.',
              NSBonjourServices: ['_http._tcp'],
              NSAppTransportSecurity: {
                NSExceptionDomains: {
                  'viva.local': {
                    NSExceptionAllowsInsecureHTTPLoads: true,
                    NSIncludesSubdomains: true,
                  },
                },
              },
            },
          }),
    },
    android: {
      package: phone ? 'com.vivamvp.phone' : 'com.vivamvp.app',
      ...(phone ? {} : { usesCleartextTraffic: true }),
      adaptiveIcon: phone
        ? {
            backgroundColor: '#FAF7F0',
            foregroundImage: './assets/android-icon-foreground.png',
            backgroundImage: './assets/android-icon-background.png',
            monochromeImage: './assets/android-icon-monochrome.png',
          }
        : {
            backgroundColor: '#000000',
            foregroundImage: './assets/android-icon-device-foreground.png',
            backgroundImage: './assets/android-icon-device-background.png',
            monochromeImage: './assets/android-icon-device-monochrome.png',
          },
    },
    web: { favicon: './assets/favicon.png' },
    plugins: [
      ['@react-native-voice/voice', { microphonePermission: 'Allow VIVA to access your microphone for voice tutoring.' }],
      ['react-native-vision-camera', { cameraPermissionText: 'Allow VIVA to access your camera to scan math problems.', enableMicrophonePermission: false }],
      'expo-dev-client',
      // RN 명명 규칙(ReactFontManager)에 맞춘 파일명 - Regular/Bold 2종만 배포.
      // Medium/SemiBold 는 RN 이 style 마다 별도 fontFamily 없이는 못 찾아
      // 뺐다: fontWeight 500 은 Regular 로, 600 이상은 Bold 로 스냅된다.
      // expo-font 12 는 top-level fonts 를 iOS/Android 양쪽에 그대로 복사한다
      // (node_modules/expo-font/plugin/build/withFonts.js 확인 완료).
      ['expo-font', {
        fonts: [
          './assets/fonts/Pretendard.otf',
          './assets/fonts/Pretendard_bold.otf',
        ],
      }],
      ['expo-splash-screen', { image: './assets/splash-icon.png', imageWidth: 200, resizeMode: 'contain', backgroundColor: '#FAF7F0' }],
      // Android 백그라운드 생존: FGS(connectedDevice) 매니페스트 주입. 오토링킹
      // 이라 phone 빌드에도 라이브러리 매니페스트가 새므로 양 variant 에 항상
      // 등록 - phone 은 plugin 내부에서 tools:node="remove" 로 걷어낸다.
      ['./plugins/withBackgroundActions.js', { phone }],
    ],
  },
};

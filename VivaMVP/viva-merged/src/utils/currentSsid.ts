import { Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import * as Location from 'expo-location';

// iOS 는 이 플래그가 없으면 details.ssid 를 아예 채우지 않는다.
NetInfo.configure({ shouldFetchWiFiSSID: true });

/** 현재 폰이 붙어 있는 WiFi 의 SSID. 권한 거부·셀룰러·핫스팟 모드면 null.
 * 비밀번호는 iOS/Android 모두 앱에서 읽을 방법이 없다 - SSID 자동 채움이 최선.
 * (iOS 는 추가로 Access WiFi Information 엔타이틀먼트 + 위치 권한이 전제) */
export async function fetchCurrentSsid(): Promise<string | null> {
  // 무료 개발자 계정(Personal Team)은 Access WiFi Information 엔타이틀먼트를
  // 발급받을 수 없어(2026-08-11 빌드 실측) iOS 에선 SSID 가 항상 null 이다 -
  // 위치 권한 프롬프트만 낭비되므로 시도 자체를 막는다. 유료 프로그램 전환 후
  // ios/VIVAforDevice/VIVAforDevice.entitlements 에 wifi-info 를 되살리고
  // 이 gate 를 지울 것.
  if (Platform.OS === 'ios') return null;
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;
    const state = await NetInfo.fetch('wifi');
    const ssid = (state.details as { ssid?: string | null } | null)?.ssid;
    return ssid || null;
  } catch {
    return null; // ponytail: 자동 채움은 best-effort - 실패는 조용히 수동 입력으로
  }
}

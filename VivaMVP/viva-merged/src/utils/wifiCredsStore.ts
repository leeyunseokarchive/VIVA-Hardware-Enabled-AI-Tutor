import AsyncStorage from '@react-native-async-storage/async-storage';

/** 마지막으로 QR 을 만든 SSID/비번 (UX 2차 스펙 §입력 저장·복원).
 * 재설정·재시도 때 재입력을 없애는 용도.
 * ponytail: 평문 AsyncStorage - 집 와이파이 비번, 기기 로컬, MVP.
 * 민감도가 올라가면 expo-secure-store 로 승격. */
const KEY = 'viva.wifiCreds';

export interface WifiCreds {
  ssid: string;
  psk: string;
}

export async function loadWifiCreds(): Promise<WifiCreds | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { ssid?: unknown; psk?: unknown };
    if (typeof v?.ssid === 'string' && typeof v?.psk === 'string') {
      return { ssid: v.ssid, psk: v.psk };
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveWifiCreds(creds: WifiCreds): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(creds));
  } catch {
    // 저장 실패는 조용히 - 다음에 다시 입력하면 된다.
  }
}

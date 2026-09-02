import AsyncStorage from '@react-native-async-storage/async-storage';

const DEVICE_ID_KEY = 'viva_device_id';

// MVP는 로그인 없이 device_id로만 세션을 구분한다. 앱 최초 실행 시 1회 생성해
// AsyncStorage에 저장하고, 이후에는 계속 재사용한다 (Repo 2의 deviceId.ts와 동일 패턴).
export async function getOrCreateDeviceId(): Promise<string> {
  const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;

  const id = generateUuid();
  await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  return id;
}

function generateUuid(): string {
  // RN Hermes에는 crypto.randomUUID가 없을 수 있어 간단한 폴백을 둔다.
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadWifiCreds, saveWifiCreds } from '../wifiCredsStore';

// in-memory 목 - 네이티브 모듈 없이 get/set 동작. (패키지 동봉 목은
// require 가 자기 자신 목으로 재귀해 스택 오버플로 - 직접 만든다.)
jest.mock('@react-native-async-storage/async-storage', () => {
  let mockStore: Record<string, string> = {};
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => mockStore[k] ?? null,
      setItem: async (k: string, v: string) => {
        mockStore[k] = v;
      },
      clear: async () => {
        mockStore = {};
      },
    },
  };
});

describe('wifiCredsStore', () => {
  beforeEach(() => AsyncStorage.clear());

  it('저장한 SSID/비번을 그대로 돌려준다', async () => {
    await saveWifiCreds({ ssid: 'MyHome', psk: 'pass1234' });
    expect(await loadWifiCreds()).toEqual({ ssid: 'MyHome', psk: 'pass1234' });
  });

  it('저장한 적 없으면 null', async () => {
    expect(await loadWifiCreds()).toBeNull();
  });

  it('깨진 JSON 이 저장돼 있으면 null (throw 안 한다)', async () => {
    await AsyncStorage.setItem('viva.wifiCreds', '{broken');
    expect(await loadWifiCreds()).toBeNull();
  });

  it('형태가 다른 값이 저장돼 있으면 null', async () => {
    await AsyncStorage.setItem('viva.wifiCreds', JSON.stringify({ ssid: 1 }));
    expect(await loadWifiCreds()).toBeNull();
  });
});

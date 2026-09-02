import { buildWifiQrPayload, buildWifiQrMatrix } from '../wifiQr';

describe('buildWifiQrPayload', () => {
  it('표준 WIFI: 포맷으로 만든다', () => {
    expect(buildWifiQrPayload('MyHome', 'pass1234')).toBe('WIFI:T:WPA;S:MyHome;P:pass1234;;');
  });

  it('특수문자(\\ ; , : ")를 이스케이프한다', () => {
    expect(buildWifiQrPayload('a;b', 'p:w,"x\\y')).toBe(
      'WIFI:T:WPA;S:a\\;b;P:p\\:w\\,\\"x\\\\y;;',
    );
  });
});

describe('buildWifiQrMatrix', () => {
  it('정사각 boolean 매트릭스를 만들고 파인더 패턴(좌상단 7x7 테두리)이 검정이다', () => {
    const m = buildWifiQrMatrix(buildWifiQrPayload('MyHome', 'pass1234'));
    expect(m.length).toBeGreaterThanOrEqual(21); // QR 최소 버전 크기
    m.forEach((row) => expect(row.length).toBe(m.length));
    for (let i = 0; i < 7; i++) {
      expect(m[0][i]).toBe(true); // 파인더 상변
      expect(m[i][0]).toBe(true); // 파인더 좌변
    }
  });
});

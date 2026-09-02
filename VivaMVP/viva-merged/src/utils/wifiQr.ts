/** 표준 WiFi QR 페이로드 + 매트릭스 생성 (프로비저닝 스펙 §2).
 * 표준 포맷이라 폰 기본 카메라로도 페이로드 검증 가능. 비번은 호출자
 * 메모리에만 존재 - 여기서든 어디서든 저장하지 않는다. */
import qrcode from 'qrcode-generator';

/** WIFI: 포맷 예약문자 이스케이프 (\ ; , : ") - 백슬래시를 맨 먼저. */
function escapeField(v: string): string {
  return v.replace(/([\\;,:"])/g, '\\$1');
}

export function buildWifiQrPayload(ssid: string, psk: string): string {
  return `WIFI:T:WPA;S:${escapeField(ssid)};P:${escapeField(psk)};;`;
}

/** true = 검정 모듈. 버전 자동(0), 오류정정 M - 페이로드가 짧아 저버전
 * (~29x29)으로 나와 로봇 고정초점 카메라 인식 마진이 크다. */
export function buildWifiQrMatrix(payload: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(payload);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) =>
    Array.from({ length: n }, (_, c) => qr.isDark(r, c)),
  );
}

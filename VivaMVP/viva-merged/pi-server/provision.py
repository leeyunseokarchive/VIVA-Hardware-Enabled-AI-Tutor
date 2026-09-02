#!/usr/bin/env python3
"""WiFi 프로비저닝 (D-XX, 2026-08-11 wifi-provisioning 스펙 §3).

WiFi 미연결이면 eyes.py 에 화면 상태를 밀고(provision_new/provision_fail),
카메라로 표준 WiFi QR 을 스캔해 nmcli 로 등록한다. 재연결은 5초 폴링 +
NM 자동연결이 알아서 돈다 (터치 재연결 버튼은 2026-08-13 제거 - 실기기에서
무반응 + 자동 재시도가 있어 거짓 어포던스). 하드웨어(카메라·nmcli·WS)는
지연 import - 개발 머신에서 --selftest 는 로직만 검증한다.
"""
import sys
import time

BOOT_GRACE_S = 30.0     # 부팅 후 저장 네트워크 연결 유예
RUNTIME_LOSS_S = 180.0  # 운영 중 끊김이 이보다 길면 P2 (공유기 재부팅 오탐 방지)
POLL_S = 5.0            # nmcli 상태 폴링 주기


def parse_wifi_qr(data: str):
    """표준 WiFi QR(WIFI:T:WPA;S:..;P:..;;) 파싱. (ssid, psk) 또는 None.

    이스케이프(\\; \\, \\: \\" \\\\)를 풀면서 세미콜론 분리 - 단순 split 은
    'a\\;b' 같은 SSID 를 자른다.
    """
    if not data.startswith("WIFI:"):
        return None
    body = data[5:]
    fields = {}
    key, buf, i = None, [], 0
    while i < len(body):
        ch = body[i]
        if ch == "\\" and i + 1 < len(body):
            buf.append(body[i + 1])
            i += 2
            continue
        if ch == ":" and key is None:
            key = "".join(buf)
            buf = []
        elif ch == ";":
            if key is not None:
                fields[key] = "".join(buf)
            key, buf = None, []
        else:
            buf.append(ch)
        i += 1
    ssid, psk = fields.get("S"), fields.get("P")
    if not ssid or not psk:
        return None
    return ssid, psk


def decide_screen(saved_count, connected, now, boot_t, last_ok_t):
    """어떤 프로비저닝 화면이 필요한가. None = 정상(화면 개입 없음).

    P1: 저장 네트워크가 하나도 없다 - 시도할 게 없으니 유예 없이 즉시.
    P2: 저장 네트워크가 있는데 실패 - 부팅 후 BOOT_GRACE_S, 또는 마지막
        연결 성공 후 RUNTIME_LOSS_S 를 넘겼을 때만 (짧은 끊김 오탐 방지).
    """
    if connected:
        return None
    if saved_count == 0:
        return "provision_new"
    if last_ok_t is None:
        return "provision_fail" if now - boot_t >= BOOT_GRACE_S else None
    return "provision_fail" if now - last_ok_t >= RUNTIME_LOSS_S else None


def selftest():
    # 파서
    assert parse_wifi_qr("WIFI:T:WPA;S:MyHome;P:pass1234;;") == ("MyHome", "pass1234")
    assert parse_wifi_qr('WIFI:T:WPA;S:a\\;b;P:p\\:w\\,\\"x\\\\y;;') == ("a;b", 'p:w,"x\\y')
    assert parse_wifi_qr("WIFI:T:nopass;S:Open;P:;;") is None      # 빈 비번은 거부
    assert parse_wifi_qr("http://example.com") is None             # 무관 QR
    assert parse_wifi_qr("WIFI:T:WPA;P:pw;;") is None              # SSID 없음

    # 화면 판정
    assert decide_screen(0, False, 1.0, 0.0, None) == "provision_new"          # 첫 부팅 즉시
    assert decide_screen(2, False, 10.0, 0.0, None) is None                    # 부팅 유예 중
    assert decide_screen(2, False, 31.0, 0.0, None) == "provision_fail"        # 부팅 실패
    assert decide_screen(2, True, 999.0, 0.0, None) is None                    # 연결됨
    assert decide_screen(2, False, 100.0, 0.0, 50.0) is None                   # 짧은 끊김
    assert decide_screen(2, False, 300.0, 0.0, 100.0) == "provision_fail"      # 장기 끊김
    print("provision selftest ok")


# --- 하드웨어 계층 (Pi 전용 - 전부 지연 import) ------------------------------
EYES_WS_URL = "ws://localhost:8787"
SCAN_INTERVAL_S = 0.4        # ~2.5fps - Zero W 에서 pyzbar 여유
PANEL_SIZE = 480


def _run(cmd):
    import subprocess
    return subprocess.run(cmd, capture_output=True, text=True, timeout=30)


def saved_wifi_count() -> int:
    out = _run(["nmcli", "-t", "-f", "TYPE", "connection", "show"])
    return out.stdout.count("802-11-wireless")


def wifi_connected() -> bool:
    out = _run(["nmcli", "-t", "-f", "TYPE,STATE", "device", "status"])
    return any(line.startswith("wifi:connected") for line in out.stdout.splitlines())


def try_connect(ssid: str, psk: str) -> bool:
    """같은 SSID 프로파일이 이미 있으면 modify+up, 없으면 device wifi connect.

    있는 프로파일에 device wifi connect 를 쓰면 NM 이 부분 업데이트를 시도하다
    "802-11-wireless-security.key-mgmt: property is missing" 으로 거부한다
    (실기기 2026-08-12). P2 의 핵심 시나리오(공유기 비번 변경 후 재등록)가
    정확히 이 경로라 우회가 아니라 본선 수정이다.
    """
    # ponytail: 프로파일 NAME==SSID 가정 - NM 이 자동 생성하는 이름 규칙.
    # 이름이 다른 동일 SSID 프로파일이면 아래 else 로 떨어져 같은 에러를 낸다.
    names = _run(["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"]).stdout
    exists = any(
        line.split(":")[0] == ssid and "802-11-wireless" in line
        for line in names.splitlines()
    )
    if exists:
        r = _run(["nmcli", "connection", "modify", ssid,
                  "802-11-wireless-security.key-mgmt", "wpa-psk",
                  "802-11-wireless-security.psk", psk])
        if r.returncode != 0:
            return False
        return _run(["nmcli", "connection", "up", ssid]).returncode == 0
    return _run(["nmcli", "device", "wifi", "connect", ssid, "password", psk]).returncode == 0


def retry_saved() -> None:
    """저장 네트워크 재시도 - NM 자동연결을 찌른다. 실패해도 루프가 계속 본다.

    rescan 만으로는 NM 이 소진한 autoconnect 재시도 카운터가 안 풀린다 -
    device connect 로 강제 재시도까지 찌른다.
    """
    _run(["nmcli", "device", "wifi", "rescan"])
    # ponytail: wlan0 하드코딩 - 인터페이스 여러 개면 device status 로 골라야 함
    _run(["nmcli", "device", "connect", "wlan0"])


class EyesPusher:
    """eyes.py 로 화면 상태를 미는 WS 클라이언트 (백그라운드 스레드).

    원하는 상태를 set() 으로 갱신하면 연결이 살아있는 한 밀어넣고, 끊기면
    3초 간격 재접속. None 이면 접속 자체를 끊는다 - eyes.py 는 클라이언트가
    사라지면 기존 규칙(disconnect 유예)으로 수렴한다.
    """

    def __init__(self):
        import threading
        self._want = None
        self._lock = threading.Lock()
        threading.Thread(target=self._thread, daemon=True).start()

    def set(self, state):
        with self._lock:
            self._want = state

    def _thread(self):
        import asyncio
        import json

        async def loop():
            import websockets
            while True:
                with self._lock:
                    want = self._want
                if want is None:
                    await asyncio.sleep(1.0)
                    continue
                try:
                    async with websockets.connect(EYES_WS_URL) as ws:
                        sent = None
                        while True:
                            with self._lock:
                                want = self._want
                            if want is None:
                                break  # 접속 종료 - eyes 가 스스로 복귀
                            if want != sent:
                                await ws.send(json.dumps({"eyeState": want}))
                                sent = want
                            await asyncio.sleep(0.5)
                except Exception:
                    await asyncio.sleep(3.0)

        asyncio.run(loop())


def scan_qr_once(cam):
    """카메라 한 프레임에서 WiFi QR 을 찾는다. (ssid, psk) 또는 None."""
    from pyzbar import pyzbar
    frame = cam.capture_array()
    for code in pyzbar.decode(frame):
        parsed = parse_wifi_qr(code.data.decode("utf-8", "replace"))
        if parsed:
            return parsed
    return None


def main():
    pusher = EyesPusher()
    cam = None
    boot_t = time.monotonic()
    last_ok_t = None
    last_poll = 0.0
    saved = 0
    connected = False

    while True:
        try:
            now = time.monotonic()
            if now - last_poll >= POLL_S:
                last_poll = now
                saved = saved_wifi_count()
                connected = wifi_connected()
                if connected:
                    last_ok_t = now
            screen = decide_screen(saved, connected, now, boot_t, last_ok_t)
            pusher.set(screen)

            if screen is None:
                if cam:
                    # stop 만으로는 libcamera acquire 가 안 풀린다 - close 까지
                    # 해야 app.py 가 촬영용으로 카메라를 열 수 있다.
                    cam.stop()
                    cam.close()
                    cam = None
                time.sleep(1.0)
                continue

            if cam is None:
                from picamera2 import Picamera2
                cam = Picamera2()
                cam.configure(cam.create_still_configuration(
                    main={"size": (640, 480), "format": "RGB888"}))
                cam.start()
                # QR 은 15~25cm 거리(앱 안내 문구)라 기본 렌즈 위치(원거리)로는
                # 초점이 안 맞아 pyzbar 가 영영 못 읽는다 - 근거리 연속 AF.
                try:
                    from libcamera import controls
                    cam.set_controls({
                        "AfMode": controls.AfModeEnum.Continuous,
                        "AfRange": controls.AfRangeEnum.Macro,
                    })
                except Exception:
                    pass  # AF 없는 고정초점 모듈이면 그대로 간다
                print("[viva-provision] scan mode:", screen)

            found = scan_qr_once(cam)
            if found:
                ssid, psk = found
                print(f"[viva-provision] QR ok: {ssid}")
                if try_connect(ssid, psk):
                    print("[viva-provision] connected")
                    # 다음 폴에서 connected 반영 - 카메라는 위 screen None 분기가 끈다
                else:
                    print("[viva-provision] connect failed (비번 오류?)")
            time.sleep(SCAN_INTERVAL_S)
        except Exception as e:
            # 개별 원인별 분기 대신 통짜 가드 - pusher 스레드/루프 상태(saved,
            # connected, cam)를 살려서 systemd 재시작 없이 다음 폴에서 복구한다.
            print(f"[viva-provision] loop error: {e}")
            # 카메라 half-init 좀비 방지 - 다음 회차가 init 을 재시도한다.
            if cam is not None:
                try:
                    cam.stop()
                except Exception:
                    pass
                try:
                    cam.close()
                except Exception:
                    pass
                cam = None
            time.sleep(1.0)


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    main()

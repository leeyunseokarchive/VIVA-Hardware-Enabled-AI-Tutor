# 멀티 디바이스 페어링 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 한 네트워크에 로봇 N대 + 폰 N대가 있어도 1:1 배타 쌍으로 안전하게 붙는다 — WiFi QR 토큰 합승 + 토큰 열쇠 서브넷 스윕.

**Architecture:** 폰이 WiFi 프로비저닝 QR에 페어링 토큰(`V:` 필드)을 합승시키고, 로봇(provision.py)이 스캔 시 `/var/lib/viva/pairing.json`에 저장한다. 이후 pi-server 3개 프로세스(app.py HTTP, eyes.py WS, wake.py WS)가 토큰을 강제한다(미페어링이면 오픈 = 하위 호환). 폰은 NetInfo 로 /24를 스윕해 `GET /pair/whoami?token=`으로 자기 로봇 주소를 자동 발견하고 AsyncStorage 에 `{host, token}`을 영속화한다. 로봇 hostname 은 firstboot 에서 Pi serial 로 유니크화한다.

**Tech Stack:** pi-server: Python 3(Flask, websockets, unittest). 앱: React Native/Expo(TypeScript, jest, AsyncStorage, NetInfo 11.3.1). HW: sh 스크립트(VivaHW).

**Spec:** [docs/superpowers/specs/2026-08-20-multi-device-pairing-design.md](../specs/2026-08-20-multi-device-pairing-design.md)

## Global Constraints

- 새 npm/pip 의존성 금지. 유일한 예외: 토큰 생성에서 `crypto.getRandomValues` 가 현 RN/Hermes 에 없을 때만 `npx expo install expo-crypto` (Task 7 Step 4).
- 토큰: 16바이트 랜덤 hex 32자. `Math.random` 절대 금지 (보안 토큰).
- 토큰 전달: HTTP 는 `X-Viva-Token` 헤더, WS 는 `?token=` 쿼리.
- 미페어링(토큰 파일 없음) 로봇은 전부 무인증 오픈 — 기존 동작과 동일해야 한다 (QA 경로·하위 호환).
- `/health` 는 항상 무인증.
- 인증 실패: HTTP 403, WS 는 close code 4403.
- 파일 경로 상수: 로봇 `/var/lib/viva/pairing.json` (테스트용 env `VIVA_PAIRING_PATH`), 앱 AsyncStorage 키 `viva.pairing`.
- WiFi QR 포맷: `WIFI:T:WPA;S:<ssid>;P:<psk>;V:<token>;;` — 표준 필드 순서·이스케이프 규칙 유지.
- pi-server 테스트: `cd pi-server && python3 -m unittest test_<name> -v`. 앱 테스트: `npm test -- <path>` (viva-merged 루트).
- 커밋 메시지는 기존 컨벤션(한국어, `feat:`/`fix:`/`docs:` 접두사).
- 모든 작업 완료 후 `docs/process.md` 갱신 (AGENTS.md 규칙, Task 13).

---

### Task 1: pi-server pairing.py — 토큰 저장·검증 코어

**Files:**
- Create: `pi-server/pairing.py`
- Test: `pi-server/test_pairing.py`

**Interfaces:**
- Produces: `load_token(path=None) -> str|None`, `save_token(token, path=None)`, `delete_token(path=None)`, `http_allowed(stored, sent) -> bool`, `token_from_ws_path(path) -> str|None`, `ws_allowed(stored, path, remote_ip) -> bool`, `ws_request_path(ws) -> str`, `TOKEN_PATH`. Task 2~5가 전부 이걸 쓴다.

- [ ] **Step 1: Write the failing test**

`pi-server/test_pairing.py`:

```python
import os
import tempfile
import unittest

from pairing import (
    load_token, save_token, delete_token,
    http_allowed, token_from_ws_path, ws_allowed,
)


class TokenStoreTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "sub", "pairing.json")

    def tearDown(self):
        self.dir.cleanup()

    def test_missing_file_is_unpaired(self):
        self.assertIsNone(load_token(self.path))

    def test_save_then_load_roundtrip(self):
        save_token("a" * 32, self.path)  # 중간 디렉토리도 만든다
        self.assertEqual(load_token(self.path), "a" * 32)

    def test_corrupt_file_is_unpaired(self):
        os.makedirs(os.path.dirname(self.path))
        with open(self.path, "w") as f:
            f.write("not json")
        self.assertIsNone(load_token(self.path))

    def test_empty_token_is_unpaired(self):
        os.makedirs(os.path.dirname(self.path))
        with open(self.path, "w") as f:
            f.write('{"token": ""}')
        self.assertIsNone(load_token(self.path))

    def test_delete_is_idempotent(self):
        save_token("t", self.path)
        delete_token(self.path)
        delete_token(self.path)  # 없어도 안 죽는다
        self.assertIsNone(load_token(self.path))


class AuthTest(unittest.TestCase):
    def test_http_unpaired_allows_everything(self):
        self.assertTrue(http_allowed(None, None))
        self.assertTrue(http_allowed(None, "whatever"))

    def test_http_paired_requires_exact_token(self):
        self.assertTrue(http_allowed("tok", "tok"))
        self.assertFalse(http_allowed("tok", None))
        self.assertFalse(http_allowed("tok", "wrong"))

    def test_token_from_ws_path(self):
        self.assertEqual(token_from_ws_path("/?token=abc"), "abc")
        self.assertEqual(token_from_ws_path("/sub?x=1&token=abc"), "abc")
        self.assertIsNone(token_from_ws_path("/"))
        self.assertIsNone(token_from_ws_path(None))
        self.assertIsNone(token_from_ws_path("/?token="))

    def test_ws_unpaired_allows(self):
        self.assertTrue(ws_allowed(None, "/", "192.168.0.9"))

    def test_ws_localhost_bypasses(self):
        # provision.py 가 로컬 WS 클라이언트로 eyes.py 에 붙는다 - 토큰 면제
        self.assertTrue(ws_allowed("tok", "/", "127.0.0.1"))
        self.assertTrue(ws_allowed("tok", "/", "::1"))

    def test_ws_paired_requires_token(self):
        self.assertTrue(ws_allowed("tok", "/?token=tok", "192.168.0.9"))
        self.assertFalse(ws_allowed("tok", "/", "192.168.0.9"))
        self.assertFalse(ws_allowed("tok", "/?token=bad", "192.168.0.9"))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pi-server && python3 -m unittest test_pairing -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pairing'`

- [ ] **Step 3: Write minimal implementation**

`pi-server/pairing.py`:

```python
"""페어링 토큰 저장/검증 (2026-08-20 multi-device-pairing 스펙 §4).

토큰은 폰이 WiFi QR 의 V 필드로 전달하고 provision.py 가 저장한다.
파일이 없으면 미페어링 = 전 엔드포인트 무인증 오픈 (QA 경로, 하위 호환).
app.py / eyes.py / wake.py 가 요청마다 load_token 을 부른다 - 파일 하나
읽기라 IPC 없이 세 프로세스가 같은 상태를 본다.
"""
import json
import os
from urllib.parse import parse_qs, urlparse

TOKEN_PATH = os.environ.get("VIVA_PAIRING_PATH", "/var/lib/viva/pairing.json")


def load_token(path=None):
    """저장된 토큰. 없거나 깨졌거나 비었으면 None (= 미페어링)."""
    try:
        with open(path or TOKEN_PATH) as f:
            v = json.load(f).get("token")
        return v if isinstance(v, str) and v else None
    except (OSError, ValueError):
        return None


def save_token(token, path=None):
    p = path or TOKEN_PATH
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"token": token}, f)
    os.replace(tmp, p)  # 쓰다 만 파일이 미페어링으로 오판되지 않게 원자 교체


def delete_token(path=None):
    try:
        os.remove(path or TOKEN_PATH)
    except FileNotFoundError:
        pass


def http_allowed(stored, sent):
    """HTTP 요청 허용 여부. 미페어링이면 전부 허용 (기존 동작)."""
    return stored is None or sent == stored


def token_from_ws_path(path):
    """'/sub?token=abc' -> 'abc'. 없으면 None."""
    v = parse_qs(urlparse(path or "").query).get("token", [None])[0]
    return v or None


def ws_allowed(stored, path, remote_ip):
    """WS 접속 허용 여부. localhost 는 면제 - provision.py 가 로컬
    클라이언트로 eyes.py 에 상태를 민다."""
    if stored is None or remote_ip in ("127.0.0.1", "::1"):
        return True
    return token_from_ws_path(path) == stored


def ws_request_path(ws):
    """websockets 신/구 API 겸용 경로 추출 (>=13: ws.request.path,
    구버전: ws.path)."""
    req = getattr(ws, "request", None)
    if req is not None and getattr(req, "path", None):
        return req.path
    return getattr(ws, "path", "") or ""
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pi-server && python3 -m unittest test_pairing -v`
Expected: PASS (11 tests OK)

- [ ] **Step 5: Commit**

```bash
git add pi-server/pairing.py pi-server/test_pairing.py
git commit -m "feat(pi): 페어링 토큰 저장·검증 코어 (pairing.py)"
```

---

### Task 2: provision.py — WiFi QR V 필드 파싱 + 토큰 저장

**Files:**
- Modify: `pi-server/provision.py` (parse_wifi_qr, selftest, scan_qr_once, main)

**Interfaces:**
- Consumes: Task 1 `save_token`.
- Produces: `parse_wifi_qr(data) -> (ssid, psk, token|None) | None` — 반환이 2-튜플에서 3-튜플로 바뀐다. 이 함수의 다른 소비자는 이 파일 안(selftest, scan_qr_once)뿐임을 `grep -rn parse_wifi_qr` 로 확인할 것.

- [ ] **Step 1: Write the failing test (selftest 확장)**

`provision.py` 의 `selftest()` 파서 블록을 다음으로 교체:

```python
    # 파서 (V = 페어링 토큰, multi-device-pairing 스펙 §2)
    assert parse_wifi_qr("WIFI:T:WPA;S:MyHome;P:pass1234;;") == ("MyHome", "pass1234", None)
    assert parse_wifi_qr("WIFI:T:WPA;S:MyHome;P:pass1234;V:abc123;;") == \
        ("MyHome", "pass1234", "abc123")
    assert parse_wifi_qr('WIFI:T:WPA;S:a\\;b;P:p\\:w\\,\\"x\\\\y;;') == ("a;b", 'p:w,"x\\y', None)
    assert parse_wifi_qr("WIFI:T:nopass;S:Open;P:;;") is None      # 빈 비번은 거부
    assert parse_wifi_qr("http://example.com") is None             # 무관 QR
    assert parse_wifi_qr("WIFI:T:WPA;P:pw;;") is None              # SSID 없음
    assert parse_wifi_qr("WIFI:T:WPA;S:H;P:pw;V:;;") == ("H", "pw", None)  # 빈 토큰 = 없음
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd pi-server && python3 provision.py --selftest`
Expected: `AssertionError` (2-튜플 반환이라 3-튜플 비교 실패)

- [ ] **Step 3: Implement**

`parse_wifi_qr` 마지막 4줄을 교체 (파싱 루프는 이미 임의 key 를 fields 딕셔너리에 담는다 — V 는 공짜):

```python
    ssid, psk = fields.get("S"), fields.get("P")
    if not ssid or not psk:
        return None
    return ssid, psk, fields.get("V") or None
```

독스트링 첫 줄도 갱신: `"""표준 WiFi QR(WIFI:T:WPA;S:..;P:..;V:<페어링토큰>;;) 파싱. (ssid, psk, token|None) 또는 None.`

`scan_qr_once` 는 반환값을 그대로 통과시키므로 독스트링만 갱신: `(ssid, psk, token|None) 또는 None.`

`main()` 의 QR 성공 분기를 교체:

```python
            found = scan_qr_once(cam)
            if found:
                ssid, psk, token = found
                print(f"[viva-provision] QR ok: {ssid}")
                if try_connect(ssid, psk):
                    print("[viva-provision] connected")
                    if token:
                        # 접속 성공한 QR 만 페어링으로 인정 - 이웃의 틀린 QR 이
                        # 토큰만 심고 가는 것 방지 (스펙 §2).
                        from pairing import save_token
                        save_token(token)
                        print("[viva-provision] paired")
                    # 다음 폴에서 connected 반영 - 카메라는 위 screen None 분기가 끈다
                else:
                    print("[viva-provision] connect failed (비번 오류?)")
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd pi-server && python3 provision.py --selftest`
Expected: `provision selftest ok`

- [ ] **Step 5: Commit**

```bash
git add pi-server/provision.py
git commit -m "feat(pi): WiFi QR V 필드로 페어링 토큰 수신·저장 (provision.py)"
```

---

### Task 3: app.py — 토큰 가드 + /pair 엔드포인트

**Files:**
- Modify: `pi-server/app.py`

**Interfaces:**
- Consumes: Task 1 전부.
- Produces: `GET /pair/whoami?token=` → 200 `{"hostname": "viva-3f7a"}` / 404(미페어링) / 403(불일치). `POST /pair` body `{"token": "..."}` → 200 / 400 / 409(이미 다른 토큰으로 페어링). `DELETE /pair` (헤더 인증) → 200. 그 외 전 엔드포인트: 페어링 시 `X-Viva-Token` 헤더 필수. Task 9~12의 앱이 이 계약을 쓴다.

로직은 전부 Task 1에서 테스트된 pairing.py 에 있다. app.py 는 모듈 최상단에서 picamera2 를 임포트해 개발 머신 단위 테스트가 불가 — 여기는 얇은 배선만 하고 문법 검증 + 실기기 §Task 14 체크리스트로 확인한다.

- [ ] **Step 1: import 추가**

`from cam_health import cam_health` 줄 아래에:

```python
import socket

from pairing import load_token, save_token, delete_token, http_allowed
```

- [ ] **Step 2: before_request 가드 추가**

`app = Flask(__name__)` 바로 아래에:

```python
# 페어링 인증 (multi-device-pairing 스펙 §4). 미페어링이면 전부 오픈.
# 예외: /health(QA·모니터링, 유출 정보 없음), /pair 계열(자체 검증).
AUTH_EXEMPT = {"/health", "/pair", "/pair/whoami"}


@app.before_request
def _require_token():
    if request.path in AUTH_EXEMPT:
        return None
    if not http_allowed(load_token(), request.headers.get("X-Viva-Token")):
        return jsonify({"error": "invalid token"}), 403
    return None
```

- [ ] **Step 3: /pair 엔드포인트 추가**

`/health` 라우트 위에:

```python
@app.route("/pair/whoami", methods=["GET"])
def pair_whoami():
    """토큰 열쇠 서브넷 스윕용 (스펙 §2). 자기 토큰을 가진 폰에게만
    hostname 을 알려준다 - 교실 20쌍이 동시에 스윕해도 각자 자기 로봇만
    발견한다."""
    stored = load_token()
    if stored is None:
        return jsonify({"error": "unpaired"}), 404
    if request.args.get("token") != stored:
        return jsonify({"error": "invalid token"}), 403
    return jsonify({"hostname": socket.gethostname()})


@app.route("/pair", methods=["POST"])
def pair_claim():
    """재페어링 경로 (스펙 §4): WiFi 가 살아있는 미페어링 로봇에 새 폰이
    hostname 수동 입력으로 토큰을 심는다. QR 경로는 provision.py 몫."""
    body = request.get_json(silent=True) or {}
    token = body.get("token")
    if not isinstance(token, str) or not token:
        return jsonify({"error": "body must have token"}), 400
    stored = load_token()
    if stored is not None and token != stored:
        return jsonify({"error": "already paired"}), 409
    save_token(token)
    return jsonify({"status": "paired", "hostname": socket.gethostname()})


@app.route("/pair", methods=["DELETE"])
def pair_delete():
    """언페어 (구 폰의 앱 설정에서). 페어링 상태면 헤더 인증 필수 -
    before_request 예외 경로라 여기서 직접 검사한다."""
    stored = load_token()
    if stored is not None and request.headers.get("X-Viva-Token") != stored:
        return jsonify({"error": "invalid token"}), 403
    delete_token()
    return jsonify({"status": "unpaired"})
```

- [ ] **Step 4: 문법 검증**

Run: `cd pi-server && python3 -m py_compile app.py && echo OK`
Expected: `OK`

Run: `cd pi-server && python3 -m unittest test_pairing -v`
Expected: PASS (회귀 없음)

- [ ] **Step 5: Commit**

```bash
git add pi-server/app.py
git commit -m "feat(pi): HTTP 토큰 가드 + /pair whoami·claim·delete (app.py)"
```

---

### Task 4: wake.py + eyes.py — WS 토큰 게이트

**Files:**
- Modify: `pi-server/wake.py` (`_handler`)
- Modify: `pi-server/eyes.py` (`_handler`)
- Test: `pi-server/test_pairing.py` (게이트 판정은 Task 1의 `ws_allowed` 로 이미 커버 — 여기는 배선)

**Interfaces:**
- Consumes: Task 1 `load_token, ws_allowed, ws_request_path`.
- Produces: 페어링된 로봇의 :8787/:8788 은 `?token=<토큰>` 없는 원격 접속을 code 4403 으로 닫는다. Task 11 앱 WS 가 이 계약을 쓴다.

- [ ] **Step 1: wake.py `_handler` 수정**

```python
async def _handler(relay, ws):
    from pairing import load_token, ws_allowed, ws_request_path
    ip = ws.remote_address[0] if ws.remote_address else ""
    if not ws_allowed(load_token(), ws_request_path(ws), ip):
        print(f"[viva-wake] rejected client (invalid token) from {ip}")
        await ws.close(code=4403, reason="invalid token")
        return
    try:
        await _relay_loop(relay, ws)
    except Exception as e:
        # 폰이 Wi-Fi 끊김 등으로 close frame 없이 사라지는 건 정상 경로다 -
        # 연결마다 traceback 을 journal 에 쌓지 않는다.
        print(f"[viva-wake] client dropped: {type(e).__name__}")
    finally:
        await relay.disconnect(ws)
```

(지연 임포트 — 개발 Mac 에서 test_wake.py 임포트가 pairing 경로 상수에 안 걸리게, 파일 상단 websockets 지연 임포트와 같은 관례.)

- [ ] **Step 2: eyes.py `_handler` 수정**

기존 `_handler` 맨 앞(`_clients.add(ws)` 이전)에:

```python
async def _handler(ws):
    from pairing import load_token, ws_allowed, ws_request_path
    ip = ws.remote_address[0] if ws.remote_address else ""
    if not ws_allowed(load_token(), ws_request_path(ws), ip):
        # provision.py(localhost)는 면제 - ws_allowed 가 처리
        print(f"[viva-eyes] rejected client (invalid token) from {ip}")
        await ws.close(code=4403, reason="invalid token")
        return
    _clients.add(ws)
    ...  # 이하 기존 코드 그대로
```

주의: eyes.py `--selftest` 의 `_FakeWS` 가 `_handler` 를 직접 부른다 (라인 ~890). `_FakeWS` 에 `remote_address = ("127.0.0.1", 0)` 속성을 추가해 localhost 면제로 통과시킨다 — selftest 클래스 정의를 찾아 한 줄 추가:

```python
        remote_address = ("127.0.0.1", 0)
```

- [ ] **Step 3: 검증**

Run: `cd pi-server && python3 -m unittest test_wake -v`
Expected: PASS (기존 테스트는 `_relay_loop`/`WakeRelay` 를 직접 부르므로 회귀 없음. `_handler` 를 부르는 테스트가 있으면 `_FakeWS` 패턴처럼 `remote_address` 를 준다)

Run: `cd pi-server && python3 -m py_compile eyes.py wake.py && echo OK`
Expected: `OK`

eyes.py selftest 는 pygame 필요 — 개발 머신에 있으면 `python3 eyes.py --selftest` 도 실행 (Expected: `eyes selftest ok` 계열 출력), 없으면 실기기 검증(§Task 14)으로 미룬다.

- [ ] **Step 4: Commit**

```bash
git add pi-server/wake.py pi-server/eyes.py
git commit -m "feat(pi): 눈·호출어 WS 토큰 게이트 (4403 close)"
```

---

### Task 5: eyes.py — 특수 화면에 로봇 이름 표시

**Files:**
- Modify: `pi-server/eyes.py` (상수 + Renderer.__init__ + draw)

**Interfaces:**
- Produces: provision_new / provision_fail / disconnected 화면 하단에 hostname(`viva-3f7a`) 소형 텍스트. 수동 입력 폴백(Task 12)에서 사용자가 이 이름을 읽는다.

- [ ] **Step 1: 상수 추가**

`FAULT_MARGIN = 28` 근처(프로비저닝 화면 상수 블록 아래)에:

```python
# 로봇 이름 (hostname) - 페어링 수동 입력 폴백에서 사용자가 읽는다
# (multi-device-pairing 스펙 §2·§3). 원형 패널 하단 chord 안에 든다.
NAME_TEXT_SIZE, NAME_TEXT_Y = 16, 436
```

- [ ] **Step 2: Renderer.__init__ 에 베이크 추가**

`self.pv_status = ...` 줄 아래에:

```python
        # 로봇 이름 - 특수 화면(프로비저닝·끊김)에서만 보여준다.
        import socket
        name_font = _load_kr_font(NAME_TEXT_SIZE)
        self.name_line = (name_font.render(socket.gethostname(), True, FG)
                          if name_font else None)
```

- [ ] **Step 3: draw 에 blit 추가**

provision 분기의 `return` 직전과 disconnected 분기의 `return` 직전, 두 곳에 동일하게:

```python
            if self.name_line:
                self.name_line.set_alpha(int(255 * 0.45 * enter))
                surface.blit(self.name_line,
                             self.name_line.get_rect(center=(cx, NAME_TEXT_Y)))
```

- [ ] **Step 4: 검증**

Run: `cd pi-server && python3 -m py_compile eyes.py && echo OK`
Expected: `OK`

pygame 있는 머신이면: `python3 eyes.py --selftest` — 기존 selftest 가 provision/disconnected 화면의 비어있지 않음을 이미 검사하므로 통과가 곧 렌더 회귀 없음. `--window` 모드에서 키 6/7/8 로 육안 확인 가능.

- [ ] **Step 5: Commit**

```bash
git add pi-server/eyes.py
git commit -m "feat(pi): 프로비저닝·끊김 화면에 로봇 이름 표시 (eyes.py)"
```

---

### Task 6: VivaHW firstboot — hostname 유니크화 + 페어링 클린

**Files:**
- Modify: `../../../VivaHW/scripts/viva-firstboot.sh` (viva-merged 기준 상대경로 — 절대경로 `VivaHW/scripts/viva-firstboot.sh`, 같은 git 저장소)
- Modify: `../../../VivaHW/scripts/viva-seal.sh`
- Modify: `../../../VivaHW/README.md` (§6 체크리스트)

**Interfaces:**
- Produces: 복제본 첫 부팅 후 hostname = `viva-<serial 끝4>`. avahi 가 `viva-XXXX.local` 광고. `socket.gethostname()`(Task 3·5)이 이 이름을 반환.

- [ ] **Step 1: 파생 로직 검증 스크립트 먼저 (러너블 체크)**

`VivaHW/scripts/test-firstboot-suffix.sh` 생성:

```sh
#!/bin/sh
# viva-firstboot.sh 의 serial->suffix 파생 검증. 개발 머신에서 실행 가능.
set -eu
derive() { printf '%s\n' "$1" | awk '/^Serial/ {print substr($3, length($3)-3)}'; }
[ "$(derive 'Serial		: 100000003f7a4b2c')" = "4b2c" ]
[ "$(derive 'Serial		: 0000000000003f7a')" = "3f7a" ]
[ -z "$(derive 'Revision	: 902120')" ]  # Serial 줄 없으면 빈 값
echo "firstboot suffix selftest ok"
```

Run: `sh VivaHW/scripts/test-firstboot-suffix.sh`
Expected: `firstboot suffix selftest ok`

- [ ] **Step 2: viva-firstboot.sh 교체**

```sh
#!/bin/sh
# viva-firstboot: 복제 이미지 첫 부팅 1회 유니크화. viva-seal.sh 가 예약한다.
# machine-id 는 systemd 가 스스로 재생성하므로 여기서는 SSH 호스트키,
# hostname(Pi serial 끝 4자리), 페어링 상태만 처리한다.
set -eu
rm -f /etc/ssh/ssh_host_*
ssh-keygen -A
# hostname: viva -> viva-XXXX. mDNS 이름 충돌 방지 (multi-device-pairing §3).
# 이 이름이 로봇 밑면 라벨·페어링 수동 입력·QA 식별의 기준이다.
suffix="$(awk '/^Serial/ {print substr($3, length($3)-3)}' /proc/cpuinfo)"
if [ -n "$suffix" ]; then
    hostnamectl set-hostname "viva-$suffix"
    sed -i "s/^127\.0\.1\.1.*/127.0.1.1\tviva-$suffix/" /etc/hosts
fi
# 마스터의 페어링이 복제본에 따라오면 안 된다
rm -f /var/lib/viva/pairing.json
rm -f /etc/viva-firstboot-pending
```

- [ ] **Step 3: viva-seal.sh 청소 절에 한 줄 추가**

`rm -f /home/viva/.bash_history /root/.bash_history` 아래:

```sh
rm -f /var/lib/viva/pairing.json
```

- [ ] **Step 4: README §6 체크리스트 갱신**

`VivaHW/README.md` §6.3(첫 부팅 확인 항목, "SSH 호스트키가 마스터와 다른지" 근처)에 항목 추가:

```markdown
   hostname 이 `viva-<serial 끝4>` 로 유니크한지 (`hostname` / 앱 없이
   `ping viva-XXXX.local`), 밑면 라벨과 일치하는지
```

같은 절의 hostname 표(`| hostname | viva |`)에 주석 추가: `| hostname | `viva` (마스터. 복제본은 firstboot 가 `viva-XXXX` 로 유니크화) |`

- [ ] **Step 5: 검증 + Commit**

Run: `sh -n VivaHW/scripts/viva-firstboot.sh && sh -n VivaHW/scripts/viva-seal.sh && echo OK`
Expected: `OK`

```bash
git add VivaHW/scripts/viva-firstboot.sh VivaHW/scripts/viva-seal.sh VivaHW/scripts/test-firstboot-suffix.sh VivaHW/README.md
git commit -m "feat(hw): firstboot hostname 유니크화 + 페어링 클린 (골든 이미지 v2)"
```

---

### Task 7: 앱 pairingStore — 영속화 + 토큰 생성

**Files:**
- Create: `src/utils/pairingStore.ts`
- Test: `src/utils/__tests__/pairingStore.test.ts`

**Interfaces:**
- Produces: `interface Pairing { host: string; token: string; lastIp?: string }`, `loadPairing(): Promise<Pairing | null>`, `savePairing(p: Pairing): Promise<void>`, `clearPairing(): Promise<void>`, `newPairingToken(): string` (hex 32자). Task 9·12가 소비.

- [ ] **Step 1: Write the failing test**

`src/utils/__tests__/pairingStore.test.ts` (wifiCredsStore.test.ts 와 같은 패턴 — 그 파일의 AsyncStorage 모킹 방식을 먼저 열어 동일하게 맞춘다):

```typescript
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  loadPairing,
  savePairing,
  clearPairing,
  newPairingToken,
} from '../pairingStore';

describe('pairingStore', () => {
  beforeEach(() => AsyncStorage.clear());

  it('빈 저장소는 null', async () => {
    expect(await loadPairing()).toBeNull();
  });

  it('save 후 load 왕복', async () => {
    await savePairing({ host: 'viva-3f7a.local', token: 'a'.repeat(32), lastIp: '192.168.0.7' });
    expect(await loadPairing()).toEqual({
      host: 'viva-3f7a.local',
      token: 'a'.repeat(32),
      lastIp: '192.168.0.7',
    });
  });

  it('깨진 JSON 은 null', async () => {
    await AsyncStorage.setItem('viva.pairing', 'not json');
    expect(await loadPairing()).toBeNull();
  });

  it('clear 후 null', async () => {
    await savePairing({ host: 'h.local', token: 't' });
    await clearPairing();
    expect(await loadPairing()).toBeNull();
  });

  it('토큰은 hex 32자, 호출마다 다르다', () => {
    const a = newPairingToken();
    const b = newPairingToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toEqual(b);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/utils/__tests__/pairingStore.test.ts`
Expected: FAIL — `Cannot find module '../pairingStore'`

- [ ] **Step 3: Implement**

`src/utils/pairingStore.ts`:

```typescript
import AsyncStorage from '@react-native-async-storage/async-storage';

/** 페어링된 로봇 (multi-device-pairing 스펙 §2·§5).
 * host 가 주소의 기준(mDNS resolve 는 OS 공짜) - lastIp 는 스윕이 마지막으로
 * 본 IP 로, 디버그·향후 mDNS 불안정 망 폴백용 기록일 뿐 현재 미사용.
 * ponytail: 평문 AsyncStorage - wifiCredsStore 와 같은 기준, 민감도가
 * 올라가면 expo-secure-store 로 승격. */
const KEY = 'viva.pairing';

export interface Pairing {
  host: string;
  token: string;
  lastIp?: string;
}

export async function loadPairing(): Promise<Pairing | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { host?: unknown; token?: unknown; lastIp?: unknown };
    if (typeof v?.host === 'string' && typeof v?.token === 'string') {
      return {
        host: v.host,
        token: v.token,
        ...(typeof v.lastIp === 'string' ? { lastIp: v.lastIp } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function savePairing(p: Pairing): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // 저장 실패는 조용히 - 다음 페어링에서 다시 쓴다.
  }
}

export async function clearPairing(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // 삭제 실패는 조용히.
  }
}

/** 페어링 토큰: 16바이트 랜덤 hex 32자. Math.random 금지 - 같은 망
 * 도청/추측 차단이 이 토큰의 존재 이유다. */
export function newPairingToken(): string {
  const bytes = new Uint8Array(16);
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (!cryptoObj?.getRandomValues) {
    // 여기 걸리면 expo-crypto 를 설치하고 이 함수를 교체할 것 (계획 Task 7 Step 4).
    throw new Error('[pairingStore] crypto.getRandomValues 없음 - expo-crypto 필요');
  }
  cryptoObj.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 4: Run to verify + Hermes 확인**

Run: `npm test -- src/utils/__tests__/pairingStore.test.ts`
Expected: PASS (jest/node 는 globalThis.crypto 보유)

**실기기/시뮬레이터 확인 필수** (Hermes 는 버전에 따라 `crypto.getRandomValues` 가 없다): dev 빌드 콘솔에서 `newPairingToken()` 1회 호출해 throw 여부 확인. throw 하면:

```bash
npx expo install expo-crypto
```

그리고 `newPairingToken` 을 다음으로 교체 (테스트는 그대로 통과해야 한다):

```typescript
import * as Crypto from 'expo-crypto';

export function newPairingToken(): string {
  const bytes = Crypto.getRandomBytes(16);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 5: Commit**

```bash
git add src/utils/pairingStore.ts src/utils/__tests__/pairingStore.test.ts
git commit -m "feat: 페어링 저장소 + 보안 토큰 생성 (pairingStore)"
```

---

### Task 8: wifiQr — V 필드 합승

**Files:**
- Modify: `src/utils/wifiQr.ts`
- Test: `src/utils/__tests__/wifiQr.test.ts` (기존 파일에 케이스 추가)

**Interfaces:**
- Produces: `buildWifiQrPayload(ssid, psk, token?)` — token 있으면 `V:<token>;` 를 `P:` 뒤에 붙인다. Task 12가 소비. 기존 2-인자 호출은 동작 불변.

- [ ] **Step 1: Write the failing test**

기존 `src/utils/__tests__/wifiQr.test.ts` 에 추가:

```typescript
  it('토큰이 있으면 V 필드를 붙인다', () => {
    expect(buildWifiQrPayload('Home', 'pw', 'abc123')).toBe(
      'WIFI:T:WPA;S:Home;P:pw;V:abc123;;',
    );
  });

  it('토큰이 없으면 기존 포맷 그대로', () => {
    expect(buildWifiQrPayload('Home', 'pw')).toBe('WIFI:T:WPA;S:Home;P:pw;;');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/utils/__tests__/wifiQr.test.ts`
Expected: FAIL (V 필드 케이스)

- [ ] **Step 3: Implement**

```typescript
export function buildWifiQrPayload(ssid: string, psk: string, token?: string): string {
  // V = VIVA 페어링 토큰 (비표준 확장, multi-device-pairing 스펙 §2).
  // 표준 파서는 미지 필드를 무시하므로 폰 기본 카메라 검증도 그대로 된다.
  const v = token ? `V:${escapeField(token)};` : '';
  return `WIFI:T:WPA;S:${escapeField(ssid)};P:${escapeField(psk)};${v};`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- src/utils/__tests__/wifiQr.test.ts`
Expected: PASS (기존 케이스 포함 전부)

- [ ] **Step 5: Commit**

```bash
git add src/utils/wifiQr.ts src/utils/__tests__/wifiQr.test.ts
git commit -m "feat: WiFi QR 에 페어링 토큰 V 필드 합승 (wifiQr)"
```

---

### Task 9: piBridge — 런타임 host/token + 403 훅

**Files:**
- Modify: `src/device/services/piBridge.service.ts`
- Test: `src/device/services/__tests__/piBridge.pairing.test.ts` (신규)

**Interfaces:**
- Consumes: Task 7 `loadPairing`.
- Produces: `configurePi(host: string | null, token: string | null): void`, `initPairingFromStore(): Promise<void>`, `getPiToken(): string | null`, `getEyeSyncWsUrl(): string`, `setAuthRejectedHandler(cb: (() => void) | null): void`, `pairRobot(host: string, token: string): Promise<string>` (POST /pair, hostname 반환), `unpairRobot(): Promise<void>` (DELETE /pair). `getPiBaseUrl()` 은 유지하되 런타임 host 반영. Task 10~13이 소비.

- [ ] **Step 1: Write the failing test**

`src/device/services/__tests__/piBridge.pairing.test.ts` (기존 `piBridge.health.test.ts` 의 fetch 모킹 패턴을 먼저 열어 동일하게 맞춘다):

```typescript
import {
  configurePi,
  getPiBaseUrl,
  getPiToken,
  getEyeSyncWsUrl,
  fetchPiHealth,
  setAuthRejectedHandler,
} from '../piBridge.service';

describe('piBridge pairing', () => {
  afterEach(() => {
    setAuthRejectedHandler(null);
    jest.restoreAllMocks();
  });

  // 모듈 상태(piHost/pairedHost)는 테스트 간 공유된다 - configurePi 를
  // 아직 안 부른 "페어링 전" 검증은 반드시 첫 테스트여야 한다.
  it('eyeSync URL: 페어링 없고 env 없으면 빈 문자열', () => {
    expect(getEyeSyncWsUrl()).toBe('');
  });

  it('configurePi 가 base URL 을 바꾼다', () => {
    configurePi('viva-3f7a.local', 'tok');
    expect(getPiBaseUrl()).toBe('http://viva-3f7a.local:5000');
    expect(getPiToken()).toBe('tok');
  });

  it('host null 이면 기존 host 유지, token 만 갱신', () => {
    configurePi('viva-3f7a.local', 'tok');
    configurePi(null, null);
    expect(getPiBaseUrl()).toBe('http://viva-3f7a.local:5000');
    expect(getPiToken()).toBeNull();
  });

  it('토큰이 있으면 요청에 X-Viva-Token 헤더가 붙는다', async () => {
    configurePi('viva-3f7a.local', 'tok');
    const spy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }) as unknown as Response,
    );
    await fetchPiHealth();
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Viva-Token']).toBe('tok');
  });

  it('403 응답이 authRejected 핸들러를 부른다', async () => {
    configurePi('viva-3f7a.local', 'tok');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 403 }) as unknown as Response,
    );
    const cb = jest.fn();
    setAuthRejectedHandler(cb);
    await fetchPiHealth(); // health 는 null 반환 - throw 안 함
    expect(cb).toHaveBeenCalled();
  });

  it('eyeSync URL: 페어링되면 host 파생 + 토큰 쿼리', () => {
    configurePi('viva-3f7a.local', 'tok');
    expect(getEyeSyncWsUrl()).toBe('ws://viva-3f7a.local:8787?token=tok');
  });
});
```

주의: `getEyeSyncWsUrl` 의 env 우선 분기는 EXPO_PUBLIC_* 이 babel 로 빌드 시점 인라인되어 테스트에서 못 바꾼다 (eyeSync.service.ts 기존 주석과 동일 제약) — env 미설정 전제의 케이스만 테스트한다.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/device/services/__tests__/piBridge.pairing.test.ts`
Expected: FAIL — `configurePi is not a function` 계열

- [ ] **Step 3: Implement**

`piBridge.service.ts` 상단(16~24행)을 교체:

```typescript
const ENV_PI_HOST = process.env.EXPO_PUBLIC_PI_HOST || '';
const PI_PORT = process.env.EXPO_PUBLIC_PI_PORT || '5000';
const ENV_EYE_URL = process.env.EXPO_PUBLIC_EYE_SYNC_WS_URL || '';

// 런타임 페어링 상태. env 는 dev 오버라이드로 강등 - 저장된 페어링이
// 있으면 initPairingFromStore 가 덮는다 (multi-device-pairing 스펙 §5).
let piHost = ENV_PI_HOST || 'viva.local';
let piToken: string | null = null;
let pairedHost: string | null = null; // 저장소에서 온 host 만 (eyeSync 파생 근거)
let authRejectedCb: (() => void) | null = null;

/** 페어링 갱신. host=null 은 "host 유지, token 만 갱신". */
export function configurePi(host: string | null, token: string | null): void {
  if (host) {
    piHost = host;
    pairedHost = host;
  }
  piToken = token;
}

export function getPiToken(): string | null {
  return piToken;
}

/** 앱 시작 시 1회 - 저장된 페어링을 모듈 상태로 올린다. */
export async function initPairingFromStore(): Promise<void> {
  const { loadPairing } = await import('../../utils/pairingStore');
  const p = await loadPairing();
  if (p) configurePi(p.host, p.token);
}

/** 디버그용: 지금 빌드에 실제로 어떤 주소가 박혀 있는지 화면에서 바로
 * 확인할 수 있게 export한다. 이제 런타임 페어링을 반영한다. */
export function getPiBaseUrl(): string {
  return `http://${piHost}:${PI_PORT}`;
}

/** 눈 WS 주소. env 오버라이드 > 페어링 host 파생 > '' (보드 없음 = off).
 * 페어링 전 기본 host 로 파생하지 않는 이유: 로봇 없는 폰 빌드에서
 * eyeSync 가 무한 재접속을 도는 예전 버그(eyeSync.service.ts 주석)의 재발 방지. */
export function getEyeSyncWsUrl(): string {
  const base = ENV_EYE_URL || (pairedHost ? `ws://${pairedHost}:8787` : '');
  if (!base) return '';
  return piToken ? `${base}?token=${piToken}` : base;
}

/** 403(토큰 불일치 - 로봇 재플래싱/언페어) 감지 콜백. App.device 가 등록. */
export function setAuthRejectedHandler(cb: (() => void) | null): void {
  authRejectedCb = cb;
}
```

`fetchWithTimeout` 에 헤더 주입 + 403 훅:

```typescript
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 8000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = piToken
    ? { ...(options.headers as Record<string, string>), 'X-Viva-Token': piToken }
    : options.headers;
  try {
    const res = await fetch(url, { ...options, headers, signal: controller.signal });
    if (res.status === 403) authRejectedCb?.();
    return res;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`[piBridge] timeout after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
```

파일 전체에서 `${PI_BASE_URL}` 를 `${getPiBaseUrl()}` 로 치환한다 (모두 이 파일 안: record/start·stop·status, capture/*, photo/crop, play, play/stop — `grep -n 'PI_BASE_URL' src/device/services/piBridge.service.ts` 로 전수 확인, `const PI_BASE_URL` 정의는 삭제).

`playAudioOnPi` 의 XHR 에 헤더 추가 — `xhr.open(...)` 직후:

```typescript
      xhr.open('POST', `${getPiBaseUrl()}/play`);
      if (piToken) xhr.setRequestHeader('X-Viva-Token', piToken);
```

파일 끝에 페어링 API 추가:

```typescript
/** 재페어링 경로 (스펙 §4): 미페어링 로봇에 토큰을 심는다. 성공 시 로봇
 * hostname 반환. 409 = 이미 다른 폰과 페어링됨. */
export async function pairRobot(host: string, token: string): Promise<string> {
  const res = await fetchWithTimeout(
    `http://${host}:${PI_PORT}/pair`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    },
    8000,
  );
  if (!res.ok) throw new Error(`Pi pair failed: ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { hostname?: unknown };
  return typeof body.hostname === 'string' ? body.hostname : host.replace(/\.local$/, '');
}

/** 언페어 (앱에서 로봇을 놓아줄 때 - 스펙 §4). 저장소 정리는 호출자 몫. */
export async function unpairRobot(): Promise<void> {
  const res = await fetchWithTimeout(`${getPiBaseUrl()}/pair`, { method: 'DELETE' }, 8000);
  if (!res.ok) throw new Error(`Pi unpair failed: ${res.status}`);
}
```

- [ ] **Step 4: Run to verify it passes + 회귀**

Run: `npm test -- src/device/services/__tests__/piBridge.pairing.test.ts src/device/services/__tests__/piBridge.health.test.ts src/device/services/__tests__/piWakeStream.service.test.ts`
Expected: 전부 PASS

- [ ] **Step 5: Commit**

```bash
git add src/device/services/piBridge.service.ts src/device/services/__tests__/piBridge.pairing.test.ts
git commit -m "feat: piBridge 런타임 페어링 (host/token 주입 + 403 훅 + pair API)"
```

---

### Task 10: piScan — 토큰 열쇠 서브넷 스윕

**Files:**
- Create: `src/device/services/piScan.service.ts`
- Test: `src/device/services/__tests__/piScan.service.test.ts`

**Interfaces:**
- Consumes: NetInfo(기설치).
- Produces: `sweepOnce(token: string): Promise<DiscoveredRobot | null>`, `interface DiscoveredRobot { hostname: string; ip: string }`. Task 12가 소비.

- [ ] **Step 1: Write the failing test**

`src/device/services/__tests__/piScan.service.test.ts`:

```typescript
import { sweepOnce } from '../piScan.service';

jest.mock('@react-native-community/netinfo', () => ({
  fetch: jest.fn().mockResolvedValue({
    type: 'wifi',
    details: { ipAddress: '192.168.0.5' },
  }),
}));

describe('piScan sweepOnce', () => {
  afterEach(() => jest.restoreAllMocks());

  it('토큰 일치 로봇을 발견한다 (자기 IP 는 건너뜀)', async () => {
    const probed: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      probed.push(String(url));
      if (String(url).startsWith('http://192.168.0.42:5000/pair/whoami')) {
        return new Response(JSON.stringify({ hostname: 'viva-3f7a' }), {
          status: 200,
        }) as unknown as Response;
      }
      return new Response('{}', { status: 403 }) as unknown as Response;
    });

    const found = await sweepOnce('tok');
    expect(found).toEqual({ hostname: 'viva-3f7a', ip: '192.168.0.42' });
    expect(probed.some((u) => u.includes('192.168.0.5:'))).toBe(false); // 자기 자신 제외
    expect(probed[0]).toContain('token=tok');
  });

  it('아무도 응답 안 하면 null', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('timeout'));
    expect(await sweepOnce('tok')).toBeNull();
  });

  it('wifi 아니면 스윕 없이 null', async () => {
    const NetInfo = jest.requireMock('@react-native-community/netinfo');
    NetInfo.fetch.mockResolvedValueOnce({ type: 'cellular', details: null });
    const spy = jest.spyOn(globalThis, 'fetch');
    expect(await sweepOnce('tok')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/device/services/__tests__/piScan.service.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: Implement**

`src/device/services/piScan.service.ts`:

```typescript
/**
 * 토큰 열쇠 서브넷 스윕 (multi-device-pairing 스펙 §2).
 *
 * 폰이 QR 로 넘긴 토큰이 "내 로봇" 식별자다 - 주소만 모른다. /24 전 주소에
 * GET /pair/whoami?token= 을 병렬로 때리면 토큰이 일치하는 로봇만 200 으로
 * 자기 hostname 을 답한다. 교실 20쌍이 동시에 돌려도 토큰이 다르니 각자
 * 자기 로봇만 발견한다. 페어링 때 1회만 돈다 - 이후엔 저장된 hostname 직행.
 */
import NetInfo from '@react-native-community/netinfo';

const PI_PORT = process.env.EXPO_PUBLIC_PI_PORT || '5000';
const PROBE_TIMEOUT_MS = 300;
const CONCURRENCY = 50;

export interface DiscoveredRobot {
  hostname: string;
  ip: string;
}

async function probe(ip: string, token: string): Promise<DiscoveredRobot | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(
      `http://${ip}:${PI_PORT}/pair/whoami?token=${encodeURIComponent(token)}`,
      { signal: controller.signal },
    );
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { hostname?: unknown } | null;
    return typeof body?.hostname === 'string' ? { hostname: body.hostname, ip } : null;
  } catch {
    return null; // 타임아웃/거부 = 그 주소엔 내 로봇 없음
  } finally {
    clearTimeout(timer);
  }
}

/** 스윕 1회 (254개 주소, 동시 50, 체감 2~4초). 재시도는 호출자 몫.
 * ponytail: /24 고정 - 대형 서브넷은 화면의 수동 입력 폴백. */
export async function sweepOnce(token: string): Promise<DiscoveredRobot | null> {
  const state = await NetInfo.fetch();
  const ip = (state.details as { ipAddress?: string } | null)?.ipAddress;
  if (state.type !== 'wifi' || !ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return null;

  const prefix = ip.split('.').slice(0, 3).join('.');
  const targets: string[] = [];
  for (let i = 1; i <= 254; i++) {
    const candidate = `${prefix}.${i}`;
    if (candidate !== ip) targets.push(candidate);
  }

  let found: DiscoveredRobot | null = null;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < targets.length && !found) {
      const target = targets[next++];
      const hit = await probe(target, token);
      if (hit) found = hit;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return found;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- src/device/services/__tests__/piScan.service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/device/services/piScan.service.ts src/device/services/__tests__/piScan.service.test.ts
git commit -m "feat: 토큰 열쇠 서브넷 스윕으로 로봇 자동 발견 (piScan)"
```

---

### Task 11: eyeSync + piWakeStream — 토큰 포함 WS 주소

**Files:**
- Modify: `src/device/services/eyeSync.service.ts`
- Modify: `src/device/services/piWakeStream.service.ts`

**Interfaces:**
- Consumes: Task 9 `getEyeSyncWsUrl`, `getPiToken`, `getPiBaseUrl`.
- Produces: 두 WS 모두 `?token=` 붙여 접속. eyeSync 는 페어링/env 어느 쪽이든 URL 이 생기는 순간부터 동작.

- [ ] **Step 1: eyeSync 수정**

`eyeSync.service.ts` 의 `const Config = {...}` 블록을 삭제하고:

```typescript
import { getEyeSyncWsUrl } from './piBridge.service';
```

사용처 3곳 치환:
- `start()`: `if (this.enabled || !getEyeSyncWsUrl()) return;` — 아래 로그도 `getEyeSyncWsUrl()`
- `connect()`: `const socket = new WebSocket(getEyeSyncWsUrl());`

`start()` 독스트링 갱신: `/** Call once (e.g. app start). URL 이 없으면(페어링 전 + env 미설정) no-op - 보드 자체가 없는 것. sendEyeState 가 매번 start 를 찔러 페어링 완료 후엔 자연히 붙는다. */`

- [ ] **Step 2: piWakeStream 수정**

`wakeStreamUrl()` 교체:

```typescript
import { getPiBaseUrl, getPiToken } from './piBridge.service';

/** http://<host>:5000 -> ws://<host>:8788 (+페어링 토큰) */
function wakeStreamUrl(): string {
  const host = getPiBaseUrl()
    .replace(/^https?:\/\//, '')
    .replace(/:.*$/, '');
  const token = getPiToken();
  return `ws://${host}:${WAKE_PORT}` + (token ? `?token=${token}` : '');
}
```

- [ ] **Step 3: 회귀 테스트**

Run: `npm test -- src/device/services/__tests__/eyeSync.service.test.ts src/device/services/__tests__/eyeSync.suppress.test.ts src/device/services/__tests__/piWakeStream.service.test.ts`
Expected: PASS. eyeSync 테스트가 env URL 인라인에 의존해 깨지면: 해당 테스트 파일에서 `jest.mock('../piBridge.service', ...)` 로 `getEyeSyncWsUrl` 을 `'ws://localhost:8787'` 반환으로 모킹해 기존 전제를 복원한다.

- [ ] **Step 4: Commit**

```bash
git add src/device/services/eyeSync.service.ts src/device/services/piWakeStream.service.ts
git commit -m "feat: 눈·호출어 WS 주소를 페어링에서 파생 + 토큰 쿼리"
```

---

### Task 12: WifiProvisionScreen — 토큰 QR + 스윕 + 폴백 + 언페어

**Files:**
- Modify: `src/device/screens/WifiProvisionScreen.tsx`
- Test: `src/device/screens/__tests__/WifiProvisionScreen.test.tsx` (기존 파일에 케이스 추가)

**Interfaces:**
- Consumes: Task 7 `newPairingToken, savePairing, loadPairing, clearPairing`; Task 8 `buildWifiQrPayload(ssid, psk, token)`; Task 9 `configurePi, pairRobot, unpairRobot`; Task 10 `sweepOnce`.
- Produces: 사용자 플로우 — QR 표시가 곧 페어링. 스윕 성공 시 저장+configurePi, 기존 `succeeded`(connectionMonitor connected 엣지)가 성공 화면을 띄운다.

- [ ] **Step 1: Write the failing tests**

기존 `WifiProvisionScreen.test.tsx` 의 모킹 관례를 먼저 읽고 (usePiConnection·타이머 패턴) 다음 케이스 추가:

```typescript
// 파일 상단 모킹에 추가
jest.mock('../../services/piScan.service', () => ({
  sweepOnce: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../services/piBridge.service', () => ({
  ...jest.requireActual('../../services/piBridge.service'),
  configurePi: jest.fn(),
  unpairRobot: jest.fn().mockResolvedValue(undefined),
  pairRobot: jest.fn().mockResolvedValue('viva-3f7a'),
}));

it('QR 페이로드에 V 토큰이 들어간다', async () => {
  // ssid/psk 입력 후 "QR 만들기" 탭 - buildWifiQrMatrix 로 넘어간 페이로드에
  // ;V: 가 포함되는지. QrCodeView 를 모킹해 payload prop 을 캡처하거나,
  // savePairing 없이도 wifiQr.buildWifiQrPayload 스파이로 검증한다.
  const spy = jest.spyOn(require('../../../utils/wifiQr'), 'buildWifiQrPayload');
  // ...기존 테스트의 입력 헬퍼로 ssid=Home, psk=pw 입력, QR 만들기 탭...
  expect(spy.mock.calls[0][2]).toMatch(/^[0-9a-f]{32}$/);
});

it('스윕이 로봇을 찾으면 configurePi + savePairing', async () => {
  const { sweepOnce } = jest.requireMock('../../services/piScan.service');
  sweepOnce.mockResolvedValueOnce({ hostname: 'viva-3f7a', ip: '192.168.0.42' });
  // QR 만들기 탭 후 10초 진행 (jest.advanceTimersByTime)
  // configurePi 가 ('viva-3f7a.local', <hex32>) 로 불렸는지 확인
});

it('2분 스윕 실패 후 수동 입력 필드가 노출된다', async () => {
  // QR 만들기 탭 후 120초 진행 - testID "pairing-manual-suffix" 가 보인다
});
```

(정확한 렌더/입력 헬퍼는 기존 테스트 파일의 것을 재사용 — 파일을 열어 동일 패턴으로 완성한다. 위 세 시나리오가 커버 대상이다.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/device/screens/__tests__/WifiProvisionScreen.test.tsx`
Expected: 새 케이스 FAIL

- [ ] **Step 3: Implement**

`WifiProvisionScreen.tsx` 변경점:

imports 추가:

```typescript
import { newPairingToken, savePairing, loadPairing, clearPairing } from '../../utils/pairingStore';
import { sweepOnce } from '../services/piScan.service';
import { configurePi, pairRobot, unpairRobot } from '../services/piBridge.service';
```

컴포넌트 상단 상태 추가:

```typescript
  // 페어링 (multi-device-pairing 스펙 §2). 토큰은 QR 생성 시 1회 발급 -
  // "QR 만들기"를 다시 눌러도 같은 세션에선 유지해, 로봇이 먼저 스캔한
  // QR 과 스윕이 쓰는 토큰이 어긋나지 않게 한다.
  const tokenRef = useRef<string | null>(null);
  const [sweepFailed, setSweepFailed] = useState(false); // 2분 소진 - 수동 폴백 노출
  const [manualSuffix, setManualSuffix] = useState('');
  const [manualError, setManualError] = useState('');
  const [paired, setPaired] = useState(false); // 이번 화면에서 페어링 완료됨
```

상수 추가 (CLOSE_AFTER_SUCCESS_MS 아래):

```typescript
const SWEEP_INTERVAL_MS = 10000; // 로봇 WiFi 접속·서버 기동 대기
const SWEEP_GIVEUP_MS = 120000; // 스펙 §2: 총 2분 뒤 수동 입력 폴백
```

"QR 만들기" onPress 교체:

```typescript
              onPress={() => {
                if (!tokenRef.current) tokenRef.current = newPairingToken();
                setShowQr(true);
                setSweepFailed(false);
                void saveWifiCreds({ ssid, psk });
              }}
```

matrix useMemo 교체 (토큰 합승):

```typescript
  const matrix = useMemo(
    () =>
      showQr && ssid.trim() && psk
        ? buildWifiQrMatrix(buildWifiQrPayload(ssid, psk, tokenRef.current ?? undefined))
        : null,
    [showQr, ssid, psk],
  );
```

스윕 루프 effect 추가 (succeeded effect 아래):

```typescript
  // 토큰 열쇠 서브넷 스윕: QR 이 떠 있는 동안 10초 간격, 총 2분 (스펙 §2).
  // 성공 = 저장 + configurePi. 성공 화면 전환은 기존 succeeded 엣지가
  // 담당한다 (connectionMonitor 가 새 host 로 붙는 순간).
  useEffect(() => {
    if (!showQr || paired || succeeded) return;
    const token = tokenRef.current;
    if (!token) return;
    let alive = true;
    const startedAt = Date.now();
    const tick = async () => {
      const found = await sweepOnce(token);
      if (!alive) return;
      if (found) {
        const host = `${found.hostname}.local`;
        configurePi(host, token);
        await savePairing({ host, token, lastIp: found.ip });
        setPaired(true);
        return;
      }
      if (Date.now() - startedAt >= SWEEP_GIVEUP_MS) {
        setSweepFailed(true);
        return;
      }
      timer = setTimeout(() => void tick(), SWEEP_INTERVAL_MS);
    };
    let timer = setTimeout(() => void tick(), SWEEP_INTERVAL_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [showQr, paired, succeeded]);
```

수동 폴백 핸들러 + UI (qrPane 의 `<Text style={styles.qrHint}>` 아래, `sweepFailed && !succeeded` 일 때):

```typescript
  const onManualPair = async () => {
    const suffix = manualSuffix.trim().toLowerCase();
    if (!/^[0-9a-f]{4}$/.test(suffix)) {
      setManualError('로봇 화면/밑면의 4글자를 입력해줘 (예: 3f7a)');
      return;
    }
    const token = tokenRef.current ?? newPairingToken();
    tokenRef.current = token;
    const host = `viva-${suffix}.local`;
    try {
      // 로봇이 QR 을 이미 스캔했다면 whoami 로 확인되고, WiFi 만 살아있는
      // 미페어링 로봇이면 POST /pair 로 토큰을 심는다 (스펙 §4 재페어링).
      const hostname = await pairRobot(host, token);
      const finalHost = `${hostname}.local`;
      configurePi(finalHost, token);
      await savePairing({ host: finalHost, token });
      setManualError('');
      setPaired(true);
    } catch {
      setManualError('로봇을 못 찾았어 - 같은 와이파이인지, 이름이 맞는지 확인해줘');
    }
  };
```

```tsx
            {sweepFailed && !succeeded && (
              <View style={styles.manualRow}>
                <Text style={styles.sub}>자동 연결이 안 되면 로봇 화면의 이름을 입력해줘</Text>
                <View style={styles.pskRow}>
                  <TextInput
                    style={[styles.input, styles.pskInput]}
                    placeholder="viva- 뒤 4글자"
                    placeholderTextColor={INK_MUTED}
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={4}
                    testID="pairing-manual-suffix"
                    value={manualSuffix}
                    onChangeText={setManualSuffix}
                  />
                  <Pressable
                    accessibilityRole="button"
                    testID="pairing-manual-go"
                    onPress={() => void onManualPair()}
                    style={({ pressed }) => [styles.pskToggle, pressed && { opacity: 0.55 }]}
                  >
                    <Text style={styles.pskToggleText}>연결</Text>
                  </Pressable>
                </View>
                {!!manualError && <Text style={styles.helper}>{manualError}</Text>}
              </View>
            )}
```

styles 에 추가: `manualRow: { alignSelf: 'stretch', gap: 8, marginTop: 12 },`

언페어 버튼 (formPane 하단, 기존 페어링이 있을 때만 — mount 시 `loadPairing()` 으로 판단하는 `hasPairing` state):

```typescript
  const [hasPairing, setHasPairing] = useState(false);
  useEffect(() => {
    void loadPairing().then((p) => setHasPairing(!!p));
  }, [paired]);

  const onUnpair = async () => {
    try {
      await unpairRobot(); // 로봇 쪽 토큰 삭제 (실패해도 로컬은 지운다)
    } catch {
      // 로봇이 꺼져 있어도 로컬 페어링은 지운다 - 로봇 쪽은 SSH/재프로비저닝 몫
    }
    await clearPairing();
    configurePi(null, null);
    setHasPairing(false);
  };
```

```tsx
            {hasPairing && (
              <Pressable
                accessibilityRole="button"
                testID="pairing-unpair"
                onPress={() => void onUnpair()}
                style={({ pressed }) => [styles.shortcutBtn, pressed && { opacity: 0.55 }]}
              >
                <Text style={styles.shortcutBtnText}>이 로봇과 연결 해제</Text>
              </Pressable>
            )}
```

- [ ] **Step 4: Run to verify**

Run: `npm test -- src/device/screens/__tests__/WifiProvisionScreen.test.tsx`
Expected: 기존 + 신규 전부 PASS

- [ ] **Step 5: Commit**

```bash
git add src/device/screens/WifiProvisionScreen.tsx src/device/screens/__tests__/WifiProvisionScreen.test.tsx
git commit -m "feat: 프로비저닝 화면에서 QR 페어링 + 스윕 + 수동 폴백 + 언페어"
```

---

### Task 13: 앱 초기화 + 문서

**Files:**
- Modify: `App.device.tsx` (connectionMonitor 시작 effect, ~150행)
- Modify: `.env.example` (로봇 헤드 절)
- Modify: `docs/superpowers/specs/2026-08-20-multi-device-pairing-design.md` (고아 로봇 한계 1줄)
- Modify: `docs/process.md` (문서 규칙 — 맨 위 "문서 갱신 규칙" 절을 따라 항목 추가)

- [ ] **Step 1: App.device.tsx 초기화**

imports 에 추가: `initPairingFromStore, setAuthRejectedHandler` (piBridge), `Alert` (react-native).

기존 effect 교체:

```typescript
  useEffect(() => {
    let stopped = false;
    // 저장된 페어링을 먼저 올리고 모니터를 켠다 - 첫 /health 폴부터 맞는
    // host 로 가게 (실패해도 모니터는 켠다 - 기본 host 폴백).
    void initPairingFromStore().finally(() => {
      if (!stopped) connectionMonitor.start();
    });
    setAuthRejectedHandler(() => {
      // 로봇 재플래싱/언페어로 토큰 불일치 (스펙 §5). 1회만 알린다.
      setAuthRejectedHandler(null);
      Alert.alert(
        '비바와 연결이 풀렸어',
        '와이파이 등록 화면에서 QR 로 다시 연결해줘.',
      );
    });
    return () => {
      stopped = true;
      setAuthRejectedHandler(null);
      connectionMonitor.stop();
    };
  }, []);
```

- [ ] **Step 2: .env.example 로봇 헤드 절 주석 갱신**

`EXPO_PUBLIC_PI_HOST` 주석 앞에 추가:

```
# 아래 두 값은 이제 dev 오버라이드다 - 정상 경로는 앱 내 QR 페어링이
# host/토큰을 AsyncStorage 에 저장한다 (multi-device-pairing 스펙).
# 저장된 페어링이 있으면 그게 이긴다.
```

`EXPO_PUBLIC_EYE_SYNC_WS_URL` 주석도 한 줄 추가: `# 페어링돼 있으면 자동 파생(ws://<host>:8787) - 이 값은 dev 오버라이드.`

- [ ] **Step 3: 스펙에 고아 로봇 한계 명시**

스펙 §4 재페어링 절 끝에 추가:

```markdown
- **고아 로봇** (구 폰 분실 + 같은 WiFi 유지): QR 경로(스캔은 WiFi 끊김
  때만)도 POST /pair(409)도 막힌다 - SSH 로 pairing.json 삭제 또는
  재플래싱이 유일한 복구. 새 WiFi 로 이사하면 자동 복구(재프로비저닝 =
  재페어링)라 실사용 빈도는 낮다.
```

- [ ] **Step 4: 전체 테스트 + process.md**

Run: `npm test` (앱 전체) — Expected: PASS
Run: `cd pi-server && python3 -m unittest -v` — Expected: PASS (test_pairing 포함 전부)
Run: `cd pi-server && python3 provision.py --selftest` — Expected: `provision selftest ok`

`docs/process.md` 맨 위 "문서 갱신 규칙" 절을 읽고 그 규칙대로 이번 작업(멀티 디바이스 페어링: QR 토큰 합승 + 서브넷 스윕 + hostname 유니크화, 실기기 검증은 Task 14 대기)을 해당 섹션에 기록한다.

- [ ] **Step 5: Commit**

```bash
git add App.device.tsx .env.example docs/superpowers/specs/2026-08-20-multi-device-pairing-design.md docs/process.md
git commit -m "feat: 앱 시작 시 페어링 복원 + 403 재페어링 안내 + 문서"
```

---

### Task 14: 실기기 검증 체크리스트 (사람 확인 게이트)

자동화 불가 항목 — 실기기(Pi + 폰)에서 확인하고 결과를 process.md 에 기록:

- [ ] pi-server 배포 후 미페어링 상태에서 기존 플로우 그대로 동작 (하위 호환)
- [ ] 폰 A: WiFi 프로비저닝 → 스윕 자동 발견 → "비바가 연결됐어!" (사용자 행동은 QR 보여주기뿐)
- [ ] 페어링 후 폰 B(토큰 없음): `/record/start` 403, 눈/wake WS 즉시 close (도청 차단 확인)
- [ ] 폰 A 재시작: 저장된 페어링으로 바로 연결 (스윕 없이)
- [ ] provision_new/disconnected 화면에 `viva-XXXX` 이름 표시
- [ ] 언페어 → 미페어링 오픈 복귀 → 수동 입력(4글자)로 재페어링
- [ ] 골든 이미지 v2: seal → 복제 → firstboot 후 hostname 유니크 + pairing.json 없음 (README §6 체크리스트)
- [ ] `crypto.getRandomValues` Hermes 동작 확인 (Task 7 Step 4)
- [ ] 로봇 2대 + 폰 2대 동시: 각 쌍이 자기 로봇만 발견 (핵심 시나리오)

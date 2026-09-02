# Device Vitals (디바이스 모드 마이크·스피커 상태) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 디바이스 모드 홈 화면에서 비바의 마이크·스피커가 실제로 살아있는지 볼 수 있게 한다.

**Architecture:** Pi 가 `/proc/asound` 를 읽어(장치를 열지 않고) `mic_ok`/`speaker_ok` 를 `/health` 에 실어 보낸다. 앱은 이미 5초마다 `/health` 를 치는 `connectionMonitor` 가 그 값을 같이 실어나르고, 홈 화면은 상단 알약 대신 중앙 히어로 아래 계기판 한 줄로 연결·마이크·스피커를 함께 보여준다.

**Tech Stack:** Python 3 + Flask (pi-server), React Native 0.74 / Expo 51 + TypeScript, Jest + jest-expo + react-test-renderer, Python `unittest`.

**설계 문서:** [docs/superpowers/specs/2026-08-10-device-vitals-design.md](../specs/2026-08-10-device-vitals-design.md) — 판정 방식의 근거(배타 캡처 제약)는 여기 있다.

## Global Constraints

- **다른 세션이 `src/screens/HomeScreen.tsx` 를 미커밋 상태로 수정 중이다** (호출어 `"비바야"` → `"헤이, 비바"`). Task 6 시작 전 `git status` 로 확인하고, 그 변경을 절대 커밋에 섞지 마라. **`git add -A` 금지 — 항상 명시 파일만 add.**
- 히어로·서브 **문구는 이 작업에서 바꾸지 않는다.** 크기(24→28)와 배치만 바꾼다.
- 새 색 토큰·새 폰트 추가 금지. `src/theme.ts` 의 기존 토큰만 쓴다.
- 계기판 라벨 색은 **항상 `INK`**. `ORANGE`(약 3.3:1)·`INK_MUTED`(약 3.0:1)는 크림 배경 `#FAF7F0` 에서 12px 소형 텍스트 기준 4.5:1 미달이다. 의미는 문구가 지고 색은 보강만 한다.
- 계기판에 애니메이션 금지. 이 코드베이스에는 reduced-motion 처리가 없다.
- `micOk`/`speakerOk` 가 `undefined`(구버전 Pi)면 해당 칸을 **렌더하지 않는다.** 모르는 정보를 초록으로 칠하지 않는다.
- `/health` 는 절대 500 을 내면 안 된다 — 연결 판정 전체가 이 엔드포인트에 걸려 있다.
- 앱 테스트: `npm test`. Pi 테스트: `pi-server/` 안에서 `python3 -m unittest <module> -v`.
- 커밋 메시지는 한국어 본문 + `feat:`/`fix:`/`test:`/`docs:` 접두. 끝에 `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## File Structure

| 파일 | 책임 |
|---|---|
| `pi-server/audio_health.py` (신규) | `/proc/asound` 를 읽어 마이크·스피커 열림 판정. **app.py 와 분리하는 이유: app.py 는 `picamera2`/`libcamera` 를 모듈 최상단에서 import 해서 Pi 밖에서는 import 자체가 실패한다. 분리해야 개발 머신에서 테스트가 돈다.** |
| `pi-server/test_audio_health.py` (신규) | 위 모듈 단위 테스트. tmpdir 로 가짜 `/proc/asound` 를 만든다. |
| `pi-server/app.py` (수정) | `/health` 응답에 `mic_ok`/`speaker_ok` 추가, sticky 전역 보관. |
| `pi-server/README.md` (수정) | 새 필드·`VIVA_SOUND_CARD`·배포 시 복사 파일 목록 갱신. |
| `src/services/piBridge.service.ts` (수정) | `PiHealth` 타입 + `fetchPiHealth()`. `checkPiConnection()` 은 얇은 래퍼로 유지(E2E 러너가 쓴다). |
| `src/services/__tests__/piBridge.health.test.ts` (신규) | `fetchPiHealth()` 파싱·실패 처리. |
| `src/services/connectionMonitor.service.ts` (수정) | `_health` 보관, 상태 **또는** 헬스가 바뀌면 통지. |
| `src/hooks/usePiConnection.ts` (수정) | `usePiDeviceHealth()` 추가. 기존 `usePiConnection()` 시그니처 불변. |
| `src/components/DeviceVitals.tsx` (신규) | 계기판 한 줄 전체(항목 조립 + 구분선 + 합쳐진 a11y 라벨). |
| `src/components/__tests__/DeviceVitals.test.tsx` (신규) | 항목 구성·문구·미렌더 조건. |
| `src/components/ConnectionStatusChip.tsx` (삭제) | 역할을 `DeviceVitals` 가 흡수. |
| `src/screens/HomeScreen.tsx` (수정) | 칩 제거, 계기판 추가, 히어로 24→28, `piHealth` prop, `ModeToggle` 에 `transparent`. |
| `App.tsx` (수정) | `usePiDeviceHealth()` 구독 후 `HomeScreen` 에 전달. |
| `src/components/ModeToggle.tsx` (수정) | SolveModeToggle 과 같은 슬라이딩 스위치 문법으로 통일 (Task 8). |
| `src/components/__tests__/connectionUi.test.tsx` (수정) | 칩 블록 삭제(Task 7), ModeToggle 라벨 단언 추가(Task 8). |

---

### Task 1: Pi — `audio_health` 순수 함수

**Files:**
- Create: `pi-server/audio_health.py`
- Test: `pi-server/test_audio_health.py`

**Interfaces:**
- Consumes: 없음 (표준 라이브러리만)
- Produces:
  - `MIC_STICKY_S: float` (= `10.0`)
  - `substream_open(card_dir: str, kind: str) -> bool` — `kind` 는 `'c'`(캡처) 또는 `'p'`(재생)
  - `audio_health(card_dir: str, recording: bool, now: float, last_capture_open: float) -> tuple[bool, bool, float]` — `(mic_ok, speaker_ok, next_last_capture_open)`

- [ ] **Step 1: Write the failing test**

Create `pi-server/test_audio_health.py`:

```python
"""audio_health.py 단위 체크. 하드웨어 없이 python3 -m unittest test_audio_health 로 돈다."""
import os
import tempfile
import unittest

from audio_health import MIC_STICKY_S, audio_health, substream_open


def make_card(root, capture="closed", playback="closed"):
    """가짜 /proc/asound/card0 트리를 만든다. ALSA 는 아무도 안 열었을 때
    hw_params 에 'closed' 를 쓰고, 열려 있으면 파라미터 덤프를 쓴다."""
    card = os.path.join(root, "card0")
    for pcm, body in (("pcm0c", capture), ("pcm0p", playback)):
        sub = os.path.join(card, pcm, "sub0")
        os.makedirs(sub)
        with open(os.path.join(sub, "hw_params"), "w") as f:
            f.write(body)
    return card


OPEN = "access: RW_INTERLEAVED\nformat: S16_LE\nrate: 16000 (16000/1)\n"


class SubstreamOpenTest(unittest.TestCase):
    def test_closed_body_is_not_open(self):
        with tempfile.TemporaryDirectory() as root:
            card = make_card(root)
            self.assertFalse(substream_open(card, "c"))
            self.assertFalse(substream_open(card, "p"))

    def test_param_dump_is_open(self):
        with tempfile.TemporaryDirectory() as root:
            card = make_card(root, capture=OPEN)
            self.assertTrue(substream_open(card, "c"))
            self.assertFalse(substream_open(card, "p"))

    def test_missing_card_dir_is_not_open(self):
        self.assertFalse(substream_open("/nonexistent/card0", "c"))


class AudioHealthTest(unittest.TestCase):
    def test_missing_card_means_both_broken(self):
        # I2S 오버레이 미적용 / 카드 인식 실패
        mic, speaker, last = audio_health("/nonexistent/card0", False, 1000.0, 0.0)
        self.assertFalse(mic)
        self.assertFalse(speaker)
        self.assertEqual(last, 0.0)

    def test_both_streams_open_means_both_healthy(self):
        with tempfile.TemporaryDirectory() as root:
            card = make_card(root, capture=OPEN, playback=OPEN)
            mic, speaker, last = audio_health(card, False, 1000.0, 0.0)
            self.assertTrue(mic)
            self.assertTrue(speaker)
            self.assertEqual(last, 1000.0)  # 캡처 열림을 관측한 시각 기록

    def test_silence_service_dead_means_speaker_broken(self):
        # viva-silence 가 죽으면 재생 서브스트림이 닫힌다
        with tempfile.TemporaryDirectory() as root:
            card = make_card(root, capture=OPEN, playback="closed")
            mic, speaker, _ = audio_health(card, False, 1000.0, 0.0)
            self.assertTrue(mic)
            self.assertFalse(speaker)

    def test_capture_closed_but_recording_means_mic_healthy(self):
        # app.py 가 녹음 중이면 wake.py 는 마이크를 놓은 상태다
        with tempfile.TemporaryDirectory() as root:
            card = make_card(root, capture="closed", playback=OPEN)
            mic, _, _ = audio_health(card, True, 1000.0, 0.0)
            self.assertTrue(mic)

    def test_capture_closed_within_sticky_window_means_mic_healthy(self):
        # pause -> /record/start 핸드오프 공백을 흡수한다
        with tempfile.TemporaryDirectory() as root:
            card = make_card(root, capture="closed", playback=OPEN)
            mic, _, last = audio_health(card, False, 1003.0, 1000.0)
            self.assertTrue(mic)
            self.assertEqual(last, 1000.0)  # 닫혀 있으면 갱신 안 함

    def test_capture_closed_past_sticky_window_means_mic_broken(self):
        with tempfile.TemporaryDirectory() as root:
            card = make_card(root, capture="closed", playback=OPEN)
            mic, _, _ = audio_health(card, False, 1000.0 + MIC_STICKY_S + 1, 1000.0)
            self.assertFalse(mic)

    def test_never_observed_open_means_mic_broken(self):
        # 부팅부터 마이크가 죽어 있으면 last_capture_open 은 0 인 채다
        with tempfile.TemporaryDirectory() as root:
            card = make_card(root, capture="closed", playback=OPEN)
            mic, _, _ = audio_health(card, False, 1_700_000_000.0, 0.0)
            self.assertFalse(mic)

    def test_unreadable_hw_params_is_treated_as_closed(self):
        # 권한/IOError 로 못 읽어도 예외가 새어나가면 안 된다 (/health 가 500 나면
        # 연결 판정 전체가 무너진다)
        with tempfile.TemporaryDirectory() as root:
            card = make_card(root, capture=OPEN, playback=OPEN)
            os.chmod(os.path.join(card, "pcm0c", "sub0", "hw_params"), 0o000)
            try:
                mic, speaker, _ = audio_health(card, False, 1000.0, 0.0)
            finally:
                os.chmod(os.path.join(card, "pcm0c", "sub0", "hw_params"), 0o644)
            self.assertFalse(mic)
            self.assertTrue(speaker)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pi-server && python3 -m unittest test_audio_health -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'audio_health'`

- [ ] **Step 3: Write minimal implementation**

Create `pi-server/audio_health.py`:

```python
"""
마이크·스피커가 살아있는지 /proc/asound 읽기만으로 판정한다.

능동 프로브(짧게 녹음해 RMS 확인)는 쓸 수 없다. asound.conf 의 micboost 는
plughw:0 직결(softvol)이라 캡처가 배타적이고, 유휴 상태에서 그 장치는
wake.py 의 arecord 가 쥐고 있다. 열어보려 하면 -EBUSY 로 실패해 멀쩡한
마이크를 고장으로 오판하거나, 마이크를 뺏어 호출어 감지를 죽인다.

그래서 "누군가 그 서브스트림을 열고 있는가"를 본다. 유휴 상태의 캡처는
wake.py 가, 재생은 viva-silence.service 의 aplay /dev/zero 가 영구히 쥐고
있는 것이 정상이므로, 닫혀 있다는 건 그쪽 경로가 죽었다는 뜻이다.

app.py 와 분리한 이유: app.py 는 picamera2/libcamera 를 모듈 최상단에서
import 해서 Pi 밖에서는 import 자체가 실패한다 - 여기 있어야 개발 머신에서
테스트가 돈다.
"""
import glob
import os

# 호출어 감지 후 폰은 wake.py 에 pause(= arecord 종료) 를 보낸 뒤에야
# /record/start 를 친다. 그 사이엔 아무도 마이크를 쥐지 않는 공백이 있어,
# 5초 폴링이 그 틈에 떨어지면 정상 마이크가 고장으로 뜬다. 마지막으로
# 열린 걸 본 시각으로부터 이 시간 안이면 정상으로 본다.
MIC_STICKY_S = 10.0


def substream_open(card_dir, kind):
    """kind: 'c'(캡처) | 'p'(재생). 서브스트림이 하나라도 열려 있으면 True.

    ALSA 는 아무도 안 열었을 때 hw_params 에 'closed' 를 쓰고, 열려 있으면
    format/rate 등 파라미터 덤프를 쓴다. 읽기 실패는 '닫힘'으로 삼킨다."""
    pattern = os.path.join(card_dir, "pcm*" + kind, "sub*", "hw_params")
    for path in glob.glob(pattern):
        try:
            with open(path) as f:
                if f.read().strip() != "closed":
                    return True
        except OSError:
            continue
    return False


def audio_health(card_dir, recording, now, last_capture_open):
    """(mic_ok, speaker_ok, next_last_capture_open) 을 돌려준다.

    호출부가 next_last_capture_open 을 보관했다가 다음 호출에 도로 넣어준다 -
    이 모듈은 상태를 안 들고 있어서 테스트가 시간에 의존하지 않는다."""
    if not os.path.isdir(card_dir):
        return False, False, last_capture_open

    capture = substream_open(card_dir, "c")
    if capture:
        last_capture_open = now

    mic_ok = capture or recording or (now - last_capture_open) < MIC_STICKY_S
    return mic_ok, substream_open(card_dir, "p"), last_capture_open
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pi-server && python3 -m unittest test_audio_health -v`
Expected: PASS — `OK` (11 tests)

- [ ] **Step 5: Commit**

```bash
git add pi-server/audio_health.py pi-server/test_audio_health.py
git commit -m "$(cat <<'EOF'
feat: Pi 마이크·스피커 생존 판정을 /proc/asound 읽기로 추가

능동 프로브는 불가능하다 - micboost 가 plughw:0 직결이라 캡처가 배타적이고
유휴 상태에서 그 장치는 wake.py 의 arecord 가 쥐고 있다. 열어보려 하면
멀쩡한 마이크를 고장으로 오판하거나 호출어 감지를 죽인다.

pause -> /record/start 핸드오프 공백은 10초 sticky 로 흡수한다.
app.py 가 아닌 별도 모듈인 이유는 app.py 가 picamera2 를 최상단에서
import 해 Pi 밖에서는 테스트가 안 돌기 때문이다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Pi — `/health` 응답 확장 + 배포 문서

**Files:**
- Modify: `pi-server/app.py` (imports 블록 47-59행 근처, 설정 블록 39-40행 근처, `/health` 라우트 414-421행)
- Modify: `pi-server/README.md`

**Interfaces:**
- Consumes: Task 1 의 `audio_health(card_dir, recording, now, last_capture_open)`
- Produces: `GET /health` 가 `mic_ok: bool`, `speaker_ok: bool` 을 추가로 반환

- [ ] **Step 1: `audio_health` import 추가**

`pi-server/app.py` 의 `from imaging import ...` 줄(59행) 바로 아래에 추가:

```python
from audio_health import audio_health
```

- [ ] **Step 2: 카드 인덱스 설정 + sticky 전역 추가**

`pi-server/app.py` 에서 `PLAY_DEVICE = os.environ.get("VIVA_PLAY_DEVICE", "dmixout")` 줄(40행) 바로 아래에 추가:

```python
# 오디오 구성이 바뀌면(USB 동글 등) 카드 번호가 달라진다 - /health 의
# mic_ok/speaker_ok 판정이 볼 /proc/asound/card{N} 을 바꿀 수 있게 뺀다.
SOUND_CARD = os.environ.get("VIVA_SOUND_CARD", "0")

# audio_health 가 상태를 안 들고 있어서 여기가 보관한다. 캡처가 열려 있는 걸
# 마지막으로 관측한 시각(epoch). 0 = 한 번도 못 봄.
_mic_last_open = 0.0
```

- [ ] **Step 3: `/health` 라우트 교체**

`pi-server/app.py` 의 `/health` 라우트 전체(414-421행)를 아래로 교체:

```python
@app.route("/health", methods=["GET"])
def health():
    global _mic_last_open
    mic_ok, speaker_ok, _mic_last_open = audio_health(
        "/proc/asound/card" + SOUND_CARD,
        _rec_state["recording"],
        time.time(),
        _mic_last_open,
    )
    return jsonify({
        "status": "ok",
        "recording": _rec_state["recording"],
        "record_device": RECORD_DEVICE,
        "play_device": PLAY_DEVICE,
        "mic_ok": mic_ok,
        "speaker_ok": speaker_ok,
    })
```

- [ ] **Step 4: 문법·import 검증**

Run: `cd pi-server && python3 -c "import ast,sys; ast.parse(open('app.py').read()); print('syntax ok')"`
Expected: `syntax ok`

> `python3 -c "import app"` 은 개발 머신에서 `ModuleNotFoundError: No module named 'picamera2'` 로 실패한다 — 정상이다. 실제 동작 확인은 Pi 배포 후 Step 6.

- [ ] **Step 5: README 갱신**

`pi-server/README.md` 의 "## 실행" 절에서 복사 명령을 고친다. **`audio_health.py` 를 빠뜨리면 배포 후 `ImportError` 로 서버가 안 뜬다.**

기존:
```bash
cp app.py imaging.py /home/viva/pi-server/
```
교체:
```bash
cp app.py imaging.py audio_health.py /home/viva/pi-server/
```

그리고 "## 테스트" 절 바로 앞에 아래 절을 추가:

```markdown
## 하드웨어 상태 (/health)

`/health` 는 연결 확인용 필드 외에 마이크·스피커 생존 여부를 같이 준다.

```json
{"status":"ok","recording":false,"record_device":"micboost",
 "play_device":"dmixout","mic_ok":true,"speaker_ok":true}
```

`/proc/asound/card0` 의 서브스트림이 열려 있는지만 본다 - 장치를 열지 않는다.
`micboost` 는 `plughw:0` 직결이라 캡처가 배타적이어서, 유휴 상태의 마이크는
`viva-wake` 가 쥐고 있다. 확인하려고 열어보면 그 서비스와 싸운다.

- `mic_ok` false → `viva-wake` 가 죽었거나 `arecord` 가 바로 사망(마이크 모듈·배선 불량)
- `speaker_ok` false → `viva-silence` 가 죽어 앰프 경로가 끊김
- 둘 다 false → 사운드카드 자체가 안 잡힘 (`dtoverlay` 확인)

카드 번호가 0 이 아니면 `viva-server.service` 에 `VIVA_SOUND_CARD` 를 준다.
이 판정은 "소리가 실제로 들어온다"까지는 증명하지 않는다 - 게인이 리셋됐거나
마이크가 살아있되 무음인 경우는 못 잡는다.
```

- [ ] **Step 6: 커밋 후 실기기 확인**

```bash
git add pi-server/app.py pi-server/README.md
git commit -m "$(cat <<'EOF'
feat: /health 에 mic_ok·speaker_ok 추가

연결은 됐는데 마이크 배선이 빠졌거나 viva-silence 가 죽어도 앱은 정상으로
표시됐다. 기존 5초 /health 폴링에 업어서 새 폴러 없이 표면화한다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

배포 후 확인 (Pi 가 켜져 있을 때):

```bash
scp pi-server/app.py pi-server/audio_health.py viva@viva.local:/home/viva/pi-server/
ssh viva@viva.local 'sudo systemctl restart viva-server'
curl -s http://viva.local:5000/health
```

Expected: `mic_ok`, `speaker_ok` 가 둘 다 `true`.
`speaker_ok` 가 false 면 `ssh viva@viva.local 'systemctl is-active viva-silence'` 를 먼저 확인한다.
`mic_ok` 가 false 면 폰이 디바이스 모드로 붙어 있는지(= `viva-wake` 가 마이크를 쥐고 있는지) 확인한다.

---

### Task 3: 앱 — `fetchPiHealth()`

**Files:**
- Modify: `src/services/piBridge.service.ts:41-52`
- Test: `src/services/__tests__/piBridge.health.test.ts` (신규)

**Interfaces:**
- Consumes: Task 2 의 `/health` 응답 형태
- Produces:
  - `export interface PiHealth { micOk?: boolean; speakerOk?: boolean }`
  - `export async function fetchPiHealth(): Promise<PiHealth | null>` — 실패 시 `null`, 절대 throw 안 함
  - `export async function checkPiConnection(): Promise<boolean>` — 시그니처 불변 (`tools/e2e-loop/runner.e2e.ts:140` 이 쓴다)

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/piBridge.health.test.ts`:

```typescript
import { checkPiConnection, fetchPiHealth } from '../piBridge.service';

const mockFetch = jest.fn();

function okResponse(body: unknown) {
  return { ok: true, json: async () => body };
}

describe('fetchPiHealth', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    (global as any).fetch = mockFetch;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    (console.warn as jest.Mock).mockRestore();
  });

  it('snake_case 를 camelCase 로 옮긴다', async () => {
    mockFetch.mockResolvedValue(okResponse({ status: 'ok', mic_ok: true, speaker_ok: false }));
    await expect(fetchPiHealth()).resolves.toEqual({ micOk: true, speakerOk: false });
  });

  it('필드가 없는 구버전 Pi 는 undefined 로 남긴다 - "모름"이지 "정상"이 아니다', async () => {
    mockFetch.mockResolvedValue(okResponse({ status: 'ok' }));
    await expect(fetchPiHealth()).resolves.toEqual({ micOk: undefined, speakerOk: undefined });
  });

  it('불리언이 아닌 값은 undefined 로 떨군다', async () => {
    mockFetch.mockResolvedValue(okResponse({ mic_ok: 'yes', speaker_ok: null }));
    await expect(fetchPiHealth()).resolves.toEqual({ micOk: undefined, speakerOk: undefined });
  });

  it('본문이 JSON 이 아니어도 연결 자체는 살아있는 것으로 본다', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('not json');
      },
    });
    await expect(fetchPiHealth()).resolves.toEqual({ micOk: undefined, speakerOk: undefined });
  });

  it('HTTP 실패는 null', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(fetchPiHealth()).resolves.toBeNull();
  });

  it('네트워크 예외는 삼키고 null', async () => {
    mockFetch.mockRejectedValue(new Error('Network request failed'));
    await expect(fetchPiHealth()).resolves.toBeNull();
  });
});

describe('checkPiConnection', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    (global as any).fetch = mockFetch;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    (console.warn as jest.Mock).mockRestore();
  });

  it('헬스를 받으면 true, 못 받으면 false', async () => {
    mockFetch.mockResolvedValue(okResponse({ status: 'ok' }));
    await expect(checkPiConnection()).resolves.toBe(true);

    mockFetch.mockRejectedValue(new Error('down'));
    await expect(checkPiConnection()).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/services/__tests__/piBridge.health.test.ts`
Expected: FAIL — `fetchPiHealth is not a function`

- [ ] **Step 3: Write minimal implementation**

`src/services/piBridge.service.ts` 의 `checkPiConnection` 블록(41-52행)을 아래로 통째 교체:

```typescript
/** Pi 하드웨어 상태. 필드가 없으면(구버전 펌웨어) undefined - "모름"이지
 * "정상"이 아니다. 화면은 모르는 항목을 아예 안 그린다. */
export interface PiHealth {
  micOk?: boolean;
  speakerOk?: boolean;
}

/** Pi 는 snake_case, 앱은 camelCase. 변환은 여기 한 곳에서만 한다.
 * 불리언이 아닌 값은 떨군다 - 이상한 응답을 정상으로 오독하지 않기 위해서다. */
function optionalBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Pi 서버가 살아있는지 + 마이크·스피커가 정상인지. 죽었으면 null.
 * 절대 throw 하지 않는다 - connectionMonitor 의 판정이 여기 걸려 있다. */
export async function fetchPiHealth(): Promise<PiHealth | null> {
  try {
    const res = await fetchWithTimeout(`${PI_BASE_URL}/health`, {}, 5000);
    if (!res.ok) return null;
    // 본문이 깨져도 200 을 받았으면 서버는 살아있다 - 연결은 살리고
    // 하드웨어 상태만 "모름"으로 둔다.
    const body = await res.json().catch(() => ({}));
    return {
      micOk: optionalBool(body?.mic_ok),
      speakerOk: optionalBool(body?.speaker_ok),
    };
  } catch (err) {
    // 실패 원인이 IP 오타/다른 와이파이/서버 꺼짐 중 뭔지 로그로 남긴다 -
    // 호출부 Alert은 "응답 없음"이라고만 뜨니 실제 원인은 여기서 봐야 한다.
    console.warn(`[piBridge] health check failed against ${PI_BASE_URL}/health:`, err);
    return null;
  }
}

/** 살아있는지만 필요한 호출부(tools/e2e-loop/runner.e2e.ts)용 얇은 래퍼. */
export async function checkPiConnection(): Promise<boolean> {
  return (await fetchPiHealth()) !== null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/services/__tests__/piBridge.health.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/services/piBridge.service.ts src/services/__tests__/piBridge.health.test.ts
git commit -m "$(cat <<'EOF'
feat: fetchPiHealth 로 /health 본문까지 파싱

checkPiConnection 은 res.ok 만 보고 본문을 버렸다. mic_ok/speaker_ok 를
읽되, 불리언이 아닌 값은 undefined 로 떨궈 이상한 응답을 정상으로
오독하지 않게 한다. checkPiConnection 은 E2E 러너가 쓰므로 래퍼로 남긴다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 앱 — `connectionMonitor` 가 헬스를 실어나름

**Files:**
- Modify: `src/services/connectionMonitor.service.ts` (12행 import, 클래스 전체)
- Modify: `src/services/__tests__/connectionMonitor.service.test.ts` (1-3행 mock, 19-22행 import, 각 `mockResolvedValue`)

**Interfaces:**
- Consumes: Task 3 의 `fetchPiHealth(): Promise<PiHealth | null>`, `PiHealth`
- Produces: `connectionMonitor.health: PiHealth | null` (getter). `onStatusChange` 는 **상태 또는 헬스가 바뀌면** 통지한다. `status`/`start`/`stop`/`reportFailure`/`probeNow`/`onStatusChange` 시그니처 전부 불변.

- [ ] **Step 1: 기존 테스트의 mock 을 새 함수로 교체**

`src/services/__tests__/connectionMonitor.service.test.ts` 의 1-3행을 교체:

```typescript
jest.mock('../piBridge.service', () => ({
  fetchPiHealth: jest.fn(),
}));
```

19-22행을 교체:

```typescript
import { fetchPiHealth } from '../piBridge.service';
import { connectionMonitor } from '../connectionMonitor.service';

const mockCheck = fetchPiHealth as jest.Mock;
/** 연결 성공 = 헬스 객체, 실패 = null. 기존 true/false 자리에 그대로 들어간다. */
const ALIVE = {};
```

이제 파일 안의 모든 `mockCheck.mockResolvedValue(true)` → `mockCheck.mockResolvedValue(ALIVE)`, 모든 `mockCheck.mockResolvedValue(false)` → `mockCheck.mockResolvedValue(null)` 로 바꾼다 (총 13곳). 110-123행의 `a probe resolving after stop()` 테스트도 타입을 바꾼다:

```typescript
  it('a probe resolving after stop() does not override the connecting status it set', async () => {
    let resolveCheck: (health: object | null) => void = () => {};
    mockCheck.mockImplementation(
      () =>
        new Promise<object | null>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    connectionMonitor.start(); // probe() 시작 - fetchPiHealth 가 pending 인 채 대기
    connectionMonitor.stop(); // APP 모드 전환: 'connecting' 으로 되돌림
    resolveCheck(ALIVE); // 뒤늦게 도착한 판정
    await flush();
    expect(connectionMonitor.status).toBe('connecting');
  });
```

118행 주석의 `checkPiConnection` 도 `fetchPiHealth` 로 고친다.

- [ ] **Step 2: 새 동작 테스트 추가**

같은 파일의 마지막 `});` (157행, `describe` 닫기) **바로 위**에 추가:

```typescript
  it('exposes the health payload and clears it on stop()', async () => {
    mockCheck.mockResolvedValue({ micOk: true, speakerOk: false });
    connectionMonitor.start();
    await flush();
    expect(connectionMonitor.health).toEqual({ micOk: true, speakerOk: false });

    connectionMonitor.stop();
    expect(connectionMonitor.health).toBeNull();
  });

  it('health is null while disconnected', async () => {
    mockCheck.mockResolvedValue(null);
    connectionMonitor.start();
    await flush();
    expect(connectionMonitor.status).toBe('disconnected');
    expect(connectionMonitor.health).toBeNull();
  });

  it('notifies when only the health changes - status stays connected', async () => {
    // status 만 보고 게이팅하면 마이크가 죽어도 화면이 안 바뀐다.
    mockCheck.mockResolvedValue({ micOk: true, speakerOk: true });
    const seen: string[] = [];
    connectionMonitor.start();
    await flush();
    const unsub = connectionMonitor.onStatusChange((s) => seen.push(s));

    mockCheck.mockResolvedValue({ micOk: false, speakerOk: true });
    jest.advanceTimersByTime(5000);
    await flush();
    expect(seen).toEqual(['connected']); // 상태는 그대로지만 통지는 왔다
    expect(connectionMonitor.health).toEqual({ micOk: false, speakerOk: true });
    unsub();
  });

  it('does not notify when neither status nor health changed', async () => {
    mockCheck.mockResolvedValue({ micOk: true, speakerOk: true });
    connectionMonitor.start();
    await flush();
    const seen: string[] = [];
    const unsub = connectionMonitor.onStatusChange((s) => seen.push(s));

    mockCheck.mockResolvedValue({ micOk: true, speakerOk: true }); // 같은 값, 다른 객체
    jest.advanceTimersByTime(5000);
    await flush();
    expect(seen).toEqual([]);
    unsub();
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/services/__tests__/connectionMonitor.service.test.ts`
Expected: FAIL — `connectionMonitor.health` 가 `undefined` 이고, health-only 변경 시 통지가 안 온다

- [ ] **Step 4: Write implementation**

`src/services/connectionMonitor.service.ts` 의 12행 import 를 교체:

```typescript
import { fetchPiHealth, PiHealth } from './piBridge.service';
```

15행 아래 `PiConnectionStatus` 재수출 옆에 타입을 재수출한다(화면이 서비스 한 곳에서 다 가져가게):

```typescript
export type { PiHealth } from './piBridge.service';
```

22행 `private _status` 아래에 필드 추가:

```typescript
  private _health: PiHealth | null = null;
```

28-30행 `status` getter 아래에 추가:

```typescript
  /** 마지막 성공 프로브의 하드웨어 상태. 미연결·정지 중엔 null. */
  get health(): PiHealth | null {
    return this._health;
  }
```

54행 `this.setStatus('connecting');` 를 교체:

```typescript
    this.commit('connecting', null);
```

78-97행(`probe` 와 `setStatus`)을 아래로 통째 교체:

```typescript
  private async probe(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      const health = await fetchPiHealth(); // 절대 throw 안 함 (piBridge)
      // await 도중 stop() 이 오면(APP 모드 전환) 늦게 도착한 판정이
      // stop() 이 세팅한 'connecting' 계약을 덮어쓰면 안 된다.
      if (!this.pollTimer) return;
      this.commit(health ? 'connected' : 'disconnected', health);
    } finally {
      this.probing = false;
    }
  }

  /** 상태 **또는** 헬스가 바뀌었을 때만 통지한다. status 만 보고 게이팅하면
   * 연결을 유지한 채 마이크가 죽는 경우가 화면에 안 뜬다. */
  private commit(status: PiConnectionStatus, health: PiHealth | null): void {
    const changed =
      this._status !== status ||
      this._health?.micOk !== health?.micOk ||
      this._health?.speakerOk !== health?.speakerOk;
    if (this._status !== status) {
      console.log(`[ConnectionMonitor] ${this._status} -> ${status}`);
    }
    this._status = status;
    this._health = health;
    if (changed) this.listeners.forEach((l) => l(status));
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/services/__tests__/connectionMonitor.service.test.ts`
Expected: PASS — 기존 10개 + 신규 4개 = 14 tests

- [ ] **Step 6: 회귀 확인 — piBridge mock 을 쓰는 다른 스위트**

Run: `npm test -- src/hooks/__tests__/usePiConnection.test.ts`
Expected: FAIL — 이 파일은 아직 `checkPiConnection` 을 mock 한다. Task 5 에서 고친다. **여기서 고치지 마라.**

- [ ] **Step 7: Commit**

```bash
git add src/services/connectionMonitor.service.ts src/services/__tests__/connectionMonitor.service.test.ts
git commit -m "$(cat <<'EOF'
feat: connectionMonitor 가 하드웨어 상태를 같이 실어나름

기존 5초 폴링·기존 구독 채널에 업는다. setStatus 를 commit 으로 바꿔
상태가 그대로여도 헬스가 바뀌면 통지한다 - status 만 보고 게이팅하면
연결을 유지한 채 마이크가 죽는 경우가 화면에 안 뜬다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 앱 — `usePiDeviceHealth()` 훅

**Files:**
- Modify: `src/hooks/usePiConnection.ts`
- Modify: `src/hooks/__tests__/usePiConnection.test.ts:1-3` (mock 교체) + 테스트 추가

**Interfaces:**
- Consumes: Task 4 의 `connectionMonitor.health`, `connectionMonitor.onStatusChange`
- Produces: `export function usePiDeviceHealth(): PiHealth | null`. `usePiConnection(): PiConnectionStatus` 는 **반환 타입 불변** (App.tsx·ConversationScreen 이 문자열로 쓴다).

- [ ] **Step 1: 테스트 mock 교체 + 새 테스트 추가**

`src/hooks/__tests__/usePiConnection.test.ts` 의 1-3행을 교체:

```typescript
jest.mock('../../services/piBridge.service', () => ({
  fetchPiHealth: jest.fn().mockResolvedValue({ micOk: true, speakerOk: true }),
}));
```

8행 import 를 교체:

```typescript
import { usePiConnection, usePiDeviceHealth } from '../usePiConnection';
```

파일 맨 끝(45행 `});` 다음)에 추가:

```typescript
describe('usePiDeviceHealth', () => {
  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
    connectionMonitor.stop();
  });

  it('follows the monitor health and clears on stop()', async () => {
    const ref: { current: unknown } = { current: undefined };
    function Harness() {
      ref.current = usePiDeviceHealth();
      return null;
    }
    act(() => {
      renderer = ReactTestRenderer.create(React.createElement(Harness));
    });
    expect(ref.current).toBeNull();

    await act(async () => {
      connectionMonitor.start();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(ref.current).toEqual({ micOk: true, speakerOk: true });

    act(() => {
      connectionMonitor.stop();
    });
    expect(ref.current).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/hooks/__tests__/usePiConnection.test.ts`
Expected: FAIL — `usePiDeviceHealth is not a function`

- [ ] **Step 3: Write implementation**

`src/hooks/usePiConnection.ts` 를 아래로 통째 교체:

```typescript
import { useEffect, useState } from 'react';
import {
  connectionMonitor,
  PiConnectionStatus,
  PiHealth,
} from '../services/connectionMonitor.service';

/** connectionMonitor 구독. 판정은 서비스가 하고 여기는 리렌더만 잇는다. */
export function usePiConnection(): PiConnectionStatus {
  const [status, setStatus] = useState<PiConnectionStatus>(connectionMonitor.status);

  useEffect(() => {
    setStatus(connectionMonitor.status); // 마운트 전 변화 반영
    return connectionMonitor.onStatusChange(setStatus);
  }, []);

  return status;
}

/** 마이크·스피커 생존 상태. 같은 구독 채널을 쓴다 - monitor 가 헬스만
 * 바뀌어도 통지하므로(commit) 별도 채널이 필요 없다. */
export function usePiDeviceHealth(): PiHealth | null {
  const [health, setHealth] = useState<PiHealth | null>(connectionMonitor.health);

  useEffect(() => {
    setHealth(connectionMonitor.health); // 마운트 전 변화 반영
    return connectionMonitor.onStatusChange(() => setHealth(connectionMonitor.health));
  }, []);

  return health;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/hooks/__tests__/usePiConnection.test.ts`
Expected: PASS — 2 tests

- [ ] **Step 5: Commit**

```bash
git add src/hooks/usePiConnection.ts src/hooks/__tests__/usePiConnection.test.ts
git commit -m "$(cat <<'EOF'
feat: usePiDeviceHealth 훅 추가

usePiConnection 반환 타입은 그대로 둔다 - App.tsx 와 ConversationScreen 이
문자열로 쓰고 있어 넓히면 호출부가 다 깨진다. 새 파일 대신 같은 파일에
두 번째 훅을 얹는다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: UI — `DeviceVitals` 컴포넌트

**Files:**
- Create: `src/components/DeviceVitals.tsx`
- Test: `src/components/__tests__/DeviceVitals.test.tsx`

**Interfaces:**
- Consumes: `PiConnectionStatus`, `PiHealth` (from `../services/connectionMonitor.service`), 토큰 `GREEN`/`ORANGE`/`INK`/`FONT`/`SURFACE_BORDER_COLOR` (from `../theme`)
- Produces: `export default function DeviceVitals(props: { status: PiConnectionStatus; health: PiHealth | null }): React.JSX.Element | null`. `testID="device-vitals"`.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/DeviceVitals.test.tsx`:

```typescript
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import DeviceVitals from '../DeviceVitals';
import { GREEN, INK, ORANGE } from '../../theme';

function render(el: React.ReactElement) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(el);
  });
  return tree;
}

function labels(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findAllByType(Text).map((t) => t.props.children);
}

const HEALTHY = { micOk: true, speakerOk: true };

describe('DeviceVitals', () => {
  it('연결됨 + 정상: 연결·마이크·스피커 3칸', () => {
    const tree = render(<DeviceVitals status="connected" health={HEALTHY} />);
    expect(labels(tree)).toEqual(['연결됨', '마이크', '스피커']);
  });

  it('마이크 고장: 색이 아니라 문구가 바뀐다', () => {
    const tree = render(<DeviceVitals status="connected" health={{ micOk: false, speakerOk: true }} />);
    expect(labels(tree)).toEqual(['연결됨', '마이크 안 들려', '스피커']);
  });

  it('스피커 고장: 문구 교체', () => {
    const tree = render(<DeviceVitals status="connected" health={{ micOk: true, speakerOk: false }} />);
    expect(labels(tree)).toEqual(['연결됨', '마이크', '소리가 안 나와']);
  });

  it('고장난 칸의 점만 ORANGE, 라벨 색은 항상 INK 로 유지된다', () => {
    // ORANGE 는 크림 배경에서 12px 소형 텍스트 대비 미달이라 라벨엔 못 쓴다.
    const tree = render(<DeviceVitals status="connected" health={{ micOk: false, speakerOk: true }} />);
    const dots = tree.root.findAllByProps({ testID: 'device-vitals-dot' });
    const colors = dots.map((d) => StyleSheet.flatten(d.props.style).backgroundColor);
    expect(colors).toEqual([GREEN, ORANGE, GREEN]);

    const labelColors = tree.root
      .findAllByType(Text)
      .map((t) => StyleSheet.flatten(t.props.style).color);
    expect(labelColors).toEqual([INK, INK, INK]);
  });

  it('구버전 Pi(필드 없음): 모르는 칸은 아예 안 그린다', () => {
    const tree = render(<DeviceVitals status="connected" health={{}} />);
    expect(labels(tree)).toEqual(['연결됨']);
  });

  it('마이크만 알고 스피커는 모름', () => {
    const tree = render(<DeviceVitals status="connected" health={{ micOk: true }} />);
    expect(labels(tree)).toEqual(['연결됨', '마이크']);
  });

  it('health 가 null 이어도 연결 칸은 그린다', () => {
    const tree = render(<DeviceVitals status="connected" health={null} />);
    expect(labels(tree)).toEqual(['연결됨']);
  });

  it.each(['connecting', 'disconnected'] as const)('%s: 아무것도 안 그린다', (status) => {
    const tree = render(<DeviceVitals status={status} health={HEALTHY} />);
    expect(tree.toJSON()).toBeNull();
  });

  it('스크린리더는 파편이 아니라 한 문장을 읽는다', () => {
    const tree = render(<DeviceVitals status="connected" health={{ micOk: false, speakerOk: true }} />);
    const row = tree.root.findByProps({ testID: 'device-vitals' });
    expect(row.props.accessibilityLabel).toBe('비바 상태: 연결됨, 마이크 안 들려, 스피커 정상');
  });

  it('항목 사이에 구분선이 들어간다 (3칸이면 2개)', () => {
    const tree = render(<DeviceVitals status="connected" health={HEALTHY} />);
    expect(tree.root.findAllByProps({ testID: 'device-vitals-divider' })).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/__tests__/DeviceVitals.test.tsx`
Expected: FAIL — `Cannot find module '../DeviceVitals'`

- [ ] **Step 3: Write implementation**

Create `src/components/DeviceVitals.tsx`:

```typescript
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { GREEN, ORANGE, INK, FONT, SURFACE_BORDER_COLOR } from '../theme';
import type { PiConnectionStatus, PiHealth } from '../services/connectionMonitor.service';

interface DeviceVitalsProps {
  status: PiConnectionStatus;
  health: PiHealth | null;
}

interface Vital {
  key: string;
  /** 화면 문구. 고장 상태는 색이 아니라 이 문구가 진다. */
  label: string;
  /** 스크린리더용. 정상일 때 "마이크"만 읽으면 상태가 안 들린다. */
  a11y: string;
  ok: boolean;
}

/** 모르는 항목(구버전 Pi 라 필드가 없음)은 목록에 넣지 않는다 - 모르는
 * 정보를 초록으로 칠하지 않기 위해서다. */
function buildVitals(health: PiHealth | null): Vital[] {
  // 계기판은 connected 일 때만 뜨므로 연결 칸은 사실상 항상 초록이다.
  // 그래도 남기는 건 셋을 한 덩어리로 읽히게 하는 앵커이기 때문 - 마이크·
  // 스피커만 떠 있으면 "무엇의 상태인지"가 모호해진다.
  const vitals: Vital[] = [{ key: 'connection', label: '연결됨', a11y: '연결됨', ok: true }];

  if (typeof health?.micOk === 'boolean') {
    vitals.push(
      health.micOk
        ? { key: 'mic', label: '마이크', a11y: '마이크 정상', ok: true }
        : { key: 'mic', label: '마이크 안 들려', a11y: '마이크 안 들려', ok: false },
    );
  }

  if (typeof health?.speakerOk === 'boolean') {
    vitals.push(
      health.speakerOk
        ? { key: 'speaker', label: '스피커', a11y: '스피커 정상', ok: true }
        : { key: 'speaker', label: '소리가 안 나와', a11y: '소리가 안 나와', ok: false },
    );
  }

  return vitals;
}

/**
 * 디바이스 모드 홈의 계기판 한 줄. 연결·마이크·스피커는 한 물건(비바)의
 * 세 단면이라 흩어진 알약 대신 한 덩어리로 묶는다 - 구분선이 그 대등함을
 * 인코딩한다.
 *
 * 애니메이션은 없다. 5초 폴링으로 갱신되는 값의 상태 전환에 모션을 붙이면
 * 장식이고, 이 코드베이스에는 reduced-motion 처리가 아직 없다.
 */
export default function DeviceVitals({
  status,
  health,
}: DeviceVitalsProps): React.JSX.Element | null {
  // 미연결 상태에선 하드웨어 상태를 알 방법이 없다. stale 값을 보여주느니
  // 아무것도 안 보여준다 (중앙은 연결 가이드 카드가 가져간다).
  if (status !== 'connected') return null;

  const vitals = buildVitals(health);

  return (
    <View
      style={styles.row}
      testID="device-vitals"
      accessibilityLabel={`비바 상태: ${vitals.map((v) => v.a11y).join(', ')}`}
    >
      {vitals.map((vital, i) => (
        <React.Fragment key={vital.key}>
          {i > 0 && <View style={styles.divider} testID="device-vitals-divider" />}
          <View
            style={styles.item}
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
          >
            <View
              style={[styles.dot, { backgroundColor: vital.ok ? GREEN : ORANGE }]}
              testID="device-vitals-dot"
            />
            <Text style={styles.label}>{vital.label}</Text>
          </View>
        </React.Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 12,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  divider: {
    width: 1,
    height: 12,
    backgroundColor: SURFACE_BORDER_COLOR,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: FONT,
    // 항상 INK. ORANGE(약 3.3:1)와 INK_MUTED(약 3.0:1)는 크림 배경에서
    // 12px 소형 텍스트 기준 4.5:1 미달이다 - 의미는 문구가 지고 색은 점만.
    color: INK,
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/__tests__/DeviceVitals.test.tsx`
Expected: PASS — 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/components/DeviceVitals.tsx src/components/__tests__/DeviceVitals.test.tsx
git commit -m "$(cat <<'EOF'
feat: DeviceVitals - 연결·마이크·스피커 계기판 한 줄

한 물건의 세 단면이라 흩어진 알약 대신 한 덩어리로 묶고, 구분선이 그
대등함을 인코딩한다. 고장은 색이 아니라 문구가 진다 - ORANGE 는 크림
배경에서 12px 대비 3.3:1 로 미달이라 라벨엔 못 쓴다. 모르는 항목(구버전
Pi)은 아예 안 그린다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: UI — HomeScreen 배치 + App.tsx 배선 + 칩 삭제

> **드롭됨(2026-08-10, 최종 리뷰).** 완료가 아니라 **의도적으로 안 함**이다.
> 프로젝트가 폰 앱을 두 개(디바이스 없는 앱 / 디바이스 연동 앱)로 쪼개는
> 쪽으로 방향이 바뀌었다 - 쪼개고 나면 런타임 모드 토글 자체가 없어진다.
> `DeviceVitals` 를 `HomeScreen` 에 배선하는 일은 그 분리 작업 쪽으로 넘어간다.
> 아래 내용은 지우지 않는다 - 분리 작업이 그대로 재사용한다.

**Files:**
- Modify: `src/screens/HomeScreen.tsx`
- Modify: `App.tsx:21` (import), `App.tsx:98` 근처 (훅), `App.tsx:385-395` (HomeScreen 렌더)
- Delete: `src/components/ConnectionStatusChip.tsx`
- Modify: `src/components/__tests__/connectionUi.test.tsx` (칩 describe 블록 삭제)
- Modify: `src/components/__tests__/HomeScreen.modes.test.tsx`

**Interfaces:**
- Consumes: Task 5 의 `usePiDeviceHealth()`, Task 6 의 `DeviceVitals`
- Produces: `HomeScreenProps` 에 `piHealth: PiHealth | null` 추가

- [ ] **Step 1: 작업 트리 확인 — 다른 세션의 미커밋 변경**

Run: `git status --short src/screens/HomeScreen.tsx`

`M src/screens/HomeScreen.tsx` 가 뜨면 다른 세션이 호출어 문구를 고치는 중이다.
Run: `git diff src/screens/HomeScreen.tsx`
그 변경 내용을 확인하고 **보존한 채** 아래 편집을 얹는다. 커밋 시 이 파일을 add 하면 남의 변경이 딸려간다 — Step 8 에서 다시 확인한다.

- [ ] **Step 2: HomeScreen 테스트 갱신**

`src/components/__tests__/HomeScreen.modes.test.tsx` 의 `baseProps`(9-15행)에 `piHealth` 추가:

```typescript
const baseProps = {
  onPressToTalk: jest.fn(),
  onPressHistory: jest.fn(),
  solveMode: false,
  onToggleSolveMode: jest.fn(),
  onToggleMode: jest.fn(),
  piHealth: null,
};
```

58행의 칩 단언을 계기판으로 교체:

```typescript
    expect(tree.root.findAllByProps({ testID: 'device-vitals' })).toHaveLength(0);
```

`describe('HomeScreen 디바이스 모드')` 블록 안, 첫 테스트 다음에 추가:

```typescript
  it('연결됨 + 헬스 정상: 계기판 3칸', () => {
    const tree = render(
      <HomeScreen
        {...baseProps}
        mode="device"
        piStatus="connected"
        piHealth={{ micOk: true, speakerOk: true }}
      />,
    );
    expect(tree.root.findAllByProps({ testID: 'device-vitals' }).length).toBeGreaterThan(0);
    expect(JSON.stringify(tree.toJSON())).toContain('스피커');
  });

  it('마이크 고장: 문구가 계기판에 뜬다', () => {
    const tree = render(
      <HomeScreen
        {...baseProps}
        mode="device"
        piStatus="connected"
        piHealth={{ micOk: false, speakerOk: true }}
      />,
    );
    expect(JSON.stringify(tree.toJSON())).toContain('마이크 안 들려');
  });

  it('연결 안 됨: 계기판 없음', () => {
    const tree = render(
      <HomeScreen
        {...baseProps}
        mode="device"
        piStatus="disconnected"
        piHealth={{ micOk: true, speakerOk: true }}
      />,
    );
    expect(tree.root.findAllByProps({ testID: 'device-vitals' })).toHaveLength(0);
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/components/__tests__/HomeScreen.modes.test.tsx`
Expected: FAIL — `device-vitals` 를 못 찾는다

- [ ] **Step 4: HomeScreen 수정**

`src/screens/HomeScreen.tsx` 에서:

(a) 6행 `import ConnectionStatusChip from '../components/ConnectionStatusChip';` 을 **삭제**하고 대신 추가:

```typescript
import DeviceVitals from '../components/DeviceVitals';
```

(b) 12행 import 를 교체:

```typescript
import type { PiConnectionStatus, PiHealth } from '../services/connectionMonitor.service';
```

(c) `HomeScreenProps` 의 `piStatus` 선언 아래에 추가:

```typescript
  /** 디바이스 모드에서만 의미 있다. 모르면 null. */
  piHealth: PiHealth | null;
```

(d) 구조분해(34-42행)에 `piHealth` 추가:

```typescript
export default function HomeScreen({
  mode,
  onToggleMode,
  piStatus,
  piHealth,
  onPressToTalk,
  onPressHistory,
  solveMode,
  onToggleSolveMode,
}: HomeScreenProps): React.JSX.Element {
```

(e) 53행 칩 렌더 줄을 **삭제**:

```typescript
      {deviceMode && <ConnectionStatusChip status={piStatus} safeTop={safeTop + 44} />}
```

(f) `piStatus === 'connected'` 분기(68-72행)에서 **`</Text>` 두 줄은 손대지 않고**, 닫는 `</View>` 바로 앞에 세 줄을 삽입한다. `wakeTitle`/`wakeSub` 의 문구 리터럴은 현재 파일에 있는 것을 그대로 둔다 (Global Constraints 참조 — 다른 세션이 바꾸는 중이다).

삽입 위치는 아래 구조에서 `+` 표시한 줄이다:

```
        ) : piStatus === 'connected' ? (
          <View style={styles.wakeGuide}>
            <Text style={styles.wakeTitle}>...현재 문구 그대로...</Text>
            <Text style={styles.wakeSub}>...현재 문구 그대로...</Text>
+           <View style={styles.vitalsSlot}>
+             <DeviceVitals status={piStatus} health={piHealth} />
+           </View>
          </View>
```

즉 `<Text style={styles.wakeSub}>` 로 시작하는 줄 다음에 아래를 그대로 붙인다:

```typescript
            <View style={styles.vitalsSlot}>
              <DeviceVitals status={piStatus} health={piHealth} />
            </View>
```

(g) 스타일에서 `wakeGuide` 의 `gap` 을 12 → 8 로 줄이고, `wakeTitle` 의 `fontSize` 를 24 → 28 로 올리고, `vitalsSlot` 을 추가:

```typescript
  wakeGuide: {
    alignItems: 'center',
    // 히어로 -> 서브는 붙이고, 계기판만 vitalsSlot 으로 크게 떼어놓는다.
    gap: 8,
  },
  vitalsSlot: {
    marginTop: 20,
  },
  wakeTitle: {
    fontSize: 28,
    fontWeight: '700',
    fontFamily: FONT,
    color: INK,
    textAlign: 'center',
  },
```

> `vitalsSlot` 의 `marginTop: 20` + `wakeGuide` 의 `gap: 8` = 서브 문구와 계기판 사이 28.
> `connecting`/`disconnected` 분기는 별도 `wakeGuide`/`guideWrap` 을 쓰므로 이 슬롯이 안 붙는다.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/components/__tests__/HomeScreen.modes.test.tsx`
Expected: PASS — 5 tests

- [ ] **Step 6: App.tsx 배선**

`App.tsx` 21행 import 를 교체:

```typescript
import { usePiConnection, usePiDeviceHealth } from './src/hooks/usePiConnection';
```

98행 `const piStatus = usePiConnection();` 바로 아래에 추가:

```typescript
  const piHealth = usePiDeviceHealth();
```

385-395행의 `HomeScreen` 렌더에서 `piStatus={piStatus}` 바로 아래에 prop 추가:

```typescript
          piHealth={piHealth}
```

- [ ] **Step 7: 칩 삭제 + 남은 테스트 정리**

`src/components/ConnectionStatusChip.tsx` 를 삭제한다:

```bash
git rm src/components/ConnectionStatusChip.tsx
```

`src/components/__tests__/connectionUi.test.tsx` 에서 4행 import 와 32-44행 `describe('ConnectionStatusChip', ...)` 블록 전체를 삭제한다. 남는 파일은 `ModeToggle` 과 `ConnectionGuideCard` describe 두 개다.

- [ ] **Step 8: 전체 스위트 + 타입 확인**

Run: `npx tsc --noEmit`
Expected: 에러 없음 (`connection-status-chip` 잔여 참조가 있으면 여기서 잡힌다)

Run: `npm test`
Expected: 전부 PASS.

> **알려진 주의:** `HomeScreen.modes.test.tsx:41` 이 히어로 문구로 `'비바야'` 를 단언한다. 다른 세션이 문구를 `"헤이, 비바"` 로 바꾸는 중이라, 그 변경이 들어와 있으면 이 단언이 깨진다. **그건 이 작업의 회귀가 아니다** — 문구를 바꾼 쪽이 고칠 몫이니 임의로 문구를 되돌리지 마라. 깨졌다면 사용자에게 알린다.

Run: `npx eslint src/components/DeviceVitals.tsx src/screens/HomeScreen.tsx src/hooks/usePiConnection.ts src/services/connectionMonitor.service.ts src/services/piBridge.service.ts`
Expected: 에러 없음

- [ ] **Step 9: Commit**

`git status --short` 로 스테이징 대상을 먼저 확인한다. **`git add -A` 금지** — 다른 세션의 미커밋 파일이 섞인다. HomeScreen.tsx 에 남의 문구 변경이 함께 들어 있다면 사용자에게 먼저 알린다.

```bash
git status --short
git add src/screens/HomeScreen.tsx App.tsx \
        src/components/__tests__/HomeScreen.modes.test.tsx \
        src/components/__tests__/connectionUi.test.tsx \
        src/components/ConnectionStatusChip.tsx
git commit -m "$(cat <<'EOF'
feat: 디바이스 모드 홈에 마이크·스피커 상태 표시

상단 흰 알약 3개가 전부 같은 서피스라 누르는 것과 읽는 것이 구분되지
않았고, 연결 칩은 left:132 하드코딩이라 라벨이 길어지면 모드 토글과
겹쳤다. 상태를 중앙 히어로 아래 계기판 한 줄로 옮기면서 칩을 삭제하고
절대배치도 함께 없앤다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 10: 실기기 확인**

Pi 에 Task 2 가 배포된 상태에서 폰을 디바이스 모드로 띄운다.

1. 정상: 히어로 아래 `● 연결됨 │ ● 마이크 │ ● 스피커` 3칸이 초록으로 뜬다.
2. 스피커 고장 재현: `ssh viva@viva.local 'sudo systemctl stop viva-silence'` → 5초 안에 `소리가 안 나와` + 주황 점. 복구: `sudo systemctl start viva-silence`.
3. 마이크 고장 재현: `ssh viva@viva.local 'sudo systemctl stop viva-wake'` → 10초 sticky 지난 뒤 `마이크 안 들려`. 복구: `sudo systemctl start viva-wake`.
4. 핸드오프 오탐 확인: 호출어로 대화를 한 턴 돌리는 동안 `마이크 안 들려` 가 깜빡이지 않아야 한다 (sticky 가 먹는지 보는 것 — 여기서 깜빡이면 `MIC_STICKY_S` 를 올린다).

---

### Task 8: UI — ModeToggle 을 SolveModeToggle 문법으로 통일

> **드롭됨(2026-08-10, 최종 리뷰).** 완료가 아니라 **의도적으로 안 함**이다.
> 앱을 폰 전용/디바이스 연동 두 빌드로 쪼개는 쪽으로 방향이 바뀌면서
> `ModeToggle` 자체(런타임 모드 전환 스위치)가 사라진다 - 통일할 대상이
> 없어진다. 아래 내용은 지우지 않는다 - 참고용으로 남긴다.

**Files:**
- Modify: `src/components/ModeToggle.tsx` (전체 교체)
- Modify: `src/components/__tests__/connectionUi.test.tsx` (ModeToggle describe 에 라벨 테스트 추가)
- Modify: `src/screens/HomeScreen.tsx` (`ModeToggle` 에 `transparent` 전달)

**Interfaces:**
- Consumes: 토큰 `SURFACE_COLOR`/`SURFACE_BORDER_COLOR`/`INK` (from `../theme`), `AppMode` (from `../hooks/useAppMode`)
- Produces: `ModeToggle` props 에 `transparent?: boolean` 추가. `mode`/`onToggle`/`safeTop` 및 `testID="mode-toggle"`, `accessibilityRole="switch"`, `accessibilityState={{ checked: isApp }}` 는 **전부 불변** (기존 테스트가 이 계약에 걸려 있다).

**디자인 결정 — 그린 채움은 가져오지 않는다**

SolveModeToggle 의 그린은 "정답 모드 ON" 이라는 불리언 상태다. 모드 토글은 on/off 가
아니라 A/B 선택이라, 한쪽을 그린으로 칠하면 "APP 모드가 켜진 좋은 상태"로 읽힌다.
실제로는 APP 모드가 디바이스 없이 쓰는 축소 모드다. 그린은 상단 줄 전체에서
**"정답 모드 켜짐" 한 가지 의미만** 지게 남긴다.

가져오는 것: 트랙 높이 36 / 반경 18 / 테두리 1.5 / 그림자, 원형 노브 28 + 슬라이드,
스프링 `friction: 6, tension: 50`, `useNativeDriver: false`, 라벨 13/700 Pretendard
크로스페이드, `transparent` prop, **라벨은 노브 반대편**(SolveModeToggle 과 같은 문법).

트랙 폭만 76 → 104 로 넓힌다 — `정답`/`힌트`는 2자지만 `디바이스`는 4자다.

- [ ] **Step 1: Write the failing test**

먼저 `src/components/__tests__/connectionUi.test.tsx` 의 상단(1-13행)을 교체한다. ModeToggle 이 이제 `Animated.spring` 을 돌리므로, 언마운트하지 않으면 스위트 teardown 뒤에 타이머가 튄다:

```typescript
import React from 'react';
import { StyleSheet } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import ModeToggle from '../ModeToggle';
import ConnectionGuideCard from '../ConnectionGuideCard';

let current: ReactTestRenderer.ReactTestRenderer | undefined;

function render(el: React.ReactElement) {
  act(() => {
    current = ReactTestRenderer.create(el);
  });
  return current!;
}

// ModeToggle 의 spring 이 언마운트 없이 남으면 teardown 후에 타이머가 튄다.
afterEach(() => {
  act(() => {
    current?.unmount();
  });
  current = undefined;
});
```

> `ConnectionStatusChip` import 는 Task 7 Step 7 에서 이미 지웠다. 위 블록에도 없다.
> 한 테스트에서 `render()` 를 두 번 부르면 뒤엣것만 언마운트된다 — 아래 라벨
> 테스트는 그래서 각각 즉시 단언하고 넘어간다.

그다음 `describe('ModeToggle', ...)` 블록 안, 기존 두 테스트 다음에 추가:

```typescript
  it('현재 모드를 라벨로 보여준다', () => {
    const device = render(<ModeToggle mode="device" onToggle={() => {}} />);
    expect(JSON.stringify(device.toJSON())).toContain('디바이스');

    const app = render(<ModeToggle mode="app" onToggle={() => {}} />);
    expect(JSON.stringify(app.toJSON())).toContain('APP');
  });

  it('SolveModeToggle 과 같은 슬라이딩 노브를 쓴다', () => {
    const tree = render(<ModeToggle mode="device" onToggle={() => {}} />);
    expect(tree.root.findAllByProps({ testID: 'mode-toggle-knob' })).toHaveLength(1);
  });

  it('transparent 는 트랙 배경/테두리를 지운다 (HomeScreen 용)', () => {
    const tree = render(<ModeToggle mode="device" onToggle={() => {}} transparent />);
    const track = tree.root.findByProps({ testID: 'mode-toggle' });
    // style 이 ({pressed}) => [...] 형태라 직접 호출한 뒤 flatten 한다.
    const flat = StyleSheet.flatten(track.props.style({ pressed: false }));
    expect(flat.backgroundColor).toBe('transparent');
    expect(flat.borderColor).toBe('transparent');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/__tests__/connectionUi.test.tsx`
Expected: FAIL — `mode-toggle-knob` 을 못 찾고, 라벨이 `디바이스 모드` 라 `APP` 단언이 깨진다

- [ ] **Step 3: Write implementation**

`src/components/ModeToggle.tsx` 를 아래로 통째 교체:

```typescript
import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';
import { SURFACE_COLOR, SURFACE_BORDER_COLOR, INK, FONT } from '../theme';
import type { AppMode } from '../hooks/useAppMode';

interface ModeToggleProps {
  mode: AppMode;
  onToggle: () => void;
  /** Safe-area top inset (HomeScreen 의 safeTop 과 동일 값). */
  safeTop?: number;
  /** 트랙 배경/테두리를 지운다 (HomeScreen 처럼 배경 위에 얹을 때). */
  transparent?: boolean;
}

const TRACK_WIDTH = 104;
const KNOB_SIZE = 28;
const KNOB_INSET = 4;

/**
 * 좌상단 모드 전환 스위치. SolveModeToggle(우상단)과 같은 문법 - 트랙 높이 36,
 * 원형 노브 28 슬라이드, 라벨은 노브 반대편에서 크로스페이드.
 *
 * 다만 그린 채움은 가져오지 않는다. SolveModeToggle 의 그린은 "정답 모드 ON"
 * 이라는 불리언 상태인데, 모드 전환은 on/off 가 아니라 A/B 선택이다. 한쪽을
 * 그린으로 칠하면 APP 모드(디바이스 없이 쓰는 축소 모드)가 "켜진 좋은 상태"로
 * 읽힌다. 그린은 상단 줄에서 "정답 모드 켜짐" 한 가지 의미만 지게 남긴다.
 *
 * 트랙 폭만 76 -> 104 다 - '정답'/'힌트'는 2자지만 '디바이스'는 4자라서.
 */
export default function ModeToggle({
  mode,
  onToggle,
  safeTop,
  transparent = false,
}: ModeToggleProps): React.JSX.Element {
  const isApp = mode === 'app';
  const anim = useRef(new Animated.Value(isApp ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(anim, {
      toValue: isApp ? 1 : 0,
      useNativeDriver: false,
      friction: 6,
      tension: 50,
    }).start();
  }, [isApp, anim]);

  const knobTranslate = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [KNOB_INSET, TRACK_WIDTH - KNOB_SIZE - KNOB_INSET],
  });

  const deviceOpacity = anim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });

  return (
    <View
      style={[styles.container, safeTop !== undefined && { top: safeTop }]}
      pointerEvents="box-none"
    >
      <Pressable
        accessibilityRole="switch"
        accessibilityLabel={isApp ? 'APP 모드 (디바이스 없이 사용 중)' : '디바이스 모드'}
        accessibilityState={{ checked: isApp }}
        testID="mode-toggle"
        style={({ pressed }) => [
          styles.track,
          transparent && styles.trackTransparent,
          pressed && styles.trackPressed,
        ]}
        onPress={onToggle}
      >
        {/* 라벨은 항상 노브 반대편에 선다 (SolveModeToggle 과 같은 문법). */}
        <Animated.Text style={[styles.labelRight, { opacity: deviceOpacity }]}>
          디바이스
        </Animated.Text>
        <Animated.Text style={[styles.labelLeft, { opacity: anim }]}>APP</Animated.Text>

        <Animated.View
          style={[styles.knob, { transform: [{ translateX: knobTranslate }] }]}
          testID="mode-toggle-knob"
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 18,
    left: 12,
    zIndex: 40,
  },
  track: {
    width: TRACK_WIDTH,
    height: 36,
    borderRadius: 18,
    backgroundColor: SURFACE_COLOR,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    justifyContent: 'center',
    overflow: 'hidden',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  trackTransparent: {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
  },
  trackPressed: {
    opacity: 0.8,
  },
  labelLeft: {
    position: 'absolute',
    left: 14,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: FONT,
    color: INK,
  },
  labelRight: {
    position: 'absolute',
    right: 12,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: FONT,
    color: INK,
  },
  knob: {
    position: 'absolute',
    width: KNOB_SIZE,
    height: KNOB_SIZE,
    borderRadius: KNOB_SIZE / 2,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
    elevation: 2,
    borderWidth: 0.5,
    borderColor: 'rgba(0,0,0,0.04)',
  },
});
```

- [ ] **Step 4: HomeScreen 에서 transparent 전달**

`src/screens/HomeScreen.tsx` 의 `ModeToggle` 렌더(52행)를 교체 — 우상단 `SolveModeToggle` 이 이미 `transparent` 라, 짝을 맞춰야 상단 두 컨트롤이 같은 재질로 읽힌다:

```typescript
      <ModeToggle mode={mode} onToggle={onToggleMode} transparent safeTop={safeTop} />
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/components/__tests__/connectionUi.test.tsx src/components/__tests__/HomeScreen.modes.test.tsx`
Expected: PASS

Run: `npm test`
Expected: 전부 PASS

Run: `npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 6: Commit**

```bash
git status --short
git add src/components/ModeToggle.tsx \
        src/components/__tests__/connectionUi.test.tsx \
        src/screens/HomeScreen.tsx
git commit -m "$(cat <<'EOF'
feat: ModeToggle 을 SolveModeToggle 과 같은 슬라이딩 스위치로 통일

상단 좌우 컨트롤이 정적 알약 / 애니메이션 스위치로 문법이 갈려 있었다.
트랙 치수·노브·스프링·크로스페이드를 맞추고 HomeScreen 에서 둘 다
transparent 로 얹는다. 트랙 폭만 104 - '디바이스'가 4자라서.

그린 채움은 가져오지 않는다. SolveModeToggle 의 그린은 "정답 모드 ON"
이라는 불리언인데 모드 전환은 A/B 선택이라, 한쪽을 칠하면 APP 모드가
"켜진 좋은 상태"로 읽힌다.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: 실기기 확인**

폰에서 홈 화면을 띄우고 모드 토글을 몇 번 눌러본다.

1. 노브가 좌우로 스프링 슬라이드하고, 라벨이 `디바이스` ↔ `APP` 으로 크로스페이드된다.
2. 우상단 `정답/힌트` 토글과 재질(노브 크기·그림자·글자 크기)이 같아 보인다.
3. 트랙이 투명이라 크림 배경 위에 노브와 글자만 뜬다 — 우상단과 같은 인상.
4. 탭 영역이 104×36 이라 44pt 최소 높이에는 못 미친다. **손가락으로 눌러보고 잘 안 눌리면
   `Pressable` 에 `hitSlop={{ top: 6, bottom: 6, left: 8, right: 8 }}` 을 추가한다**
   (SolveModeToggle 도 36 이라 같은 제약이 이미 있다 — 여기서 문제가 확인되면 양쪽 다 고친다).

---

## 검증 요약

| 확인 | 명령 |
|---|---|
| Pi 단위 | `cd pi-server && python3 -m unittest test_audio_health -v` |
| Pi 문법 | `cd pi-server && python3 -c "import ast; ast.parse(open('app.py').read())"` |
| 앱 전체 | `npm test` |
| 타입 | `npx tsc --noEmit` |
| 린트 | `npx eslint src/` |
| 실기기 | `curl -s http://viva.local:5000/health` + Task 7 Step 10 |

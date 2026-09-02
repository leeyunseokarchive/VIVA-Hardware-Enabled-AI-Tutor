"""_trim_recording 단위 체크. 하드웨어·flask 없이 python3 -m unittest
test_record_trim 으로 돈다 - app.py 의 Pi 전용 의존성은 import 전에
sys.modules 스텁으로 대체한다 (import 시점 부작용은 Flask() 생성뿐)."""
import struct
import sys
import tempfile
import types
import unittest

# app.py 의 Pi 전용 import 를 스텁으로 대체. Flask 는 라우트 데코레이터가
# 동작해야 해서 no-op 데코레이터를 가진 가짜 클래스를 준다.
class _FakeFlask:
    def __init__(self, *_a, **_k):
        pass

    def route(self, *_a, **_k):
        def deco(fn):
            return fn
        return deco


class _FakePicam:
    """app.py 가 import 시점에 카메라를 열어 센서 해상도를 읽고 닫는다 -
    그 경로가 지나갈 만큼만 흉내낸다."""
    camera_properties = {"PixelArraySize": (4608, 2592)}

    def __init__(self):
        self.options = {}

    def configure(self, *_a, **_k):
        pass

    def create_still_configuration(self, **_k):
        return None

    def close(self):
        pass


_flask = types.ModuleType("flask")
_flask.Flask = _FakeFlask
_flask.request = None
_flask.send_file = None
_flask.jsonify = None
_picamera2 = types.ModuleType("picamera2")
_picamera2.Picamera2 = _FakePicam
_libcamera = types.ModuleType("libcamera")
_libcamera.Transform = lambda **_k: None
_libcamera.controls = types.SimpleNamespace()
for name, mod in {
    "flask": _flask,
    "picamera2": _picamera2,
    "libcamera": _libcamera,
}.items():
    sys.modules.setdefault(name, mod)

import app  # noqa: E402  (스텁 이후에 import 해야 한다)

BYTES_PER_MS = app.RECORD_SAMPLE_RATE * 2 // 1000  # 32


def make_wav(path, data):
    with open(path, "wb") as f:
        f.write(app._wav_header(len(data)))
        f.write(data)


def read_wav(path):
    with open(path, "rb") as f:
        header = f.read(44)
        data = f.read()
    declared = struct.unpack("<I", header[40:44])[0]
    return declared, data


class TrimRecordingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        self.tmp.close()
        self.path = self.tmp.name

    def test_trims_leading_and_trailing_silence(self):
        # [침묵 1000ms][발화 500ms][침묵 2000ms] - 발화 구간은 0x01 로 표시.
        lead, speech, tail = 1000, 500, 2000
        data = (b"\x00" * (lead * BYTES_PER_MS)
                + b"\x01" * (speech * BYTES_PER_MS)
                + b"\x00" * (tail * BYTES_PER_MS))
        make_wav(self.path, data)
        speech_start = lead * BYTES_PER_MS
        last_voice = (lead + speech) * BYTES_PER_MS
        trimmed = app._trim_recording(self.path, speech_start, last_voice, len(data))

        declared, kept = read_wav(self.path)
        expected_len = (app.TRIM_PREROLL_MS + speech + app.TRIM_TAIL_MS) * BYTES_PER_MS
        self.assertEqual(len(kept), expected_len)
        self.assertEqual(declared, expected_len)  # 헤더 data_size 도 갱신
        self.assertEqual(trimmed, len(data) - expected_len)
        # 발화 바이트는 전부 보존 - pre-roll 뒤에 그대로 있어야 한다.
        preroll = app.TRIM_PREROLL_MS * BYTES_PER_MS
        self.assertEqual(kept[preroll:preroll + speech * BYTES_PER_MS],
                         b"\x01" * (speech * BYTES_PER_MS))

    def test_short_lead_and_tail_left_untouched(self):
        # 앞뒤 침묵이 pre-roll/tail 보다 짧으면 자를 게 없다 - 파일 불변.
        data = (b"\x00" * (100 * BYTES_PER_MS)
                + b"\x01" * (500 * BYTES_PER_MS)
                + b"\x00" * (200 * BYTES_PER_MS))
        make_wav(self.path, data)
        trimmed = app._trim_recording(
            self.path, 100 * BYTES_PER_MS, 600 * BYTES_PER_MS, len(data))
        self.assertEqual(trimmed, 0)
        declared, kept = read_wav(self.path)
        self.assertEqual(kept, data)
        self.assertEqual(declared, len(data))

    def test_preroll_clamped_at_file_start(self):
        # 발화가 파일 첫머리 근처면 start 는 0 으로 클램프.
        data = b"\x01" * (500 * BYTES_PER_MS) + b"\x00" * (2000 * BYTES_PER_MS)
        make_wav(self.path, data)
        app._trim_recording(self.path, 0, 500 * BYTES_PER_MS, len(data))
        declared, kept = read_wav(self.path)
        expected_len = (500 + app.TRIM_TAIL_MS) * BYTES_PER_MS
        self.assertEqual(len(kept), expected_len)
        self.assertEqual(kept[:500 * BYTES_PER_MS], b"\x01" * (500 * BYTES_PER_MS))


if __name__ == "__main__":
    unittest.main()

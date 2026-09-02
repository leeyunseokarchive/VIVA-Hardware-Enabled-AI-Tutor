"""/play 분리(/play/upload + /play/start) 헬퍼 단위 체크. 하드웨어·flask 없이
python3 -m unittest test_play_split 로 돈다 - 스텁 방식은 test_record_trim 과
동일 (Pi 전용 import 를 sys.modules 로 대체)."""
import sys
import types
import unittest


class _FakeFlask:
    def __init__(self, *_a, **_k):
        pass

    def route(self, *_a, **_k):
        def deco(fn):
            return fn
        return deco


class _FakePicam:
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


class _FakeProc:
    def __init__(self, rc=0):
        self.rc = rc

    def wait(self):
        return self.rc


class DedupTest(unittest.TestCase):
    def setUp(self):
        app._last_play_req_id = None

    def test_first_and_new_ids_pass(self):
        self.assertFalse(app._dedup_play_req("a", "/play/start"))
        self.assertFalse(app._dedup_play_req("b", "/play/start"))

    def test_same_id_is_duplicate(self):
        self.assertFalse(app._dedup_play_req("a", "/play/start"))
        self.assertTrue(app._dedup_play_req("a", "/play/start"))

    def test_missing_id_never_dedups(self):
        self.assertFalse(app._dedup_play_req(None, "/play"))
        self.assertFalse(app._dedup_play_req(None, "/play"))


class RunPlaybackTest(unittest.TestCase):
    def setUp(self):
        self.cmds = []
        self._popen = app.subprocess.Popen
        app.subprocess.Popen = self._fake_popen
        self.rc = 0

    def tearDown(self):
        app.subprocess.Popen = self._popen

    def _fake_popen(self, cmd):
        self.cmds.append(cmd)
        return _FakeProc(self.rc)

    def test_mp3_uses_mpg123_and_reports_played(self):
        payload, status = app._run_playback(True)
        self.assertEqual(self.cmds[0][0], "mpg123")
        self.assertEqual((payload, status), ({"status": "played"}, 200))

    def test_wav_uses_aplay(self):
        app._run_playback(False)
        self.assertEqual(self.cmds[0][0], "aplay")

    def test_nonzero_exit_is_500(self):
        self.rc = 1
        payload, status = app._run_playback(True)
        self.assertEqual(status, 500)

    def test_stop_flag_reports_stopped_not_error(self):
        # /play/stop 이 재생 중(wait 블로킹 중) terminate 하면 rc!=0 이어도
        # 정상 중단이다 - stop 은 wait() 중에 오므로 거기서 플래그를 세운다.
        class StoppedProc(_FakeProc):
            def wait(self):
                app._play_stopped = True
                return 1

        def popen_and_stop(cmd):
            self.cmds.append(cmd)
            return StoppedProc()

        app.subprocess.Popen = popen_and_stop
        payload, status = app._run_playback(True)
        self.assertEqual((payload, status), ({"status": "stopped"}, 200))


class SaveUploadTest(unittest.TestCase):
    def test_upload_sets_format_for_play_start(self):
        saved = []

        class F:
            filename = "tts.mp3"
            mimetype = "audio/mpeg"

            def save(self, path):
                saved.append(path)

        self.assertTrue(app._save_upload(F()))
        self.assertTrue(app._uploaded_is_mp3)
        self.assertEqual(saved, [app.TTS_INPUT_PATH])

        class W(F):
            filename = "tts.wav"
            mimetype = "audio/wav"

        self.assertFalse(app._save_upload(W()))
        self.assertFalse(app._uploaded_is_mp3)


if __name__ == "__main__":
    unittest.main()

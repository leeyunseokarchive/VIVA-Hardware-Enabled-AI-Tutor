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

"""cam_health.py 단위 체크. 하드웨어 없이 python3 -m unittest test_cam_health 로 돈다."""
import unittest

from cam_health import CAM_CACHE_S, cam_health


class CamHealthTest(unittest.TestCase):
    def test_camera_listed_means_ok(self):
        ok, cached = cam_health(100.0, None, info_fn=lambda: [{"Model": "imx708"}])
        self.assertTrue(ok)
        self.assertEqual(cached, (True, 100.0))

    def test_no_camera_means_broken(self):
        # 케이블 빠짐/미장착 - libcamera 가 아무것도 못 찾는다
        ok, cached = cam_health(100.0, None, info_fn=lambda: [])
        self.assertFalse(ok)
        self.assertEqual(cached, (False, 100.0))

    def test_probe_exception_means_unknown_not_false(self):
        # 하드 제약: 예외는 "모름"이지 "고장"이 아니다 - False 오탐이면
        # FaultBadge 와 X-X 표정이 헛뜬다
        def boom():
            raise RuntimeError("libcamera unavailable")
        ok, cached = cam_health(100.0, None, info_fn=boom)
        self.assertIsNone(ok)
        self.assertIsNone(cached)  # None 은 캐시하지 않는다 - 다음 호출이 재시도

    def test_cache_hit_skips_probe(self):
        def boom():
            raise AssertionError("TTL 안에서는 프로브를 다시 부르면 안 된다")
        ok, cached = cam_health(100.0 + CAM_CACHE_S - 1, (True, 100.0), info_fn=boom)
        self.assertTrue(ok)
        self.assertEqual(cached, (True, 100.0))

    def test_cache_expiry_reprobes(self):
        ok, cached = cam_health(100.0 + CAM_CACHE_S + 1, (True, 100.0), info_fn=lambda: [])
        self.assertFalse(ok)
        self.assertEqual(cached, (False, 100.0 + CAM_CACHE_S + 1))

    def test_default_probe_never_raises(self):
        # 개발 맥(picamera2 없음)에서도 예외가 새면 안 된다 - /health 가 500 나면
        # 연결 판정 전체가 무너진다. Pi 에선 True, 맥에선 None 이 나온다.
        ok, _ = cam_health(0.0, None)
        self.assertIn(ok, (True, False, None))


if __name__ == "__main__":
    unittest.main()

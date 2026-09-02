"""splash.py 순수 로직 체크. 하드웨어(/dev/fb0) 접근 없이 PIL/numpy 만으로
맥에서도 돈다: python3 test_splash.py 또는 pytest test_splash.py.

Pretendard-Bold.otf 가 없는 환경(폰트 미동봉 클론)에서도 안 깨지게, 폰트
전용 검증(워드마크 폭)은 FONT_PATH 존재 여부로 스킵한다 - splash.py 자체는
PIL 기본 폰트로 폴백하므로 나머지 체크는 그대로 돈다.
"""
import tempfile
from pathlib import Path

import numpy as np

from splash import (
    BASE_SIZE,
    CANVAS,
    DOT_CY_FRAC,
    DOT_RADIUS_BASE,
    FONT_PATH,
    FRAME_BYTES,
    FRAMES_PER_STATE,
    N_DOTS,
    N_FRAMES,
    WORDMARK,
    bake,
    lit_dots,
    measure_tracked_width,
    render_boot_frame,
    render_off_frame,
    rgb565_bytes,
    selftest,
    _wordmark_font,
)


def _dot_band(img):
    """닷이 놓이는 가로 밴드(세로 64.5% ± 닷 반지름 + 여유)만 잘라낸다."""
    arr = np.asarray(img.convert("RGB"), dtype=np.int16)
    cy = int(BASE_SIZE * DOT_CY_FRAC)
    m = DOT_RADIUS_BASE + 3
    return arr[cy - m:cy + m, :, :]


def _count_white_in_dot_band(img, thresh=200):
    band = _dot_band(img)
    return int(np.all(band >= thresh, axis=-1).sum())


def test_boot_frame_size_and_mode():
    img = render_boot_frame(0)
    assert img.size == (BASE_SIZE, BASE_SIZE)
    assert img.mode == "RGB"


def test_lit_dots_state_sequence():
    # 상태당 3프레임: 0,0,0,1,1,1,2,2,2,3,3,3
    expected = [(i // FRAMES_PER_STATE) % (N_DOTS + 1) for i in range(N_FRAMES)]
    assert [lit_dots(i) for i in range(N_FRAMES)] == expected
    assert expected[0] == 0 and expected[-1] == N_DOTS


def test_white_dot_pixels_grow_with_state():
    # 각 상태의 대표 프레임(0,3,6,9)에서 흰 닷 픽셀이 단조 증가해야 한다.
    counts = [_count_white_in_dot_band(render_boot_frame(s * FRAMES_PER_STATE))
              for s in range(N_DOTS + 1)]
    assert counts[0] == 0, f"소등 상태 밴드에 흰 픽셀이 있다: {counts[0]}"
    for a, b in zip(counts, counts[1:]):
        assert b > a, f"점등 닷 픽셀이 안 늘었다: {counts}"


def test_socket_dots_present_when_unlit():
    # 소등 상태에도 소켓(#2E2E2E)이 자리 고정으로 찍혀 있어야 한다.
    band = _dot_band(render_boot_frame(0))
    socket = np.array((0x2E, 0x2E, 0x2E), dtype=np.int16)
    near = np.all(np.abs(band - socket) <= 12, axis=-1)
    assert near.sum() > 0, "소등 프레임에 소켓 닷이 없다"


def test_off_frame_has_dimmed_wordmark_no_dots():
    off = render_off_frame()
    arr = np.asarray(off.convert("RGB"))
    # 검정이 아닌 픽셀(워드마크 안티에일리어싱 포함)이 있어야 한다.
    assert (arr.sum(axis=-1) > 0).any(), "종료 화면이 완전히 비어 있다(워드마크 없음)"
    # 닷 밴드는 완전히 비어 있어야 한다(종료 화면엔 닷 없음, 워드마크는 중앙 50%
    # 라 64.5% 밴드에 안 걸친다).
    band = _dot_band(off)
    assert (band.sum(axis=-1) == 0).all(), "종료 화면 닷 밴드에 픽셀이 남아있다"


def test_boot_frame_has_no_wordmark_specific_check_when_font_missing():
    if not FONT_PATH.exists():
        return  # 폰트 없는 환경: 폴백 폰트라 폭 계산이 의미 없다 - 스킵
    font = _wordmark_font()
    tracking = font.size * 0.075
    w = measure_tracked_width(font, WORDMARK, tracking)  # 4배 수퍼샘플 캔버스 기준
    pct = w / CANVAS * 100
    assert 55 <= pct <= 60, f"워드마크 폭이 시안 범위(55~60%) 밖: {pct:.1f}%"


def test_rgb565_bytes_length_matches_frame_bytes():
    img = render_boot_frame(0)
    raw = rgb565_bytes(img)
    assert len(raw) == FRAME_BYTES == BASE_SIZE * BASE_SIZE * 2


def test_bake_and_selftest_roundtrip():
    with tempfile.TemporaryDirectory() as tmp:
        out_dir = Path(tmp)
        bake(out_dir)
        files = sorted(p.name for p in out_dir.iterdir())
        assert files == [f"boot-{i:02d}.raw" for i in range(N_FRAMES)] + ["off.raw"]
        for f in out_dir.iterdir():
            assert f.stat().st_size == FRAME_BYTES
        selftest(out_dir)  # assert 안 터지면 통과


if __name__ == "__main__":
    test_boot_frame_size_and_mode()
    test_lit_dots_state_sequence()
    test_white_dot_pixels_grow_with_state()
    test_socket_dots_present_when_unlit()
    test_off_frame_has_dimmed_wordmark_no_dots()
    test_boot_frame_has_no_wordmark_specific_check_when_font_missing()
    test_rgb565_bytes_length_matches_frame_bytes()
    test_bake_and_selftest_roundtrip()
    print("test_splash.py: all checks passed")

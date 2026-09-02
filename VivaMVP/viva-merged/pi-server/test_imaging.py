"""imaging.py 단위 체크. 하드웨어 없이 python3 test_imaging.py 로 돈다."""
import os
import tempfile

from PIL import Image

from imaging import crop_box2d, parse_box2d, resize_to_width, save_transfer_copy, shrink_to_width


def make_test_image(w=1000, h=800):
    """회색 배경에 좌표를 아는 흰 사각형(px 300..699 x, 200..599 y)."""
    img = Image.new("RGB", (w, h), (128, 128, 128))
    for x in range(300, 700):
        for y in range(200, 600):
            img.putpixel((x, y), (255, 255, 255))
    return img


def test_crop_contains_white_box_with_margin():
    img = make_test_image()
    # 흰 사각형과 정확히 일치하는 bbox (0~1000 정규화; w=1000, h=800이라
    # x는 그대로, y는 200/800*1000=250, 600/800*1000=750)
    out = crop_box2d(img, (250, 300, 750, 700), margin=0.05)
    # 5% 여백이 붙어 흰 영역보다 커야 한다
    assert out.width > 400, f"width {out.width} should exceed box width 400"
    assert out.height > 400, f"height {out.height} should exceed box height 400"
    # 크롭 중앙은 흰색
    assert out.getpixel((out.width // 2, out.height // 2)) == (255, 255, 255)
    # 크롭이 이미지 전체는 아니어야 한다 (실제로 잘렸는지)
    assert out.width < img.width and out.height < img.height


def test_crop_clamps_at_frame_edge():
    img = make_test_image()
    # 프레임 좌상단 모서리에 걸친 bbox - 여백이 음수 좌표로 나가면 안 된다
    out = crop_box2d(img, (0, 0, 300, 300), margin=0.05)
    assert out.width <= img.width and out.height <= img.height
    assert out.width > 0 and out.height > 0


def test_resize_to_width_shrinks_and_keeps_aspect():
    img = make_test_image(4000, 2000)
    out = resize_to_width(img, 2048)
    assert out.width == 2048
    assert out.height == 1024


def test_resize_to_width_never_upscales():
    img = make_test_image(1000, 800)
    out = resize_to_width(img, 2048)
    assert (out.width, out.height) == (1000, 800)


def test_shrink_uses_reduce_before_lanczos():
    # 실제 Pi 카메라 해상도(4608x2592). LANCZOS 로 12MP 를 한 번에 줄이면
    # Pi Zero 에서 몇 초씩 걸리므로 정수배 reduce 로 먼저 내려가야 한다.
    # 4608//2048 = 2 -> reduce(2) 로 2304 까지 내린 뒤 LANCZOS 로 2048.
    img = make_test_image(4608, 2592)
    out = shrink_to_width(img, 2048)
    assert out.width == 2048, f"width {out.width}"
    assert abs(out.height - 1152) <= 2, f"height {out.height} not near 1152"


def test_shrink_never_upscales():
    img = make_test_image(1000, 800)
    assert shrink_to_width(img, 2048).size == (1000, 800)


def test_save_transfer_copy_writes_resized_file():
    img = make_test_image(4608, 2592)
    with tempfile.TemporaryDirectory() as tmpdir:
        dst = os.path.join(tmpdir, "dst.jpg")
        save_transfer_copy(img, dst, width=2048)
        with Image.open(dst) as out:
            assert out.width == 2048
            assert abs(out.height - 1152) <= 2, f"height {out.height} not near 1152"


def test_parse_box2d_valid():
    box, err = parse_box2d({"ymin": "250", "xmin": "300", "ymax": "750", "xmax": "700"})
    assert err is None
    assert box == (250, 300, 750, 700)


def test_parse_box2d_rejects_bad_input():
    for args in [
        {},  # 누락
        {"ymin": "a", "xmin": "0", "ymax": "10", "xmax": "10"},  # 숫자 아님
        {"ymin": "500", "xmin": "0", "ymax": "100", "xmax": "10"},  # min >= max
        {"ymin": "0", "xmin": "0", "ymax": "1001", "xmax": "10"},  # 범위 밖
        {"ymin": "-1", "xmin": "0", "ymax": "10", "xmax": "10"},  # 음수
    ]:
        box, err = parse_box2d(args)
        assert box is None and err is not None, f"should reject {args}"


if __name__ == "__main__":
    test_crop_contains_white_box_with_margin()
    test_crop_clamps_at_frame_edge()
    test_resize_to_width_shrinks_and_keeps_aspect()
    test_resize_to_width_never_upscales()
    test_shrink_uses_reduce_before_lanczos()
    test_shrink_never_upscales()
    test_save_transfer_copy_writes_resized_file()
    test_parse_box2d_valid()
    test_parse_box2d_rejects_bad_input()
    print("imaging.py: all checks passed")

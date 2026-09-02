"""Pi 사진 크롭/리사이즈 순수 함수. picamera2/flask 의존 없음 - 개발
머신에서 test_imaging.py 로 하드웨어 없이 검증한다.

좌표계는 Gemini box_2d 그대로: [ymin, xmin, ymax, xmax], 0~1000 정규화.
"""
from PIL import Image

BOX_KEYS = ("ymin", "xmin", "ymax", "xmax")


def parse_box2d(args):
    """쿼리 파라미터 dict -> ((ymin,xmin,ymax,xmax), None) 또는 (None, 에러문자열)."""
    try:
        ymin, xmin, ymax, xmax = (int(args[k]) for k in BOX_KEYS)
    except (KeyError, TypeError, ValueError):
        return None, "query params ymin,xmin,ymax,xmax (int 0~1000) required"
    if not (0 <= ymin < ymax <= 1000 and 0 <= xmin < xmax <= 1000):
        return None, "coords must satisfy 0 <= min < max <= 1000"
    return (ymin, xmin, ymax, xmax), None


def crop_box2d(img, box2d, margin=0.05):
    """0~1000 정규화 bbox 영역을 crop해 돌려준다. 각 변에 bbox 크기의
    margin 비율만큼 여백을 더하고 프레임 경계로 클램프한다 - Gemini 박스가
    몇 px 어긋나도 지문/풀이가 잘리지 않게."""
    ymin, xmin, ymax, xmax = box2d
    top = ymin / 1000 * img.height
    left = xmin / 1000 * img.width
    bottom = ymax / 1000 * img.height
    right = xmax / 1000 * img.width
    pad_y = (bottom - top) * margin
    pad_x = (right - left) * margin
    return img.crop((
        max(0, round(left - pad_x)),
        max(0, round(top - pad_y)),
        min(img.width, round(right + pad_x)),
        min(img.height, round(bottom + pad_y)),
    ))


def resize_to_width(img, width):
    """폭 기준 축소 (업스케일 안 함, 종횡비 유지)."""
    if img.width <= width:
        return img
    return img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)


def shrink_to_width(img, width):
    """폭 기준 축소인데, 큰 배율은 reduce()(정수배 박스 필터)로 먼저 줄이고
    남은 만큼만 LANCZOS 로 다듬는다.

    LANCZOS 로 12MP 를 한 번에 줄이면 Pi Zero 급 CPU 에서 몇 초씩 걸린다.
    reduce(2) 는 2x2 평균이라 훨씬 싸고, 그 뒤 2304 -> 2048 LANCZOS 는 거의
    공짜다. 예전 write_transfer_copy 가 JPEG draft 로 얻던 효과와 같은데,
    이쪽은 파일을 다시 디코드할 필요가 없다."""
    factor = img.width // width if width > 0 else 1
    if factor > 1:
        img = img.reduce(factor)
    return resize_to_width(img, width)


def save_transfer_copy(img, dst_path, width=2048, quality=85):
    """메모리 위의 촬영 원본 -> 전송용 축소본.

    예전에는 12MP JPEG 를 디스크에 쓴 뒤 그 파일을 **다시 디코드해서** 축소본을
    만들었다(write_transfer_copy). 그 디코드가 촬영 지연의 resize 구간
    대부분이었다 - 방금 메모리에 있던 이미지를 굳이 JPEG 로 왕복시킬 이유가 없다."""
    shrink_to_width(img, width).save(dst_path, "JPEG", quality=quality)

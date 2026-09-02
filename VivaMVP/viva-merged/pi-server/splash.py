#!/usr/bin/env python3
"""VIVA 부팅/종료 화면 - 480x480 원형 HDMI 패널용 raw RGB565 프레임 생성기.

eyes.py 와 달리 이건 **런타임에 안 돈다** - Pi 는 싱글코어 ARMv6 1GHz 라
부팅/종료 구간에 python/pygame 을 띄우는 대가가 크다(임포트만 수백ms).
그래서 설치 시 1회 이 스크립트로 프레임을 구워(bake) raw 바이트 파일로
저장해두고, 런타임은 systemd 유닛이 `sh` + `cat` 으로 그 파일을 그대로
`/dev/fb0` 에 흘려보내는 것뿐이다(viva-splash.service /
viva-splash-off.service 참고) - 프로세스 기동 비용이 사실상 0.

비주얼(2차 시안 "Ellipsis" 고정값): 배경 검정, 워드마크 "ARTFLY"
Pretendard Bold(fonts/Pretendard-Bold.otf, 없으면 PIL 기본 폰트로 폴백),
letter-spacing 0.075em, 폭 55~60%(66px 로 57.2%, FONT_SIZE_BASE 참고).
워드마크 중심은 세로 44.5% - 아래 로딩 닷 자리를 비워 광학 중심을 맞춘다.
로딩 닷: 세로 64.5% 에 지름 14px 닷 3개, 중심 간격 36px. 말줄임표처럼
하나씩 켜진다(0 -> 1 -> 2 -> 3개 점등 후 전부 소등, 반복). 점등 흰색,
소등 소켓 #2E2E2E(자리 고정). 0.6초/상태 x 4상태 = 2.4초 주기.
1차 시안의 베젤 아크는 폐기 - 저해상도에서 원호 끝점 정렬/계단 현상이
못 쓸 수준이었다. 종료 화면은 워드마크만 62% 밝기(#9E9E9E), 중앙(50%).

닷·워드마크 전부 4배 수퍼샘플(1920x1920)로 그려 LANCZOS 로 480 축소한다
- PIL 드로잉엔 안티에일리어싱이 없어서(eyes.py 와 같은 이유). 닷은 완전한
원이라 이 방식으로 저해상도에서도 깨끗하게 나온다.
letter-spacing 은 PIL ImageDraw.text 에 없어서 글자 하나씩
font.getlength() 로 전진폭을 재며 수동으로 찍는다(draw_tracked_text).

부팅 프레임은 12장(상태당 3장), 마지막(11번, 3닷 점등)에서 0번(전부
소등)으로 되돌아 루프한다 - sh 루프가 0.2초 간격으로 순환.

RGB565 변환(r>>3<<11 | g>>2<<5 | b>>3, 리틀엔디안 uint16)은 numpy 로 한다.

실행: python3 splash.py --bake       (splash/ 밑에 raw 프레임 생성)
     python3 splash.py --selftest   (구운 결과 검증, fb 접근 없음)
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

BASE_SIZE = 480
SS = 4  # 수퍼샘플 배율
CANVAS = BASE_SIZE * SS

BG = (0, 0, 0)
FG = (255, 255, 255)
OFF_FG = (0x9E, 0x9E, 0x9E)  # 워드마크 62% 밝기 (255*0.62 ≈ 158 = 0x9E)

WORDMARK = "ARTFLY"
# 시안은 "폭의 55~60%, ≈61px" 라고 적었지만 실측(아래 test_splash.py 참고)
# 으로는 61px 가 52.9% 밖에 안 된다 - 폭 퍼센트가 진짜 고정값이므로 66px 로
# 올려 57.2% 에 맞췄다.
FONT_SIZE_BASE = 66
FONT_SIZE_SS = FONT_SIZE_BASE * SS
TRACKING_EM = 0.075

# 부팅 화면 레이아웃(2차 시안 고정값): 워드마크 중심 44.5%, 닷 중심 64.5%.
MARK_CY_FRAC = 0.445
DOT_CY_FRAC = 0.645
DOT_RADIUS_BASE = 7          # 지름 14px
DOT_SPACING_BASE = 36        # 닷 중심 간 간격
DOT_LIT = (255, 255, 255)
DOT_SOCKET = (0x2E, 0x2E, 0x2E)
N_DOTS = 3
FRAMES_PER_STATE = 3         # 0.2s x 3 = 0.6s/상태

# viva-splash.service 의 ExecStart 루프에 "% 12" 로 하드코딩돼 있다 - 여기서
# 바꾸면 그쪽도 같이 고쳐야 한다(런타임은 셸 루프라 이 상수를 못 읽는다).
N_FRAMES = 12
FRAME_BYTES = BASE_SIZE * BASE_SIZE * 2  # RGB565 = 픽셀당 2바이트

HERE = Path(__file__).resolve().parent
FONT_PATH = HERE / "fonts" / "Pretendard-Bold.otf"
OUT_DIR = HERE / "splash"

_font_cache = None


def _wordmark_font():
    """Pretendard-Bold 로드, 없으면 PIL 기본 폰트로 폴백(개발 머신 방어용)."""
    global _font_cache
    if _font_cache is None:
        try:
            _font_cache = ImageFont.truetype(str(FONT_PATH), FONT_SIZE_SS)
        except OSError:
            _font_cache = ImageFont.load_default(size=FONT_SIZE_SS)
    return _font_cache


def measure_tracked_width(font, text, tracking):
    """letter-spacing 포함 전체 폭. 마지막 글자 뒤엔 트래킹을 안 붙인다."""
    if not text:
        return 0.0
    return sum(font.getlength(ch) for ch in text) + tracking * (len(text) - 1)


def draw_tracked_text(draw, cx, cy, text, font, fill, tracking):
    """중앙 정렬 + letter-spacing 텍스트. PIL text() 엔 tracking 파라미터가
    없어서 글자 하나씩 anchor="lm" 으로 찍으며 x 를 getlength()+tracking 만큼
    민다 - anchor="lm" 은 글리프별 bbox 가 아니라 폰트 메트릭 기준이라 글자마다
    세로 위치가 흔들리지 않는다."""
    w = measure_tracked_width(font, text, tracking)
    x = cx - w / 2
    for ch in text:
        draw.text((x, cy), ch, font=font, fill=fill, anchor="lm")
        x += font.getlength(ch) + tracking


def lit_dots(i):
    """프레임 i(0..11) -> 점등 닷 개수(0..3). 상태당 FRAMES_PER_STATE 프레임."""
    return (i // FRAMES_PER_STATE) % (N_DOTS + 1)


def _draw_dots(draw, n_lit):
    """닷 3개를 가로 중앙 정렬로 찍는다. 앞에서부터 n_lit 개 점등, 나머지 소켓."""
    cy = CANVAS * DOT_CY_FRAC
    r = DOT_RADIUS_BASE * SS
    spacing = DOT_SPACING_BASE * SS
    x0 = CANVAS / 2 - spacing * (N_DOTS - 1) / 2
    for d in range(N_DOTS):
        cx = x0 + d * spacing
        fill = DOT_LIT if d < n_lit else DOT_SOCKET
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)


def render_boot_frame(i):
    """부팅 프레임 i(0..11) -> 480x480 RGB Image. 상태당 3프레임씩
    0 -> 1 -> 2 -> 3닷 점등, i=11 다음은 sh 루프가 0번(소등)으로 되돌아간다."""
    assert 0 <= i < N_FRAMES, f"프레임 인덱스 범위 밖: {i}"
    canvas = Image.new("RGB", (CANVAS, CANVAS), BG)
    draw = ImageDraw.Draw(canvas)
    _draw_dots(draw, lit_dots(i))
    font = _wordmark_font()
    draw_tracked_text(draw, CANVAS / 2, CANVAS * MARK_CY_FRAC, WORDMARK, font, FG,
                      FONT_SIZE_SS * TRACKING_EM)
    return canvas.resize((BASE_SIZE, BASE_SIZE), Image.LANCZOS)


def render_off_frame():
    """종료 화면: 워드마크만 62% 밝기, 중앙(50%), 닷 없음."""
    canvas = Image.new("RGB", (CANVAS, CANVAS), BG)
    draw = ImageDraw.Draw(canvas)
    font = _wordmark_font()
    draw_tracked_text(draw, CANVAS / 2, CANVAS / 2, WORDMARK, font, OFF_FG,
                      FONT_SIZE_SS * TRACKING_EM)
    return canvas.resize((BASE_SIZE, BASE_SIZE), Image.LANCZOS)


def rgb565_bytes(img):
    """RGB Image -> RGB565 리틀엔디안 raw bytes (/dev/fb0 그대로 write)."""
    arr = np.asarray(img.convert("RGB"), dtype=np.uint16)
    rgb565 = ((arr[..., 0] >> 3) << 11) | ((arr[..., 1] >> 2) << 5) | (arr[..., 2] >> 3)
    return rgb565.astype("<u2").tobytes()


def bake(out_dir=None):
    out_dir = Path(out_dir) if out_dir else OUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    for i in range(N_FRAMES):
        (out_dir / f"boot-{i:02d}.raw").write_bytes(rgb565_bytes(render_boot_frame(i)))
    (out_dir / "off.raw").write_bytes(rgb565_bytes(render_off_frame()))
    print(f"[splash] baked {N_FRAMES} boot 프레임 + off.raw -> {out_dir}")


def selftest(out_dir=None):
    out_dir = Path(out_dir) if out_dir else OUT_DIR
    boot_files = [out_dir / f"boot-{i:02d}.raw" for i in range(N_FRAMES)]
    off_file = out_dir / "off.raw"
    for f in boot_files + [off_file]:
        assert f.exists(), f"누락된 프레임 파일: {f} (먼저 --bake 실행)"
        assert f.stat().st_size == FRAME_BYTES, f"{f} 크기 이상: {f.stat().st_size} != {FRAME_BYTES}"
    first, last = boot_files[0].read_bytes(), boot_files[-1].read_bytes()
    assert first != last, "첫/마지막 부팅 프레임이 동일하다 - 닷이 진행하지 않는다"
    off_bytes = off_file.read_bytes()
    assert off_bytes != first, "종료 화면이 부팅 프레임과 동일하다"
    print(f"[splash] selftest OK: 부팅 {N_FRAMES}프레임 + off.raw, 프레임당 {FRAME_BYTES}B")


if __name__ == "__main__":
    if "--bake" in sys.argv:
        bake()
    elif "--selftest" in sys.argv:
        selftest()
    else:
        print("usage: splash.py --bake | --selftest")
        sys.exit(1)

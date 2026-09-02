"""디바이스 연동판 앱 아이콘 생성 - pi-server/eyes.py 의 idle 눈을 그대로 재현.

eyes.py 상수 (bake_base 참고, 2026-08-11b 귀여움 보정): EYE 164x164(원형), 모서리
반경은 min(EYE_R=110, 짧은변/2) 클램프로 완전한 원, RING 19, GAP 54, 글린트
2개(22@-15,-22 / 7@+30,+26), FG 흰색, BG 검정.
4배 슈퍼샘플 후 축소 (eyes.py 의 SS 안티앨리어싱과 같은 수법).

산출물 (assets/):
  icon-device.png                       1024x1024 불투명 (iOS/공용)
  android-icon-device-foreground.png    1024x1024 투명, 중앙 66% 안전영역에 눈
  android-icon-device-background.png    1024x1024 검정 단색
  android-icon-device-monochrome.png    1024x1024 투명 배경 + 흰 눈 (테마 아이콘)
"""

import os

from PIL import Image, ImageDraw

SS = 4
SIZE = 1024
EYE_W, EYE_H, EYE_R, RING, GAP = 164, 164, 110, 19, 54
GLINTS = [(22, -15, -22), (7, 30, 26)]  # (r, dx, dy)
FG = (255, 255, 255, 255)
BG = (0, 0, 0, 255)
TRANSPARENT = (0, 0, 0, 0)


def draw_eyes(draw: ImageDraw.ImageDraw, cx: float, cy: float, scale: float) -> None:
    outer_r = min(EYE_R, min(EYE_W, EYE_H) // 2) * scale
    w, h = EYE_W * scale, EYE_H * scale
    ring = RING * scale
    inner_r = max(0.0, outer_r - ring)
    for side in (-1, 1):
        ecx = cx + side * (GAP + EYE_W) / 2 * scale
        x0, y0 = ecx - w / 2, cy - h / 2
        draw.rounded_rectangle((x0, y0, x0 + w, y0 + h), radius=outer_r, fill=FG)
        draw.rounded_rectangle(
            (x0 + ring, y0 + ring, x0 + w - ring, y0 + h - ring),
            radius=inner_r,
            fill=TRANSPARENT if draw.im.mode == "RGBA" else BG,
        )
        for gr, gx, gy in GLINTS:
            r = gr * scale
            gcx, gcy = ecx + gx * scale, cy + gy * scale
            draw.ellipse((gcx - r, gcy - r, gcx + r, gcy + r), fill=FG)


def render(content_ratio: float, background: tuple) -> Image.Image:
    """content_ratio: 두 눈 전체 폭이 캔버스에서 차지하는 비율."""
    big = SIZE * SS
    img = Image.new("RGBA", (big, big), background)
    draw = ImageDraw.Draw(img)
    total_w = GAP + EYE_W * 2  # 두 눈 + 사이 간격의 원좌표 폭
    scale = big * content_ratio / total_w
    draw_eyes(draw, big / 2, big / 2, scale)
    return img.resize((SIZE, SIZE), Image.LANCZOS)


def main() -> None:
    out = os.path.join(os.path.dirname(__file__), "..", "assets")
    render(0.62, BG).convert("RGB").save(os.path.join(out, "icon-device.png"))
    render(0.44, TRANSPARENT).save(
        os.path.join(out, "android-icon-device-foreground.png"))
    Image.new("RGB", (SIZE, SIZE), BG[:3]).save(
        os.path.join(out, "android-icon-device-background.png"))
    render(0.44, TRANSPARENT).save(
        os.path.join(out, "android-icon-device-monochrome.png"))
    print("wrote 4 assets to", os.path.abspath(out))


if __name__ == "__main__":
    main()

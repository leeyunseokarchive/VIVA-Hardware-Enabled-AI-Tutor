/**
 * 오버레이 좌표 변환 (스펙 2026-07-29 전사 1회 + 오버레이).
 * resizeMode="contain" 레터박스 보정과 box_2d(0~1000) -> 픽셀 매핑이 어긋나면
 * 표시가 문제의 엉뚱한 곳에 그려진다 - 기하만 순수 함수로 검증한다.
 */
import { computeImageRect, boxToRect, placeLabelPill } from '../BoardAnnotationOverlay';

describe('computeImageRect (contain fit)', () => {
  it('letterboxes left/right when the container is wider than 16:9', () => {
    const rect = computeImageRect(2000, 900, 16 / 9);
    expect(rect.height).toBe(900);
    expect(rect.width).toBe(1600);
    expect(rect.left).toBe(200);
    expect(rect.top).toBe(0);
  });

  it('letterboxes top/bottom when the container is taller than 16:9', () => {
    const rect = computeImageRect(1600, 1200, 16 / 9);
    expect(rect.width).toBe(1600);
    expect(rect.height).toBe(900);
    expect(rect.left).toBe(0);
    expect(rect.top).toBe(150);
  });

  it('returns an empty rect for a zero-sized container', () => {
    expect(computeImageRect(0, 0, 16 / 9)).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });
});

describe('boxToRect (box_2d 0~1000 -> pixels)', () => {
  const image = { left: 200, top: 0, width: 1600, height: 900 };

  it('maps [ymin,xmin,ymax,xmax] into the drawn image rect', () => {
    // 이미지 정중앙의 10% 크기 박스
    const rect = boxToRect([450, 450, 550, 550], image);
    expect(rect.left).toBeCloseTo(200 + 0.45 * 1600);
    expect(rect.top).toBeCloseTo(0.45 * 900);
    expect(rect.width).toBeCloseTo(0.1 * 1600);
    expect(rect.height).toBeCloseTo(0.1 * 900);
  });

  it('clamps inverted boxes to zero size instead of negative', () => {
    const rect = boxToRect([500, 500, 400, 400], image);
    expect(rect.width).toBe(0);
    expect(rect.height).toBe(0);
  });
});

describe('placeLabelPill (label 필 방어적 배치)', () => {
  const image = { left: 200, top: 0, width: 1600, height: 900 };
  const PILL_W = 180;
  const PILL_H = 24;

  it('pushes a center-content anchor to the nearest edge band', () => {
    // 앵커 중심이 이미지의 60% 지점(중앙 컨텐츠 영역) - 오른쪽 밴드로 밀려야 한다
    const box = { left: 200 + 0.6 * 1600 - 20, top: 0.5 * 900 - 20, width: 40, height: 40 };
    const pos = placeLabelPill(box, image);
    expect(pos.left).toBe(200 + 1600 - PILL_W - 4);
    // 세로는 앵커 중심에 정렬
    expect(pos.top).toBeCloseTo(0.5 * 900 - PILL_H / 2);

    // 왼쪽에 더 가까운 앵커는 왼쪽 밴드로
    const boxLeft = { left: 200 + 0.3 * 1600 - 20, top: 0.5 * 900 - 20, width: 40, height: 40 };
    expect(placeLabelPill(boxLeft, image).left).toBe(200 + 4);
  });

  it('clamps the pill fully inside the image rect', () => {
    // 우하단 구석(중앙 영역 밖) 앵커 - 그대로 두면 필이 이미지 밖으로 나간다
    const box = { left: 200 + 0.97 * 1600, top: 0.97 * 900, width: 30, height: 20 };
    const pos = placeLabelPill(box, image);
    expect(pos.left).toBeLessThanOrEqual(200 + 1600 - PILL_W);
    expect(pos.top).toBeLessThanOrEqual(900 - PILL_H);
    expect(pos.left).toBeGreaterThanOrEqual(200);
    expect(pos.top).toBeGreaterThanOrEqual(0);
  });

  it('keeps a margin-anchored label near its anchor', () => {
    // 왼쪽 여백(x 5%) 앵커 - 밀어내지 않고 박스 아래에 붙인다
    const box = { left: 200 + 0.05 * 1600, top: 0.5 * 900, width: 40, height: 30 };
    const pos = placeLabelPill(box, image);
    expect(pos.left).toBe(box.left);
    expect(pos.top).toBe(box.top + box.height + 4);
  });
});

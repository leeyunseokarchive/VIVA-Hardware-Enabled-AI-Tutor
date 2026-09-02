/**
 * 판서(전사본) 위에 얹는 힌트 오버레이 (스펙 2026-07-29 전사 1회 + 오버레이).
 *
 * Gemini 가 EVAL 응답에 실어 보내는 `annotations`(box_2d 0~1000, 첨부 판서
 * 기준)를 순수 RN View/Text 로 그린다 - react-native-svg 같은 새 네이티브
 * 의존성을 넣지 않기 위한 선택(iOS 재빌드 불필요). box_2d 는 ±수% 오차가
 * 있을 수 있어 원/밑줄에 여유 패딩을 두고 그린다.
 *
 * 좌표계: 부모(BoardView)가 resizeMode="contain" 으로 이미지를 띄우므로,
 * 컨테이너 안에서 실제 이미지가 그려진 사각형을 먼저 구하고(computeImageRect)
 * 그 사각형 기준 백분율로 각 표시를 배치한다.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { BoardAnnotation } from '../types/Tutoring';

const GREEN = '#369B75';
const INK = '#2B2926';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** resizeMode="contain" 으로 그려진 이미지의 실제 사각형. */
export function computeImageRect(
  containerWidth: number,
  containerHeight: number,
  imageAspect: number,
): Rect {
  if (containerWidth <= 0 || containerHeight <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const containerAspect = containerWidth / containerHeight;
  if (containerAspect > imageAspect) {
    // 컨테이너가 더 넓다 - 좌우 레터박스
    const width = containerHeight * imageAspect;
    return { left: (containerWidth - width) / 2, top: 0, width, height: containerHeight };
  }
  const height = containerWidth / imageAspect;
  return { left: 0, top: (containerHeight - height) / 2, width: containerWidth, height };
}

/** box_2d [ymin,xmin,ymax,xmax] 0~1000 -> 이미지 사각형 내 절대 좌표. */
export function boxToRect(box2d: number[], image: Rect): Rect {
  const [ymin, xmin, ymax, xmax] = box2d;
  return {
    left: image.left + (xmin / 1000) * image.width,
    top: image.top + (ymin / 1000) * image.height,
    width: Math.max(0, ((xmax - xmin) / 1000) * image.width),
    height: Math.max(0, ((ymax - ymin) / 1000) * image.height),
  };
}

// label 필 크기 추정치. maxWidth 180(styles.labelPill)이며 실제 폭은 텍스트에
// 따라 더 좁을 수 있다 - onLayout 측정 대신 최대폭 기준으로 클램프한다.
// ponytail: 폭 추정 클램프, 좁은 텍스트가 우측 밴드에서 약간 안쪽에 뜨는 정도의
// 오차만 있다. 정확한 폭이 필요해지면 onLayout 측정으로 교체.
const PILL_W = 180;
const PILL_H = 24;

/**
 * label 필의 좌상단 좌표를 계산한다 (순수 함수 - 테스트 대상).
 * - 앵커 박스 중심이 이미지의 중앙 컨텐츠 영역(x,y 모두 12%~88%)에 있으면
 *   판서에 보장된 ≥10% 가장자리 여백을 믿고, 가까운 좌/우 여백 밴드로 밀어내
 *   내용을 덮지 않게 한다 (세로는 앵커에 정렬). 모델이 box_2d 를 내용 위에
 *   찍어도(07-31 실기기 관측) 필이 문제 텍스트를 가리지 못하게 하는 방어선.
 * - 여백에 앵커된 경우는 기존대로 박스 아래(공간 없으면 위)에 붙인다.
 * - 어느 경로든 필이 이미지 사각형 밖으로 나가지 않게 클램프한다.
 */
export function placeLabelPill(box: Rect, image: Rect): { left: number; top: number } {
  const pillW = Math.min(PILL_W, image.width);
  const clampLeft = (l: number): number =>
    Math.min(Math.max(l, image.left), image.left + image.width - pillW);
  const clampTop = (t: number): number =>
    Math.min(Math.max(t, image.top), image.top + image.height - PILL_H);
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const rx = (cx - image.left) / image.width;
  const ry = (cy - image.top) / image.height;
  if (rx > 0.12 && rx < 0.88 && ry > 0.12 && ry < 0.88) {
    // 중앙 컨텐츠 위 - 가까운 쪽 가장자리 밴드로
    const left = rx <= 0.5 ? image.left + 4 : image.left + image.width - pillW - 4;
    return { left: clampLeft(left), top: clampTop(cy - PILL_H / 2) };
  }
  const below = box.top + box.height + 4 + PILL_H < image.top + image.height;
  return {
    left: clampLeft(box.left),
    top: clampTop(below ? box.top + box.height + 4 : box.top - PILL_H - 2),
  };
}

function Annotation({
  item,
  image,
}: {
  item: BoardAnnotation;
  image: Rect;
}): React.JSX.Element | null {
  if (!Array.isArray(item.box_2d) || item.box_2d.length !== 4) return null;
  const box = boxToRect(item.box_2d, image);

  // circle/underline 은 프롬프트로 금지했지만(ANNOTATION_POLICY) 모델이
  // 지시를 어기고 보낼 수 있다 - 앱에서 arrow 로 강제해 정밀도 낮은 도형이
  // 화면에 그려질 길을 막는다 (07-30 실기기에서 동그라미 관측).
  const type = item.type === 'circle' || item.type === 'underline' ? 'arrow' : item.type;

  switch (type) {
    case 'arrow': {
      // 대상 왼쪽에 "→", 왼쪽 여백이 없으면 오른쪽에 "←"
      const nearLeftEdge = box.left - image.left < image.width * 0.09;
      return (
        <Text
          style={[
            styles.glyph,
            {
              top: box.top + box.height / 2 - 14,
              ...(nearLeftEdge ? { left: box.left + box.width + 4 } : { left: box.left - 30 }),
            },
          ]}
        >
          {nearLeftEdge ? '←' : '→'}
        </Text>
      );
    }
    case 'question_mark':
      return (
        <Text style={[styles.glyph, { left: box.left + box.width + 4, top: box.top - 10 }]}>?</Text>
      );
    case 'label': {
      if (!item.text) return null;
      const pos = placeLabelPill(box, image);
      return (
        <View style={[styles.labelPill, pos]}>
          <Text style={styles.labelText} numberOfLines={1}>
            {item.text}
          </Text>
        </View>
      );
    }
    default:
      return null;
  }
}

interface BoardAnnotationOverlayProps {
  annotations: BoardAnnotation[];
  containerWidth: number;
  containerHeight: number;
  /** 판서 이미지 종횡비 (기본 16:9 - board.service 의 aspectRatio 와 동일). */
  imageAspect?: number;
}

export default function BoardAnnotationOverlay({
  annotations,
  containerWidth,
  containerHeight,
  imageAspect = 16 / 9,
}: BoardAnnotationOverlayProps): React.JSX.Element | null {
  if (!annotations.length || containerWidth <= 0 || containerHeight <= 0) return null;
  const image = computeImageRect(containerWidth, containerHeight, imageAspect);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" testID="board-annotation-overlay">
      {annotations.map((item, i) => (
        <Annotation key={`ann-${i}`} item={item} image={image} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  glyph: {
    position: 'absolute',
    fontSize: 24,
    lineHeight: 28,
    fontWeight: '800',
    color: GREEN,
  },
  labelPill: {
    position: 'absolute',
    backgroundColor: '#FFFFFF',
    borderWidth: 1.5,
    borderColor: GREEN,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    maxWidth: 180,
  },
  labelText: {
    fontSize: 13,
    fontWeight: '700',
    color: INK,
    fontFamily: 'Pretendard',
  },
});

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Image, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import EyeAnimation from './EyeAnimation';
import LoadingDots from './LoadingDots';
import BoardAnnotationOverlay from './BoardAnnotationOverlay';
import {
  APP_BACKGROUND_COLOR,
  SURFACE_COLOR,
  SURFACE_BORDER_COLOR,
} from '../services/board.service';
import type { BoardAnnotation } from '../types/Tutoring';

// Fully-transparent and fully-opaque versions of the same background color,
// so the gradient overlays below fade the board image's edges into the
// surrounding screen instead of hard-cutting against it. These sit on TOP
// of the image (not a mask), so board content is never actually cropped -
// only visually faded where it happens to be near an edge.
const APP_BACKGROUND_TRANSPARENT = 'rgba(250, 247, 240, 0)';
const EDGE_FADE_SIZE = 56;

interface BoardViewProps {
  /** Base64-encoded board image from the board service. */
  boardImageBase64?: string;
  /** Listening state for mic indicator. */
  isListening?: boolean;
  /** Triggered when the mic overlay button is tapped. */
  onMicPress?: () => void;
  /** Hide the mic overlay entirely (e.g. while the text-input fallback is active). */
  showMic?: boolean;
  /** Safe-area-aware bottom offset, matches the keyboard-trigger button's alignment. */
  bottom?: number;
  /** 이번 턴의 힌트 오버레이 (전사본 좌표 기준). 매 턴 교체된다. */
  annotations?: BoardAnnotation[];
  /** false = 디바이스 모드: 눈은 로봇 얼굴에 있으니 앱은 로딩 문구만 보여준다. */
  showEyes?: boolean;
}

export default function BoardView({
  boardImageBase64,
  isListening = false,
  onMicPress,
  showMic = true,
  bottom = 22,
  annotations,
  showEyes = true,
}: BoardViewProps): React.JSX.Element {
  // 오버레이 좌표 계산용 - 이미지가 실제로 그려지는 영역(marginBottom 제외)의
  // 크기. resizeMode="contain" 레터박스 보정은 BoardAnnotationOverlay 가 한다.
  const [imageArea, setImageArea] = useState({ width: 0, height: 0 });
  const onImageAreaLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setImageArea({ width, height });
  };
  // 판서가 항상 16:9(전사본)는 아니다 - 과거 세션의 원본 사진 등 종횡비가
  // 제각각이라, 실제 로드된 이미지 크기에서 읽는다.
  const [imageAspect, setImageAspect] = useState(16 / 9);

  // 판서 교체(검증 불합격 -> 교정본)를 페이드로 자연스럽게 갈아 끼운다:
  // 직전 이미지를 밑에 깔아두고 새 이미지를 위에서 fade-in, 끝나면 밑장 제거.
  // 첫 표시(빈 화면 -> 1차본)는 페이드 없이 즉시.
  const [underlay, setUnderlay] = useState<string | undefined>(undefined);
  const fade = useRef(new Animated.Value(1)).current;
  const lastShownRef = useRef<string | undefined>(boardImageBase64);
  useEffect(() => {
    if (boardImageBase64 === lastShownRef.current) return;
    const prev = lastShownRef.current;
    lastShownRef.current = boardImageBase64;
    if (!prev || !boardImageBase64) return;
    setUnderlay(prev);
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 500, useNativeDriver: true }).start(() =>
      setUnderlay(undefined),
    );
  }, [boardImageBase64, fade]);

  return (
    <View style={styles.container} testID="board-view">
      {boardImageBase64 ? (
        // Full-screen, borderless board - the generated image is prompted
        // to use the exact same APP_BACKGROUND_COLOR as this container, so
        // any imperfect edges blend in instead of visibly seaming. A bottom
        // margin keeps the actual board content clear of the mic/subtitle
        // row that floats over the bottom of the screen.
        <>
          <View style={styles.boardImage} onLayout={onImageAreaLayout}>
            {!!underlay && (
              <Image
                source={{ uri: `data:image/jpeg;base64,${underlay}` }}
                style={[styles.boardImageInner, StyleSheet.absoluteFill]}
                resizeMode="contain"
                testID="board-image-underlay"
              />
            )}
            <Animated.Image
              source={{ uri: `data:image/jpeg;base64,${boardImageBase64}` }}
              style={[styles.boardImageInner, { opacity: fade }]}
              resizeMode="contain"
              testID="board-image"
              onLoad={(e) => {
                const src = e.nativeEvent?.source;
                if (src?.width && src?.height) setImageAspect(src.width / src.height);
              }}
            />
            {!!annotations?.length && (
              <BoardAnnotationOverlay
                annotations={annotations}
                containerWidth={imageArea.width}
                containerHeight={imageArea.height}
                imageAspect={imageAspect}
              />
            )}
          </View>

          {/* Edge-fade overlays - purely visual, drawn ON TOP of the image
           * (never a mask/crop), so board content is never lost. Each fades
           * from transparent (over the image) to the exact flat app
           * background color, blending the image's rectangular edges into
           * the surrounding screen instead of hard-cutting against it. */}
          <LinearGradient
            testID="board-edge-fade-left"
            pointerEvents="none"
            colors={[APP_BACKGROUND_COLOR, APP_BACKGROUND_TRANSPARENT]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.edgeFadeLeft}
          />
          <LinearGradient
            testID="board-edge-fade-right"
            pointerEvents="none"
            colors={[APP_BACKGROUND_TRANSPARENT, APP_BACKGROUND_COLOR]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.edgeFadeRight}
          />
          <LinearGradient
            testID="board-edge-fade-bottom"
            pointerEvents="none"
            colors={[APP_BACKGROUND_TRANSPARENT, APP_BACKGROUND_COLOR]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0, y: 1 }}
            style={styles.edgeFadeBottom}
          />
        </>
      ) : showEyes ? (
        <EyeAnimation state="processing" />
      ) : (
        <View style={styles.boardLoadingCenter}>
          <LoadingDots label="칠판을 그리는 중이야" />
        </View>
      )}

      {showMic && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="마이크 버튼"
          testID="board-mic-button"
          onPress={onMicPress}
          style={({ pressed }) => [
            styles.micOverlay,
            { bottom },
            isListening && styles.micOverlayListening,
            pressed && styles.micOverlayPressed,
          ]}
        >
          <Image
            source={require('../assets/icons/mic.png')}
            style={[
              styles.micIconImage,
              isListening ? styles.micIconImageListening : styles.micIconImageInactive,
            ]}
          />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: APP_BACKGROUND_COLOR,
    position: 'relative',
  },
  boardLoadingCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boardImage: {
    flex: 1,
    width: '100%',
    // Clears the bottom mic/status row (bottom:22, 44 tall) with margin to
    // spare, so board content is never hidden underneath those controls.
    marginBottom: 90,
  },
  boardImageInner: {
    width: '100%',
    height: '100%',
  },
  edgeFadeLeft: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 90,
    width: EDGE_FADE_SIZE,
  },
  edgeFadeRight: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 90,
    width: EDGE_FADE_SIZE,
  },
  edgeFadeBottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 90,
    height: EDGE_FADE_SIZE,
  },
  micOverlay: {
    position: 'absolute',
    right: 22,
    bottom: 22,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: SURFACE_COLOR,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  micOverlayListening: {
    backgroundColor: 'rgba(54, 155, 117, 0.15)',
    borderColor: '#369B75',
  },
  micOverlayPressed: {
    opacity: 0.7,
  },
  micIconImage: {
    width: 24,
    height: 24,
  },
  micIconImageListening: {
    tintColor: '#369B75',
  },
  micIconImageInactive: {
    tintColor: '#2B2926',
  },
});

import React, { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, View, Animated, Text } from 'react-native';
import { SURFACE_BORDER_COLOR, GREEN, ON_ACCENT, INK, FONT } from '../theme';

interface SolveModeToggleProps {
  /** True when "바로 정답" mode is on. */
  enabled: boolean;
  onToggle: () => void;
  /** True if the background should be transparent (used on HomeScreen). */
  transparent?: boolean;
  /** Dynamic top inset for Safe Area compliance */
  safeTop?: number;
}

/**
 * Fixed top-right toggle shown on HomeScreen, IntentScreen, and ConversationScreen.
 * Redesigned as a pill-shaped switch that shows "정답" or "힌트" in the empty space.
 */
export default function SolveModeToggle({
  enabled,
  onToggle,
  transparent = false,
  safeTop,
}: SolveModeToggleProps): React.JSX.Element {
  const switchAnim = useRef(new Animated.Value(enabled ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(switchAnim, {
      toValue: enabled ? 1 : 0,
      useNativeDriver: false,
      friction: 6,
      tension: 50,
    }).start();
  }, [enabled, switchAnim]);

  // Handle position mapping (0 -> 4, 1 -> 44)
  const knobTranslate = switchAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [4, 44],
  });

  // Background color mapping
  const backgroundColor = switchAnim.interpolate({
    inputRange: [0, 1],
    // off = 투명(테두리만 보임), on = 그린 채움. 그린 채움이 '정답' 켜짐의
    // 유일한 상태 신호라 유지한다(외곽선 톤은 off 상태로 통일).
    outputRange: ['transparent', GREEN],
  });

  // Text color mapping
  const activeTextColor = switchAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['rgba(43, 41, 38, 0)', ON_ACCENT], // '정답' text fades in
  });

  const inactiveTextColor = switchAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [INK, 'rgba(43, 41, 38, 0)'], // '힌트' text fades out
  });

  return (
    <View
      style={[styles.container, safeTop !== undefined && { top: safeTop }]}
      pointerEvents="box-none"
    >
      <Pressable
        accessibilityRole="switch"
        accessibilityLabel={enabled ? '바로 정답 모드 켜짐' : '바로 정답 모드 꺼짐'}
        accessibilityState={{ checked: enabled }}
        testID="solve-mode-toggle"
        style={({ pressed }) => [
          styles.switchTrack,
          transparent && styles.trackTransparent,
          pressed && styles.trackPressed,
        ]}
        onPress={onToggle}
      >
        <Animated.View style={[styles.switchTrackAnimated, { backgroundColor }]}>
          {/* Label for '정답' (Visible when enabled) */}
          <Animated.Text
            style={[styles.textActive, { color: activeTextColor, opacity: switchAnim }]}
          >
            정답
          </Animated.Text>

          {/* Label for '힌트' (Visible when !enabled) */}
          <Animated.Text
            style={[
              styles.textInactive,
              {
                color: inactiveTextColor,
                opacity: switchAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
              },
            ]}
          >
            힌트
          </Animated.Text>

          {/* Draggable Knob */}
          <Animated.View style={[styles.knob, { transform: [{ translateX: knobTranslate }] }]} />
        </Animated.View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 18, // Default fallback
    right: 12,
    zIndex: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  switchTrack: {
    width: 76,
    height: 36,
    borderRadius: 18,
    // 외곽선 투명 스타일 - 칩/버튼과 톤 통일(배경/그림자 없이 테두리만).
    // 켜짐 상태의 그린 채움은 switchTrackAnimated 가 그린다.
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    justifyContent: 'center',
    zIndex: 40,
    overflow: 'hidden',
  },
  switchTrackAnimated: {
    width: '100%',
    height: '100%',
    borderRadius: 18,
    justifyContent: 'center',
  },
  trackTransparent: {
    // 홈에서도 외곽선을 남긴다 - 칩/버튼과 같은 외곽선 투명 톤으로 통일
    // (예전엔 테두리까지 지워 홈에서만 토글이 통째로 사라졌다).
    backgroundColor: 'transparent',
  },
  trackPressed: {
    opacity: 0.8,
  },
  textActive: {
    position: 'absolute',
    left: 10,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: FONT,
  },
  textInactive: {
    position: 'absolute',
    right: 10,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: FONT,
  },
  knob: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
    elevation: 2,
    borderWidth: 0.5,
    borderColor: 'rgba(0,0,0,0.04)',
  },
});

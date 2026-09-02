import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import ConnectionGuideCard from './ConnectionGuideCard';
import LoadingDots from '../../components/LoadingDots';
import {
  APP_BACKGROUND_COLOR,
  INK,
  INK_MUTED,
  FONT,
  SURFACE_COLOR,
  SURFACE_BORDER_COLOR,
} from '../../theme';

interface DisconnectOverlayProps {
  /** [세션 종료] - 기록 저장 후 홈으로. */
  onEndSession: () => void;
}

/**
 * 디바이스 모드 세션 중 연결이 끊기면 세션 전체를 덮는다. 재연결 시도는
 * 별도 로직이 없다 - connectionMonitor 폴링이 계속 돌고, 부모가 상태를
 * 구독하다가 connected 로 돌아오면 이 오버레이를 내린다.
 *
 * "휴대폰으로 계속하기" 탈출구는 없다 (Task 6) - 디바이스 연동판은 폰
 * 마이크·스피커로 새는 조용한 폴백을 정책적으로 금지한다. 남는 선택지는
 * 재연결을 기다리거나 세션을 끝내는 것뿐이다.
 */
export default function DisconnectOverlay({
  onEndSession,
}: DisconnectOverlayProps): React.JSX.Element {
  return (
    <View style={styles.overlay} testID="disconnect-overlay">
      <Text style={styles.title}>비바와 연결이 끊겼어</Text>
      <View style={styles.spinnerRow}>
        <LoadingDots />
        <Text style={styles.spinnerLabel}>다시 연결하는 중이야</Text>
      </View>
      <ConnectionGuideCard />
      <View style={styles.buttons}>
        <Pressable
          accessibilityRole="button"
          testID="end-session-button"
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          onPress={onEndSession}
        >
          <Text style={styles.secondaryLabel}>세션 종료</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: APP_BACKGROUND_COLOR, // 불투명 - 뒤 세션 UI 조작 차단
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 24,
    zIndex: 100,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    fontFamily: FONT,
    color: INK,
    textAlign: 'center',
  },
  spinnerRow: {
    alignItems: 'center',
    gap: 8,
  },
  spinnerLabel: {
    fontSize: 13,
    fontFamily: FONT,
    color: INK_MUTED,
  },
  buttons: {
    alignSelf: 'stretch',
    gap: 12,
  },
  secondaryButton: {
    height: 52,
    borderRadius: 26,
    backgroundColor: SURFACE_COLOR,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryLabel: {
    fontSize: 16,
    fontWeight: '600',
    fontFamily: FONT,
    color: INK,
  },
  pressed: {
    // 눌림 피드백 통일값 (2026-08-13 UX 통일).
    opacity: 0.55,
  },
});

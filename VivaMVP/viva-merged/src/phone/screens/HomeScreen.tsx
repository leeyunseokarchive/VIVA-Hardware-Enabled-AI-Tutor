import React from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import EyeAnimation from '../../components/EyeAnimation';
import { APP_BACKGROUND_COLOR, SURFACE_BORDER_COLOR } from '../../theme';
import SolveModeToggle from '../../components/SolveModeToggle';

// CSS-only clock icon for history (기존 그대로)
const HistoryIcon = () => (
  <View style={styles.historyIconWrapper}>
    <View style={styles.historyClockFace} />
    <View style={styles.historyClockHand} />
    <View style={styles.historyClockHandMinute} />
  </View>
);

interface HomeScreenProps {
  onPressToTalk: () => void;
  onPressHistory: () => void;
  solveMode: boolean;
  onToggleSolveMode: () => void;
}

export default function HomeScreen({
  onPressToTalk,
  onPressHistory,
  solveMode,
  onToggleSolveMode,
}: HomeScreenProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const safeTop = Math.max(insets.top + 12, 18);

  return (
    <View style={styles.container} testID="home-screen">
      <SolveModeToggle
        enabled={solveMode}
        onToggle={onToggleSolveMode}
        transparent
        safeTop={safeTop}
      />

      {/* 폰이 곧 비바 - 눈이 얼굴이다. */}
      <View style={styles.centerArea}>
        <View testID="home-eyes">
          <EyeAnimation state="idle" />
        </View>
      </View>

      <View style={styles.bottomControls}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="눌러서 말하기"
          testID="push-to-talk-button"
          style={({ pressed }) => [styles.controlButton, pressed && styles.controlButtonPressed]}
          onPress={onPressToTalk}
        >
          <Image source={require('../../assets/icons/mic.png')} style={styles.micIconImage} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="대화 기록"
          testID="history-button"
          style={({ pressed }) => [styles.controlButton, pressed && styles.controlButtonPressed]}
          onPress={onPressHistory}
        >
          <HistoryIcon />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: APP_BACKGROUND_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  centerArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
    paddingHorizontal: 36,
  },
  bottomControls: {
    position: 'absolute',
    bottom: 34,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  controlButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  controlButtonPressed: {
    opacity: 0.7,
  },
  micIconImage: {
    width: 24,
    height: 24,
    tintColor: 'rgba(43, 41, 38, 0.5)',
  },
  historyIconWrapper: {
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  historyClockFace: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.8,
    borderColor: 'rgba(43, 41, 38, 0.5)',
  },
  historyClockHand: {
    position: 'absolute',
    width: 1.8,
    height: 6,
    backgroundColor: 'rgba(43, 41, 38, 0.5)',
    top: 5,
    left: 11.1,
    borderRadius: 1,
  },
  historyClockHandMinute: {
    position: 'absolute',
    width: 5,
    height: 1.8,
    backgroundColor: 'rgba(43, 41, 38, 0.5)',
    top: 11.1,
    left: 11.1,
    borderRadius: 1,
  },
});

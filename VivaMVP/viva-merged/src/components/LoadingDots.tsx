import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

interface LoadingDotsProps {
  /** Optional short status label shown to the left of the dots (e.g. "분석 중"). */
  label?: string;
}

const EASE = Easing.inOut(Easing.ease);

/**
 * Shared "something is loading/thinking" indicator: 3 breathing dots, with
 * an optional label. This is intentionally decoupled from EyeAnimation - it
 * is the single, common loading cue used at the bottom of every screen
 * that's waiting on something (image analysis, gallery import, STT
 * evaluation, TTS generation, board regeneration), independent of whatever
 * eye state is shown elsewhere on screen.
 */
export default function LoadingDots({ label }: LoadingDotsProps): React.JSX.Element {
  const opacity1 = useRef(new Animated.Value(0.3)).current;
  const opacity2 = useRef(new Animated.Value(0.3)).current;
  const opacity3 = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const animateDot = (animValue: Animated.Value, delay: number) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(animValue, {
            toValue: 1,
            duration: 600,
            easing: EASE,
            useNativeDriver: true,
          }),
          Animated.timing(animValue, {
            toValue: 0.3,
            duration: 600,
            easing: EASE,
            useNativeDriver: true,
          }),
        ]),
      );
    };

    const a1 = animateDot(opacity1, 0);
    const a2 = animateDot(opacity2, 200);
    const a3 = animateDot(opacity3, 400);

    a1.start();
    a2.start();
    a3.start();

    return () => {
      a1.stop();
      a2.stop();
      a3.stop();
    };
  }, [opacity1, opacity2, opacity3]);

  return (
    <View style={styles.container} pointerEvents="none" testID="loading-dots">
      {!!label && <Text style={styles.label}>{label}</Text>}
      <View style={styles.dotsRow}>
        <Animated.View style={[styles.dot, { opacity: opacity1 }]} />
        <Animated.View style={[styles.dot, { opacity: opacity2 }]} />
        <Animated.View style={[styles.dot, { opacity: opacity3 }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  label: {
    fontSize: 16,
    fontWeight: '500',
    color: 'rgba(43, 41, 38, 0.5)',
    fontFamily: 'Pretendard',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(43, 41, 38, 0.5)',
  },
});

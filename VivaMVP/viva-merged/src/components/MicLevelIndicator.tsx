import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

interface MicLevelIndicatorProps {
  /** Raw RMS from useVoiceInput's micLevel, 0~1 (unclamped above 1 in
   * practice - typical speech sits well under that). */
  level: number;
}

// Per-bar weighting so bars don't all move in lockstep (equalizer look),
// center bars react a bit more than the edges. This array's length IS the
// bar count - a separate BAR_COUNT const existed and went unused, which is
// the safer shape anyway (two sources for one number can disagree).
const BAR_WEIGHTS = [0.55, 0.85, 1, 0.85, 0.55];
// RMS above this reads as "fully loud" for the bar height - typical speech
// RMS sits well below this, SPEECH_RMS_THRESHOLD (useVoiceInput.ts) is 0.015.
const MAX_LEVEL = 0.12;
const MIN_HEIGHT_FRACTION = 0.2; // idle/silent baseline so bars still "breathe"

/**
 * Volume-reactive bar meter shown while listening, in place of a live
 * transcript - useVoiceInput deliberately has no partial/streaming
 * recognition (see its file header), so this is the "you're being heard"
 * feedback instead of text.
 */
export default function MicLevelIndicator({ level }: MicLevelIndicatorProps): React.JSX.Element {
  const heights = useRef(BAR_WEIGHTS.map(() => new Animated.Value(MIN_HEIGHT_FRACTION))).current;

  useEffect(() => {
    const normalized = Math.min(Math.max(level / MAX_LEVEL, 0), 1);
    const animation = Animated.parallel(
      heights.map((anim, i) =>
        Animated.timing(anim, {
          toValue: Math.max(MIN_HEIGHT_FRACTION, normalized * BAR_WEIGHTS[i]),
          duration: 90,
          useNativeDriver: false, // animating height, not transform/opacity
        }),
      ),
    );
    animation.start();
    return () => animation.stop();
  }, [level, heights]);

  return (
    <View style={styles.row} pointerEvents="none">
      {heights.map((anim, i) => (
        <Animated.View
          key={i}
          style={[
            styles.bar,
            {
              height: anim.interpolate({
                inputRange: [0, 1],
                outputRange: ['20%', '100%'],
              }),
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 4,
    height: 22,
  },
  bar: {
    width: 4,
    borderRadius: 2,
    backgroundColor: '#369B75',
  },
});

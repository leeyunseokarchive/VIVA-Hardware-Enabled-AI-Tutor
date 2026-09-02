import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import EyeAnimation, { EyeState } from './EyeAnimation';
import {
  APP_BACKGROUND_COLOR,
  SURFACE_COLOR,
  SURFACE_BORDER_COLOR,
} from '../services/board.service';
import { INK, FONT } from '../theme';

interface CharacterViewProps {
  /** Eye animation state. */
  state?: EyeState;
  /** Listening state for the mic. */
  isListening?: boolean;
  /** Triggered when the mic button is pressed. */
  onMicPress?: () => void;
  /** Hide the mic overlay entirely (e.g. while the text-input fallback is active). */
  showMic?: boolean;
  /** Safe-area-aware bottom offset, matches the keyboard-trigger button's alignment. */
  bottom?: number;
  /** false = 디바이스 모드: 눈은 로봇 얼굴에 있으니 앱은 자막이 주인공. */
  showEyes?: boolean;
  /** showEyes=false 일 때 중앙에 크게 띄울 현재 자막. */
  centerSubtitle?: string;
}

export default function CharacterView({
  state = 'conversation',
  isListening = false,
  onMicPress,
  showMic = true,
  bottom = 22,
  showEyes = true,
  centerSubtitle,
}: CharacterViewProps): React.JSX.Element {
  // Eye-state sync to the physical board lives in ConversationScreen (it
  // must fire even while BoardView is shown instead of this component).
  return (
    <View style={styles.container} testID="character-view">
      {showEyes ? (
        <EyeAnimation state={state} />
      ) : (
        <View style={styles.centerSubtitleWrap} pointerEvents="none">
          {centerSubtitle ? (
            <Text style={styles.centerSubtitleText}>{centerSubtitle}</Text>
          ) : null}
        </View>
      )}

      {/* Mic button in the bottom-right corner - matches BoardView's
       * placement so it never competes with the screen-centered eyes or
       * the bottom-center subtitle/loading-dot status row. */}
      {showMic && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="마이크 입력"
          testID="character-mic-button"
          onPress={onMicPress}
          style={({ pressed }) => [
            isListening ? styles.micActive : styles.micInactive,
            { bottom },
            pressed && styles.micPressed,
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
  centerSubtitleWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 36,
  },
  centerSubtitleText: {
    fontSize: 22,
    lineHeight: 34,
    fontWeight: '600',
    fontFamily: FONT,
    color: INK,
    textAlign: 'center',
  },
  micActive: {
    position: 'absolute',
    right: 22,
    bottom: 22,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(54, 155, 117, 0.15)',
    borderWidth: 1.5,
    borderColor: '#369B75',
    alignItems: 'center',
    justifyContent: 'center',
  },
  micInactive: {
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
  },
  micPressed: {
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

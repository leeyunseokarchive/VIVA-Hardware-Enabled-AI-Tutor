/**
 * 촬영 직후 분석 대기 화면 (AppState 'processing').
 *
 * 기존엔 캐릭터 눈만 떠 있어서 Pi 촬영+전송+1차 분석(~19초)이 통째로 무언의
 * 대기였다 - 자막바 위치에 로딩닷 + 진행 문구를 띄우고, 문구를 몇 초마다
 * 바꿔 "진행되고 있다" 는 감각을 준다 (실기기 피드백 2026-07-29).
 * 문구 톤은 앱의 다른 발화와 같은 반말.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import EyeAnimation from './EyeAnimation';
import LoadingDots from './LoadingDots';
import { APP_BACKGROUND_COLOR } from '../theme';

/** 순서대로 순환 - 실제 파이프라인 순서(촬영 확인 -> 읽기 -> 풀이 준비)를
 * 흉내내면 임의 순환보다 진행감이 있다. */
const PROCESSING_PHRASES = [
  '찍은 사진을 자세히 보고 있어!',
  '문제를 읽는 중이야!',
  '어떻게 도와줄지 생각하고 있어!',
];
const PHRASE_INTERVAL_MS = 3000;

interface ProcessingViewProps {
  /** false = 디바이스 모드 (로봇 눈이 'listening' 으로 일하는 중을 표현한다). */
  showEyes?: boolean;
}

export default function ProcessingView({ showEyes = true }: ProcessingViewProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [phraseIndex, setPhraseIndex] = useState(0);
  const phraseAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const timer = setInterval(
      () => setPhraseIndex((i) => (i + 1) % PROCESSING_PHRASES.length),
      PHRASE_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, []);

  // Narration-style rise-in on every phrase change, matching the subtitle
  // entrance used by ConversationScreen's status row.
  useEffect(() => {
    phraseAnim.setValue(0);
    Animated.timing(phraseAnim, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [phraseIndex, phraseAnim]);

  // Same bottom anchor as ConversationScreen's status row (safeBottom), so
  // the loading dots sit in the identical spot across both screens.
  const safeBottom = Math.max(insets.bottom + 12, 24);

  return (
    <View style={styles.container} testID="processing-screen">
      {showEyes && <EyeAnimation state="processing" />}
      <View
        style={showEyes ? [styles.statusRow, { bottom: safeBottom }] : styles.statusCenter}
        pointerEvents="none"
      >
        <Animated.Text
          style={[
            styles.phraseText,
            {
              opacity: phraseAnim,
              transform: [
                {
                  translateY: phraseAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [15, 0],
                  }),
                },
              ],
            },
          ]}
        >
          {PROCESSING_PHRASES[phraseIndex]}
        </Animated.Text>
        <LoadingDots />
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
  },
  statusRow: {
    position: 'absolute',
    left: 48,
    right: 48,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusCenter: {
    paddingHorizontal: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Matches ConversationScreen's subtitleTextSmall exactly, for visual
  // parity between the two loading-dot placements.
  phraseText: {
    fontSize: 12,
    color: 'rgba(43, 41, 38, 0.5)',
    fontWeight: '500',
    fontFamily: 'Pretendard',
    textAlign: 'center',
    lineHeight: 16,
    marginBottom: 4,
    textShadowColor: 'rgba(255, 255, 255, 0.95)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
});

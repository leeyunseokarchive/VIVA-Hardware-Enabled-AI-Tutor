import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text } from 'react-native';
import { GREEN, ORANGE, INK_MUTED, FONT, MOTION, SURFACE_BORDER_COLOR } from '../../theme';
import type { PiConnectionStatus } from '../services/connectionMonitor.service';
import FadeInView from '../../components/FadeInView';

interface ConnectionStatusChipProps {
  status: PiConnectionStatus;
}

const LABELS: Record<PiConnectionStatus, string> = {
  connected: '비바 연결됨',
  connecting: '비바 찾는 중',
  disconnected: '연결 안 됨',
};

const DOT_COLORS: Record<PiConnectionStatus, string> = {
  connected: GREEN,
  connecting: INK_MUTED,
  disconnected: ORANGE,
};

// 상태가 바뀔 때마다 라벨이 점 왼쪽으로 스르륵 펼쳐졌다가, connected 만 이
// 시간 뒤 다시 접혀 초록 점만 남는다(실기기 피드백 2026-08-11: "연결됨" 문구가
// 계속 떠 있을 필요 없다). connecting/disconnected 는 접지 않는다 - 문구 없이
// 점 색만 남기면 의미를 색으로만 전달하게 된다 (color-not-only).
const LABEL_HOLD_MS = 2600;
// 가장 긴 라벨("비바 찾는 중")이 12px 로 다 들어가는 폭. 이보다 크게 잡으면
// 접힘 애니 초반에 아무 변화 없는 구간이 생긴다.
const LABEL_MAX_W = 80;

/** 디바이스 연동판 홈 우상단, 힌트 토글 왼쪽에 같은 간격으로 붙는 상태 칩.
 * 형태·그림자는 SolveModeToggle 의 36px 서피스 필과 동일 - 한 줄에 서는 두
 * 컨트롤이 같은 패턴이어야 한다. 접히면 지름 36 정원(점만)이 된다.
 * 배치는 HomeScreen 의 topRightRow 가 한다 (2026-08-11: 고장 배지와 한 줄에
 * 서면서 absolute 를 벗었다). */
export default function ConnectionStatusChip({
  status,
}: ConnectionStatusChipProps): React.JSX.Element {
  // 1 = 라벨 펼침, 0 = 점만. maxWidth/margin(레이아웃 속성) 애니라 non-native.
  const reveal = useRef(new Animated.Value(1)).current;
  // 접힌 배지를 탭하면 증가 - 아래 이펙트가 다시 돌며 펼침→접힘을 재생한다
  // (실기기 피드백 2026-08-11b: 접힌 뒤에도 눌러서 다시 볼 수 있어야 한다).
  const [poke, setPoke] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    reveal.stopAnimation();
    Animated.timing(reveal, {
      toValue: 1,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished && status === 'connected') {
        timer = setTimeout(() => {
          Animated.timing(reveal, {
            toValue: 0,
            duration: 200,
            easing: Easing.in(Easing.cubic),
            useNativeDriver: false,
          }).start();
        }, LABEL_HOLD_MS);
      }
    });
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      reveal.stopAnimation();
    };
  }, [status, poke, reveal]);

  return (
    // 홈 화면 진입 시(마운트) 얇게 페이드인 (과제 5, 2026-08-13) - 내부
    // reveal 애니(라벨 펼침/접힘)와는 별개.
    <FadeInView duration={MOTION.fast}>
      <Pressable
        style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
        // 36px 필이라 최소 터치 타깃(44)에 못 미치는 만큼을 히트 영역으로 보충.
        hitSlop={8}
        onPress={() => setPoke((n) => n + 1)}
        testID="connection-status-chip"
        accessibilityRole="button"
        accessibilityLabel={`디바이스 연결 상태: ${LABELS[status]}`}
      >
        <Animated.View
          style={[
            styles.labelClip,
            {
              maxWidth: reveal.interpolate({ inputRange: [0, 1], outputRange: [0, LABEL_MAX_W] }),
              opacity: reveal,
              marginRight: reveal.interpolate({ inputRange: [0, 1], outputRange: [0, 7] }),
            },
          ]}
        >
          {/* ellipsizeMode clip: 접히는 동안 "비바 연결…" 말줄임표가 깜빡이지
              않게 하드 클립 - 점 밑으로 미끄러져 들어가는 것처럼 읽힌다. */}
          <Text style={styles.label} numberOfLines={1} ellipsizeMode="clip">
            {LABELS[status]}
          </Text>
        </Animated.View>
        <Animated.View style={[styles.dot, { backgroundColor: DOT_COLORS[status] }]} />
      </Pressable>
    </FadeInView>
  );
}

const styles = StyleSheet.create({
  chip: {
    height: 36,
    // 접히면 14+점8+14 = 36 - 높이와 같아져 정원이 된다.
    paddingHorizontal: 14,
    borderRadius: 18,
    // 외곽선 투명 스타일 - 마이크/기록 버튼·토글과 톤 통일(실기기 피드백
    // 2026-08-11: 흰 알약+그림자만 홀로 튀었다). 배경/그림자 없이 테두리만.
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 40,
  },
  chipPressed: {
    opacity: 0.55,
  },
  labelClip: {
    overflow: 'hidden',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: FONT,
    color: INK_MUTED,
  },
});

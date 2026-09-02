import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text } from 'react-native';
import { ORANGE, INK, FONT, MOTION, SURFACE_BORDER_COLOR } from '../../theme';
import type { PiConnectionStatus, PiHealth } from '../services/connectionMonitor.service';
import FadeInView from '../../components/FadeInView';

interface FaultBadgeProps {
  status: PiConnectionStatus;
  health: PiHealth | null;
}

interface Fault {
  key: string;
  testId: string;
  /** 화면 문구이자 스크린리더 문구. 진단 톤 (사용자 지시 2026-08-11:
   * 시연자 대상이라 "안 들려" 말투 대신 짧고 명확하게). */
  label: string;
}

/**
 * 부품별 고장 목록 (사용자 지시 2026-08-10: 정상은 조용히, 이상만 외친다).
 * false 인 항목만 남는다 - true(정상)·undefined(모름, 구버전 Pi 나 아직
 * 프로브가 없는 항목)는 똑같이 "지금 알릴 것 없음"으로 취급한다.
 */
export function buildFaults(health: PiHealth | null): Fault[] {
  const faults: Fault[] = [];
  if (health?.micOk === false) {
    faults.push({ key: 'mic', testId: 'fault-badge-mic', label: '마이크 이상' });
  }
  if (health?.speakerOk === false) {
    faults.push({ key: 'speaker', testId: 'fault-badge-speaker', label: '스피커 이상' });
  }
  if (health?.camOk === false) {
    faults.push({ key: 'camera', testId: 'fault-badge-camera', label: '카메라 이상' });
  }
  if (health?.displayOk === false) {
    faults.push({ key: 'display', testId: 'fault-badge-display', label: '화면 이상' });
  }
  return faults;
}

// 연결 칩(LABEL_HOLD_MS 2600)보다 길게 잡는다 - 고장은 인사가 아니라 경고라
// 읽을 시간을 더 준다. 접혀도 ORANGE 점이 남아 "이상 있음"은 계속 보인다.
const LABEL_HOLD_MS = 4000;
// 가장 긴 라벨("스피커 이상")이 12px 로 다 들어가는 폭.
const LABEL_MAX_W = 72;
// 라벨 한 줄 높이. 첫 줄이 점(8px)과 세로 중앙이 맞도록 점 marginTop 과 짝.
const LINE_H = 20;

/**
 * 디바이스 홈 우상단, 연결 칩 왼쪽에 붙는 고장 배지 (DeviceVitals 후속,
 * 2026-08-11 개편: 중앙 상단 알약 나열 -> 연결 칩과 같은 접이식 배지 하나).
 *
 * 칩과 같은 리듬: 이상이 생기면 점 왼쪽으로 라벨이 스르륵 펼쳐졌다가
 * LABEL_HOLD_MS 뒤 접혀 점만 남고, 탭하면 다시 펼쳐진다. 이상이 여러 개면
 * 배지를 늘리지 않고 점 왼쪽 첫 줄 아래로 목록이 주르륵 붙는다 (필 높이가
 * 같이 자란다). 이상이 없거나 미연결이면 컴포넌트 자체가 null - 미연결
 * 상태에선 하드웨어 상태를 알 방법이 없어 stale 값을 보여주지 않는다.
 */
export default function FaultBadge({
  status,
  health,
}: FaultBadgeProps): React.JSX.Element | null {
  // 1 = 목록 펼침, 0 = 점만. maxWidth/maxHeight(레이아웃 속성) 애니라 non-native.
  const reveal = useRef(new Animated.Value(0)).current;
  // 접힌 배지를 탭하면 증가 - 아래 이펙트가 다시 돌며 펼침→접힘을 재생한다.
  const [poke, setPoke] = useState(0);

  const faults = status === 'connected' ? buildFaults(health) : [];
  const visible = faults.length > 0;
  // 고장 조합이 바뀌면(새 부품 추가/회복) 재펼침 - 5초 폴링의 동일 값 반복엔
  // 반응하지 않는다.
  const faultsKey = faults.map((f) => f.key).join(',');

  useEffect(() => {
    if (!visible) {
      reveal.setValue(0);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    reveal.stopAnimation();
    Animated.timing(reveal, {
      toValue: 1,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished) {
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
  }, [visible, faultsKey, poke, reveal]);

  if (!visible) return null;

  return (
    // 배지 자체는 조건부 마운트(!visible 이면 null)라 나타날 때 "팝"하지
    // 않도록 얇게 페이드인한다 (과제 5, 2026-08-13). 내부 reveal 애니와는
    // 별개 - reveal 은 라벨 펼침/접힘, 이건 배지 등장.
    <FadeInView duration={MOTION.fast}>
      <Pressable
        style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
        hitSlop={8}
        onPress={() => setPoke((n) => n + 1)}
        testID="fault-badge"
        accessibilityRole="button"
        accessibilityLabel={`비바 부품 이상: ${faults.map((f) => f.label).join(', ')}`}
      >
        <Animated.View
          style={[
            styles.labelClip,
            {
              maxWidth: reveal.interpolate({ inputRange: [0, 1], outputRange: [0, LABEL_MAX_W] }),
              maxHeight: reveal.interpolate({
                inputRange: [0, 1],
                outputRange: [0, faults.length * LINE_H],
              }),
              opacity: reveal,
              marginRight: reveal.interpolate({ inputRange: [0, 1], outputRange: [0, 7] }),
            },
          ]}
        >
          {faults.map((fault) => (
            /* ellipsizeMode clip: 접히는 동안 말줄임표가 깜빡이지 않게 하드
               클립 - 점 밑으로 미끄러져 들어가는 것처럼 읽힌다 (칩과 동일). */
            <Text
              key={fault.key}
              style={styles.label}
              numberOfLines={1}
              ellipsizeMode="clip"
              testID={fault.testId}
            >
              {fault.label}
            </Text>
          ))}
        </Animated.View>
        <Animated.View style={styles.dot} testID="fault-badge-dot" />
      </Pressable>
    </FadeInView>
  );
}

const styles = StyleSheet.create({
  // 연결 칩과 같은 36px 외곽선 필. 접히면 14+점8+14 = 36 정원, 펼치면
  // 목록 높이만큼 아래로 자란 라운드 사각형이 된다.
  pill: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    minHeight: 36,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
  },
  pillPressed: {
    opacity: 0.55,
  },
  labelClip: {
    overflow: 'hidden',
    alignItems: 'flex-end',
  },
  // 첫 줄(LINE_H 20) 세로 중앙 = 8+10 = 18 = 접힌 필의 중앙. 점(8px)도
  // marginTop 6 으로 같은 줄에 맞춘다.
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 6,
    // 뜨는 배지는 전부 고장 신호라 항상 ORANGE (앱 공용 경고색 - 순빨강을
    // 새로 만들지 않는다, 사용자 확정 2026-08-11).
    backgroundColor: ORANGE,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: FONT,
    lineHeight: LINE_H,
    // 항상 INK. ORANGE(약 3.3:1)는 크림 배경에서 12px 소형 텍스트 기준
    // 4.5:1 미달이다 - 의미는 문구가 지고 색은 점만.
    color: INK,
    textAlign: 'right',
  },
});

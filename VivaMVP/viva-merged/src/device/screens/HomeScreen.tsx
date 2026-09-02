import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ConnectionStatusChip from '../components/ConnectionStatusChip';
import ConnectionGuideCard from '../components/ConnectionGuideCard';
import FaultBadge from '../components/FaultBadge';
import WifiProvisionScreen from './WifiProvisionScreen';
import { usePiDeviceHealth } from '../hooks/usePiConnection';
import type { PiConnectionStatus, PiHealth } from '../services/connectionMonitor.service';
import LoadingDots from '../../components/LoadingDots';
import SolveModeToggle from '../../components/SolveModeToggle';
import { APP_BACKGROUND_COLOR, SURFACE_BORDER_COLOR, INK, INK_MUTED, FONT } from '../../theme';

// CSS-only clock icon for history (기존 그대로)
const HistoryIcon = () => (
  <View style={styles.historyIconWrapper}>
    <View style={styles.historyClockFace} />
    <View style={styles.historyClockHand} />
    <View style={styles.historyClockHandMinute} />
  </View>
);

// CSS-only sliders icon for settings - HistoryIcon 과 같은 1.8 스트로크 언어.
// 링 노브가 배경색으로 라인을 끊어 조절 슬라이더로 읽힌다.
const SettingsIcon = () => (
  <View style={styles.historyIconWrapper}>
    <View style={[styles.settingsLine, { top: 5 }]} />
    <View style={[styles.settingsLine, { top: 11.1 }]} />
    <View style={[styles.settingsLine, { top: 17.2 }]} />
    <View style={[styles.settingsKnob, { top: 2.4, left: 5 }]} />
    <View style={[styles.settingsKnob, { top: 8.5, left: 13 }]} />
    <View style={[styles.settingsKnob, { top: 14.6, left: 8 }]} />
  </View>
);

interface HomeScreenProps {
  piStatus: PiConnectionStatus;
  onPressToTalk: () => void;
  onPressHistory: () => void;
  solveMode: boolean;
  onToggleSolveMode: () => void;
}

// F1 (device-vitals 스펙 정정 절): 연결 직후 첫 /health 프로브는 wake 스트림
// resume 전이라 멀쩡한 마이크도 mic_ok:false 로 온다. 연결 엣지에서
// MIC_GRACE_MS 동안 micOk:false 를 "모름"으로 강등해 오탐 주황 점을 막는다.
// 5초 폴링이라 grace 만료 후 늦어도 다음 폴에서 실값이 반영된다.
export const MIC_GRACE_MS = 12000;
export function graceHealth(
  health: PiHealth | null,
  connectedSinceMs: number | null,
  nowMs: number,
): PiHealth | null {
  if (!health || health.micOk !== false || connectedSinceMs === null) return health;
  if (nowMs - connectedSinceMs < MIC_GRACE_MS) return { ...health, micOk: undefined };
  return health;
}

export default function HomeScreen({
  piStatus,
  onPressToTalk,
  onPressHistory,
  solveMode,
  onToggleSolveMode,
}: HomeScreenProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const safeTop = Math.max(insets.top + 12, 18);

  // 디바이스 모드의 세션 시작은 로봇 마이크·카메라 전제 - 미연결이면 막는다.
  const startDisabled = piStatus !== 'connected';
  // 연결 가이드가 차지하는 화면에선 하단 버튼을 아예 숨긴다 - 마이크는 어차피
  // 비활성이고, 가이드 카드와 겹쳐 보이는 문제(실기기 피드백 2026-08-11).
  const guideVisible = piStatus !== 'connected' && piStatus !== 'connecting';

  const health = usePiDeviceHealth();
  // state 여야 한다 (ref 금지): 엣지 직후 grace 적용된 값으로 재렌더가 일어나야
  // 한다 - ref 면 다음 5초 폴 재렌더까지 주황 점이 그대로 보인다.
  const [connectedSince, setConnectedSince] = useState<number | null>(null);
  const [showWifiProvision, setShowWifiProvision] = useState(false);
  useEffect(() => {
    setConnectedSince(piStatus === 'connected' ? Date.now() : null);
  }, [piStatus]);

  // 중앙 안내가 연결 상태에 따라 통째로 갈리므로, 바뀔 때마다 새 내용을
  // 짧게 페이드+떠오름으로 들인다 (실기기 피드백 2026-08-11: 자막 전환이
  // 뚝뚝 끊긴다). opacity/transform 뿐이라 native driver.
  const centerAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    centerAnim.setValue(0);
    Animated.timing(centerAnim, {
      toValue: 1,
      duration: 300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [piStatus, centerAnim]);

  return (
    <View style={styles.container} testID="home-screen">
      {/* 우상단 한 줄: [고장 배지][연결 칩]. 행이 right 기준이라 배지 라벨이
          펼쳐지면 왼쪽으로 자연히 자란다 - 겹침 계산이 필요 없다 (2026-08-11
          개편: 고장 배지가 중앙 상단에서 연결 칩 왼쪽으로 이동). */}
      <View style={[styles.topRightRow, { top: safeTop }]}>
        <FaultBadge
          status={piStatus}
          health={graceHealth(health, connectedSince, Date.now())}
        />
        <ConnectionStatusChip status={piStatus} />
      </View>
      <SolveModeToggle
        enabled={solveMode}
        onToggle={onToggleSolveMode}
        transparent
        safeTop={safeTop}
      />

      {/* 중앙: 연결 상태에 따라 하나만 */}
      <View style={styles.centerArea}>
        <Animated.View
          style={[
            styles.centerContent,
            {
              opacity: centerAnim,
              transform: [
                { translateY: centerAnim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
              ],
            },
          ]}
        >
          {piStatus === 'connected' ? (
            <View style={styles.wakeGuide}>
              <Text style={styles.wakeTitle}>"비바야" 라고 불러봐</Text>
              <Text style={styles.wakeSub}>궁금한 수학 문제나 개념이 있으면 언제든 물어봐</Text>
            </View>
          ) : piStatus === 'connecting' ? (
            <View style={styles.wakeGuide}>
              <LoadingDots />
              <Text style={styles.wakeSub}>비바를 찾는 중이야</Text>
            </View>
          ) : (
            <View style={styles.guideWrap}>
              <Text style={styles.wakeTitle}>비바와 연결이 안 돼</Text>
              <ConnectionGuideCard onRegisterWifi={() => setShowWifiProvision(true)} />
            </View>
          )}
        </Animated.View>
      </View>

      {!guideVisible && (
        <View style={styles.bottomControls}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="눌러서 말하기"
            accessibilityState={{ disabled: startDisabled }}
            disabled={startDisabled}
            testID="push-to-talk-button"
            style={({ pressed }) => [
              styles.controlButton,
              startDisabled && styles.controlButtonDisabled,
              pressed && styles.controlButtonPressed,
            ]}
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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="WiFi 설정"
            testID="wifi-settings-button"
            style={({ pressed }) => [styles.controlButton, pressed && styles.controlButtonPressed]}
            onPress={() => setShowWifiProvision(true)}
          >
            <SettingsIcon />
          </Pressable>
        </View>
      )}

      {showWifiProvision && (
        <WifiProvisionScreen onClose={() => setShowWifiProvision(false)} />
      )}
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
  topRightRow: {
    position: 'absolute',
    // ConnectionStatusChip 이 쓰던 자리 그대로 - SolveModeToggle(right:12,
    // 트랙 폭 76) 왼쪽에 같은 간격(12)으로 붙는다.
    right: 100,
    flexDirection: 'row',
    // 고장 배지가 목록으로 아래로 자라도 칩은 윗줄에 남는다.
    alignItems: 'flex-start',
    gap: 12,
    zIndex: 40,
  },
  centerArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
    paddingHorizontal: 36,
  },
  centerContent: {
    alignSelf: 'stretch',
    alignItems: 'center',
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
  controlButtonDisabled: {
    opacity: 0.38,
  },
  controlButtonPressed: {
    // 눌림 피드백 통일값 (2026-08-13 UX 통일).
    opacity: 0.55,
  },
  micIconImage: {
    width: 24,
    height: 24,
    tintColor: 'rgba(43, 41, 38, 0.5)',
  },
  wakeGuide: {
    alignItems: 'center',
    gap: 12,
  },
  wakeTitle: {
    fontSize: 24,
    fontWeight: '700',
    fontFamily: FONT,
    color: INK,
    textAlign: 'center',
  },
  wakeSub: {
    fontSize: 15,
    fontFamily: FONT,
    color: INK_MUTED,
    textAlign: 'center',
  },
  guideWrap: {
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: 20,
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
  settingsLine: {
    position: 'absolute',
    left: 2,
    width: 20,
    height: 1.8,
    borderRadius: 1,
    backgroundColor: 'rgba(43, 41, 38, 0.5)',
  },
  settingsKnob: {
    position: 'absolute',
    width: 7,
    height: 7,
    borderRadius: 3.5,
    borderWidth: 1.8,
    borderColor: 'rgba(43, 41, 38, 0.5)',
    backgroundColor: APP_BACKGROUND_COLOR,
  },
});

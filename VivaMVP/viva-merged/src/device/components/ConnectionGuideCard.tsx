import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { GREEN, SURFACE_COLOR, SURFACE_BORDER_COLOR, INK, FONT } from '../../theme';

/** 홈(미연결)과 끊김 오버레이 공용 복구 체크리스트. 순서가 곧 시도 순서다.
 * 2026-08-11 리디자인: 숫자 원 -> GREEN 틴트 타일 + CSS 드로잉 아이콘,
 * 행별 스태거 등장 - 새 의존성 없이 기존 CSS 아이콘 관례(HistoryIcon)를 따른다. */
const GUIDE_ITEMS = [
  { key: 'power', text: '비바 전원이 켜져 있는지 확인해줘', Icon: PowerIcon },
  { key: 'wifi', text: '휴대폰과 비바가 같은 와이파이에 있어야 해', Icon: WifiIcon },
  { key: 'replug', text: '그래도 안 되면 비바 전원을 뽑았다 다시 꽂아줘', Icon: ReplugIcon },
  { key: 'qr', text: '비바 화면에 QR 안내가 보이면 와이파이를 등록해줘', Icon: QrIcon },
];

/** 전원 심볼 - 위가 트인 링 + 세로 막대. */
function PowerIcon() {
  return (
    <View style={iconStyles.box}>
      <View style={iconStyles.powerRing} />
      <View style={iconStyles.powerStick} />
    </View>
  );
}

/** 와이파이 - 아래 반이 잘린 동심원 2개 + 점. 원 중심을 랩 하단 중앙에 두고
 * overflow hidden 으로 아랫반원을 잘라 아크만 남긴다. */
function WifiIcon() {
  return (
    <View style={iconStyles.box}>
      <View style={iconStyles.wifiClip}>
        <View style={iconStyles.wifiArcOuter} />
        <View style={iconStyles.wifiArcInner} />
        <View style={iconStyles.wifiDot} />
      </View>
    </View>
  );
}

/** 재시작 - 오른쪽 위가 트인 링 + 그 끝의 화살촉(45° 사각형). */
function ReplugIcon() {
  return (
    <View style={iconStyles.box}>
      <View style={iconStyles.replugRing} />
      <View style={iconStyles.replugTip} />
    </View>
  );
}

/** QR 스캔 - 네 모서리 브래킷 + 중앙 점. */
function QrIcon() {
  return (
    <View style={iconStyles.box}>
      {(['tl', 'tr', 'bl', 'br'] as const).map((c) => (
        <View key={c} style={[iconStyles.qrCorner, iconStyles[`qrCorner_${c}`]]} />
      ))}
      <View style={iconStyles.qrDot} />
    </View>
  );
}

interface Props {
  /** 주면 QR 등록 안내 행 + "WiFi 등록하기" 버튼이 붙는다 (프로비저닝 스펙 §4). */
  onRegisterWifi?: () => void;
}

export default function ConnectionGuideCard({ onRegisterWifi }: Props = {}): React.JSX.Element {
  // 행별 스태거 등장 (opacity/transform 뿐이라 native driver). 카드가 뜰 때
  // 한 번만 - 재렌더마다 흔들면 장식이다.
  const enters = useRef(GUIDE_ITEMS.map(() => new Animated.Value(0))).current;
  useEffect(() => {
    Animated.stagger(
      90,
      enters.map((v) =>
        Animated.timing(v, {
          toValue: 1,
          duration: 280,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ),
    ).start();
  }, [enters]);

  const items = onRegisterWifi ? GUIDE_ITEMS : GUIDE_ITEMS.filter((it) => it.key !== 'qr');

  return (
    <View style={styles.card} testID="connection-guide-card">
      {items.map(({ key, text, Icon }, i) => (
        <Animated.View
          key={key}
          style={[
            styles.row,
            {
              opacity: enters[i],
              transform: [
                { translateY: enters[i].interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
              ],
            },
          ]}
        >
          <View style={styles.iconTile}>
            <Icon />
          </View>
          <Text style={styles.text}>{text}</Text>
        </Animated.View>
      ))}
      {onRegisterWifi && (
        <Pressable
          accessibilityRole="button"
          testID="wifi-register-button"
          onPress={onRegisterWifi}
          style={({ pressed }) => [styles.registerBtn, pressed && { opacity: 0.55 }]}
        >
          <Text style={styles.registerBtnText}>WiFi 등록하기</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: SURFACE_COLOR,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    borderRadius: 20,
    paddingVertical: 20,
    paddingHorizontal: 20,
    gap: 16,
    // 랜드스케이프 폰에서 stretch 는 700pt 를 넘게 퍼진다 - 읽는 폭으로 제한
    // (실기기 피드백 2026-08-11: 옆으로 너무 넓다).
    alignSelf: 'center',
    width: '100%',
    maxWidth: 420,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconTile: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: 'rgba(54, 155, 117, 0.10)', // GREEN 10% 틴트
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
    color: INK,
    fontFamily: FONT,
  },
  registerBtn: {
    marginTop: 4,
    alignSelf: 'stretch',
    backgroundColor: GREEN,
    borderRadius: 14,
    minHeight: 48, // 터치 타깃 최소 44pt+
    alignItems: 'center',
    justifyContent: 'center',
  },
  registerBtnText: { fontSize: 15, fontWeight: '700', fontFamily: FONT, color: '#FFFFFF' },
});

const iconStyles = StyleSheet.create({
  box: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  powerRing: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: GREEN,
    borderTopColor: 'transparent', // 막대가 지나는 자리
    marginTop: 3,
  },
  powerStick: {
    position: 'absolute',
    top: 0,
    width: 2,
    height: 9,
    borderRadius: 1,
    backgroundColor: GREEN,
  },
  // 원 중심 = 랩 하단 중앙(10, 16). 랩 밖(아랫반원)은 hidden 으로 잘린다.
  wifiClip: {
    width: 20,
    height: 16,
    overflow: 'hidden',
    marginTop: 3,
  },
  wifiArcOuter: {
    position: 'absolute',
    left: 0,
    top: 6,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: GREEN,
  },
  wifiArcInner: {
    position: 'absolute',
    left: 4,
    top: 10,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: GREEN,
  },
  wifiDot: {
    position: 'absolute',
    left: 8,
    top: 13,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: GREEN,
  },
  replugRing: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: GREEN,
    borderTopColor: 'transparent', // 트인 구간 - 화살촉이 이어받는다
    transform: [{ rotate: '45deg' }],
  },
  replugTip: {
    position: 'absolute',
    top: 2,
    right: 1,
    width: 5,
    height: 5,
    backgroundColor: GREEN,
    transform: [{ rotate: '45deg' }],
  },
  qrCorner: {
    position: 'absolute',
    width: 7,
    height: 7,
    borderColor: GREEN,
  },
  qrCorner_tl: { top: 1, left: 1, borderTopWidth: 2, borderLeftWidth: 2 },
  qrCorner_tr: { top: 1, right: 1, borderTopWidth: 2, borderRightWidth: 2 },
  qrCorner_bl: { bottom: 1, left: 1, borderBottomWidth: 2, borderLeftWidth: 2 },
  qrCorner_br: { bottom: 1, right: 1, borderBottomWidth: 2, borderRightWidth: 2 },
  qrDot: { width: 6, height: 6, borderRadius: 1.5, backgroundColor: GREEN },
});

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import QrCodeView from '../components/QrCodeView';
import { buildWifiQrPayload, buildWifiQrMatrix } from '../../utils/wifiQr';
import { fetchCurrentSsid } from '../../utils/currentSsid';
import { loadWifiCreds, saveWifiCreds } from '../../utils/wifiCredsStore';
import { usePiConnection } from '../hooks/usePiConnection';
import {
  APP_BACKGROUND_COLOR,
  GREEN,
  SURFACE_COLOR,
  SURFACE_BORDER_COLOR,
  INK,
  INK_MUTED,
  FONT,
  ON_ACCENT,
} from '../../theme';

/** WiFi 등록 화면 (UX 2차 스펙 §화면 구조). 좌 폼 + 우 대형 QR 단일 화면.
 * QR 은 생성 후 입력 수정에 라이브 반응 - 입력이 비면 자리 안내로 돌아간다.
 * 성공 확인은 별도 폴링 없이 connectionMonitor connected 엣지 재사용.
 * 비밀번호 자동 추출은 iOS/Android 모두 불가(플랫폼 제약) - 붙여넣기 안내와
 * 저장·복원으로 마찰만 줄인다. */
const CLOSE_AFTER_SUCCESS_MS = 1500;

/** QR 이전 자리 안내의 사용 순서. 실제 시도 순서라 번호가 정보다. */
const QR_STEPS = [
  '스마트폰을 와이파이에 연결하거나 휴대용 핫스팟을 켜줘',
  '비바 전원을 켜줘',
  'QR 코드를 만들어 비바에게 보여줘',
];

const PSK_HELPER = Platform.select({
  ios: 'iPhone 설정 > Wi-Fi > ⓘ > 비밀번호에서 복사해 붙여넣을 수 있어',
  default: '공유기 스티커나 와이파이 설정에서 비밀번호를 확인해줘',
});

interface Props {
  onClose: () => void;
}

/** 로봇 카메라 뷰파인더 코너 틱 - 이 화면의 시그니처. 부모는 position 기준. */
function CornerTicks(): React.JSX.Element {
  return (
    <>
      <View pointerEvents="none" style={[styles.tick, styles.tickTL]} />
      <View pointerEvents="none" style={[styles.tick, styles.tickTR]} />
      <View pointerEvents="none" style={[styles.tick, styles.tickBL]} />
      <View pointerEvents="none" style={[styles.tick, styles.tickBR]} />
    </>
  );
}

export default function WifiProvisionScreen({ onClose }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [ssid, setSsid] = useState('');
  const [psk, setPsk] = useState('');
  const [showPsk, setShowPsk] = useState(false);
  // 'saved' = 지난 입력 복원, 'ssid' = 현재 WiFi 이름 자동 채움
  const [prefill, setPrefill] = useState<'saved' | 'ssid' | null>(null);
  const [showQr, setShowQr] = useState(false);
  const status = usePiConnection();
  // 성공은 "미연결→연결" 엣지만. 이미 연결된 채 열린 재등록 화면에서 레벨
  // 판정을 쓰면 QR을 만들자마자 성공으로 닫혀버린다(2026-08-12 실기기).
  // ref 는 이전 렌더 사이클의 effect 에서 갱신되므로 엣지 렌더 시점엔 이미
  // "끊김을 봤다"가 반영돼 있다.
  const sawDisconnectRef = useRef(status !== 'connected');
  useEffect(() => {
    if (status !== 'connected') sawDisconnectRef.current = true;
  }, [status]);
  const succeeded = showQr && status === 'connected' && sawDisconnectRef.current;

  // 프리필: 저장분(비번까지) > 현재 WiFi SSID > 없음. 사용자가 먼저
  // 타이핑했으면 덮어쓰지 않는다. 순차 체인이라 둘이 경합하지 않는다.
  const ssidTouchedRef = useRef(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const saved = await loadWifiCreds();
      if (!alive) return;
      if (saved) {
        if (ssidTouchedRef.current) return;
        setSsid(saved.ssid);
        setPsk((p) => p || saved.psk);
        setPrefill('saved');
        return;
      }
      const s = await fetchCurrentSsid();
      if (!alive || !s || ssidTouchedRef.current) return;
      setSsid(s);
      setPrefill('ssid');
    })();
    return () => {
      alive = false;
    };
  }, []);

  // HomeScreen이 넘기는 onClose는 인라인 콜백이라 리렌더마다 새 레퍼런스 -
  // deps에 직접 넣으면 타이머가 계속 리셋된다. ref로 최신 값만 읽는다.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!succeeded) return;
    const t = setTimeout(() => onCloseRef.current(), CLOSE_AFTER_SUCCESS_MS);
    return () => clearTimeout(t);
  }, [succeeded]);

  // 생성 후엔 입력에 라이브 반응. 입력이 비면 null - 자리 안내로 복귀.
  const matrix = useMemo(
    () =>
      showQr && ssid.trim() && psk ? buildWifiQrMatrix(buildWifiQrPayload(ssid, psk)) : null,
    [showQr, ssid, psk],
  );

  // 로봇 카메라 인식 대비 - 세로 공간이 허락하는 최대 크기 (상한 320).
  const qrSize = Math.max(200, Math.min(320, height - 120));
  const frameSize = qrSize + 28; // 코너 틱 프레임 패딩 14*2

  const makeDisabled = !ssid.trim() || !psk;

  return (
    <View style={[styles.fill, { paddingTop: Math.max(insets.top + 12, 18) }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="닫기"
        testID="wifi-provision-close"
        onPress={onClose}
        style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.55 }]}
      >
        <Text style={styles.closeGlyph}>✕</Text>
      </Pressable>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <View style={styles.split}>
          <View style={styles.formPane}>
            <Text style={styles.title}>비바를 새 와이파이에 연결해요</Text>
            <Text style={styles.sub}>
              {prefill === 'saved'
                ? '지난번 입력을 불러왔어'
                : prefill === 'ssid'
                  ? '지금 연결된 와이파이 이름을 가져왔어'
                  : '연결할 와이파이 이름과 비밀번호를 입력해줘'}
            </Text>
            {Platform.OS === 'android' && (
              <View style={styles.shortcutCard}>
                <Text style={styles.shortcutText}>
                  더 빠른 방법 — Wi-Fi 설정의 QR 공유 화면을 비바에게 바로 보여줘도 돼
                </Text>
                <Pressable
                  accessibilityRole="button"
                  testID="wifi-open-settings"
                  onPress={() => {
                    Linking.sendIntent('android.settings.WIFI_SETTINGS').catch(() => {
                      // 일부 제조사 롬에서 인텐트가 없을 수 있다 - 조용히 무시.
                    });
                  }}
                  style={({ pressed }) => [styles.shortcutBtn, pressed && { opacity: 0.55 }]}
                >
                  <Text style={styles.shortcutBtnText}>Wi-Fi 설정 열기</Text>
                </Pressable>
              </View>
            )}
            <TextInput
              style={styles.input}
              placeholder="와이파이 이름 (SSID)"
              placeholderTextColor={INK_MUTED}
              autoCapitalize="none"
              autoCorrect={false}
              value={ssid}
              onChangeText={(t) => {
                ssidTouchedRef.current = true;
                setSsid(t);
              }}
            />
            <View style={styles.pskRow}>
              <TextInput
                style={[styles.input, styles.pskInput]}
                placeholder="비밀번호"
                placeholderTextColor={INK_MUTED}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry={!showPsk}
                testID="wifi-psk"
                value={psk}
                onChangeText={setPsk}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={showPsk ? '비밀번호 가리기' : '비밀번호 보기'}
                testID="wifi-psk-toggle"
                onPress={() => setShowPsk((v) => !v)}
                style={({ pressed }) => [styles.pskToggle, pressed && { opacity: 0.55 }]}
              >
                <Text style={styles.pskToggleText}>{showPsk ? '가리기' : '보기'}</Text>
              </Pressable>
            </View>
            <Text style={styles.helper}>{PSK_HELPER}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: makeDisabled }}
              disabled={makeDisabled}
              testID="wifi-qr-make"
              onPress={() => {
                setShowQr(true);
                void saveWifiCreds({ ssid, psk });
              }}
              style={({ pressed }) => [
                styles.makeBtn,
                makeDisabled && { opacity: 0.38 },
                pressed && { opacity: 0.55 },
              ]}
            >
              <Text style={styles.makeBtnText}>QR 만들기</Text>
            </Pressable>
          </View>

          <View style={styles.qrPane}>
            {succeeded ? (
              <View style={[styles.qrFrame, { width: frameSize, height: frameSize }]}>
                <CornerTicks />
                <View style={styles.successBadge}>
                  <Text style={styles.successCheck}>✓</Text>
                </View>
                <Text style={styles.successTitle}>비바가 연결됐어!</Text>
                <Text style={styles.sub}>이제 비바랑 같이 공부할 수 있어</Text>
              </View>
            ) : matrix ? (
              <>
                <View style={[styles.qrFrame, { width: frameSize, height: frameSize }]}>
                  <CornerTicks />
                  <QrCodeView matrix={matrix} size={qrSize} />
                </View>
                <Text style={styles.qrHint}>화면 밝기 최대 · 비바에게 15~25cm 거리로 보여줘</Text>
              </>
            ) : (
              <View style={[styles.placeholder, { width: frameSize, height: frameSize }]}>
                {QR_STEPS.map((text, i) => (
                  <View key={text} style={styles.stepRow}>
                    <View style={styles.stepNum}>
                      <Text style={styles.stepNumText}>{i + 1}</Text>
                    </View>
                    <Text style={styles.stepText}>{text}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: APP_BACKGROUND_COLOR,
    zIndex: 60, // topRightRow(40)·SolveModeToggle 위
  },
  flex: { flex: 1 },
  split: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 36,
    paddingHorizontal: 28,
  },
  formPane: {
    flexShrink: 1,
    width: '100%',
    maxWidth: 380,
    gap: 12,
  },
  closeBtn: {
    position: 'absolute',
    top: 18,
    right: 20,
    zIndex: 1,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeGlyph: { fontSize: 20, color: INK_MUTED, fontFamily: FONT },
  title: {
    fontSize: 22,
    fontWeight: '700',
    fontFamily: FONT,
    color: INK,
  },
  sub: {
    fontSize: 14,
    lineHeight: 21,
    fontFamily: FONT,
    color: INK_MUTED,
  },
  input: {
    alignSelf: 'stretch',
    backgroundColor: SURFACE_COLOR,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    borderRadius: 14,
    paddingHorizontal: 16,
    minHeight: 48, // 터치 타깃 44pt+
    paddingVertical: 12,
    fontSize: 16,
    fontFamily: FONT,
    color: INK,
  },
  pskRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pskInput: { flex: 1, alignSelf: 'auto' },
  pskToggle: {
    minHeight: 48,
    minWidth: 56,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    backgroundColor: SURFACE_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  pskToggleText: { fontSize: 13, fontFamily: FONT, color: INK_MUTED },
  helper: {
    fontSize: 12,
    lineHeight: 17,
    fontFamily: FONT,
    color: INK_MUTED,
    marginTop: -4,
    marginLeft: 4,
  },
  makeBtn: {
    alignSelf: 'stretch',
    backgroundColor: GREEN,
    borderRadius: 14,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  makeBtnText: { fontSize: 16, fontWeight: '700', fontFamily: FONT, color: ON_ACCENT },
  shortcutCard: {
    alignSelf: 'stretch',
    backgroundColor: 'rgba(54, 155, 117, 0.10)', // GREEN 10% 틴트
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  shortcutText: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: FONT,
    color: INK,
  },
  shortcutBtn: {
    minHeight: 44,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  shortcutBtnText: { fontSize: 14, fontWeight: '700', fontFamily: FONT, color: GREEN },
  qrPane: {
    alignItems: 'center',
    gap: 10,
  },
  // 시그니처: 로봇 카메라 뷰파인더 프레임. QR 은 흰 카드(QrCodeView 자체 배경).
  qrFrame: {
    padding: 14,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  tick: { position: 'absolute', width: 26, height: 26, borderColor: GREEN },
  tickTL: { top: 0, left: 0, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 10 },
  tickTR: { top: 0, right: 0, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 10 },
  tickBL: { bottom: 0, left: 0, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 10 },
  tickBR: { bottom: 0, right: 0, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 10 },
  placeholder: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: SURFACE_BORDER_COLOR,
    borderRadius: 22,
    justifyContent: 'center',
    padding: 22,
    gap: 14,
  },
  qrHint: {
    fontSize: 12,
    fontFamily: FONT,
    color: INK_MUTED,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  stepNum: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(54, 155, 117, 0.10)', // GREEN 10% 틴트 (가이드 카드와 동일)
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumText: { fontSize: 14, fontWeight: '700', fontFamily: FONT, color: GREEN },
  stepText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: FONT,
    color: INK,
  },
  successBadge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: GREEN,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successCheck: { fontSize: 30, fontWeight: '700', color: ON_ACCENT, fontFamily: FONT },
  successTitle: {
    fontSize: 20,
    fontWeight: '700',
    fontFamily: FONT,
    color: INK,
    marginTop: 4,
  },
});

/**
 * 의도파악 화면. 로직은 전부 useIntentLoop — 여기는 렌더와 로봇 오디오 sink
 * 등록(ConversationScreen 과 동일 패턴)만 한다.
 *
 * 레이아웃은 ConversationScreen 디바이스 모드와 동일 문법(2026-08-12 피드백):
 * 크림 배경, 판서는 중앙, 하단 상태행에 {자막 | 자막+마이크미터 | 자막+로딩닷}
 * 중 정확히 하나. 자막을 중앙에 크게 띄우지 않는다(2026-08-11 실기기 피드백).
 * 눈은 로봇 얼굴 담당이라 앱 화면엔 없다(D-42).
 *
 * 크롬(2026-08-12 피드백): 좌상단 홈 버튼(onExit), 우하단 마이크·키보드 버튼.
 * 정답 토글만 뺀 ConversationScreen 과 같은 배치. 키보드 입력은 useIntentLoop
 * 의 submitText 로 청취 턴에 주입된다(음성 대신 타이핑).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIntentLoop } from '../hooks/useIntentLoop';
import type { UseIntentLoopOptions } from '../hooks/useIntentLoop';
import { setAudioSink } from '../../services/tts.service';
import { playAudioOnPi, stopPiPlayback } from '../services/piBridge.service';
import LoadingDots from '../../components/LoadingDots';
import MicLevelIndicator from '../../components/MicLevelIndicator';
import { SURFACE_COLOR, SURFACE_BORDER_COLOR } from '../../services/board.service';
import { APP_BACKGROUND_COLOR, FONT, INK, INK_MUTED, MOTION } from '../../theme';

type Props = Omit<
  UseIntentLoopOptions,
  'deps' | 'pollIntervalMs' | 'noSpeechTimeoutMs' | 'captureDelayMs'
> & { robotAudio: boolean };

export default function IntentScreen({ robotAudio, ...options }: Props) {
  const {
    begin,
    phase,
    subtitle,
    boardImageBase64,
    boardAsset,
    micLevel,
    inputMode,
    switchToText,
    switchToVoice,
    submitText,
  } = useIntentLoop(options);
  const insets = useSafeAreaInsets();
  const [inputText, setInputText] = useState('');
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const safeTop = Math.max(insets.top + 12, 18); // ConversationScreen 과 동일 계산
  const safeBottom = keyboardHeight > 0 ? 12 : Math.max(insets.bottom + 12, 24);

  // 판서/개념 이미지 페이드인 — 이미지 정체성(asset 번호 또는 base64)이
  // 바뀔 때마다 새로 등장하는 느낌을 준다(과제 3, 2026-08-13).
  const boardImageKey = boardAsset != null ? `asset:${boardAsset}` : (boardImageBase64 ?? '');
  const boardAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!boardImageKey) return;
    boardAnim.setValue(0);
    const anim = Animated.timing(boardAnim, {
      toValue: 1,
      duration: MOTION.slow,
      useNativeDriver: true,
    });
    anim.start();
    // 진행 중 언마운트되면 애니 타이머가 남아 unmount 뒤(특히 테스트 환경)
    // 콜백이 죽은 스코프를 건드리는 걸 막는다.
    return () => anim.stop();
  }, [boardImageKey, boardAnim]);

  // 디바이스 연동판: 스피커는 파이 전용, 실패해도 폰 폴백 없음(자막이 전달).
  // ConversationScreen 의 sink 효과와 동일 — 핸드오프 시 그 화면이 재등록한다.
  useEffect(() => {
    setAudioSink(
      robotAudio
        ? {
            play: async (b64, onStarted) => {
              try {
                await playAudioOnPi(b64, onStarted);
              } catch (err) {
                console.warn('[IntentScreen] Pi playback failed - staying silent:', err);
              }
            },
            stop: stopPiPlayback,
          }
        : null,
    );
    return () => setAudioSink(null);
  }, [robotAudio]);

  useEffect(() => {
    begin();
    // begin 은 startedRef 가드가 있는 1회용 — 마운트 시 한 번만.
  }, [begin]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (e) =>
      setKeyboardHeight(e.endCoordinates.height),
    );
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const listening = phase === 'listening';
  const busy = phase === 'thinking' || phase === 'analyzing';

  // 하단 상태행 페이드 — ConversationScreen 의 subtitleAnim/statusSlotKey 와
  // 동일 문법(2026-08-13 UX 통일): {청취, 생각중, 자막} 중 정확히 하나를
  // 보여주고, 그 내용(kind+텍스트)이 바뀔 때마다 opacity(+subtitle 만
  // translateY)로 다시 페이드인한다.
  type StatusSlot =
    | { kind: 'listening'; subtitle?: string }
    | { kind: 'thinking'; subtitle?: string }
    | { kind: 'subtitle'; text: string }
    | { kind: 'none' };
  const statusSlot: StatusSlot = listening
    ? { kind: 'listening', subtitle: subtitle || undefined }
    : busy
      ? { kind: 'thinking', subtitle: subtitle || undefined }
      : subtitle
        ? { kind: 'subtitle', text: subtitle }
        : { kind: 'none' };
  const statusSlotKey = `${statusSlot.kind}${statusSlot.kind === 'subtitle' ? `|${statusSlot.text}` : ''}${(statusSlot.kind === 'listening' || statusSlot.kind === 'thinking') && statusSlot.subtitle ? `|${statusSlot.subtitle}` : ''}`;
  const subtitleAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    subtitleAnim.setValue(0);
    const anim = Animated.timing(subtitleAnim, {
      toValue: 1,
      duration: MOTION.base,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [statusSlotKey, subtitleAnim]);

  const handleKeyboardTrigger = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    switchToText();
  }, [switchToText]);

  const handleBackToVoice = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    Keyboard.dismiss();
    switchToVoice();
  }, [switchToVoice]);

  const handleSubmit = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    submitText(text);
    setInputText('');
  }, [inputText, submitText]);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={undefined}>
      <View style={styles.container}>
        {boardAsset || boardImageBase64 ? (
          <Animated.Image
            style={[styles.board, { opacity: boardAnim }]}
            resizeMode="contain"
            source={boardAsset ?? { uri: `data:image/png;base64,${boardImageBase64}` }}
          />
        ) : null}

        {/* 좌상단 홈 버튼 — ConversationScreen 의 backButton 과 동일(미니멀 셰브런). */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="홈으로 이동"
          testID="intent-back-to-home-button"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={({ pressed }) => [
            styles.backButton,
            { top: safeTop },
            pressed && styles.backButtonPressed,
          ]}
          onPress={() => options.onExit()}
        >
          <Text style={styles.backButtonText}>‹</Text>
        </Pressable>

        {/* 하단 상태행 — ConversationScreen 의 statusRow 와 동일 배치·타이포·
         * 페이드 문법(opacity, subtitle 만 translateY 15→0). */}
        {statusSlot.kind === 'listening' && (
          <Animated.View
            style={[styles.statusRow, { bottom: safeBottom, opacity: subtitleAnim }]}
            pointerEvents="none"
          >
            {statusSlot.subtitle ? (
              <Text style={styles.subtitleTextSmall} numberOfLines={2}>
                {statusSlot.subtitle}
              </Text>
            ) : null}
            <MicLevelIndicator level={micLevel} />
          </Animated.View>
        )}

        {statusSlot.kind === 'thinking' && (
          <Animated.View
            style={[styles.statusRow, { bottom: safeBottom, opacity: subtitleAnim }]}
            pointerEvents="none"
          >
            {statusSlot.subtitle ? (
              <Text style={styles.subtitleTextSmall} numberOfLines={2}>
                {statusSlot.subtitle}
              </Text>
            ) : null}
            <LoadingDots />
          </Animated.View>
        )}

        {statusSlot.kind === 'subtitle' && (
          <Animated.View
            style={[
              styles.statusRow,
              { bottom: safeBottom },
              {
                opacity: subtitleAnim,
                transform: [
                  {
                    translateY: subtitleAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [15, 0],
                    }),
                  },
                ],
              },
            ]}
            pointerEvents="none"
          >
            <Text style={styles.subtitleText} numberOfLines={3}>
              {statusSlot.text}
            </Text>
          </Animated.View>
        )}

        {/* 음성 모드: 우하단 마이크(청취 상태 표시 + 탭 시 무응답 타이머 리셋)
         * 와 그 왼쪽 키보드 트리거. ConversationScreen 과 같은 위치값. */}
        {inputMode === 'voice' && (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="키보드로 입력"
              testID="intent-keyboard-trigger"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={[styles.keyboardTriggerButton, { bottom: safeBottom }]}
              onPress={handleKeyboardTrigger}
            >
              <Image
                source={require('../../assets/icons/keyboard.png')}
                style={styles.keyboardTriggerIcon}
              />
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="마이크 입력"
              testID="intent-mic-button"
              onPress={switchToVoice}
              style={({ pressed }) => [
                listening ? styles.micActive : styles.micInactive,
                { bottom: safeBottom },
                pressed && styles.micPressed,
              ]}
            >
              <Image
                source={require('../../assets/icons/mic.png')}
                style={[
                  styles.micIcon,
                  listening ? styles.micIconListening : styles.micIconInactive,
                ]}
              />
            </Pressable>
          </>
        )}

        {/* 키보드 모드: 텍스트 입력 바 (ConversationScreen 과 동일 구성). */}
        {inputMode === 'text' && (
          <View style={[styles.textInputBar, { bottom: safeBottom + keyboardHeight }]}>
            <Pressable
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              onPress={handleBackToVoice}
              style={styles.inputLeftButton}
            >
              <Image source={require('../../assets/icons/mic.png')} style={styles.inputLeftIcon} />
            </Pressable>

            <TextInput
              autoFocus={true}
              placeholder="여기에 궁금한 걸 적어줘..."
              placeholderTextColor="rgba(43, 41, 38, 0.5)"
              value={inputText}
              onChangeText={setInputText}
              onSubmitEditing={handleSubmit}
              style={styles.textInput}
              returnKeyType="send"
              testID="intent-text-input"
            />

            <Pressable
              disabled={inputText.trim().length === 0}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              onPress={handleSubmit}
              style={[
                styles.inputRightButton,
                inputText.trim().length === 0 && styles.inputRightButtonDisabled,
              ]}
            >
              <Image
                source={require('../../assets/icons/send.png')}
                style={[
                  styles.sendIcon,
                  inputText.trim().length === 0 ? styles.sendIconDisabled : styles.sendIconActive,
                ]}
              />
            </Pressable>
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: APP_BACKGROUND_COLOR,
  },
  board: {
    flex: 1,
    width: '100%',
    // 하단 상태행과 겹치지 않게 아래를 비워둔다 (statusRow 는 absolute).
    marginBottom: 96,
  },
  // 이하 ConversationScreen 의 statusRow/subtitleText/subtitleTextSmall 과
  // 동일 값 — 두 화면이 같은 문법으로 보이게 하는 것이 목적이라 값을 맞춘다.
  statusRow: {
    position: 'absolute',
    left: 136,
    right: 136,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 30,
  },
  subtitleText: {
    fontSize: 16,
    color: INK,
    fontWeight: '600',
    fontFamily: FONT,
    textAlign: 'center',
    lineHeight: 22,
    textShadowColor: 'rgba(255, 255, 255, 0.95)',
    textShadowOffset: { width: 0, height: 1.5 },
    textShadowRadius: 3,
  },
  subtitleTextSmall: {
    fontSize: 12,
    color: INK_MUTED,
    fontWeight: '500',
    fontFamily: FONT,
    textAlign: 'center',
    lineHeight: 16,
    marginBottom: 4,
    textShadowColor: 'rgba(255, 255, 255, 0.95)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  // 좌상단 홈 버튼 — ConversationScreen.backButton 과 동일.
  backButton: {
    position: 'absolute',
    left: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 40,
  },
  backButtonPressed: {
    // 눌림 피드백 통일값 (2026-08-13 UX 통일, MOTION 과 짝을 이루는 상수).
    opacity: 0.55,
  },
  backButtonText: {
    fontSize: 30,
    fontWeight: '400',
    color: '#2B2926',
    lineHeight: 34,
  },
  // 우하단 마이크 — CharacterView 의 micActive/micInactive 와 동일.
  micActive: {
    position: 'absolute',
    right: 22,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(54, 155, 117, 0.15)',
    borderWidth: 1.5,
    borderColor: '#369B75',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  micInactive: {
    position: 'absolute',
    right: 22,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: SURFACE_COLOR,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  micPressed: {
    opacity: 0.55,
  },
  micIcon: {
    width: 24,
    height: 24,
  },
  micIconListening: {
    tintColor: '#369B75',
  },
  micIconInactive: {
    tintColor: '#2B2926',
  },
  // 마이크 왼쪽 키보드 트리거 — ConversationScreen.keyboardTriggerButton 과 동일.
  keyboardTriggerButton: {
    position: 'absolute',
    right: 78,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: SURFACE_COLOR,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  keyboardTriggerIcon: {
    width: 24,
    height: 24,
    tintColor: '#2B2926',
  },
  // 텍스트 입력 바 — ConversationScreen.textInputBar 계열과 동일.
  textInputBar: {
    position: 'absolute',
    left: '10%',
    right: '10%',
    backgroundColor: SURFACE_COLOR,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: SURFACE_BORDER_COLOR,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    height: 44,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
    zIndex: 20,
  },
  textInput: {
    flex: 1,
    fontSize: 15,
    color: '#2B2926',
    fontFamily: 'Pretendard',
    paddingHorizontal: 12,
    height: '100%',
  },
  inputLeftButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(54, 155, 117, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  inputLeftIcon: {
    width: 20,
    height: 20,
    tintColor: '#369B75',
  },
  inputRightButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#369B75',
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputRightButtonDisabled: {
    backgroundColor: 'rgba(43, 41, 38, 0.08)',
  },
  sendIcon: {
    width: 18,
    height: 18,
  },
  sendIconActive: {
    tintColor: '#FFFFFF',
  },
  sendIconDisabled: {
    tintColor: 'rgba(43, 41, 38, 0.3)',
  },
});

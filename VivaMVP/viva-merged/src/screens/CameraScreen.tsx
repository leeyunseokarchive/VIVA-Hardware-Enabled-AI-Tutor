import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import {
  Camera,
  useCameraDevice,
  useCameraDevices,
  useCameraFormat,
  useCameraPermission,
} from 'react-native-vision-camera';
import * as ImagePicker from 'expo-image-picker';
import { analyzeImage } from '../services/gemini.service';
import { evaluateCaptureResult } from '../utils/captureDecision';
import EyeAnimation from '../components/EyeAnimation';
import LoadingDots from '../components/LoadingDots';
import { APP_BACKGROUND_COLOR, MONO, FONT } from '../theme';
import type { GeminiTutoringResponse, TutoringSession } from '../types/Tutoring';
import type { TokenUsage } from '../types/ApiUsage';

// Minimalist Vector Icons (CSS-only)
const CloseIcon = () => (
  <View style={styles.iconWrapper}>
    <View style={[styles.closeLine, { transform: [{ rotate: '45deg' }] }]} />
    <View style={[styles.closeLine, { transform: [{ rotate: '-45deg' }] }]} />
  </View>
);

const AlbumIcon = () => (
  <View style={styles.iconWrapper}>
    <View style={styles.albumFrameBack} />
    <View style={styles.albumFrameFront} />
  </View>
);

const UndoIcon = () => (
  <View style={styles.iconWrapper}>
    <View
      style={{ position: 'absolute', width: 14, height: 2, backgroundColor: '#FFFFFF', left: 5 }}
    />
    <View
      style={{
        position: 'absolute',
        width: 7,
        height: 2,
        backgroundColor: '#FFFFFF',
        transform: [{ rotate: '-45deg' }],
        left: 4,
        top: 8,
      }}
    />
    <View
      style={{
        position: 'absolute',
        width: 7,
        height: 2,
        backgroundColor: '#FFFFFF',
        transform: [{ rotate: '45deg' }],
        left: 4,
        bottom: 8,
      }}
    />
  </View>
);

const CheckIcon = () => (
  <View style={styles.iconWrapper}>
    <View
      style={[
        styles.checkLine,
        { width: 2, height: 8, transform: [{ rotate: '-45deg' }], left: 6, top: 11 },
      ]}
    />
    <View
      style={[
        styles.checkLine,
        { width: 2, height: 14, transform: [{ rotate: '45deg' }], left: 13, top: 5 },
      ]}
    />
  </View>
);

/** 기계적인 "분석 중" 대신 자연스러운 한마디를 골라 보여준다. 매 촬영/분석
 * 시작 시점에 한 번만 뽑는다(재렌더마다 바뀌면 산만해 보임).
 *
 * 1인칭 발화체("그래! 이 문제 한번 살펴볼게.")였는데 이 화면엔 TTS 가 없어서,
 * 비바가 말한 것처럼 읽히지만 실제로는 아무 소리도 안 났다. 여기서 소리를
 * 내면 대화 화면의 TTS 와 겹쳐 서로 자른다 - 발화체를 버리고 로딩 라벨답게
 * 바꾼다 (LoadingDots 의 label 로 들어간다). */
const ANALYZING_PHRASES = ['문제 살펴보는 중', '문제 확인하는 중', '어떤 문제인지 보는 중'];

function pickAnalyzingPhrase(): string {
  return ANALYZING_PHRASES[Math.floor(Math.random() * ANALYZING_PHRASES.length)];
}

interface CameraScreenProps {
  systemPrompt: string;
  /** Session context to send with the captured photo (TRD §2.2). */
  session: TutoringSession;
  /** Called once analyzeImage() returns a usable (non-retake) result. The
   * response carries `.usage` (token usage for this call) for the caller to
   * seed the session's running API-cost total. */
  onAnalyzed: (
    response: GeminiTutoringResponse & { usage?: TokenUsage },
    imageBase64: string,
  ) => void;
  /** Called when the student backs out of the camera screen entirely
   * (e.g. cancel), returning AppState to idle. */
  onCancel?: () => void;
  /** What the student said before this photo was requested (mic-first
   * flow), if anything - passed through to analyzeImage() so Gemini knows
   * why the photo was taken. */
  initialQuestion?: string;
  /** "바로 정답" toggle state - passed through to analyzeImage() purely to
   * skip its image-hash cache (the cache has no awareness of which
   * systemPrompt/mode produced a cached response, so caching here could
   * serve a stale normal-mode hint response back after toggling direct
   * solve on for the same photo). `systemPrompt` above is already built
   * with directSolveMode baked in - this prop does not affect prompt
   * content, only cache behavior. */
  directSolveMode?: boolean;
  /** false = 디바이스 모드: 눈은 로봇 얼굴에 있으니 앱은 분석 중 문구만 보여준다. */
  showEyes?: boolean;
}

type CaptureStatus = 'idle' | 'capturing' | 'analyzing' | 'retake';

export default function CameraScreen({
  systemPrompt,
  session,
  onAnalyzed,
  onCancel,
  initialQuestion,
  directSolveMode,
  showEyes = true,
}: CameraScreenProps): React.JSX.Element {
  const camera = useRef<Camera>(null);
  // Primary pick: the default back device. Fallback: any device whose
  // position is 'back', then any device at all - some Samsung multi-lens
  // phones fail the default pick depending on vision-camera version.
  const backDevice = useCameraDevice('back');
  const allDevices = useCameraDevices();
  const { hasPermission, requestPermission } = useCameraPermission();

  const device = backDevice ?? allDevices.find((d) => d.position === 'back') ?? allDevices[0];

  useEffect(() => {
    if (!device) {
      console.warn(
        '[CameraScreen] no camera device found. hasPermission=',
        hasPermission,
        'hook devices:',
        JSON.stringify(allDevices.map((d) => ({ id: d.id, position: d.position, name: d.name }))),
      );
    } else {
      console.log('[CameraScreen] using camera device:', device.id, device.position, device.name);
    }
  }, [device, allDevices, hasPermission]);
  // Cap photo resolution. Modern phones default to their full sensor
  // resolution (50MP+), whose base64 payload is tens of MB - large enough
  // for the Gemini vision request to be rejected or time out, surfacing as
  // "문제를 인식하지 못했습니다" only on the camera path (the gallery path
  // already compresses with quality 0.7). ~2MP is plenty for problem OCR.
  const format = useCameraFormat(device, [{ photoResolution: { width: 1920, height: 1080 } }]);
  const [permissionRequested, setPermissionRequested] = useState(false);

  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [retakeMessage, setRetakeMessage] = useState<string | undefined>();
  const [capturedImages, setCapturedImages] = useState<string[]>([]);
  const [analyzingPhrase, setAnalyzingPhrase] = useState(ANALYZING_PHRASES[0]);

  const handleRequestPermission = useCallback(async () => {
    setPermissionRequested(true);
    await requestPermission();
  }, [requestPermission]);

  // Shared by both entry points: the auto-analyze-after-one-shutter-photo
  // flow (handleCapture below) and the manual "확인" checkmark (kept for the
  // multi-page thumbnail flow, if a student adds more than one photo before
  // confirming). Takes the image list explicitly instead of reading
  // `capturedImages` from state, so the caller right after `setCapturedImages`
  // doesn't have to wait a render for the state to settle first.
  //
  // Declared BEFORE handleCapture, which references it in its deps array -
  // `const` bindings aren't usable before their declaration runs (temporal
  // dead zone), so handleCapture must come after this or every render would
  // throw a ReferenceError the moment it evaluates its own useCallback deps.
  const runAnalysis = useCallback(
    async (images: string[]) => {
      if (images.length === 0) return;
      setAnalyzingPhrase(pickAnalyzingPhrase());
      setStatus('analyzing');
      setErrorMessage(undefined);
      setRetakeMessage(undefined);

      try {
        const response = await analyzeImage(
          images,
          session,
          systemPrompt,
          initialQuestion,
          directSolveMode,
        );
        console.log(
          '[CameraScreen] analyze response:',
          JSON.stringify({
            fsm_state: response.fsm_state,
            confidence: response.confidence,
            error_type: response.error_type,
            message: response.message,
          }),
        );
        const decision = evaluateCaptureResult(response);

        if (decision.shouldRetake) {
          console.warn('[CameraScreen] retake requested:', decision.retakeMessage);
          setRetakeMessage(decision.retakeMessage);
          setStatus('retake');
          return;
        }

        setStatus('idle');
        onAnalyzed(response, images[0]);
      } catch (err) {
        console.error('[CameraScreen] analyzeImage failed:', err);
        const message = err instanceof Error ? err.message : String(err);
        setErrorMessage(`사진을 분석하다 문제가 생겼어: ${message}`);
        setStatus('retake');
      }
    },
    [onAnalyzed, session, systemPrompt, initialQuestion, directSolveMode],
  );

  const handleCapture = useCallback(async () => {
    if (camera.current == null) return;
    setStatus('capturing');

    try {
      const photo = await camera.current.takePhoto({
        flash: 'off',
      });
      // charing_viva의 검증된 파이프라인 포팅: 원본을 그대로 보내지 않고
      // 폭 1600으로 리사이즈 + JPEG 재인코딩한다. 이 재인코딩이 (1) 수십 MB
      // 원본을 Gemini가 받는 크기로 줄이고 (2) EXIF 회전을 픽셀에 실제
      // 적용한다. 이 단계가 없으면 Gemini가 회전된 초대형 이미지를 받아
      // OCR_FAILED("문제를 인식하지 못했습니다")로 판정한다.
      // 압축 실패 시엔 원본 base64로 폴백해 흐름은 계속 진행한다.
      let base64: string;
      try {
        const compressed = await manipulateAsync(
          `file://${photo.path}`,
          [{ resize: { width: 1600 } }],
          { compress: 0.6, format: SaveFormat.JPEG, base64: true },
        );
        if (!compressed.base64) throw new Error('base64 missing from manipulateAsync result');
        base64 = compressed.base64;
        console.log(
          '[CameraScreen] photo captured+compressed:',
          `${photo.width}x${photo.height}`,
          '->',
          `${compressed.width}x${compressed.height}`,
          'base64Bytes=',
          base64.length,
        );
      } catch (compressErr) {
        console.warn('[CameraScreen] compress failed, falling back to original:', compressErr);
        base64 = await FileSystem.readAsStringAsync(photo.path, {
          encoding: FileSystem.EncodingType.Base64,
        });
      }
      // Real-teacher flow: a single photo is normally the whole problem, so
      // don't make the student tap a separate "확인" checkmark before VIVA
      // looks at it - the first shutter press goes straight into analysis.
      // (If they're adding a SECOND page to an already-in-progress capture,
      // that's a deliberate multi-page case - just add the thumbnail and
      // let them keep using the checkmark to confirm when ready.)
      const isFirstPhoto = capturedImages.length === 0;
      setCapturedImages((prev) => [...prev, base64]);
      setStatus('idle');
      if (isFirstPhoto) {
        await runAnalysis([base64]);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(`사진을 찍다 문제가 생겼어: ${message}`);
      setStatus('retake');
    }
  }, [capturedImages, runAnalysis]);

  // Manual "확인" checkmark path - only reachable now if a student adds MORE
  // than one photo before confirming (see thumbnail row below); the normal
  // single-photo shutter flow auto-analyzes on its own (handleCapture).
  const handleAnalyzeAll = useCallback(() => {
    return runAnalysis(capturedImages);
  }, [runAnalysis, capturedImages]);

  const handleChooseFromGallery = useCallback(async () => {
    if (status === 'capturing' || status === 'analyzing') {
      return;
    }

    setErrorMessage(undefined);
    setRetakeMessage(undefined);
    setAnalyzingPhrase(pickAnalyzingPhrase());
    setStatus('analyzing');

    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        base64: true,
        quality: 0.7,
      });

      if (result.canceled) {
        setStatus('idle');
        return;
      }

      const assets = result.assets || [];
      const base64List = assets.map((a) => a.base64).filter(Boolean) as string[];
      if (base64List.length === 0) {
        throw new Error('고른 사진이 없어.');
      }

      const response = await analyzeImage(
        base64List,
        session,
        systemPrompt,
        initialQuestion,
        directSolveMode,
      );
      const decision = evaluateCaptureResult(response);

      if (decision.shouldRetake) {
        console.warn('[CameraScreen] retake requested (gallery):', decision.retakeMessage);
        setRetakeMessage(decision.retakeMessage);
        setStatus('retake');
        return;
      }

      setStatus('idle');
      onAnalyzed(response, base64List[0]);
    } catch (err) {
      console.error('[CameraScreen] gallery analyzeImage failed:', err);
      const message = err instanceof Error ? err.message : String(err);
      setErrorMessage(`사진을 고르다 문제가 생겼어: ${message}`);
      setStatus('retake');
    }
  }, [onAnalyzed, session, status, systemPrompt, initialQuestion, directSolveMode]);

  // Cancel retry and return to normal camera idle state
  const handleResetFromRetake = useCallback(() => {
    setErrorMessage(undefined);
    setRetakeMessage(undefined);
    setCapturedImages([]);
    setStatus('idle');
  }, []);

  if (status === 'analyzing') {
    return (
      <View style={styles.analyzingScreenContainer} testID="camera-analyzing-overlay">
        {showEyes && <EyeAnimation state="processing" />}
        <View style={styles.analyzingStatusRow} pointerEvents="none">
          <LoadingDots label={analyzingPhrase} />
        </View>
      </View>
    );
  }

  if (status === 'retake') {
    return (
      <View
        style={[styles.analyzingScreenContainer, { backgroundColor: 'rgba(250, 247, 240, 0.95)' }]}
        testID="camera-retake-banner"
      >
        <View style={styles.errorContent}>
          <Text style={styles.errorTitle}>
            {errorMessage
              ? '문제를 못 알아봤어'
              : (retakeMessage ?? '문제가 좀 흐릿해')}
          </Text>
          <Text style={styles.errorSubtitle}>
            {device == null ? '다시 골라볼까?' : '다시 찍어볼까?'}
          </Text>

          {device == null ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="앨범에서 재선택"
              style={styles.primaryButton}
              onPress={() => {
                handleResetFromRetake();
                handleChooseFromGallery();
              }}
            >
              <Text style={styles.primaryButtonText}>앨범에서 다시 선택하기</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="재촬영"
              style={styles.retryShutterButton}
              onPress={handleResetFromRetake}
            >
              <View style={styles.retryShutterInner} />
            </Pressable>
          )}

          {onCancel && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="취소"
              style={styles.errorCancelButton}
              onPress={onCancel}
            >
              <Text style={styles.errorCancelText}>취소</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  if (!hasPermission) {
    return (
      <View style={styles.permissionContainer} testID="camera-permission-screen">
        <Text style={styles.permissionTitle}>카메라 권한이 필요해</Text>
        <Text style={styles.permissionSubtitle}>
          문제를 찍으려면 카메라를 켜줘.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="카메라 권한 요청"
          testID="camera-permission-button"
          style={styles.primaryButton}
          onPress={handleRequestPermission}
        >
          <Text style={styles.primaryButtonText}>권한 허용하기</Text>
        </Pressable>
        {permissionRequested && (
          <Text style={styles.hintText} testID="camera-permission-denied-hint">
            거부했으면 설정 앱에서 카메라를 켜줘.
          </Text>
        )}
        {onCancel && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="취소"
            testID="camera-cancel-button"
            style={styles.secondaryButton}
            onPress={onCancel}
          >
            <Text style={styles.secondaryButtonText}>취소</Text>
          </Pressable>
        )}
      </View>
    );
  }

  if (device == null) {
    return (
      <View style={styles.permissionContainer} testID="camera-no-device-screen">
        <Text style={styles.permissionTitle}>카메라를 쓸 수 없어</Text>
        <Text style={styles.permissionSubtitle}>
          후면 카메라를 못 찾겠어. 대신 앨범에서 문제/풀이 사진을 올려도 돼.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="앨범에서 선택"
          testID="camera-gallery-button"
          style={styles.primaryButton}
          onPress={handleChooseFromGallery}
        >
          <Text style={styles.primaryButtonText}>앨범에서 선택하기</Text>
        </Pressable>
        {onCancel && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="취소"
            testID="camera-cancel-button"
            style={styles.secondaryButton}
            onPress={onCancel}
          >
            <Text style={styles.secondaryButtonText}>취소</Text>
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <View style={styles.container} testID="camera-screen">
      <Camera
        ref={camera}
        style={StyleSheet.absoluteFill}
        device={device}
        format={format}
        isActive={(status as string) !== 'retake'}
        photo
        testID="camera-preview"
      />

      {/* Simulator text preview placeholder */}
      <View style={styles.previewPlaceholderContainer}></View>

      {/* Camera viewfinder guide borders */}
      <View style={styles.viewfinderGuide}>
        <View style={[styles.corner, styles.topLeft]} />
        <View style={[styles.corner, styles.topRight]} />
        <View style={[styles.corner, styles.bottomLeft]} />
        <View style={[styles.corner, styles.bottomRight]} />
      </View>

      {/* Captured thumbnails list */}
      {capturedImages.length > 0 && (
        <View style={styles.thumbnailContainer}>
          {capturedImages.map((base64, index) => (
            <View key={index} style={styles.thumbnailWrapper}>
              <Image
                source={{ uri: `data:image/png;base64,${base64}` }}
                style={styles.thumbnailImage}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="사진 삭제"
                testID={`camera-thumbnail-remove-${index}`}
                style={styles.thumbnailRemoveButton}
                hitSlop={12}
                onPress={() => setCapturedImages((prev) => prev.filter((_, i) => i !== index))}
              >
                <View style={[styles.thumbnailRemoveLine, { transform: [{ rotate: '45deg' }] }]} />
                <View style={[styles.thumbnailRemoveLine, { transform: [{ rotate: '-45deg' }] }]} />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {/* Shutter & Cancel overlay */}
      <View style={styles.controlsContainer}>
        {onCancel && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={capturedImages.length > 0 ? '다시 촬영' : '취소'}
            testID="camera-cancel-button"
            style={styles.cancelButton}
            onPress={() => {
              if (capturedImages.length > 0) {
                setCapturedImages([]);
              } else {
                onCancel();
              }
            }}
          >
            {capturedImages.length > 0 ? <UndoIcon /> : <CloseIcon />}
          </Pressable>
        )}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="촬영"
          testID="camera-shutter-button"
          style={styles.shutterButton}
          onPress={handleCapture}
          disabled={status === 'capturing' || (status as string) === 'analyzing'}
        >
          {status === 'capturing' || (status as string) === 'analyzing' ? (
            <ActivityIndicator color="#ffffff" />
          ) : (
            <View style={styles.shutterInner} />
          )}
        </Pressable>

        {capturedImages.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="분석 완료"
            testID="camera-done-button"
            style={styles.doneButton}
            onPress={handleAnalyzeAll}
            disabled={(status as string) === 'analyzing'}
          >
            <CheckIcon />
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="앨범에서 선택"
            testID="camera-gallery-live-button"
            style={styles.galleryButton}
            onPress={handleChooseFromGallery}
            disabled={status === 'capturing' || (status as string) === 'analyzing'}
          >
            <AlbumIcon />
          </Pressable>
        )}
      </View>

      {/* Error/Retake overlay matching style 07 */}
      {(status as string) === 'retake' && (
        <View style={styles.errorOverlay} testID="camera-retake-banner">
          <View style={styles.errorContent}>
            <Text style={styles.errorTitle}>
              {errorMessage
                ? '문제를 못 알아봤어'
                : (retakeMessage ?? '문제가 좀 흐릿해')}
            </Text>
            <Text style={styles.errorSubtitle}>다시 찍어볼까?</Text>

            {/* Custom retry shutter button */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="재촬영"
              style={styles.retryShutterButton}
              onPress={handleResetFromRetake}
            >
              <View style={styles.retryShutterInner} />
            </Pressable>

            {onCancel && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="취소"
                style={styles.errorCancelButton}
                onPress={onCancel}
              >
                <Text style={styles.errorCancelText}>취소</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  previewPlaceholderContainer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  previewPlaceholderText: {
    fontSize: 13,
    fontWeight: '500',
    color: 'rgba(43, 41, 38, 0.4)',
    fontFamily: MONO,
    letterSpacing: 0.3,
  },
  viewfinderGuide: {
    position: 'absolute',
    top: 44,
    right: 44,
    bottom: 44,
    left: 44,
    zIndex: 2,
  },
  corner: {
    position: 'absolute',
    width: 30,
    height: 30,
    borderColor: '#369B75',
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 3,
    borderLeftWidth: 3,
    borderTopLeftRadius: 6,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: 3,
    borderRightWidth: 3,
    borderTopRightRadius: 6,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 3,
    borderLeftWidth: 3,
    borderBottomLeftRadius: 6,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 3,
    borderRightWidth: 3,
    borderBottomRightRadius: 6,
  },
  controlsContainer: {
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 48,
    zIndex: 3,
  },
  shutterButton: {
    width: 68,
    height: 68,
    borderRadius: 34,
    borderWidth: 3,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  shutterInner: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#369B75',
  },
  cancelButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  galleryButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Error overlay style 07
  analyzingScreenContainer: {
    flex: 1,
    backgroundColor: APP_BACKGROUND_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
  },
  analyzingStatusRow: {
    position: 'absolute',
    left: 96,
    right: 96,
    bottom: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(250, 247, 240, 0.95)', // Warm off-white with overlay opacity
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },
  errorContent: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  errorTitle: {
    fontSize: 22,
    lineHeight: 33,
    fontWeight: '500',
    color: '#2B2926',
    textAlign: 'center',
    fontFamily: 'Pretendard',
  },
  errorSubtitle: {
    fontSize: 22,
    lineHeight: 33,
    fontWeight: '500',
    color: '#2B2926',
    textAlign: 'center',
    fontFamily: 'Pretendard',
    marginTop: -8,
  },
  retryShutterButton: {
    width: 54,
    height: 54,
    borderRadius: 27,
    borderWidth: 3,
    borderColor: '#2B2926',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    marginTop: 8,
  },
  retryShutterInner: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#369B75',
  },
  errorCancelButton: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginTop: 8,
  },
  errorCancelText: {
    color: '#2B2926',
    fontSize: 13,
    fontWeight: '600',
    fontFamily: FONT,
  },
  // Permission styles
  permissionContainer: {
    flex: 1,
    backgroundColor: APP_BACKGROUND_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
  },
  permissionTitle: {
    color: '#2B2926',
    fontSize: 20,
    fontWeight: '600',
    fontFamily: FONT,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  permissionSubtitle: {
    color: 'rgba(43, 41, 38, 0.6)',
    fontSize: 14,
    fontFamily: FONT,
    marginTop: 8,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  hintText: {
    color: 'rgba(43, 41, 38, 0.5)',
    fontSize: 12,
    fontFamily: FONT,
    marginTop: 16,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  primaryButton: {
    marginTop: 24,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 16,
    backgroundColor: '#369B75',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
    fontFamily: FONT,
  },
  secondaryButton: {
    marginTop: 16,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  secondaryButtonText: {
    color: 'rgba(43, 41, 38, 0.5)',
    fontSize: 13,
    fontFamily: FONT,
  },
  doneButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#369B75',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbnailContainer: {
    position: 'absolute',
    bottom: 96,
    left: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    zIndex: 10,
  },
  thumbnailImage: {
    width: 60,
    height: 60,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
  },
  thumbnailWrapper: {
    width: 60,
    height: 60,
  },
  thumbnailRemoveButton: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 11,
  },
  thumbnailRemoveLine: {
    position: 'absolute',
    width: 10,
    height: 1.5,
    backgroundColor: '#FFFFFF',
    borderRadius: 1,
  },
  // Custom Icon styles
  iconWrapper: {
    width: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeLine: {
    position: 'absolute',
    width: 2,
    height: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 1,
  },
  albumFrameBack: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
    borderRadius: 3,
    top: 2,
    left: 2,
    opacity: 0.4,
  },
  albumFrameFront: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
    borderRadius: 3,
    bottom: 2,
    right: 2,
    backgroundColor: 'transparent',
  },
  checkLine: {
    position: 'absolute',
    backgroundColor: '#FFFFFF',
    borderRadius: 1,
  },
});

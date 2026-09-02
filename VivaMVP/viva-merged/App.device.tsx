/**
 * VIVA — AI math tutoring app (device-connected shell)
 *
 * Routes between screens based on AppState.status. 로봇(Pi)이 항상 붙어
 * 있다는 전제 - 연결 상태는 connectionMonitor 가 판정하고, 눈 표정은
 * eyeSyncService 가 미러링한다.
 */

import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { StatusBar, StyleSheet, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAppState } from './src/hooks/useAppState';
import { useSolveMode } from './src/hooks/useSolveMode';
import HomeScreen from './src/device/screens/HomeScreen';
import IntentScreen from './src/device/screens/IntentScreen';
import CameraScreen from './src/screens/CameraScreen';
import ConversationScreen from './src/device/screens/ConversationScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import SessionDetailScreen from './src/screens/SessionDetailScreen';
import ProcessingView from './src/components/ProcessingView';
import FadeInView from './src/components/FadeInView';
import { buildSystemPrompt } from './src/prompts/system_prompt';
import { useWakeWord } from './src/hooks/useWakeWord';
import type { PiWakeStream } from './src/hooks/useWakeWord';
import { usePiConnection } from './src/device/hooks/usePiConnection';
import { Camera } from 'react-native-vision-camera';
import { connectionMonitor } from './src/device/services/connectionMonitor.service';
import { createPiWakeStream } from './src/device/services/piWakeStream.service';
import { CALLING_HOLD_MS, eyeSyncService, STATUS_EYE_STATE } from './src/device/services/eyeSync.service';
import type {
  GeminiTutoringResponse,
  ResumeSessionSnapshot,
  TutoringSession,
} from './src/types/Tutoring';
import type { ConversationPayload } from './src/types/AppState';
import type { TokenUsage } from './src/types/ApiUsage';

function App() {
  const isDarkMode = useColorScheme() === 'dark';

  return (
    <SafeAreaProvider>
      <StatusBar hidden translucent barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <AppContent />
    </SafeAreaProvider>
  );
}

function makeSession(): TutoringSession {
  return {
    sessionId: `session-${Date.now()}`,
    problemImageBase64: '',
    fsmState: 'HINT_STAGE',
    hintCount: 0,
    wrongStreak: 0,
    boardRegenerationCount: 0,
  };
}

function toConversationPayload(
  response: GeminiTutoringResponse & { usage?: TokenUsage },
  imageBase64: string,
  initialQuestion?: string,
  resumeSession?: ResumeSessionSnapshot,
  photoSource?: 'pi' | 'phone',
  parentConceptSessionId?: string,
): ConversationPayload {
  return {
    fsmState: response.fsm_state,
    message: response.message,
    requires_board: response.requires_board,
    board_update_needed: response.board_update_needed,
    board_prompt: response.board_prompt,
    initialAnalysis: response,
    problemImageBase64: imageBase64,
    initialQuestion,
    initialUsage: response.usage,
    resumeSession,
    photoSource,
    parentConceptSessionId,
  };
}

function AppContent() {
  const {
    appState,
    transitionTo,
    startCapturing,
    startProcessing,
    enterConversation,
    resetToIdle,
    enterHistory,
    viewSessionDetail,
  } = useAppState({
    onStatusChange: useCallback(
      (status) => eyeSyncService.sendEyeState(STATUS_EYE_STATE[status]),
      [],
    ),
  });

  const piStatus = usePiConnection();

  const [session, setSession] = useState<TutoringSession>(makeSession);
  const { solveMode, toggleSolveMode, resetSolveMode } = useSolveMode();

  // 대화 도중 재촬영으로 ConversationScreen 이 언마운트되는 사이, 직전 튜터링
  // 세션을 잠시 들고 있는 곳. 카메라를 거쳐 대화로 돌아올 때 payload 에 실어
  // 보내 같은 세션을 이어가게 한다(없으면 새 세션).
  const resumeSessionRef = useRef<ResumeSessionSnapshot | undefined>(undefined);

  // 한 문제가 끝나면 앱을 처음 켜 상태로 돌려놓는다. 세션 간에 남아서는
  // 안 되는 게 세 가지다: 튜터링 세션, 재촬영 이어가기 스냅샷, 그리고
  // 정답 모드 토글. 마지막 것을 안 꺼서, 풀이가 끝나 홈으로 돌아간 뒤
  // 다음 촬영을 하면 학생이 아무 말도 안 했는데 VIVA 가 사진 속 문제를
  // 골라 바로 풀어버렸다 (실기기 2026-07-29).
  const handleResetToIdle = useCallback(() => {
    setSession(makeSession());
    resumeSessionRef.current = undefined;
    resetSolveMode();
    resetToIdle();
  }, [resetToIdle, resetSolveMode]);

  // 앱이 뜨자마자 카메라 권한 상태를 확인하고, 아직 결정된 적이 없으면
  // (never_ask_again 이 아닌 한) 바로 요청한다. CameraScreen 은 화면에
  // 진입했을 때에야 useCameraPermission()으로 권한을 뒤늦게 물어봤는데,
  // 그 사이 vision-camera 가 디바이스 목록을 못 잡아 "카메라 인식 안 됨"
  // 으로 보이는 경우가 있었다 - 시작 시점에 미리 물어봐서 실제 촬영
  // 화면에 도달했을 땐 이미 권한이 정리돼 있도록 한다.
  useEffect(() => {
    (async () => {
      const status = await Camera.getCameraPermissionStatus();
      console.log('[App] camera permission status on launch:', status);
      if (status !== 'granted' && status !== 'denied') {
        const result = await Camera.requestCameraPermission();
        console.log('[App] camera permission request result:', result);
      }
    })();
  }, []);

  const stopListeningRef = useRef<(() => Promise<void>) | null>(null);

  // Pi 호출어 PCM 스트림 (앱 수명 동안 1개). 인스턴스는 상태를 안 만드니
  // lazy init 한 ref 로 든다.
  const piWakeStreamRef = useRef<PiWakeStream | null>(null);
  if (!piWakeStreamRef.current) piWakeStreamRef.current = createPiWakeStream();
  const piWakeStream = piWakeStreamRef.current;

  // 디바이스 셸은 항상 로봇 연동 전제라 모드 분기가 없다 - monitor 폴링을
  // 앱 수명 동안 그냥 돌린다.
  useEffect(() => {
    connectionMonitor.start();
    return () => connectionMonitor.stop();
  }, []);

  // useWakeWord 에 주는 소스. monitor 가 연결을 확인 못 했으면 start 를
  // 거부해 기존 폰 마이크 경로로 흘린다.
  const wakePiSource = useMemo<PiWakeStream>(
    () => ({
      ...piWakeStream,
      start: async (onPcm) => {
        if (connectionMonitor.status !== 'connected') {
          throw new Error('pi disabled - using phone mic');
        }
        return piWakeStream.start(onPcm);
      },
    }),
    [piWakeStream],
  );

  const handleAnalyzed = useCallback(
    (
      response: GeminiTutoringResponse,
      imageBase64: string,
      photoSource: 'pi' | 'phone' = 'phone',
      initialQuestionOverride?: string,
      parentConceptSessionId?: string,
    ) => {
      const resume = resumeSessionRef.current;
      resumeSessionRef.current = undefined;
      startProcessing();
      enterConversation(
        toConversationPayload(
          response,
          imageBase64,
          initialQuestionOverride ??
            (appState.status === 'capturing' ? appState.initialQuestion : undefined),
          resume,
          photoSource,
          parentConceptSessionId,
        ),
      );
    },
    [appState, startProcessing, enterConversation],
  );

  // 촬영 진입점 하나. "비바야" 호출어, 홈 화면 탭, 디버그 버튼이 전부 여기로
  // 온다. 로봇이 붙어 있으면 로봇 카메라, 없거나 실패하면 폰 카메라.
  //
  // 예전엔 Pi 경로가 HomeScreen 롱프레스 전용 디버그 함수(handlePiCameraTest)
  // 였다 - "검증되면 이 함수를 실제 로봇 모드 진입점으로 옮기면 된다" 고
  // 적어둔 그 자리다. 그대로 두면 호출어로 시작한 세션은 photoSource='phone'
  // 이 박혀 대화 중 재촬영도 영영 폰 카메라로 간다.
  //
  // 한때 마이크 먼저(IntentScreen, 의도 분류 후 카메라) 흐름이었으나 호출 즉시
  // 카메라 직행으로 바뀌면서 그 화면/분류기는 삭제됐다 (2026-07-28 죽은 코드 정리).
  const beginCapture = useCallback(async () => {
    // 이 로그가 안 찍히면 버튼 자체가 안 눌린 것이고, 찍히고 그 다음 줄이
    // 안 나오면 마이크 teardown 에 걸린 것이다 - 실기기에서 "눌러도 아무
    // 반응이 없다" 를 이 두 줄로 구분한다.
    console.log(`[App] beginCapture: pi=${connectionMonitor.status}`);
    // 불렸다 - '!' 를 띄운다. 호출어와 홈 버튼 둘 다 여기로 들어오고, 둘 다
    // "지금 부른 것" 이라 같은 표정이 맞다.
    //
    // holdMs 로 최소 노출을 보장한다. 예전엔 그냥 보내기만 해서, 마이크
    // teardown 이 끝나는 수백 ms 뒤 startCapturing/startProcessing 의
    // transitionTo 가 곧바로 덮어써 사람이 인지하기 전에 사라졌다 - 학생
    // 눈엔 idle 에서 촬영 표정으로 직행이다. 그 사이 도착하는 상태는
    // eyeSyncService 가 물고 있다가 만료 시 반영하므로, 촬영·분석
    // 파이프라인 자체는 이 값과 무관하게 그대로 돈다 (2026-08-07).
    eyeSyncService.sendEyeState('calling', { holdMs: CALLING_HOLD_MS });
    // 여기서는 AF 선행(prewarmPiFocus)을 부르지 않는다.
    //
    // 처음엔 "마이크 teardown 이 흘려보내는 시간에 AF 를 숨긴다" 였는데,
    // 실기기 로그로 이득이 0 인 게 확인됐다 (2026-07-29). 호출어를 누르면
    // 곧바로 찍는 흐름이라 겹칠 시간이 애초에 없고, prewarm 과 capture 가
    // 거의 동시에 Pi 에 도착해 _capture_lock 을 두고 경합할 뿐이다:
    //   - prewarm 이 이기면 AF 5.7초 + capture 가 lock 대기 후 encode 7초
    //   - capture 가 이기면 자기 AF 5.7초 + encode 7초
    // 어느 쪽이든 버튼~사진이 ~12.7초로 같다. 요청만 하나 더 나갈 뿐이다.
    //
    // AF 선행이 실제로 값을 하는 곳은 덮을 발화가 있는 대화 중 재촬영
    // (useTutoringFSM 의 PI_RETAKE_FILLER 앞)뿐이라 거기만 남겨뒀다.
    // 이 경로에서도 5.7초를 없애려면 버튼을 누르기 *전에* 초점이 맞아 있어야
    // 하고(유휴 중 주기적 prewarm), 그건 오래된 초점으로 찍을 위험과 AF 모터를
    // 계속 돌리는 비용을 맞바꾸는 별개 결정이다.
    // 호출어 리스너를 내린다. 실패해도 촬영은 계속해야 한다 - 여기서 예외가
    // 그대로 올라가면 beginCapture 가 조용히 중단되고, 학생 눈엔 버튼이 안
    // 눌린 것으로 보인다.
    if (stopListeningRef.current) {
      try {
        await stopListeningRef.current();
      } catch (err) {
        console.warn('[App] wake word teardown failed - continuing to capture:', err);
      }
    }
    // 새로 부른 것이므로 이전 세션 이어가기는 버린다.
    resumeSessionRef.current = undefined;

    const openPhoneCamera = async () => {
      // 항상 켜져 있던 wake-word 마이크 스트림(AudioRecord)이 네이티브에서 완전히
      // 해제되기 전에 카메라가 열리면 vision-camera 기기 목록이 빈 배열로 나오며
      // 카메라를 못 여는 자원 충돌이 있다. 마이크가 확실히 풀리도록 여유를 준다.
      // (로봇 경로는 폰 카메라를 안 여니 이 대기가 필요 없다.)
      await new Promise<void>((resolve) => setTimeout(resolve, 700));
      startCapturing();
    };

    const usePi = connectionMonitor.status === 'connected';
    if (!usePi) {
      // 미연결이면 홈이 촬영 시작을 막고 웨이크도 안 돌므로 원칙적으로
      // 도달하지 않는다 - 그래도 도달하면 폰 카메라가 안전값.
      await openPhoneCamera();
      return;
    }

    try {
      // Pi 마이크 소유권 hand-off (기존과 동일): wake arecord 종료 ack 후에야
      // 의도루프가 녹음을 시작할 수 있다.
      await piWakeStream.pause();
      // 의도파악 루프로 진입 — 촬영·분석은 IntentScreen(useIntentLoop)이
      // 백그라운드로 병렬 진행한다 (2026-08-12 스펙).
      transitionTo({ status: 'intent' });
    } catch (err) {
      console.error('[App] intent entry failed:', err);
      const stillAlive = await connectionMonitor.probeNow();
      if (stillAlive) {
        await openPhoneCamera();
      } else {
        handleResetToIdle();
      }
    }
  }, [
    startCapturing,
    transitionTo,
    piWakeStream,
    handleResetToIdle,
  ]);

  const { startListening, stopListening } = useWakeWord(beginCapture, { piStream: wakePiSource });

  useEffect(() => {
    stopListeningRef.current = stopListening;
  }, [stopListening]);

  // Manage wake-word listening depending on AppState + Pi 연결 상태.
  useEffect(() => {
    // resume().then(startListening) 은 비동기라 이 effect 가 재실행된 뒤에도
    // (예: piStatus 가 다시 바뀌어 stopListening 분기를 탄 뒤에) 뒤늦게
    // startListening 을 실행하는 레이스가 있었다 - 표준 취소 플래그로 막는다.
    let cancelled = false;
    if (appState.status !== 'idle') {
      stopListening();
      piWakeStream.pause().catch(() => {});
      return () => {
        cancelled = true;
      };
    }
    if (piStatus === 'connected') {
      piWakeStream
        .resume()
        .catch((err) => console.warn('[App] pi wake stream resume failed:', err))
        .then(() => {
          if (!cancelled) startListening();
        });
    } else {
      // 미연결: 웨이크는 로봇 마이크 전제라 올리지 않는다. monitor 가
      // connected 로 바뀌면 이 effect 가 다시 돌아 올라간다.
      stopListening();
    }
    return () => {
      cancelled = true;
    };
  }, [appState.status, piStatus, startListening, stopListening, piWakeStream]);

  // 사진이 필요하다고 판단된 경우(대화 중 재촬영 포함). 학생이 뭐라고 했는지는
  // analyzeImage() 가 알아야 하고, `resume` 은 재촬영 후 같은 튜터링 세션을
  // 이어가기 위한 스냅샷이다 - 없으면(홈에서 바로 촬영) 새 세션.
  const handleCameraNeeded = useCallback(
    (question?: string, resume?: ResumeSessionSnapshot) => {
      resumeSessionRef.current = resume;
      startCapturing(question ?? '');
    },
    [startCapturing],
  );

  return (
    // key=appState.status: 화면이 바뀔 때마다 새로 마운트시켜 크로스페이드를
    // 다시 재생한다(2026-08-13 UX 통일). RN 언마운트는 즉시라 exit 애니는 없음
    // - 들어오는 화면만 페이드인.
    <FadeInView key={appState.status} style={styles.container}>
      {appState.status === 'idle' && (
        <HomeScreen
          piStatus={piStatus}
          onPressToTalk={beginCapture}
          onPressHistory={enterHistory}
          solveMode={solveMode}
          onToggleSolveMode={toggleSolveMode}
        />
      )}
      {appState.status === 'intent' && (
        <IntentScreen
          robotAudio={piStatus === 'connected'}
          session={session}
          solveMode={solveMode}
          onAnalyzed={(response, imageBase64, question, conceptSessionId) =>
            handleAnalyzed(response, imageBase64, 'pi', question, conceptSessionId)
          }
          onPhoneCamera={(question) => {
            // 폰 카메라 폴백 — 웨이크 마이크 해제 여유는 openPhoneCamera 와 동일 사유.
            setTimeout(() => startCapturing(question ?? ''), 700);
          }}
          onExit={handleResetToIdle}
        />
      )}
      {appState.status === 'capturing' && (
        <CameraScreen
          systemPrompt={buildSystemPrompt({
            ...session,
            hasProblemImage: true,
            freshPhoto: true,
            directSolveMode: solveMode,
          })}
          session={session}
          onAnalyzed={handleAnalyzed}
          onCancel={handleResetToIdle}
          initialQuestion={appState.initialQuestion}
          directSolveMode={solveMode}
          showEyes={false}
        />
      )}
      {appState.status === 'processing' && <ProcessingView showEyes={false} />}
      {appState.status === 'conversation' && (
        <ConversationScreen
          conversation={appState.conversation}
          robotAudio={piStatus === 'connected'}
          onSessionComplete={handleResetToIdle}
          onCameraNeeded={handleCameraNeeded}
          solveMode={solveMode}
          onToggleSolveMode={toggleSolveMode}
        />
      )}
      {appState.status === 'history' && (
        <HistoryScreen onBack={resetToIdle} onSelectSession={viewSessionDetail} />
      )}
      {appState.status === 'session_detail' && (
        <SessionDetailScreen
          sessionId={appState.sessionId}
          onBack={enterHistory}
          onSelectSession={viewSessionDetail}
        />
      )}
    </FadeInView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

export default App;

/**
 * VIVA — AI math tutoring app (phone-only shell)
 *
 * Routes between screens based on AppState.status. 로봇(Pi) 연동 없음 -
 * 마이크·카메라·스피커 전부 폰 것을 그대로 쓴다. 눈 미러링 대상도 없다.
 */

import React, { useCallback, useEffect, useState, useRef } from 'react';
import { StatusBar, StyleSheet, useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAppState } from './src/hooks/useAppState';
import { useSolveMode } from './src/hooks/useSolveMode';
import HomeScreen from './src/phone/screens/HomeScreen';
import CameraScreen from './src/screens/CameraScreen';
import ConversationScreen from './src/phone/screens/ConversationScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import SessionDetailScreen from './src/screens/SessionDetailScreen';
import ProcessingView from './src/components/ProcessingView';
import { buildSystemPrompt } from './src/prompts/system_prompt';
import { useWakeWord } from './src/hooks/useWakeWord';
import { Camera } from 'react-native-vision-camera';
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
  };
}

function AppContent() {
  const {
    appState,
    startCapturing,
    startProcessing,
    enterConversation,
    resetToIdle,
    enterHistory,
    viewSessionDetail,
  } = useAppState();

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

  const handleAnalyzed = useCallback(
    (
      response: GeminiTutoringResponse,
      imageBase64: string,
      photoSource: 'pi' | 'phone' = 'phone',
    ) => {
      const resume = resumeSessionRef.current;
      resumeSessionRef.current = undefined;
      startProcessing();
      enterConversation(
        toConversationPayload(
          response,
          imageBase64,
          appState.status === 'capturing' ? appState.initialQuestion : undefined,
          resume,
          photoSource,
        ),
      );
    },
    [appState, startProcessing, enterConversation],
  );

  // 촬영 진입점 하나. "비바야" 호출어와 홈 화면 탭이 전부 여기로 온다.
  // 로봇 연동이 없으니 폰 카메라만 있다.
  const beginCapture = useCallback(async () => {
    console.log('[App] beginCapture (phone)');
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
    // 항상 켜져 있던 wake-word 마이크 스트림(AudioRecord)이 네이티브에서 완전히
    // 해제되기 전에 카메라가 열리면 vision-camera 기기 목록이 빈 배열로 나오며
    // 카메라를 못 여는 자원 충돌이 있다. 마이크가 확실히 풀리도록 여유를 준다.
    await new Promise<void>((resolve) => setTimeout(resolve, 700));
    startCapturing();
  }, [startCapturing]);

  const { startListening, stopListening } = useWakeWord(beginCapture);

  useEffect(() => {
    stopListeningRef.current = stopListening;
  }, [stopListening]);

  // Manage wake-word listening depending on AppState. idle 이 아니면 정지,
  // idle 이면 다시 듣는다.
  useEffect(() => {
    if (appState.status !== 'idle') {
      stopListening();
    } else {
      startListening();
    }
  }, [appState.status, startListening, stopListening]);

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
    <View style={styles.container}>
      {appState.status === 'idle' && (
        <HomeScreen
          onPressToTalk={beginCapture}
          onPressHistory={enterHistory}
          solveMode={solveMode}
          onToggleSolveMode={toggleSolveMode}
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
          showEyes={true}
        />
      )}
      {appState.status === 'processing' && <ProcessingView showEyes={true} />}
      {appState.status === 'conversation' && (
        <ConversationScreen
          conversation={appState.conversation}
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

export default App;

import React, { useCallback, useEffect, useState, useRef } from 'react';
import {
  Image,
  Keyboard,
  LayoutAnimation,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  Animated,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import BoardView from '../../components/BoardView';
import CharacterView from '../../components/CharacterView';
import { useTutoringFSM } from '../../hooks/useTutoringFSM';
import { useVoiceInput } from '../../hooks/useVoiceInput';
import {
  generateVerifiedBoardImage,
  TRANSCRIPTION_INSTRUCTION,
  APP_BACKGROUND_COLOR,
  SURFACE_COLOR,
  SURFACE_BORDER_COLOR,
} from '../../services/board.service';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { debugRecordBoard } from '../../services/sessionDebug.service';
import { speak, stopSpeaking, TTS_PAUSE_MARKER } from '../../services/tts.service';
import { cropBase64Image } from '../../utils/cropImage';
import LoadingDots from '../../components/LoadingDots';
import MicLevelIndicator from '../../components/MicLevelIndicator';
import SolveModeToggle from '../../components/SolveModeToggle';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ConversationPayload } from '../../types/AppState';
import type { ResumeSessionSnapshot } from '../../types/Tutoring';
import type { EyeState } from '../../components/EyeAnimation';
import type { TokenUsage } from '../../types/ApiUsage';
import { cleanMathForSubtitle } from '../../utils/mathTextProcessor';
import { splitIntoSentences, SUBTITLE_MS_PER_CHAR } from '../../utils/subtitleSchedule';

/** 판서 원본(2K PNG, ~2MB)을 한 번 1280px JPEG 로 줄인다 - 이 표현 하나를
 * 화면 표시·EVAL 첨부(매 턴 재업로드)·SOLVE 수정 base 로 공용한다 (스펙
 * 2026-07-29). 실패하면 원본 그대로 - 기능은 유지되고 업로드 비용만 원래대로. */
async function downscaleBoard(base64Png: string): Promise<string> {
  try {
    const out = await manipulateAsync(
      `data:image/png;base64,${base64Png}`,
      [{ resize: { width: 1280 } }],
      { compress: 0.8, format: SaveFormat.JPEG, base64: true },
    );
    return out.base64 || base64Png;
  } catch (err) {
    console.warn('[BoardView] board downscale failed - using the full-size image:', err);
    return base64Png;
  }
}

interface ConversationScreenProps {
  conversation?: ConversationPayload;
  onSessionComplete?: () => void;
  /** `resume` 는 재촬영 후 같은 튜터링 세션을 이어가기 위한 스냅샷 - 호출부가
   * 다음 ConversationPayload 의 `resumeSession` 으로 그대로 넘겨줘야 한다. */
  onCameraNeeded?: (question?: string, resume?: ResumeSessionSnapshot) => void;
  solveMode: boolean;
  onToggleSolveMode: () => void;
}

export default function ConversationScreen({
  conversation,
  onSessionComplete,
  onCameraNeeded,
  solveMode,
  onToggleSolveMode,
}: ConversationScreenProps): React.JSX.Element {
  const [currentSubtitle, setCurrentSubtitle] = useState<string>('');
  const [inputText, setInputText] = useState<string>('');
  const [isBoardLoading, setIsBoardLoading] = useState<boolean>(false);
  const [keyboardHeight, setKeyboardHeight] = useState<number>(0);

  const insets = useSafeAreaInsets();
  const safeTop = Math.max(insets.top + 12, 18);
  const safeBottom = keyboardHeight > 0 ? 12 : Math.max(insets.bottom + 12, 24);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);
  const subtitleTimeouts = useRef<any[]>([]);
  const subtitleAnim = useRef(new Animated.Value(0)).current;

  // Stop any in-flight TTS playback AND cancel any pending Gemini
  // evaluate/solve call when this screen goes away (e.g. the student taps
  // "홈으로" mid-sentence or while VIVA is still "생각 중"). Without
  // cancelTutoringFSM(), an evaluate call already in flight would resolve
  // after unmount and still trigger speakFn() - so VIVA kept "talking" (a
  // fresh TTS playback would start) even though the screen had already
  // returned to idle/Home.
  useEffect(() => {
    return () => {
      stopSpeaking();
      cancelTutoringFSM();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearSubtitleTimeouts = useCallback(() => {
    subtitleTimeouts.current.forEach(clearTimeout);
    subtitleTimeouts.current = [];
  }, []);

  const startSubtitles = useCallback(
    (text: string, durationMs: number) => {
      clearSubtitleTimeouts();
      const sentences = splitIntoSentences(text);
      const totalLength = sentences.reduce((sum, s) => sum + s.length, 0);
      if (totalLength === 0) {
        setCurrentSubtitle('');
        return;
      }

      // Intentionally no final "clear" timeout here: the estimated
      // `durationMs` (from Sound.getDuration()) can drift slightly short of
      // the real playback length, which used to blank the subtitle - and
      // fall back to the loading-dot slot - while audio was still audibly
      // playing. The last sentence now simply stays on screen until `phase`
      // actually leaves 'speaking' (the true "playback finished" signal,
      // handled by the effect below), so the subtitle is guaranteed to cover
      // the whole time audio is playing.
      let accumulatedTime = 0;
      sentences.forEach((sentence) => {
        const sentenceRatio = sentence.length / totalLength;
        const sentenceDuration = durationMs * sentenceRatio;
        const showTime = accumulatedTime;
        accumulatedTime += sentenceDuration;

        const id = setTimeout(() => {
          setCurrentSubtitle(sentence);
        }, showTime);
        subtitleTimeouts.current.push(id);
      });
    },
    [clearSubtitleTimeouts],
  );

  const customSpeak = useCallback(
    async (text: string, _onPlay?: (d: number) => void, rate?: number) => {
      // Google Cloud TTS playback duration is known once the clip loads
      // (speak()'s onPlay callback), so subtitles can be timed against the
      // real audio length instead of an estimate.
      // speak() needs the raw TTS_PAUSE_MARKER token (see
      // ANSWER_CONFIRMATION_POLICY) to synthesize a real pause - but the
      // subtitle pipeline just splits on sentence punctuation, so the literal
      // "[[PAUSE]]" token would otherwise show up glued to the next sentence.
      // Swap it for a space before it ever reaches subtitles.
      const subtitleText = text.split(TTS_PAUSE_MARKER).join(' ');
      await speak(
        text,
        (durationMillis) => {
          startSubtitles(
            subtitleText,
            durationMillis || subtitleText.length * SUBTITLE_MS_PER_CHAR,
          );
        },
        rate,
      );
      // 여기에 "onPlay 가 안 왔으면 추정 길이로 자막이라도 돌린다" 폴백이
      // 있었는데, 현행 speak() 은 재생에 도달하면 반드시 onPlay 를 부른다 -
      // onPlay 없이 resolve 하는 유일한 경로는 더 새 요청(끼어들기의
      // stopSpeaking/새 speak)에 밀려 조기 반환된 경우다. 그 폴백이 밀려난
      // 옛 발화의 자막을 다시 돌리면서 새 턴의 자막 타이머까지 지워버려,
      // 끼어들기 직후 옛 문장이 오디오 없이 화면에 뜨는 자막 중복을 만들었다.
      // 밀린 발화는 자막도 없어야 맞으므로 폴백은 없는 게 정답이다.
    },
    [startSubtitles],
  );

  // The FSM only calls this AFTER it has already fully spoken the camera
  // guidance message ("그래, 그럼 그 문제를 사진으로 찍어서 보여줘!") via
  // speakAndWait (which resolves on true TTS completion), so the transition
  // is already correctly triggered by TTS-end. Do NOT add an arbitrary timer
  // here: a fixed delay used to fire before/independently of playback and
  // could swap to the camera while VIVA was still mid-sentence.
  const handleCameraNeededWrapper = useCallback(
    (question?: string, resume?: ResumeSessionSnapshot) => {
      console.log(
        '[ConversationScreen] Camera guidance finished speaking. Transitioning to camera.',
      );
      onCameraNeeded?.(question, resume);
    },
    [onCameraNeeded],
  );

  // voice 는 아래(289행)에서 만들어지므로 ref 로 한 단계 미룬다. FSM 의
  // 되묻기 무응답 타이머가 말하기 직전에 마이크를 닫는 데 쓴다.
  const stopListeningRef = useRef<(() => Promise<void>) | null>(null);

  const {
    phase,
    session,
    conversation: fsmConversation,
    startSession,
    submitStudentInput,
    updateBoardData,
    addBoardUsage,
    cancel: cancelTutoringFSM,
  } = useTutoringFSM({
    onSessionComplete,
    speakFn: customSpeak,
    stopListeningFn: useCallback(() => {
      stopListeningRef.current?.()?.catch(() => {});
    }, []),
    onCameraNeeded: handleCameraNeededWrapper,
    directSolveMode: solveMode,
    cropLocalImageFn: cropBase64Image,
  });

  // Clear subtitles when phase moves past speaking AND past the listening
  // turn that follows it. NO cleanup function here: the FSM does
  // setPhase('speaking') and speakFn() in the same tick, so the subtitle
  // timeouts are scheduled BEFORE the phase change commits - a per-run
  // cleanup fired on that commit and killed them all (only the loading dots
  // ever showed).
  //
  // 'awaiting_input' is intentionally NOT cleared here:
  // once VIVA finishes speaking and the mic opens for the student's turn,
  // her question should stay on screen (instead of being replaced by a
  // generic "궁금한 점을 말해보세요" placeholder) so the student can see
  // exactly what she asked while they're answering it. It only clears once
  // a NEW turn actually starts producing new content, or the session ends.
  //
  // 'evaluating' (Gemini actually thinking/grading) DOES clear it - that's
  // a genuinely new "state" the student should read as "생각 중", not VIVA
  // still appearing to show her last line. Only listening keeps it, so the
  // student can re-read her question while answering; the moment they stop
  // talking, the loading dots take over.
  useEffect(() => {
    if (phase !== 'speaking' && phase !== 'awaiting_input') {
      clearSubtitleTimeouts();
      setCurrentSubtitle('');
    }
  }, [phase, clearSubtitleTimeouts]);

  // Unmount-only timeout cleanup.
  useEffect(() => clearSubtitleTimeouts, [clearSubtitleTimeouts]);

  const handleVoiceResult = useCallback(
    (text: string) => {
      submitStudentInput(text);
    },
    [submitStudentInput],
  );

  const voice = useVoiceInput({
    onResult: handleVoiceResult,
    // 직전 튜터 발화를 전사 힌트로 넘긴다 - "오" 같은 짧은 대답을 감탄사가
    // 아니라 숫자 5 로 받아쓰게 하는 문맥 (geminiStt.service 참고).
    getTranscribeContext: () => {
      const history = session.history ?? [];
      for (let i = history.length - 1; i >= 0; i -= 1) {
        if (history[i].role === 'model') return history[i].message;
      }
      return undefined;
    },
  });
  stopListeningRef.current = voice.stopListening;

  // Tracks an intentional manual mic-stop within the CURRENT turn, so the
  // auto-resume effect below doesn't immediately override it (without this,
  // tapping the mic to silence it just flickered back on, since stopping
  // only changes `voice.isListening` - not `phase`/`voice.mode` - which is
  // exactly what the effect's guard watches). Reset whenever `phase`
  // changes (a new turn), so the next turn still auto-listens normally.
  const manualStopRef = useRef(false);
  useEffect(() => {
    manualStopRef.current = false;
  }, [phase]);

  // (Silence-detection auto-submit now lives INSIDE useVoiceInput: the hook
  // fires onResult exactly once per listening session after the transcript
  // stays stable for VOICE_SILENCE_FINALIZE_MS. The screen-level detector
  // that used to live here was a SECOND submit path on top of the hook's own
  // onSpeechResults firing, which double-submitted every utterance.)

  // Auto re-enable voice listening as soon as VIVA finishes speaking, so the
  // student can respond without tapping the mic. If STT fails, useVoiceInput
  // flips voice.mode to 'text_fallback' on its own, which makes the guard
  // below false on the next render - no retry loop needed.
  useEffect(() => {
    const shouldAutoListen =
      phase === 'awaiting_input' &&
      voice.mode === 'voice' &&
      !voice.isListening &&
      !voice.isProcessing &&
      !manualStopRef.current;
    if (shouldAutoListen) {
      voice.startListening();
    }
  }, [phase, voice, voice.mode, voice.isListening, voice.isProcessing, voice.startListening]);

  // Safety net: stop listening once the session first reaches 'done'. Only
  // fires on the phase transition itself (guarded by prevPhaseRef) - not on
  // every re-render while phase stays 'done' - otherwise it fights any
  // manual mic press on the solution screen (mic flips isListening=true,
  // this effect immediately stops it again since `voice` is a new object
  // every render and phase is still 'done').
  const prevPhaseRef = useRef(phase);
  useEffect(() => {
    const justEnteredDone = phase === 'done' && prevPhaseRef.current !== 'done';
    prevPhaseRef.current = phase;
    if (justEnteredDone && voice.isListening) {
      voice.stopListening();
    }
  }, [phase, voice]);

  // 사용자가 답을 제출해 VIVA가 채점/생각을 시작하면(evaluating) 마이크를 확실히
  // 끈다. 이제 명확히 "VIVA 차례"이므로 마이크가 계속 켜져 있으면 안 되고(자기
  // 목소리를 다시 듣거나, 사용자가 답을 마쳤는데도 켜져 있는 것처럼 보이는 문제),
  // 다음 사용자 차례(awaiting_input)가 되면 위의 자동 재개 로직이 다시 켜준다.
  // 'speaking'은 일부러 제외한다 - 그 구간의 마이크 켜짐은 사용자가 끼어들려고
  // 직접 누른 것이므로 끊으면 안 된다.
  useEffect(() => {
    if (phase === 'evaluating' && voice.isListening) {
      voice.stopListening();
    }
  }, [phase, voice]);

  // 1. Initialize FSM Session on Mount
  useEffect(() => {
    if (conversation?.initialAnalysis) {
      // 재촬영으로 돌아온 경우(resumeSession) 직전 세션의 id/history/카운터를
      // 그대로 이어간다. 새 id 를 뽑으면 대화 맥락이 통째로 날아가고, 같은
      // 튜터링이 DB 에 두 개의 세션 row 로 쪼개진다.
      startSession(
        conversation.initialAnalysis,
        conversation.resumeSession
          ? {
              ...conversation.resumeSession,
              problemImageBase64: conversation.problemImageBase64,
              photoSource: conversation.photoSource,
            }
          : {
              sessionId:
                conversation.initialAnalysis.fsm_state === 'ERROR'
                  ? `error-${Date.now()}`
                  : `session-${Date.now()}`,
              problemImageBase64: conversation.problemImageBase64,
              photoSource: conversation.photoSource,
            },
        // 재촬영 복귀(resumeSession)면 initialQuestion 을 넘기지 않는다: 그
        // 발화는 재촬영을 유발한 ERROR 턴(또는 폰 폴백 동의 인터셉트)에서 이미
        // history 에 기록됐고, 스냅샷이 그 history 를 통째로 승계한다 - 또
        // 넘기면 같은 발화가 이력에 두 번 쌓인다 (FSM 의 pi 재촬영 경로가
        // initialQuestion 을 비우는 것과 같은 규칙). 분석 문맥은 seed.history
        // 가 이미 실어 나른다 (sessionFromSeed).
        conversation.resumeSession ? undefined : conversation.initialQuestion,
        conversation.initialUsage,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation]);

  // 2. Fetch Board Image when FSM indicates board requirement.
  // This uses the raw per-turn flag from Gemini (not the "sticky" display
  // flag below) - it should only fetch/regenerate when Gemini actually
  // asked for it this turn.
  const rawRequiresBoard = fsmConversation?.requires_board ?? false;
  const boardUpdateNeeded = fsmConversation?.board_update_needed ?? false;
  const boardPrompt = fsmConversation?.board_prompt ?? '';

  useEffect(() => {
    if (!rawRequiresBoard) return;

    // 이미지 모델을 부르는 경우 (스펙 2026-07-30, BOARD_PROMPT_POLICY 와 대칭):
    //  1) 전사: 사진은 있는데 판서가 아직 없다 - 순수 전사 1장.
    //  2) 판서 수정: board_update_needed + board_prompt 가 온 턴 - 전사본을
    //     base 로 수정 1장. SOLVE_STAGE 풀이 시각화가 대표지만, 힌트 턴도
    //     annotations 로 못 그리는 새 획(보조선·개형 등)이 필요하면 프롬프트
    //     예외 조항에 따라 이 플래그를 켠다 (예전 SOLVE_STAGE 전용 게이트는
    //     그 힌트 판서 요청을 조용히 버렸다 - "풀이 이미지가 안 나온다" 증상).
    //  (사진 없는 개념 질문은 기존처럼 board_prompt 로 생성/업데이트.)
    // 일반 힌트 턴은 이미지 호출 없음 - annotations 오버레이가 그린다.
    const hasPhoto = !!session.problemImageBase64 && session.problemImageBase64.trim().length > 0;
    const hasBoard = !!session.lastBoardImageBase64;
    let instruction: string | null = null;
    if (!hasPhoto) {
      if (boardPrompt && (boardUpdateNeeded || !hasBoard)) instruction = boardPrompt;
    } else if (!hasBoard) {
      // 첫 판서. 기본은 순수 전사지만, 이미 정답 공개가 확정된 턴(바로 정답
      // 모드 첫 턴 / 손풀이가 이미 정답)이라면 학생이 볼 판서는 문제 전사가
      // 아니라 풀이 과정이어야 한다 - 예전엔 무조건 전사여서 SOLVE_STAGE 의
      // ANSWER POLICY("최종 답을 그려라")와 TRANSCRIPTION ONLY 가 한 요청에서
      // 충돌했다 (2026-07-31 프롬프트 감사 #5, 사용자 확정: 풀이 판서로 전환).
      instruction =
        session.fsmState === 'SOLVE_STAGE' && boardPrompt ? boardPrompt : TRANSCRIPTION_INSTRUCTION;
    } else if (boardUpdateNeeded && boardPrompt) {
      instruction = boardPrompt;
    }
    if (!instruction) {
      // requires_board 는 왔는데 아무것도 안 그리기로 한 턴 - 왜 스킵됐는지
      // 게이트 값을 남긴다 ("판서가 안 나온다" 재발 시 이 로그가 답이다).
      console.log(
        `[BoardView] board gen skipped: fsm=${session.fsmState} hasPhoto=${hasPhoto} ` +
          `hasBoard=${hasBoard} updateNeeded=${boardUpdateNeeded} prompt=${boardPrompt ? 'set' : 'empty'}`,
      );
      return;
    }
    const effectiveInstruction = instruction;

    const fetchBoardImage = async () => {
      {
        setIsBoardLoading(true);
        try {
          // usage 는 도착하는 대로 모아뒀다 splice 로 "아직 반영 안 한 것만"
          // 흘려보낸다 - 1차본 표시(onDraft) 시점과 최종 반영 시점이 나뉜다.
          const imageUsages: TokenUsage[] = [];
          const textUsages: TokenUsage[] = [];
          const result = await generateVerifiedBoardImage(
            session.problemImageBase64,
            effectiveInstruction,
            session,
            {
              onImageUsage: (usage) => {
                imageUsages.push(usage);
              },
              onTextUsage: (usage) => {
                textUsages.push(usage);
              },
              // 1차 생성본을 즉시 화면에 건다. 검증+재생성(최악 ~20초+)까지
              // 기다리면 판서가 안 나오는 것처럼 보인다 (실기기 피드백
              // 2026-07-29 2차). 재생성본이 나오면 아래에서 교체된다.
              onDraft: async (draft) => {
                const small = await downscaleBoard(draft);
                setIsBoardLoading(false);
                updateBoardData(small, undefined, {
                  boardPrompt: effectiveInstruction,
                  imageUsages: imageUsages.splice(0),
                });
              },
              // 검증 첨부도 표시용과 같은 1280px JPEG 로 - 1K 원본 base64
              // 업로드(~2-3MB)가 검증 지연의 큰 몫이었다.
              prepareVerifyImage: downscaleBoard,
            },
            // 사진 세션은 항상 크롭 사진을 base 로 캔버스 전체 재생성한다
            // (실기기 피드백 2026-07-30: "전사본 base 수정" 경로의 풀이
            // 이미지 품질이 나빠 롤백 - FAITHFUL-TRANSCRIPTION RULES +
            // GROUND TRUTH 가 문제 보존을 강제한다). 사진 없는 개념 질문만
            // 직전 판서를 base 로 수정한다.
            session.problemImageBase64?.trim() ? undefined : session.lastBoardImageBase64,
          );
          debugRecordBoard(session.sessionId, result.debug);
          // 재생성 상한까지 불합격이어도 마지막 교정본을 그대로 쓴다 - 예전
          // "원본 사진 폴백" 은 실기기 피드백(2026-07-30)으로 폐기. 판정은
          // debug.verify 에 남는다.
          if (result.debug.regenerated) {
            // 검증 불합격 -> 교정본으로 교체 (새 생성이므로 updateBoardData).
            updateBoardData(await downscaleBoard(result.imageBase64), undefined, {
              boardPrompt: effectiveInstruction,
              imageUsages: imageUsages.splice(0),
              textUsages: textUsages.splice(0),
            });
          } else if (imageUsages.length || textUsages.length) {
            // 통과/검증실패 - 이미지는 이미 걸려 있고 검증 호출 비용만 남았다.
            addBoardUsage({
              imageUsages: imageUsages.splice(0),
              textUsages: textUsages.splice(0),
            });
          }
        } catch (err) {
          console.error('[BoardView] Failed to generate board image:', err);
        } finally {
          setIsBoardLoading(false);
        }
      }
    };

    fetchBoardImage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawRequiresBoard, boardUpdateNeeded, boardPrompt]);

  // Which view to show. Once a board has been shown for this problem, keep
  // showing it through the rest of the conversation so the student can refer to it.
  // Gemini may optionally update the board during SOLVE_STAGE as well.
  const requiresBoard = rawRequiresBoard || !!session.lastBoardImageBase64;

  // Toggle PTT / microphone listening. If VIVA is still mid-sentence, tapping
  // the mic means "I'm answering now" - cut her off immediately rather than
  // letting her keep talking over the student. speakAndWait() picks up the
  // interruption as a normal playback-finished signal and advances `phase`,
  // so the student's answer is evaluated against the question she was just
  // asking (nothing is skipped).
  const handleMicPress = useCallback(() => {
    if (voice.isListening) {
      manualStopRef.current = true;
      voice.stopListening();
      return;
    }
    manualStopRef.current = false;
    if (phase === 'speaking') {
      stopSpeaking();
    }
    voice.startListening();
  }, [voice, phase]);

  // Map FSM status and phase to custom eye shapes
  const getEyeState = (): EyeState => {
    if (session.fsmState === 'ERROR') {
      return 'idle'; // error shows retry screen, eyes are idle / resting
    }
    // 전사·채점·판서 생성. **isListening 보다 먼저 본다** - 전사 도중 자동
    // 재청취가 마이크를 한 박자 먼저 켜는 순간이 있어서, 순서가 반대면 그
    // 사이에 표정이 한 번 튄다(getStatusSlot 이 같은 이유로 같은 순서다).
    if (voice.isProcessing || phase === 'evaluating' || isBoardLoading) {
      return 'listening';
    }
    // 학생이 말하는 중(마이크 열림). 침묵 600ms 구간(voice.isSettling)도
    // 여기 포함된다 - isSettling 은 isListening 이 true 일 때만 켜지므로
    // 같은 값으로 접힌다. 그래서 지금 매핑에는 "다 들었다" 눈 전환이 없다
    // (2026-08-07 사용자 지정). 되살리려면 isSettling 을 다른 상태로 가른다.
    if (voice.isListening) {
      return 'processing';
    }
    // VIVA 가 말하는 중, 그리고 마이크가 아직 안 열린 사이 구간.
    return 'listening';
  };
  const eyeState = getEyeState();

  // Single source of truth for what (if anything) occupies the bottom
  // status row, so exactly one of {listening guide, TTS subtitle, loading
  // dots} is ever shown - never stacked/overlapping. The text-fallback
  // input bar and the mic button are handled separately.
  //
  // There is no separate full-screen "evaluating" overlay: BoardView and
  // CharacterView already switch their own centered eyes to the
  // "processing" look while evaluating (see getEyeState() / BoardView's
  // no-image placeholder), so a second overlaid processing-eyes layer was
  // redundant and made the "thinking" scene look doubled/inconsistent.
  type StatusSlot =
    | { kind: 'listening'; subtitle?: string }
    | { kind: 'thinking'; subtitle?: string }
    | { kind: 'subtitle'; text: string }
    | { kind: 'loading'; label?: string }
    | { kind: 'none' };

  const getStatusSlot = (): StatusSlot => {
    // In text_fallback only the mic 'listening' guide is irrelevant - the
    // subtitle/loading slots must stay visible (they used to be dropped
    // entirely here, so students who fell back to the keyboard never saw
    // VIVA's subtitles - the row also sat hidden underneath the keyboard).
    //
    // While listening, VIVA's last subtitle stays on screen too (smaller,
    // above the live mic-level meter) instead of being replaced by it - the
    // student should be able to see exactly what she said while they're
    // forming their answer.
    // "VIVA 가 일하는 중" 은 두 구간이다: 발화 전사(voice.isProcessing)와
    // 채점(phase==='evaluating'). 둘 다 같은 thinking 슬롯 - 작은 자막은
    // 그대로 두고 마이크 미터 자리에 로딩 닷이 들어온다.
    //
    // isProcessing 이 빠져 있던 게 "대답 끝났는데 방금 그 질문이 큰 검은
    // 자막으로 다시 뜬다" 의 원인이었다: 전사 중(0.5~3초)에는 phase 가 아직
    // 'awaiting_input' 이라 아래 자막 분기로 떨어졌고, statusSlotKey 가 바뀌며
    // 페이드+슬라이드까지 다시 돌아 비바가 같은 말을 반복하는 것처럼 보였다.
    //
    // isListening 보다 **먼저** 본다. 전사 도중 자동 재청취가 마이크를 다시
    // 켜더라도(아래 shouldAutoListen) 로딩 닷이 계속 이겨야 한다 - 순서가
    // 반대였을 땐 그 사이 내내 청취 UI 가 떠서 닷이 맨 마지막에 나왔다.
    if (voice.isProcessing || phase === 'evaluating') {
      return { kind: 'thinking', subtitle: currentSubtitle || undefined };
    }
    if (voice.isListening) {
      return { kind: 'listening', subtitle: currentSubtitle || undefined };
    }
    // 'awaiting_input' covers the gap between TTS finishing and the mic
    // actually flipping isListening (startListening awaits stop() + a fixed
    // 300ms debounce before setListening(true) - useVoiceInput.ts). Without
    // this branch the subtitle fell through to 'none' for that whole window
    // and then popped back in once isListening caught up: a visible
    // disappear/reappear flicker on every turn. Keeping it in the same
    // subtitle-preserving branch as 'speaking' closes that gap.
    if (phase === 'speaking' || phase === 'awaiting_input') {
      if (currentSubtitle) return { kind: 'subtitle', text: currentSubtitle };
      return phase === 'awaiting_input' ? { kind: 'none' } : { kind: 'loading' };
    }
    if (isBoardLoading) return { kind: 'loading' };
    return { kind: 'none' };
  };

  const statusSlot = getStatusSlot();
  // Primitive identity for the CURRENT status row content, so the crossfade
  // effect below can key off it without re-triggering every render (the
  // statusSlot object itself is a fresh literal every render). Deliberately
  // excludes voice.micLevel (changes on every audio chunk) so the fade-in
  // doesn't restart mid-utterance.
  const statusSlotKey = `${statusSlot.kind}${statusSlot.kind === 'subtitle' ? `|${statusSlot.text}` : ''}${statusSlot.kind === 'loading' && statusSlot.label ? `|${statusSlot.label}` : ''}${(statusSlot.kind === 'listening' || statusSlot.kind === 'thinking') && statusSlot.subtitle ? `|${statusSlot.subtitle}` : ''}`;

  // Fade the status row in whenever its CONTENT changes (subtitle text
  // updates, or it swaps between subtitle/listening/loading). Previously
  // only the subtitle text swap animated in - the listening -> loading
  // transition (mic closes after ~1.5s silence, transcription starts) had
  // no animation on either side, so the subtitle vanished and the loading
  // dots popped in on the exact same frame: a hard, jarring "blink" right
  // as the student finished talking. Fading every kind in (even though the
  // outgoing one still disappears instantly) softens that cut enough that
  // it reads as a transition instead of a flicker.
  useEffect(() => {
    subtitleAnim.setValue(0);
    Animated.timing(subtitleAnim, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [statusSlotKey, subtitleAnim]);

  // Status row rides above the text-input bar (and the keyboard) in
  // text_fallback mode; otherwise it sits in the shared bottom row.
  const statusBottom =
    voice.mode === 'text_fallback' ? safeBottom + keyboardHeight + 56 : safeBottom;

  // Shared by every manual "the student wants to respond now" entry point
  // (mic tap, switching to keyboard, submitting typed text) - cuts VIVA off
  // immediately if she's still talking, per the same reasoning as
  // handleMicPress above.
  const interruptIfSpeaking = useCallback(() => {
    if (phase === 'speaking') {
      stopSpeaking();
    }
  }, [phase]);

  const handleSwitchToText = useCallback(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    voice.switchToTextFallback();
  }, [voice]);

  const handleSubmitTypedText = useCallback(() => {
    const text = inputText.trim();
    if (text.length === 0) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    interruptIfSpeaking();
    voice.submitText(text);
    setInputText('');
    voice.switchToVoice();
  }, [inputText, voice, interruptIfSpeaking]);

  const handleDismissInputs = useCallback(() => {
    if (voice.isListening) {
      manualStopRef.current = true;
      voice.stopListening();
    }
    if (voice.mode === 'text_fallback') {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      voice.switchToVoice();
    }
  }, [voice]);

  const handleToggleSolveMode = useCallback(() => {
    Keyboard.dismiss();
    onToggleSolveMode();
    if (!solveMode && phase !== 'done' && phase !== 'idle') {
      interruptIfSpeaking();
      // onToggleSolveMode() above only schedules the parent's state update -
      // solveMode here is still the pre-toggle value, so pass the intended
      // new value straight through instead of waiting a render for it.
      submitStudentInput('답 알려줘', { directSolveMode: true });
    }
  }, [onToggleSolveMode, solveMode, phase, interruptIfSpeaking, submitStudentInput]);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={undefined}>
      <Pressable
        style={styles.container}
        onPress={handleDismissInputs}
        testID="conversation-screen"
      >
        {/* Back to Home Button */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="홈으로 이동"
          testID="back-to-home-button"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={({ pressed }) => [
            styles.backButton,
            { top: safeTop },
            pressed && styles.backButtonPressed,
          ]}
          onPress={onSessionComplete}
        >
          <Text style={styles.backButtonText}>‹</Text>
        </Pressable>

        <SolveModeToggle enabled={solveMode} onToggle={handleToggleSolveMode} safeTop={safeTop} />

        {requiresBoard ? (
          <BoardView
            boardImageBase64={session.lastBoardImageBase64}
            annotations={fsmConversation?.annotations}
            isListening={voice.isListening}
            onMicPress={handleMicPress}
            showMic={voice.mode === 'voice'}
            bottom={safeBottom}
            showEyes
          />
        ) : (
          <CharacterView
            state={eyeState}
            isListening={voice.isListening}
            onMicPress={handleMicPress}
            showMic={voice.mode === 'voice'}
            bottom={safeBottom}
            showEyes
            centerSubtitle={
              statusSlot.kind === 'subtitle' ? cleanTextForSubtitle(statusSlot.text) : undefined
            }
          />
        )}

        {/* Keyboard Input Fallback Trigger Button - sits left of the mic,
         * which is now always bottom-right in both Board/CharacterView. */}
        {voice.mode === 'voice' && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="키보드로 입력"
            testID="keyboard-fallback-trigger"
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={[styles.keyboardTriggerButton, { bottom: safeBottom }]}
            onPress={handleSwitchToText}
          >
            <Image
              source={require('../../assets/icons/keyboard.png')}
              style={styles.keyboardTriggerIcon}
            />
          </Pressable>
        )}

        {/* STT Text Fallback Input Bar */}
        {voice.mode === 'text_fallback' && (
          <View style={[styles.textInputBar, { bottom: safeBottom + keyboardHeight }]}>
            <Pressable
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              onPress={() => {
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                interruptIfSpeaking();
                voice.switchToVoice();
                voice.startListening();
              }}
              style={styles.inputLeftButton}
            >
              <Image source={require('../../assets/icons/mic.png')} style={styles.inputLeftIcon} />
            </Pressable>

            <TextInput
              autoFocus={true}
              placeholder={
                voice.errorMessage
                  ? voice.errorMessage.toLowerCase().includes('permission')
                    ? '마이크 권한을 허용해주세요. (키보드로 입력)'
                    : '마이크를 확인할 수 없습니다. 텍스트 입력을 시도해주세요.'
                  : '답변을 여기에 입력해 주세요...'
              }
              placeholderTextColor="rgba(43, 41, 38, 0.5)"
              value={inputText}
              onChangeText={setInputText}
              onSubmitEditing={handleSubmitTypedText}
              style={styles.textInput}
              returnKeyType="send"
              testID="text-fallback-input"
            />

            <Pressable
              disabled={inputText.trim().length === 0}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              onPress={handleSubmitTypedText}
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

        {/* Unified bottom status row - exactly one of {listening guide, TTS
         * subtitle, loading dots} at a time, fixed above the mic/text-input
         * row so the two never overlap. */}
        {statusSlot.kind === 'listening' && (
          <Animated.View
            style={[styles.statusRow, { bottom: statusBottom, opacity: subtitleAnim }]}
            pointerEvents="none"
          >
            {statusSlot.subtitle && (
              <Text style={styles.subtitleTextSmall} numberOfLines={2}>
                {cleanTextForSubtitle(statusSlot.subtitle)}
              </Text>
            )}
            <MicLevelIndicator level={voice.micLevel} />
          </Animated.View>
        )}

        {statusSlot.kind === 'thinking' && (
          <Animated.View
            style={[styles.statusRow, { bottom: statusBottom, opacity: subtitleAnim }]}
            pointerEvents="none"
          >
            {statusSlot.subtitle && (
              <Text style={styles.subtitleTextSmall} numberOfLines={2}>
                {cleanTextForSubtitle(statusSlot.subtitle)}
              </Text>
            )}
            <LoadingDots />
          </Animated.View>
        )}

        {statusSlot.kind === 'subtitle' && (
          <Animated.View
            style={[
              styles.statusRow,
              { bottom: statusBottom },
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
            <Text style={styles.subtitleText}>{cleanTextForSubtitle(statusSlot.text)}</Text>
          </Animated.View>
        )}

        {statusSlot.kind === 'loading' && (
          <Animated.View
            style={[styles.statusRow, { bottom: statusBottom, opacity: subtitleAnim }]}
            pointerEvents="none"
          >
            <LoadingDots label={statusSlot.label} />
          </Animated.View>
        )}
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: APP_BACKGROUND_COLOR,
  },
  textInputBar: {
    position: 'absolute',
    bottom: 22,
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
  keyboardTriggerButton: {
    position: 'absolute',
    // Left of the mic, which is always at right:22/bottom:22 in both
    // Board/CharacterView now, so this fixed position never collides with it.
    right: 78,
    bottom: 22,
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
  // Minimal chevron, no background/border - just an affordance to go back,
  // not a competing "surface" button (per design feedback: it shouldn't
  // look like another floating pill alongside the mic/keyboard buttons).
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
    opacity: 0.5,
  },
  backButtonText: {
    fontSize: 30,
    fontWeight: '400',
    color: '#2B2926',
    lineHeight: 34,
  },
  // 마이크/키보드 버튼과 같은 줄(bottom:22)이라 양옆을 비워 피한다.
  // 오른쪽에 실제로 뭐가 있는지(화면 오른쪽 끝에서 잰 값):
  //   마이크        right:22, 폭 44  -> 22~66   (BoardView/CharacterView)
  //   키보드 트리거  right:78, 폭 44  -> 78~122  (이 파일)
  // 예전 값 80 은 마이크만 보고 정한 숫자라 키보드 버튼을 42px 침범했고,
  // statusRow 의 zIndex(30)가 버튼(20)보다 높아 자막이 버튼 위에 겹쳐 그려졌다.
  // 136 이면 122 를 14px 여유로 비껴간다 - 마이크만 있던 시절 80 이 66 에 대해
  // 두던 여유와 같은 값이다. 왼쪽도 같은 값을 줘야 가운데 정렬이 화면 중앙에
  // 맞는다(왼쪽 아래엔 아무것도 없어서 순전히 대칭용).
  // 버튼 위치를 바꾸면 이 숫자도 같이 바꿔야 한다.
  //
  // 퍼센트(maxWidth) 로 하지 않는 이유: 버튼이 고정 픽셀 오프셋이라 화면이
  // 넓어질수록 퍼센트는 과하게 좁아지고 좁으면 모자란다.
  statusRow: {
    position: 'absolute',
    left: 136,
    right: 136,
    // minHeight (not height): a long multi-line subtitle must grow UPWARD
    // from its bottom anchor - a fixed 44px box centered its overflow both
    // ways, so the bottom half slid behind the text-input bar / keyboard.
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 30,
  },
  subtitleText: {
    fontSize: 16,
    color: '#2B2926',
    fontWeight: '600',
    fontFamily: 'Pretendard',
    textAlign: 'center',
    lineHeight: 22,
    textShadowColor: 'rgba(255, 255, 255, 0.95)',
    textShadowOffset: { width: 0, height: 1.5 },
    textShadowRadius: 3,
  },
  subtitleTextSmall: {
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

export function cleanTextForSubtitle(text: string): string {
  return cleanMathForSubtitle(text);
}

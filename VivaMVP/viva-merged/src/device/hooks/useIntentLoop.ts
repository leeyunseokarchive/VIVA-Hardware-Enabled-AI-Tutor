/**
 * 의도파악 루프 (2026-08-12 스펙). 호출 직후:
 *   [병렬 A] 인사 → 녹음 → 전사+분류 → 분기
 *   [병렬 B] 촬영 → 경량 문제감지 (detectProblems)
 * solve → 크롭+풀분석 후 onAnalyzed 로 기존 튜터링 파이프라인 핸드오프.
 * concept → explainConcept 경량 설명 루프 (힌트 FSM 안 탐).
 * unclear/무응답 → 종료 문구 후 onExit.
 *
 * 의존성은 전부 주입 가능 (useVoiceInput 의 어댑터 주입 규칙과 동일) —
 * 테스트는 모듈 mock 없이 fake deps 로 돈다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImageSourcePropType } from 'react-native';
import { analyzeImage, detectProblems, explainConcept } from '../../services/gemini.service';
import { fetchConcepts } from '../../services/concepts.service';
import type { ConceptInfo } from '../../services/concepts.service';
import { transcribeAndClassify, classifyText } from '../../services/geminiStt.service';
import { speak } from '../../services/tts.service';
import { generateVerifiedBoardImage } from '../../services/board.service';
import {
  capturePhotoNow,
  fetchPiAudioBase64,
  fetchPiPhotoBase64,
  fetchPiPhotoCropBase64,
  fetchPiRecordStatus,
  startPiRecording,
  stopPiRecording,
} from '../services/piBridge.service';
import { connectionMonitor } from '../services/connectionMonitor.service';
import { eyeSyncService } from '../services/eyeSync.service';
import { buildSystemPrompt } from '../../prompts/system_prompt';
import { extractProblemNumber, matchProblemLabel } from '../../utils/problemChoice';
import { cleanMathForTTS, cleanMathForSubtitle } from '../../utils/mathTextProcessor';
import { buildSubtitleSchedule, splitIntoSentences } from '../../utils/subtitleSchedule';
import type { PiRecordStatus } from '../services/piBridge.service';
import { saveSession, saveBoardImage } from '../../services/sessionHistory.service';
import { EMPTY_USAGE_SUMMARY } from '../../types/ApiUsage';
import type { SessionHistoryEntry, SavedBoardImage } from '../../types/SessionHistory';
import type { GeminiTutoringResponse, ProblemBox, TutoringSession } from '../../types/Tutoring';
import type { TokenUsage } from '../../types/ApiUsage';
import type { StudentIntent } from '../../services/geminiStt.service';
import type { EyeState } from '../../components/EyeAnimation';

// 고정 발화 — 모델 호출 0. tts.service 가 80자 이하 고정문구를 캐시한다.
export const GREETING_PHRASE = '안녕! 무엇이 궁금해?';
export const FILLER_PHRASE = '잠깐만, 책상 좀 볼게!';
export const MULTI_PROBLEM_QUESTION = '책상 위에 문제가 여러 개 보이네. 몇 번이 궁금해?';
export const NO_SPEECH_EXIT_PHRASE = '조금 더 생각해보고 필요하면 다시 불러줘!';
export const UNCLEAR_EXIT_PHRASE = '수학 개념이나 문제가 궁금하면 다시 불러줘!';
export const CONCEPT_EXIT_PHRASE = '또 궁금한 거 있으면 언제든 불러줘!';
/** 발화에 번호가 있는데 감지 결과에 없을 때 (동적 문구 — TTS 캐시 미대상). */
export const buildRecheckPhrase = (n: number) =>
  `책상에 ${n}번 문제가 보이지 않아서, 다시 확인해볼게!`;
const FIXED_PHRASE_RATE = 1.0; // useTutoringFSM.FIXED_PHRASE_RATE 와 동일 값

// 의도루프 안전 상한 — 학생이 개념 질문을 이어가는 정상 루프는 무응답으로
// 끝나므로 이 상한은 폭주 방지용이다.
const MAX_TURNS = 10;

export interface UseIntentLoopOptions {
  session: TutoringSession;
  solveMode: boolean;
  /** solve 확정 + 풀 분석 완료. App 이 handleAnalyzed(r, img, 'pi', q) 로 잇는다. */
  onAnalyzed: (
    response: GeminiTutoringResponse & { usage: TokenUsage },
    imageBase64: string,
    initialQuestion: string,
    parentConceptSessionId?: string,
  ) => void;
  /** Pi 촬영 2회 실패 + Pi 생존 시 폰 카메라 폴백. */
  onPhoneCamera: (question?: string) => void;
  /** 종료(무응답·unclear·Pi 사망). App 의 handleResetToIdle. */
  onExit: () => void;
  deps?: Partial<IntentLoopDeps>;
  pollIntervalMs?: number; // 기본 500
  noSpeechTimeoutMs?: number; // 기본 8000
  captureDelayMs?: number; // 기본 Number(process.env.EXPO_PUBLIC_INTENT_CAPTURE_DELAY_MS ?? '0')
}

export interface UseIntentLoopResult {
  begin: () => Promise<void>; // 1회용 — IntentScreen 마운트 시 호출
  phase: 'greeting' | 'listening' | 'thinking' | 'speaking' | 'analyzing' | 'done';
  subtitle: string;
  boardImageBase64: string | null;
  /** 등록 개념(concept_id) 히트 시 표시하는 검수된 Storage asset({uri}) —
   * 있으면 boardImageBase64 보다 우선한다 (concepts.service.ts, WS1). */
  boardAsset: ImageSourcePropType | null;
  /** listening 중 Pi record/status 의 실측 RMS(0~1) — MicLevelIndicator 용.
   * 폴링 주기(기본 500ms)로만 갱신되고 청취가 끝나면 0. */
  micLevel: number;
  /** 'voice' = 자동 청취(마이크), 'text' = 키보드 입력창 표시. */
  inputMode: 'voice' | 'text';
  /** 키보드 입력으로 전환 — 현재 청취 턴은 submitText 전까지 열려 있고
   * 무응답 타임아웃도 멈춘다. */
  switchToText: () => void;
  /** 음성(자동 청취)으로 복귀. 청취 중이면 무응답 타임아웃도 리셋한다. */
  switchToVoice: () => void;
  /** 타이핑한 문장을 현재(또는 다음) 청취 턴에 주입해 루프를 진행시킨다. */
  submitText: (text: string) => void;
}

export interface IntentLoopDeps {
  speak: typeof speak;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  fetchRecordStatus: () => Promise<PiRecordStatus>;
  fetchAudio: () => Promise<string>;
  capturePhoto: () => Promise<void>;
  fetchPhoto: () => Promise<string>;
  fetchCrop: (box2d: number[]) => Promise<string>;
  detect: typeof detectProblems;
  classify: typeof transcribeAndClassify;
  classifyText: typeof classifyText;
  explain: typeof explainConcept;
  fetchConcepts: () => Promise<ConceptInfo[]>;
  analyze: typeof analyzeImage;
  generateBoard: (
    boardPrompt: string,
    session: TutoringSession,
    previousBoardBase64?: string,
  ) => Promise<{ imageBase64: string }>;
  probeNow: () => Promise<boolean>;
  sendEyeState: (s: EyeState) => void;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: IntentLoopDeps = {
  speak,
  startRecording: startPiRecording,
  stopRecording: stopPiRecording,
  fetchRecordStatus: fetchPiRecordStatus,
  fetchAudio: fetchPiAudioBase64,
  capturePhoto: capturePhotoNow,
  fetchPhoto: fetchPiPhotoBase64,
  fetchCrop: fetchPiPhotoCropBase64,
  detect: detectProblems,
  classify: transcribeAndClassify,
  classifyText,
  explain: explainConcept,
  fetchConcepts,
  analyze: analyzeImage,
  generateBoard: async (boardPrompt, session, prev) => {
    const res = await generateVerifiedBoardImage('', boardPrompt, session, {}, prev);
    return { imageBase64: res.imageBase64 };
  },
  probeNow: () => connectionMonitor.probeNow(),
  sendEyeState: (s) => eyeSyncService.sendEyeState(s),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

interface DeskScan {
  photo: string;
  problems: ProblemBox[];
  usage?: TokenUsage;
}

/** listenOnce 결과 — 음성 청취(wav, 무발화면 null) 또는 키보드 텍스트. */
type ListenResult = { kind: 'audio'; wav: string | null } | { kind: 'text'; text: string };

export function useIntentLoop(options: UseIntentLoopOptions): UseIntentLoopResult {
  const [phase, setPhase] = useState<UseIntentLoopResult['phase']>('greeting');
  const [subtitle, setSubtitle] = useState('');
  const [boardImageBase64, setBoardImage] = useState<string | null>(null);
  const [boardAsset, setBoardAsset] = useState<ImageSourcePropType | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [inputMode, setInputMode] = useState<'voice' | 'text'>('voice');

  // 키보드 입력 배선용. listenOnce 가 이 resolver 를 걸어두면 submitText 가
  // 현재 청취를 텍스트로 마감한다. textModeRef=true 인 동안엔 오디오로 마감
  // 하지 않고(무응답 타임아웃 포함) submitText 만 턴을 끝낸다. voiceBaseRef 는
  // 무응답 타임아웃 기준 시각 — 텍스트→음성 복귀 시 리셋해 타이핑에 쓴 시간이
  // 즉시 타임아웃되지 않게 한다. pendingTextRef 는 청취 시작 전(비바 발화 중)에
  // 미리 제출된 텍스트를 다음 청취가 집어가게 하는 큐.
  const typedResolveRef = useRef<((text: string) => void) | null>(null);
  const textModeRef = useRef(false);
  const voiceBaseRef = useRef(0);
  const pendingTextRef = useRef<string | null>(null);

  const deps: IntentLoopDeps = { ...defaultDeps, ...options.deps };
  const pollMs = options.pollIntervalMs ?? 200; // 500 -> 200 (Track B): 종료 판정 꼬리 지연 축소
  const noSpeechMs = options.noSpeechTimeoutMs ?? 8000;
  const captureDelayMs =
    options.captureDelayMs ?? Number(process.env.EXPO_PUBLIC_INTENT_CAPTURE_DELAY_MS ?? '0');

  // TTFT 계측 기준점 - 녹음 종료(학생 발화 끝) 판정 순간. 각 단계는
  // [TTFT] 태그 로그로 남고 runConceptTurn 의 onPlay 에서 total 이 찍힌다.
  const ttftT0Ref = useRef(0);

  const startedRef = useRef(false);
  const scanRef = useRef<Promise<DeskScan> | null>(null);
  const scanDoneRef = useRef<DeskScan | null>(null);
  const historyRef = useRef<{ role: 'user' | 'model'; message: string }[]>([]);
  const lastBoardRef = useRef<string | undefined>(undefined);
  const hadConceptTurnRef = useRef(false);
  // 개념 대화 세션 레코드용 — begin() 시작 시 id 를 찍고, 개념 판서 이미지를
  // 모아 saveConceptSession 이 SessionHistoryEntry 로 저장한다. solve 로 넘어가면
  // 이 id 가 parentConceptSessionId 로 링크된다.
  const conceptSessionIdRef = useRef<string | null>(null);
  const conceptBoardImagesRef = useRef<SavedBoardImage[]>([]);
  // 종료(모든 terminal 콜백) 표지 — scanDesk 가 종료 후에도 detect 를 쏘는
  // 낭비를 막는 데만 쓴다 (I1). exitWith/runSolve/begin 의 각 terminal
  // 콜백 직전에 세운다.
  const doneRef = useRef(false);
  // 최신 options 미러 — begin() 은 마운트 시 1회 도는 장수 async 라 stale 위험.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // concept 설명 자막 문장별 표시 타이머 (runConceptTurn 이 예약한다).
  const subtitleTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearSubtitleTimers = useCallback(() => {
    subtitleTimersRef.current.forEach(clearTimeout);
    subtitleTimersRef.current = [];
  }, []);
  // 언마운트 후 setSubtitle 이 돌지 않게 타이머를 걷는다.
  useEffect(() => clearSubtitleTimers, [clearSubtitleTimers]);

  // 학생 입력이 확정돼 thinking/analyzing 으로 넘어가면 직전 발화 자막을
  // 지운다 - 안 지우면 speaking 진입~onPlay(TTS 합성 왕복 1~2.5초) 사이에
  // 직전 질문이 큰 자막으로 한 번 더 페이드인했다 (실기기 2026-08-14,
  // ConversationScreen 의 phase 클리어 effect 와 동일 원칙). listening 은
  // 유지 - 학생이 답하는 동안 비바의 질문을 다시 읽을 수 있어야 한다.
  useEffect(() => {
    if (phase === 'thinking' || phase === 'analyzing') {
      clearSubtitleTimers();
      setSubtitle('');
    }
  }, [phase, clearSubtitleTimers]);

  /** [병렬 B] 촬영 → 경량 감지. detect 실패는 삼키고 빈 problems (풀프레임 폴백). */
  const scanDesk = useCallback(async (): Promise<DeskScan> => {
    if (captureDelayMs > 0) await deps.sleep(captureDelayMs);
    await deps.capturePhoto();
    const photo = await deps.fetchPhoto();
    // 루프가 이미 종료됐으면 Gemini 감지 호출은 낭비 — 촬영 자체는 서버측
    // 취소 불가라 여기까진 돈다 (I1).
    if (doneRef.current) return { photo, problems: [] };
    try {
      const det = await deps.detect(photo);
      return { photo, problems: det.problems, usage: det.usage };
    } catch (err) {
      console.warn('[IntentLoop] detect failed - full frame fallback:', err);
      return { photo, problems: [] };
    }
  }, []); // deps/captureDelayMs 는 begin 1회 실행 동안 불변

  /** 학생 입력 1회. 음성(wav base64, 무발화면 null) 또는 키보드 텍스트. */
  const listenOnce = useCallback((): Promise<ListenResult> => {
    return new Promise<ListenResult>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        typedResolveRef.current = null;
        setMicLevel(0);
        fn();
      };
      // 키보드 제출 경로 — 현재 청취를 텍스트로 마감한다.
      typedResolveRef.current = (text: string) => {
        deps.stopRecording().catch(() => {});
        done(() => resolve({ kind: 'text', text }));
      };
      (async () => {
        // 마이크가 실제로 열린 뒤에 'listening' 을 표시한다 - 순서가 뒤집혀
        // 있으면 화면이 먼저 "듣는 중"으로 바뀌어 학생이 마이크 생기기 전에
        // 말을 시작해 첫 마디가 잘렸다(Track B). 실패 시엔 그대로 catch 로
        // 빠져 phase/eye state 를 건드리지 않는다(기존 동작 유지).
        await deps.startRecording();
        // 마이크 여는 왕복 중에 이미 마감됐으면(예: 타이핑 제출이 먼저
        // resolve) UI 를 되돌리지 않는다 - typedResolveRef 경로가 이미
        // stopRecording 까지 처리했으니 여기서 recording 이 새지 않는다.
        if (settled) return;
        setPhase('listening');
        deps.sendEyeState('processing'); // 마이크 열림 = 학생 말하는 중 (D-42 매핑)
        voiceBaseRef.current = Date.now();
        // 비바 발화 중 미리 제출한 텍스트가 있으면 녹음을 바로 접고 텍스트로.
        if (pendingTextRef.current != null) {
          const t = pendingTextRef.current;
          pendingTextRef.current = null;
          await deps.stopRecording().catch(() => {});
          done(() => resolve({ kind: 'text', text: t }));
          return;
        }
        for (;;) {
          if (settled) return;
          await deps.sleep(pollMs);
          if (settled) return;
          // 키보드 입력 중엔 오디오로 마감하지 않는다(무응답 타임아웃 포함) —
          // submitText 만 이 청취를 끝낼 수 있다.
          if (textModeRef.current) continue;
          const st = await deps.fetchRecordStatus();
          setMicLevel(st.rms);
          if (!st.recording) {
            ttftT0Ref.current = Date.now();
            let wav: string | null = null;
            if (st.had_speech) {
              wav = await deps.fetchAudio();
              // wav 크기/추정 길이 - classify 편차(3.3s vs 11.9s)가 오디오
              // 길이 탓인지 detect 업로드 경쟁 탓인지 가르는 계측 (16kHz mono
              // 16bit = 32KB/s).
              const kb = Math.round((wav.length * 3) / 4 / 1024);
              console.log(
                `[TTFT] fetch_audio ${Date.now() - ttftT0Ref.current}ms wav=${kb}KB ~${(kb / 32).toFixed(1)}s`,
              );
            }
            done(() => resolve({ kind: 'audio', wav }));
            return;
          }
          if (!st.had_speech && Date.now() - voiceBaseRef.current >= noSpeechMs) {
            await deps
              .stopRecording()
              .catch((e) => console.warn('[IntentLoop] record stop failed:', e));
            done(() => resolve({ kind: 'audio', wav: null }));
            return;
          }
        }
      })().catch((err) => done(() => reject(err)));
    });
  }, []);

  /** ListenResult → 전사+의도. 무입력(무음/빈 타이핑)이면 null 을 돌려
   * 호출부가 종료 문구로 마감하게 한다. classify 실패는 unclear 로 접는다
   * (기존 오디오 경로와 동일 — begin 의 unclear 분기로 떨어진다). */
  const resolveInput = useCallback(async (res: ListenResult, context: string) => {
    if (res.kind === 'text') {
      if (!res.text.trim()) return null;
      ttftT0Ref.current = Date.now(); // 텍스트 경로 기준점 (녹음 종료가 없다)
      setPhase('thinking');
      deps.sendEyeState('listening');
      try {
        return await deps.classifyText(res.text, context);
      } catch (err) {
        console.warn('[IntentLoop] text classify failed:', err);
        return { transcript: res.text.trim(), intent: 'unclear' as StudentIntent };
      }
    }
    if (!res.wav) return null;
    setPhase('thinking');
    deps.sendEyeState('listening');
    try {
      const t = Date.now();
      const out = await deps.classify(res.wav, context);
      console.log(`[TTFT] classify ${Date.now() - t}ms`);
      return out;
    } catch (err) {
      console.warn('[IntentLoop] classify failed:', err);
      return { transcript: '', intent: 'unclear' as StudentIntent };
    }
  }, []);

  const exitWith = useCallback(async (line: string) => {
    clearSubtitleTimers(); // 설명 자막 타이머가 종료 문구를 덮어쓰지 않게.
    // 무응답 종료는 thinking 을 안 거쳐 위 effect 가 못 지운다 - 여기서도
    // 직전 자막을 지워 종료 문구 onPlay 전 잔상 재페이드인을 막는다.
    setSubtitle('');
    setPhase('speaking');
    deps.sendEyeState('listening'); // VIVA 발화 중 (D-42 매핑)
    // 자막은 onPlay 이후에만 - speak 호출 전 선표시는 TTS 합성 왕복만큼
    // 자막이 나레이션을 앞서게 했다 (runConceptTurn 과 동일 원칙). 합성이
    // 죽어 소리를 못 내는 경우에만 catch 폴백으로 자막을 남긴다.
    await deps
      .speak(line, () => setSubtitle(line), FIXED_PHRASE_RATE)
      .catch(() => setSubtitle(line));
    setPhase('done');
    doneRef.current = true;
    // 늦게 도착한 판서 이미지까지 담아 한 번 더 저장 (개념 턴이 있었을 때만).
    if (hadConceptTurnRef.current) saveConceptSession();
    optionsRef.current.onExit();
  }, []);

  /** solve 분기: 사전분석 결과로 크롭 → 풀 분석 → 핸드오프. */
  const runSolve = useCallback(async (transcript: string) => {
    clearSubtitleTimers(); // 설명 자막 타이머가 이후 화면을 덮어쓰지 않게.
    deps.sendEyeState('listening');
    setPhase('analyzing');
    let scan: DeskScan;
    if (scanDoneRef.current) {
      scan = scanDoneRef.current;
    } else {
      // 사전분석 미완 — 필러 한 마디로 흡수 (스펙 §타이밍). 자막은 onPlay 이후에만.
      await deps
        .speak(FILLER_PHRASE, () => setSubtitle(FILLER_PHRASE), FIXED_PHRASE_RATE)
        .catch(() => setSubtitle(FILLER_PHRASE));
      try {
        scan = await scanRef.current!;
      } catch (err) {
        // 촬영 실패 — Pi 생존 재판정 (beginCapture 의 D-45 정책과 동일).
        console.warn('[IntentLoop] desk scan failed:', err);
        const alive = await deps.probeNow();
        if (!alive) {
          doneRef.current = true;
          optionsRef.current.onExit();
          return;
        }
        try {
          scan = await scanDesk(); // 풀프레임 재시도 1회
        } catch (err2) {
          console.warn('[IntentLoop] rescan failed - phone camera:', err2);
          doneRef.current = true;
          optionsRef.current.onPhoneCamera(transcript);
          return;
        }
      }
    }

    // 발화에 번호가 있으면("524번 어떻게 풀어?") 되묻기 없이 바로 매칭한다.
    // 감지에 그 번호가 없으면 재촬영+재감지 1회 후 재매칭, 그래도 없으면
    // 풀프레임 — 이때 원문 질문에 번호가 남아 모델이 직접 찾는다 (2026-08-14).
    const wanted = extractProblemNumber(transcript);
    let target: ProblemBox | null = null;
    if (wanted !== null) {
      target = matchProblemLabel(transcript, scan.problems);
      if (!target) {
        setPhase('speaking');
        const recheck = buildRecheckPhrase(wanted);
        // 자막은 onPlay 이후에만 (exitWith/필러와 동일 원칙) - speak 전
        // 선표시는 TTS 합성 왕복만큼 자막이 나레이션을 앞서게 했다.
        await deps
          .speak(recheck, () => setSubtitle(recheck), FIXED_PHRASE_RATE)
          .catch(() => setSubtitle(recheck));
        setPhase('analyzing');
        try {
          scan = await scanDesk();
          target = matchProblemLabel(transcript, scan.problems);
        } catch (err) {
          // 재촬영 실패 — 기존 scan 사진이 유효하므로 풀프레임으로 진행.
          console.warn('[IntentLoop] recheck scan failed - full frame:', err);
        }
      }
    } else if (scan.problems.length >= 2) {
      setPhase('speaking');
      // 자막은 onPlay 이후에만 (exitWith/필러와 동일 원칙).
      await deps
        .speak(MULTI_PROBLEM_QUESTION, () => setSubtitle(MULTI_PROBLEM_QUESTION), FIXED_PHRASE_RATE)
        .catch(() => setSubtitle(MULTI_PROBLEM_QUESTION));
      const res = await listenOnce();
      // 음성/키보드 어느 쪽이든 "몇 번" 한 마디만 뽑아 매칭한다. classify 는
      // 내부 JSON 파싱 가드가 없어 throw 하면 begin() 을 벗어나는 unhandled
      // rejection 이 된다 - 실패 시 풀프레임 폴백(target=null 유지, 재질문
      // 없음, D-15 일관).
      let pick = '';
      if (res.kind === 'text') {
        pick = res.text.trim();
      } else if (res.wav) {
        deps.sendEyeState('listening');
        try {
          pick = (await deps.classify(res.wav, MULTI_PROBLEM_QUESTION)).transcript;
        } catch (err) {
          console.warn('[IntentLoop] multi-problem classify failed - full frame:', err);
        }
      }
      if (pick) {
        deps.sendEyeState('listening');
        target = matchProblemLabel(pick, scan.problems);
      }
      setPhase('analyzing');
      deps.sendEyeState('listening');
    } else {
      target = scan.problems[0] ?? null;
    }

    let image = scan.photo;
    let cropped = false;
    if (target) {
      try {
        image = await deps.fetchCrop(target.box_2d);
        cropped = true;
      } catch (err) {
        console.warn('[IntentLoop] crop failed - full frame:', err);
      }
    }

    const { session, solveMode } = optionsRef.current;
    const systemPrompt = buildSystemPrompt({
      ...session,
      hasProblemImage: true,
      freshPhoto: true,
      directSolveMode: solveMode,
    });
    try {
      const analysis = await deps.analyze([image], session, systemPrompt, transcript, solveMode);
      // 사전분석(detect) 토큰도 세션 사용량에 접힌다 (M1 스펙).
      const merged = scan.usage
        ? {
            ...analysis,
            usage: {
              promptTokens: analysis.usage.promptTokens + scan.usage.promptTokens,
              candidateTokens: analysis.usage.candidateTokens + scan.usage.candidateTokens,
              totalTokens: analysis.usage.totalTokens + scan.usage.totalTokens,
            },
          }
        : analysis;
      // 크롭본으로 분석했으면 problems 를 벗긴다 — 남기면 FSM 이 다문제
      // 되묻기를 또 연다 (기존 재진입 3곳과 동일 처리). 발화에서 번호를
      // 이미 말한 경우(wanted)도 벗긴다 — 풀프레임 폴백이어도 FSM 이
      // "몇 번 풀고 있어?" 를 또 물으면 안 된다.
      const finalAnalysis =
        cropped || wanted !== null ? { ...merged, problems: undefined } : merged;
      setPhase('done');
      doneRef.current = true;
      optionsRef.current.onAnalyzed(
        finalAnalysis,
        image,
        transcript,
        hadConceptTurnRef.current ? (conceptSessionIdRef.current ?? undefined) : undefined,
      );
    } catch (err) {
      console.error('[IntentLoop] analyze failed:', err);
      const alive = await deps.probeNow();
      doneRef.current = true;
      if (alive) optionsRef.current.onPhoneCamera(transcript);
      else optionsRef.current.onExit();
    }
  }, []);

  /** concept 분기 1턴. 다음 STT 문맥용으로 비바 발화를 돌려준다. */
  const runConceptTurn = useCallback(async (transcript: string): Promise<string> => {
    hadConceptTurnRef.current = true;
    setPhase('thinking');
    deps.sendEyeState('listening');
    // 이미지 없는 메타 행이 concept_id 로 잡히면 도해 약속이 깨진다 - 목록에서
    // 빼면 LLM 이 board_prompt 생성 경로로 간다.
    const tConcepts = Date.now();
    const concepts = (await deps.fetchConcepts()).filter((c) => c.imageUrl);
    console.log(`[TTFT] fetch_concepts ${Date.now() - tConcepts}ms`);
    const tExplain = Date.now();
    const res = await deps.explain(transcript, historyRef.current, lastBoardRef.current, concepts);
    console.log(`[TTFT] explain ${Date.now() - tExplain}ms`);
    historyRef.current.push(
      { role: 'user', message: transcript },
      { role: 'model', message: res.message },
    );
    const subtitleText = cleanMathForSubtitle(res.message);
    const matched = res.concept_id ? concepts.find((c) => c.id === res.concept_id) : undefined;
    const asset = matched?.imageUrl ? { uri: matched.imageUrl } : undefined;
    if (asset) {
      // 등록 개념: 검수된 Storage 이미지({uri} — RN Image 기본 캐시 + CDN
      // 헤더) 즉시 표시 - 생성 호출 0 (스펙 WS1). lastBoardRef 는 건드리지
      // 않는다 - Storage 이미지는 base64 가 아니라 이어그리기 문맥으로 못
      // 넘긴다. 다음 턴이 미등록 개념이면 빈 캔버스에서 새로 그린다.
      setBoardAsset(asset);
      setBoardImage(null);
      // 등록 개념 asset 을 세션 판서 목록에 누적 — 같은 url 반복은 건너뛴다.
      const last = conceptBoardImagesRef.current[conceptBoardImagesRef.current.length - 1];
      if (last?.filePath !== matched!.imageUrl) {
        conceptBoardImagesRef.current.push({
          filePath: matched!.imageUrl,
          timestamp: Date.now(),
          boardPrompt: '',
        });
      }
    } else if (res.board_prompt) {
      // 판서는 발화와 병렬 — 부가물이라 실패는 삼킨다 (스펙 §에러).
      const boardSession: TutoringSession = {
        sessionId: `intent-concept`,
        problemImageBase64: '',
        fsmState: 'HINT_STAGE',
        hintCount: 0,
        wrongStreak: 0,
        boardRegenerationCount: 0,
      };
      deps
        .generateBoard(res.board_prompt, boardSession, lastBoardRef.current)
        .then((b) => {
          lastBoardRef.current = b.imageBase64;
          setBoardAsset(null); // 생성 이미지가 도착하면 asset 표시를 걷어낸다.
          setBoardImage(b.imageBase64);
          // fire-and-forget 업로드 — 실패해도 턴은 살린다 (부가물, 스펙 §에러).
          saveBoardImage(conceptSessionIdRef.current!, b.imageBase64, res.board_prompt)
            .then((saved) => conceptBoardImagesRef.current.push(saved))
            .catch((err) => console.warn('[IntentLoop] concept board upload failed:', err));
        })
        .catch((err) => console.warn('[IntentLoop] concept board failed:', err));
    } else {
      // 말로만 답한 턴 - 이전 개념의 판서/이미지를 지워 새 주제와 어긋난
      // 화면이 남지 않게 한다 (WS1 리뷰 반영).
      setBoardAsset(null);
      setBoardImage(null);
    }
    setPhase('speaking');
    // 전체 텍스트 한 방 표시는 numberOfLines 에 잘려 "..." 가 됐다 - 문장
    // 단위로 나눠 재생 길이 비례로 순차 표시한다 (ConversationScreen 과 동일
    // 문법, 2026-08-12 피드백). onPlay 는 재생 시작 시점에 불린다 - 파이
    // 스피커 경로는 duration 0 으로 오고 유틸이 글자수로 추정한다.
    // 자막은 onPlay 이후에만 - speak 호출 전 선표시는 TTS 합성 왕복(1~2.5초)
    // 만큼 자막이 나레이션을 앞서게 했다 (실기기 2026-08-13). 합성이 죽어
    // 소리를 못 내는 경우에만 첫 문장을 폴백으로 남긴다 (5898d73 의도).
    const tSpeak = Date.now();
    await deps
      .speak(cleanMathForTTS(res.message), (durationMillis) => {
        console.log(
          `[TTFT] tts_to_play ${Date.now() - tSpeak}ms total ${Date.now() - ttftT0Ref.current}ms`,
        );
        clearSubtitleTimers();
        buildSubtitleSchedule(subtitleText, durationMillis).forEach(({ sentence, showAtMs }) => {
          if (showAtMs <= 0) {
            setSubtitle(sentence);
            return;
          }
          subtitleTimersRef.current.push(setTimeout(() => setSubtitle(sentence), showAtMs));
        });
      })
      .catch(() => {
        setSubtitle(splitIntoSentences(subtitleText)[0] ?? '');
      });
    return res.message;
  }, []);

  /** 개념 대화를 세션 레코드로 저장. useTutoringFSM.backgroundSaveSession 과
   * 같은 fire-and-forget 스타일 — 실패는 삼킨다. 개념 턴 뒤에만 불려 kind 로
   * 구분된다. */
  const saveConceptSession = useCallback(() => {
    const sid = conceptSessionIdRef.current;
    if (!sid) return;
    const entry: SessionHistoryEntry = {
      sessionId: sid,
      kind: 'concept',
      startedAt: parseInt(sid.replace('concept-', ''), 10) || Date.now(),
      endedAt: Date.now(),
      finalState: 'HINT_STAGE', // filler — 실제 구분자는 kind
      hintCount: 0,
      messages: historyRef.current.map((m) => ({ ...m, timestamp: Date.now() })),
      boardImages: conceptBoardImagesRef.current,
      preview:
        historyRef.current.find((m) => m.role === 'user')?.message.slice(0, 50) || '개념 대화',
      // ponytail: 개념 대화 토큰 집계는 보류 — 지금은 빈 usage. 필요해지면
      // explain/generateBoard usage 를 여기 접는다.
      usage: EMPTY_USAGE_SUMMARY,
    };
    (async () => {
      try {
        await saveSession(entry);
      } catch (err) {
        console.warn('[IntentLoop] concept session save failed:', err);
      }
    })();
  }, []);

  const begin = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;
    conceptSessionIdRef.current = 'concept-' + Date.now();

    try {
      // [병렬 B] 시작. 결과/실패는 solve 분기에서 소비 — 여기선 unhandled
      // rejection 만 막는다.
      const scan = scanDesk();
      scanRef.current = scan;
      scan.then((s) => (scanDoneRef.current = s)).catch(() => {});
      // concepts 프리페치 — 모듈 캐시를 데워 첫 concept 턴의 Supabase 왕복
      // (실측 930ms)을 TTFT 사슬에서 뺀다. 실패는 runConceptTurn 이 재시도.
      deps.fetchConcepts().catch(() => {});

      // [병렬 A] 인사 후 청취 루프. 자막은 onPlay 이후에만.
      setPhase('greeting');
      await deps
        .speak(GREETING_PHRASE, () => setSubtitle(GREETING_PHRASE), FIXED_PHRASE_RATE)
        .catch(() => setSubtitle(GREETING_PHRASE));

      let context = GREETING_PHRASE;
      for (let turn = 0; turn < MAX_TURNS; turn += 1) {
        const res = await listenOnce();
        const out = await resolveInput(res, context);
        if (!out) {
          await exitWith(hadConceptTurnRef.current ? CONCEPT_EXIT_PHRASE : NO_SPEECH_EXIT_PHRASE);
          return;
        }
        const { transcript, intent } = out;
        console.log(`[IntentLoop] turn=${turn} intent=${intent} transcript="${transcript}"`);
        if (intent === 'done') {
          // "이해했어/이제 됐어" - 개념 대화의 정상 마무리 (2026-08-12 스펙).
          await exitWith(CONCEPT_EXIT_PHRASE);
          return;
        }
        if (intent === 'unclear') {
          await exitWith(UNCLEAR_EXIT_PHRASE);
          return;
        }
        if (intent === 'solve') {
          await runSolve(transcript);
          return;
        }
        context = await runConceptTurn(transcript);
        saveConceptSession();
      }
      await exitWith(CONCEPT_EXIT_PHRASE); // MAX_TURNS 도달 (폭주 방지)
    } catch (err) {
      // begin() 안의 나머지 bare await (startRecording/fetchRecordStatus/
      // fetchAudio/explain, 다문제 재청취) 이 던지면 여기로 떨어진다 —
      // runSolve 내부 catch 들은 이미 자체 종결하므로 못 걸린다. 미처리
      // 예외로 IntentScreen 에 방치되지 않게 하는 최후 그물 (C1, runSolve
      // 의 D-45 사다리와 동일 정책).
      console.error('[IntentLoop] loop failed:', err);
      try {
        const alive = await deps.probeNow();
        doneRef.current = true;
        if (alive) optionsRef.current.onPhoneCamera();
        else optionsRef.current.onExit();
      } catch {
        doneRef.current = true;
        optionsRef.current.onExit();
      }
    }
  }, [scanDesk, listenOnce, resolveInput, exitWith, runSolve, runConceptTurn]);

  // 키보드 입력으로 전환. 현재 청취 턴은 열린 채 유지되고(submitText 전까지
  // 오디오로 마감 안 됨), 무응답 타임아웃도 멈춘다.
  const switchToText = useCallback(() => {
    textModeRef.current = true;
    setMicLevel(0);
    setInputMode('text');
  }, []);

  // 음성(자동 청취)으로 복귀. 청취 중이면 무응답 타임아웃 기준을 리셋해
  // 타이핑에 쓴 시간이 즉시 타임아웃되지 않게 한다.
  const switchToVoice = useCallback(() => {
    textModeRef.current = false;
    voiceBaseRef.current = Date.now();
    setInputMode('voice');
  }, []);

  // 타이핑 문장을 현재 청취 턴에 주입. 청취 전(비바 발화 중)에 제출하면
  // pendingTextRef 에 담아 다음 청취가 집어가게 한다.
  const submitText = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    textModeRef.current = false;
    setInputMode('voice');
    if (typedResolveRef.current) typedResolveRef.current(t);
    else pendingTextRef.current = t;
  }, []);

  return {
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
  };
}

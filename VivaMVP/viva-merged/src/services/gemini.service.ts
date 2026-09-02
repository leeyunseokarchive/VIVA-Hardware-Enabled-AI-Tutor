/**
 * Gemini multimodal analysis/evaluation service (TRD.md §3.1).
 *
 * - `analyzeImage` sends the captured problem image + a system prompt and
 *   forces a `GeminiTutoringResponse` via responseSchema/responseMimeType.
 * - `evaluateStudentInput` sends the student's text response the same way.
 * - Both retry on HTTP 429/503 with 1s -> 2s -> 4s exponential backoff, and
 *   retry once on structured-JSON parse failure.
 *
 * This task only needs the service to call Gemini with the right
 * schema/prompt and return the typed response — FSM transition logic
 * (HINT_STAGE/EVAL/SOLVE_STAGE handling) is implemented in Task 5. The
 * `systemPrompt` argument is a caller-supplied string; Task 3 builds the
 * real prompt content.
 */
import {
  GoogleGenerativeAI,
  SchemaType,
  type GenerationConfig,
  type ResponseSchema,
} from '@google/generative-ai';
import type { GeminiTutoringResponse, ProblemBox, TutoringSession } from '../types/Tutoring';
import { toTokenUsage, type TokenUsage } from '../types/ApiUsage';

/** 텍스트 모델 id 의 코드측 기본값. `.env` 의 EXPO_PUBLIC_GEMINI_TEXT_MODEL_ID
 * 가 항상 이긴다 - 이 값은 `.env` 가 없는 환경(CI, 새 클론)에서만
 * 쓰인다. 한 곳에 모아 두는 이유: 예전엔 이 폴백이 세 파일(gemini /
 * geminiStt / board 검증자)에 따로 박혀 있었고, `.env` 를
 * 3.6 으로 올린 뒤에도 코드는 3.5 로 남아 **`.env` 없는 환경이 조용히 다른
 * 모델을 쓰는** 상태였다. 8주차 베이스라인 측정처럼 "어느 모델의 숫자인가"
 * 가 결론을 좌우하는 작업에서 이 종류의 드리프트는 측정을 통째로 무효화한다. */
export const DEFAULT_TEXT_MODEL_ID = 'gemini-3.7-flash';

const Config = {
  GEMINI_API_KEY: process.env.EXPO_PUBLIC_GEMINI_API_KEY,
  GEMINI_TEXT_MODEL_ID: process.env.EXPO_PUBLIC_GEMINI_TEXT_MODEL_ID || DEFAULT_TEXT_MODEL_ID,
  // EVAL 턴 첨부 이미지(전사본 판서)의 토큰 해상도 A/B 노브 (2026-07-31 비용
  // 분석). 'MEDIA_RESOLUTION_MEDIUM' 이면 이미지당 1,120 -> ~560토큰. 판서는
  // 깨끗한 렌더 이미지라 사진보다 저해상도에 강하지만, annotations box_2d
  // 정밀도가 떨어지면 되돌린다. 빈 값 = 기본(HIGH). 사진 분석 턴은 이 노브와
  // 무관하게 항상 기본 해상도다 - 크롭 파이프라인 자체가 "1,120토큰으로는
  // 풀프레임이 안 읽힌다" 에서 출발했다 (D-14).
  GEMINI_EVAL_MEDIA_RESOLUTION: process.env.EXPO_PUBLIC_GEMINI_EVAL_MEDIA_RESOLUTION || '',
  // 인식 전용 호출의 해상도. 기본 ''(= HIGH, 이미지 ~1,078토큰).
  // 'MEDIA_RESOLUTION_MEDIUM' 이면 ~544 로 절반이지만 실측 중 후보가 더
  // 벌어졌다 - 헛물음이 늘 수 있어 실기기 측정 전엔 내리지 않는다.
  GEMINI_RECOGNITION_MEDIA_RESOLUTION:
    process.env.EXPO_PUBLIC_GEMINI_RECOGNITION_MEDIA_RESOLUTION || '',
};

// Backoff schedule per TRD.md §3.1: "429·503 발생 시 1s → 2s → 4s 지수 백오프".
const RETRY_BACKOFF_MS = [1000, 2000, 4000];

// Structured JSON parsing per task-2-brief.md ("Gemini responseSchema
// 기능으로 이 타입 그대로 강제해 파싱 실패가 없게 한다").
const RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    fsm_state: {
      type: SchemaType.STRING,
      format: 'enum',
      enum: ['HINT_STAGE', 'EVAL', 'SOLVE_STAGE', 'ERROR'],
    },
    explicit_answer_request: { type: SchemaType.BOOLEAN },
    // 학생 하차 신호 ("알았어 꺼져", "이제 가도 돼") - FSM 이 고정 인사만
    // 말하고 세션을 닫는다. required 로 강제해 모델이 매 턴 명시 판정한다.
    student_dismissal: { type: SchemaType.BOOLEAN },
    is_on_correct_path: { type: SchemaType.BOOLEAN, nullable: true },
    requires_board: { type: SchemaType.BOOLEAN },
    board_update_needed: { type: SchemaType.BOOLEAN },
    message: { type: SchemaType.STRING },
    board_prompt: { type: SchemaType.STRING },
    confidence: { type: SchemaType.NUMBER },
    error_type: {
      type: SchemaType.STRING,
      format: 'enum',
      enum: ['LOW_IMAGE_QUALITY', 'OUT_OF_SCOPE', 'OCR_FAILED', 'UNSUPPORTED_PROBLEM', 'NONE'],
    },
    misconception_type: {
      type: SchemaType.STRING,
      format: 'enum',
      enum: [
        'SIGN_ERROR',
        'CALCULATION_ERROR',
        'CONCEPT_ERROR',
        'STRATEGY_ERROR',
        'OCR_UNCERTAIN',
        'NONE',
      ],
    },
    // Short specific Korean phrase describing exactly what the student got
    // wrong (see WRONG_STEP_POLICY in system_prompt.ts) - "" when
    // is_on_correct_path is not false. Surfaced in the 오답노트 detail view
    // so a student can see WHY they missed it, not just that they did.
    mistake_reason: { type: SchemaType.STRING },
    topic: {
      type: SchemaType.STRING,
      format: 'enum',
      enum: [
        '실수와 그 계산',
        '다항식의 인수분해',
        '이차방정식',
        '이차함수',
        '통계',
        '피타고라스의 정리',
        '삼각비',
        '원의 성질',
        '기타',
      ],
    },
    title: { type: SchemaType.STRING },
    // 문제 원문 전사 (PROBLEM_FACTS_POLICY). 판서 생성 ground truth +
    // 사후검증 대조 기준. 사진 없는 턴에는 "".
    problem_facts: { type: SchemaType.STRING },
    // 최종 정답 (FINAL_ANSWER_POLICY). 사진 분석 턴에 1회 도출해 세션에
    // 고정하고, 이후 모든 턴(음성 recap·판서·채점)이 이 값을 참조한다 -
    // 턴마다 독립 재풀이하다 답이 갈리는 문제(③인데 ④라고 말함)의 방지책.
    final_answer: { type: SchemaType.STRING },
    // 객관식 self-check 실패 신호 (FINAL_ANSWER_POLICY): 계산 답이 전사한
    // 선지에 없다 = 선지 오인식 가능성. FSM 이 재인식 사다리를 태운다 (D-30).
    answer_not_in_choices: { type: SchemaType.BOOLEAN },
    // 판서 오버레이 명령 (ANNOTATION_POLICY) - 첨부 이미지가 전사본인
    // EVAL 턴에만 채운다. 앱이 전사본 위에 직접 그린다.
    annotations: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          type: {
            type: SchemaType.STRING,
            format: 'enum',
            // circle/underline 은 픽셀 정밀도 문제로 오버레이에서 제외됐다
            // (ANNOTATION_POLICY). 스키마에서 빼면 모델이 아예 낼 수 없다 -
            // 렌더러의 arrow 강제 변환(BoardAnnotationOverlay)은 과거 세션
            // 데이터용 안전망으로 유지.
            enum: ['arrow', 'question_mark', 'label'],
          },
          box_2d: { type: SchemaType.ARRAY, items: { type: SchemaType.INTEGER } },
          // 무엇을 가리키는지 명명 (ANNOTATION_POLICY) - 대상을 먼저 명명하게
          // 하면 box_2d 가 조여진다 (07-30 오버레이 정밀도 개선). label 타입은
          // 이 값이 화면에 그려지고, 나머지 타입은 디버그 대조용 메타데이터.
          text: { type: SchemaType.STRING },
        },
        required: ['type', 'box_2d', 'text'],
      },
    },
    problems: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          label: { type: SchemaType.STRING },
          box_2d: { type: SchemaType.ARRAY, items: { type: SchemaType.INTEGER } },
        },
        required: ['label', 'box_2d'],
      },
    },
  },
  required: [
    'fsm_state',
    'explicit_answer_request',
    'student_dismissal',
    'is_on_correct_path',
    'requires_board',
    'board_update_needed',
    'message',
    'board_prompt',
    'topic',
    'confidence',
    'error_type',
    'mistake_reason',
    'title',
    // 사진 없는 턴에는 "" (FINAL_ANSWER_POLICY / PROBLEM_FACTS_POLICY).
    // required 가 아니면 모델이 생략해 D-27 정답 고정이 조용히 무력화된다.
    'problem_facts',
    'final_answer',
    'answer_not_in_choices',
  ],
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status;
  return status === 429 || status === 503;
}

// Module-level model instance cache: avoids re-constructing the
// GoogleGenerativeAI + getGenerativeModel pipeline on every API call.
// The model configuration (schema, thinking level) never changes at
// runtime, so per-mediaResolution 캐시면 충분하다 ('' = 기본 해상도).
const cachedModels = new Map<string, ReturnType<GoogleGenerativeAI['getGenerativeModel']>>();

function getModel(mediaResolution: string = '') {
  const cached = cachedModels.get(mediaResolution);
  if (cached) return cached;

  const apiKey = Config.GEMINI_API_KEY;
  const modelId = Config.GEMINI_TEXT_MODEL_ID;

  if (!apiKey || !modelId) {
    throw new Error(
      'Missing GEMINI_API_KEY or GEMINI_TEXT_MODEL_ID (react-native-config). Check .env.',
    );
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  // Keep thinking latency low, but the REST field differs by model family:
  // Gemini 3.x uses `thinkingLevel` ('low'|'medium'|'high'), while Gemini
  // 2.5 uses `thinkingBudget` (token count; 0 disables thinking) and
  // rejects `thinkingLevel` with a 400 "Thinking level is not supported".
  // `thinkingConfig`/`mediaResolution` aren't in this SDK version's
  // GenerationConfig type yet (@google/generative-ai predates them) but are
  // real generateContent REST fields, so they're cast through. If EVAL
  // judgments (is_on_correct_path) start feeling less accurate on harder
  // problems, raise thinking - it's a speed/quality tradeoff, not a free win.
  const thinkingConfig = modelId.startsWith('gemini-3')
    ? { thinkingLevel: 'low' }
    : { thinkingBudget: 0 };
  const model = genAI.getGenerativeModel({
    model: modelId,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      thinkingConfig,
      ...(mediaResolution ? { mediaResolution } : {}),
    } as GenerationConfig,
  });
  cachedModels.set(mediaResolution, model);
  return model;
}

/** 인식 전용 호출의 응답 스키마. 통합 스키마(RESPONSE_SCHEMA)와 별개다 -
 * 판독만 시키는 호출에 채점·판서 필드를 딸려보낼 이유가 없고, 프롬프트를
 * 얇게 유지하는 것이 3회 병렬 판독을 감당 가능하게 만드는 근거다
 * (스펙 v2 비용 실측: 통합 8,188토큰 vs 인식 전용 1,109토큰). */
const RECOGNITION_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    candidates: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
  },
  required: ['candidates'],
};

/** 판독 전용 프롬프트. 소극적 지시를 유지한다 - "후보를 적극 생성하라" 로
 * 시키면 안 보이는 값을 지어낸다 (선행 실험 조건 B: 지어내기 100%). */
const RECOGNIZE_PROMPT = `Read ONE line of the student's handwriting in this image: the line their grade depends on. Ignore the printed problem text.
- WHICH line: their handwritten FINAL answer if they wrote one. If they did NOT write a final answer, the LAST line of their work instead (the step they stopped at). Exactly one line either way - never merge two lines into one candidate.
- Handwriting that is crossed out, struck through or scribbled over is ABANDONED - skip it and take the next line up.
- List the DIFFERENT values that line could read as, based ONLY on strokes physically visible. NEVER guess or invent a value that is not written - an empty array is always better than a fabricated candidate.
- If the handwriting is clear, return exactly ONE candidate.
- No student handwriting -> empty array.
- MERGE before listing. SAME value, list once: unit differences ("5cm" = "5"), expression vs its value ("88-66=22" = "22"). DIFFERENT values, keep separate: with/without π ("27" ≠ "27π"), different digit counts ("24" ≠ "240").
- Order candidates by likelihood - most plausible reading first.
Output JSON only: {"candidates": ["..."]}`;

const cachedRecognitionModels = new Map<
  string,
  ReturnType<GoogleGenerativeAI['getGenerativeModel']>
>();

function getRecognitionModel(mediaResolution: string = '') {
  const cached = cachedRecognitionModels.get(mediaResolution);
  if (cached) return cached;

  const apiKey = Config.GEMINI_API_KEY;
  const modelId = Config.GEMINI_TEXT_MODEL_ID;
  if (!apiKey || !modelId) {
    throw new Error('Missing GEMINI_API_KEY or GEMINI_TEXT_MODEL_ID. Check .env.');
  }

  const thinkingConfig = modelId.startsWith('gemini-3')
    ? { thinkingLevel: 'low' }
    : { thinkingBudget: 0 };
  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: modelId,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RECOGNITION_SCHEMA,
      thinkingConfig,
      ...(mediaResolution ? { mediaResolution } : {}),
    } as GenerationConfig,
  });
  cachedRecognitionModels.set(mediaResolution, model);
  return model;
}

/**
 * 학생 손글씨 최종 답을 1회 판독한다. FSM 이 같은 이미지에 대해 이 함수를
 * HANDWRITING_READ_COUNT 회 **병렬** 호출해 그 일치/불일치로 되묻기를 판정한다
 * (스펙 v2). 통합 분석(analyzeImage)과 달리 캐시하지 않는다 - 매번 독립
 * 표본이어야 투표가 의미를 갖는다.
 */
export async function recognizeHandwriting(
  image: string,
  mediaResolution: string = Config.GEMINI_RECOGNITION_MEDIA_RESOLUTION,
): Promise<{ candidates: string[]; usage: TokenUsage }> {
  const model = getRecognitionModel(mediaResolution);
  const parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] = [
    { inlineData: { mimeType: 'image/jpeg', data: image } },
    { text: RECOGNIZE_PROMPT },
  ];
  // callGeminiWithRetry 의 "text call {ms}ms upload={KB}KB attempts=N" 과
  // 같은 형태 - 기기 로그에서 통합 호출과 나란히 읽히게 (IMPORTANT 2). 이
  // 호출은 한 세션에 최대 3회 병렬로 나가므로 지연/재시도가 특히 궁금하다.
  // res 도 같이 남긴다 - HIGH/MEDIUM 은 서버측 토큰 해상도만 바꾸고 전송
  // 바이트는 같아서, upload 만으론 두 run 을 구분할 수 없다. 스펙이 실기기
  // 측정에 미룬 결정이 정확히 이 A/B 다.
  const imageKB = Math.round(image.length / 1024);
  const t0 = Date.now();

  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
    try {
      const result = await model.generateContent(parts);
      const parsed = JSON.parse(result.response.text()) as { candidates?: string[] };
      console.log(
        `[GeminiService] recognize call ${Date.now() - t0}ms ` +
          `upload=${imageKB}KB res=${mediaResolution || 'HIGH'} attempts=${attempt + 1}`,
      );
      return {
        candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [],
        usage: toTokenUsage(
          (result.response as { usageMetadata?: unknown }).usageMetadata as never,
        ),
      };
    } catch (err) {
      lastError = err;
      if (!isRetryableStatus(err) || attempt === RETRY_BACKOFF_MS.length) throw err;
      await sleep(RETRY_BACKOFF_MS[attempt]);
    }
  }
  throw lastError;
}

/** 의도파악 루프의 경량 사전분석용 스키마 — 통합 스키마의 problems 필드만. */
const DETECT_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    problems: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          label: { type: SchemaType.STRING },
          box_2d: { type: SchemaType.ARRAY, items: { type: SchemaType.INTEGER } },
        },
        required: ['label', 'box_2d'],
      },
    },
  },
  required: ['problems'],
};

const DETECT_PROMPT = `This is a photo of a student's desk with a math workbook/textbook page.
List every distinct numbered math problem visible in the photo.
- label: the problem's printed number as written (e.g. "59번", "3").
- box_2d: [ymin, xmin, ymax, xmax] normalized 0~1000, tightly enclosing that problem's full text (지문+선지+그림 포함).
- Problems only — ignore handwriting, headers, page numbers.
- No problems visible -> empty array.
Output JSON only: {"problems": [...]}`;

let cachedDetectModel: ReturnType<GoogleGenerativeAI['getGenerativeModel']> | null = null;

function getDetectModel() {
  if (cachedDetectModel) return cachedDetectModel;
  const apiKey = Config.GEMINI_API_KEY;
  const modelId = Config.GEMINI_TEXT_MODEL_ID;
  if (!apiKey || !modelId) {
    throw new Error('Missing GEMINI_API_KEY or GEMINI_TEXT_MODEL_ID. Check .env.');
  }
  const thinkingConfig = modelId.startsWith('gemini-3')
    ? { thinkingLevel: 'low' }
    : { thinkingBudget: 0 };
  cachedDetectModel = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: modelId,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: DETECT_SCHEMA,
      thinkingConfig,
    } as GenerationConfig,
  });
  return cachedDetectModel;
}

/**
 * 의도파악 루프의 백그라운드 사전분석: 책상 사진에서 문제 개수·bbox 만 뽑는다.
 * 풀 분석(analyzeImage)의 문제감지 서브셋 — "책상 위에 문제가 여러 개
 * 보이네" 즉답과 solve 확정 시 크롭 좌표에 쓴다.
 */
export async function detectProblems(
  image: string,
): Promise<{ problems: ProblemBox[]; usage: TokenUsage }> {
  const model = getDetectModel();
  const parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] = [
    { inlineData: { mimeType: 'image/jpeg', data: image } },
    { text: DETECT_PROMPT },
  ];
  const t0 = Date.now();
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
    try {
      const result = await model.generateContent(parts);
      const parsed = JSON.parse(result.response.text()) as { problems?: ProblemBox[] };
      console.log(`[GeminiService] detect call ${Date.now() - t0}ms attempts=${attempt + 1}`);
      return {
        problems: Array.isArray(parsed.problems) ? parsed.problems : [],
        usage: toTokenUsage(
          (result.response as { usageMetadata?: unknown }).usageMetadata as never,
        ),
      };
    } catch (err) {
      lastError = err;
      if (!isRetryableStatus(err) || attempt === RETRY_BACKOFF_MS.length) throw err;
      await sleep(RETRY_BACKOFF_MS[attempt]);
    }
  }
  throw lastError;
}

const CONCEPT_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    message: { type: SchemaType.STRING },
    board_prompt: { type: SchemaType.STRING },
    concept_id: { type: SchemaType.STRING },
  },
  required: ['message', 'board_prompt', 'concept_id'],
};

/** 의도파악 루프의 개념 설명 프롬프트. 튜터링 FSM(소크라테스 힌트)과 달리
 * 묻는 것에 바로 답한다. 수학 표기는 통합 프롬프트와 같은 LaTeX 계약 —
 * mathTextProcessor 가 TTS/자막 양방향으로 렌더한다. */
const CONCEPT_PROMPT = `너는 한국 중고등학생의 친근한 수학 튜터 "비바"다. 학생이 개념 질문을 했다.
- 묻는 것에 바로, 정확하게 답한다. 유도 질문·힌트 게이트 없음.
- 3~6문장, 반말, 발화체(음성으로 읽힌다).
- 수학 표기는 전부 LaTeX 로 쓴다: \\sqrt{5}, \\frac{1}{2}, \\sin 30^{\\circ}, x^{2}. "루트 5" 같은 한글 표기·맨몸 sin/cos 금지.
- board_prompt: 그림·그래프·수식 전개가 설명에 도움되면 화이트보드 이미지 생성 지시문(한국어 1~2문장)을 쓴다. 말로 충분하면 빈 문자열 "".
- 이전 판서 이미지가 첨부돼 있으면 board_prompt 는 그 판서에 이어 그릴 내용으로 쓴다.
- concept_id: 아래 "등록된 개념 목록"에 학생 질문이 해당하면 그 id 를 정확히 쓴다. 목록에 없거나 애매하면 빈 문자열 "". 목록이 안 주어졌으면 항상 "".
- concept_id 를 골랐으면 그 개념의 "도해:" 이미지가 화면에 그대로 표시된다 - message 설명을 그 도해에 맞춰 쓴다 (도해에 그려진 모형·예시를 언급).
- message 에서 화면에 표시되는 그림을 지칭할 때는 "여기 보이는 이미지"처럼 "이미지"라고만 부른다. "도해"라는 단어와 위치 표현("오른쪽에 있는", "아래의" 등)은 쓰지 않는다 - 화면 배치가 기기마다 달라 위치 언급이 틀릴 수 있다.
- 설명이 끝나면 곧바로 마이크가 켜져 학생 대답을 기다린다. 마지막 문장은 반드시 학생이 대답하기 쉬운 짧은 질문으로 끝낸다 ("여기까지 이해했어?", "더 궁금한 거 있어?" 등). "~야."/"~해." 같은 평서문으로 끝내면 학생이 뭐라 답해야 할지 몰라 침묵하게 된다. 같은 마무리 질문을 매 턴 반복하지 말고 상황에 맞게 바꾼다.
출력은 JSON 만: {"message": "...", "board_prompt": "...", "concept_id": "..."}`;

/** 새 개념 등장 시 시각 자료 보장 규칙 — 세션 내 처음 다루는 개념마다 적용.
 * 첫 턴은 히스토리가 없으니 자동으로 새 개념. 이미 다룬 개념의 후속 질문은
 * 기존 "말로 충분하면 빈 문자열" 규칙 그대로. */
const NEW_CONCEPT_RULE = `
- 이전 대화에서 아직 다루지 않은 개념을 처음 설명할 때는 반드시 시각 자료를 제공한다: 질문이 등록된 개념 목록에 해당하면 concept_id 를 쓰고, 해당하지 않으면 board_prompt 를 반드시 작성한다 (빈 문자열 금지). 이미 다룬 개념의 후속 질문에만 생략을 허용한다.`;

let cachedConceptModel: ReturnType<GoogleGenerativeAI['getGenerativeModel']> | null = null;

function getConceptModel() {
  if (cachedConceptModel) return cachedConceptModel;
  const apiKey = Config.GEMINI_API_KEY;
  const modelId = Config.GEMINI_TEXT_MODEL_ID;
  if (!apiKey || !modelId) {
    throw new Error('Missing GEMINI_API_KEY or GEMINI_TEXT_MODEL_ID. Check .env.');
  }
  const thinkingConfig = modelId.startsWith('gemini-3')
    ? { thinkingLevel: 'low' }
    : { thinkingBudget: 0 };
  cachedConceptModel = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: modelId,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: CONCEPT_SCHEMA,
      thinkingConfig,
    } as GenerationConfig,
  });
  return cachedConceptModel;
}

/** LLM 이 돌려준 concept_id 를 등록 목록으로 검증 — 환각 id 는 '' (스펙 §에러). */
export function normalizeConceptId(
  raw: string | undefined,
  known: { id: string }[] | undefined,
): string {
  if (!raw || !known) return '';
  return known.some((k) => k.id === raw) ? raw : '';
}

/** 개념 질문 1턴 응답. history 는 이번 의도루프 안의 대화 이력(마지막 6개만
 * 직렬화), previousBoardBase64 는 직전 개념 판서(이어 그리기 문맥), knownConcepts
 * 는 등록된 개념 목록(WS1) — 있으면 프롬프트에 실어 LLM 이 concept_id 로 매칭한다. */
export async function explainConcept(
  question: string,
  history: { role: 'user' | 'model'; message: string }[],
  previousBoardBase64?: string,
  knownConcepts?: { id: string; name: string; aliases: string[]; sketch?: string }[],
): Promise<{ message: string; board_prompt: string; concept_id: string; usage: TokenUsage }> {
  const model = getConceptModel();
  const historyText = history
    .slice(-6)
    .map((h) => `${h.role === 'user' ? '학생' : '비바'}: ${h.message}`)
    .join('\n');
  // sketch 도 싣는다 - LLM 이 화면에 뜰 도해 내용을 알아야 message 가 도해와
  // 어긋나지 않는다 (스펙 §4, 호출당 프롬프트 약 1.5k 토큰 증가).
  const conceptListText = knownConcepts?.length
    ? `\n\n등록된 개념 목록 (id: 이름 — 별칭 | 도해):\n${knownConcepts
        .map(
          (c) =>
            `${c.id}: ${c.name} — ${c.aliases.join(', ')}${c.sketch ? ` | 도해: ${c.sketch}` : ''}`,
        )
        .join('\n')}`
    : '';
  const parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] = [];
  if (previousBoardBase64) {
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: previousBoardBase64 } });
  }
  parts.push({
    text: `${CONCEPT_PROMPT}${NEW_CONCEPT_RULE}${conceptListText}\n\n${historyText ? `이전 대화:\n${historyText}\n\n` : ''}학생의 질문: "${question}"`,
  });
  const t0 = Date.now();
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
    try {
      const result = await model.generateContent(parts);
      const parsed = JSON.parse(cleanJsonResponse(result.response.text())) as {
        message?: string;
        board_prompt?: string;
        concept_id?: string;
      };
      console.log(`[GeminiService] concept call ${Date.now() - t0}ms attempts=${attempt + 1}`);
      return {
        message: parsed.message ?? '',
        board_prompt: parsed.board_prompt ?? '',
        concept_id: normalizeConceptId(parsed.concept_id, knownConcepts),
        usage: toTokenUsage(
          (result.response as { usageMetadata?: unknown }).usageMetadata as never,
        ),
      };
    } catch (err) {
      lastError = err;
      if (!isRetryableStatus(err) || attempt === RETRY_BACKOFF_MS.length) throw err;
      await sleep(RETRY_BACKOFF_MS[attempt]);
    }
  }
  throw lastError;
}

// Memory cache for analyzeImage to avoid redundant costly vision API calls
const MAX_CACHE_SIZE = 20;
const imageAnalysisCache = new Map<string, GeminiTutoringResponse & { usage: TokenUsage }>();

function getImageHash(base64: string): string {
  if (!base64 || base64.length < 200) return base64;
  return `${base64.length}-${base64.substring(0, 100)}-${base64.substring(base64.length - 100)}`;
}

/**
 * Calls Gemini with retry on 429/503 (1s -> 2s -> 4s backoff) and retries
 * once more on structured-JSON parse failure, per TRD.md §3.1.
 */
async function callGeminiWithRetry(
  parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[],
  mediaResolution: string = '',
): Promise<GeminiTutoringResponse & { usage: TokenUsage }> {
  const model = getModel(mediaResolution);

  // 체감 지연이 어디서 오는지는 이 한 줄로 갈린다: 텍스트 호출이 느린 건지,
  // 판서 이미지 생성([BoardService] 로그)이 느린 건지. 보내는 이미지 바이트도
  // 같이 남긴다 - 매 EVAL 턴이 같은 문제 사진을 재업로드하는 구조라 여기가
  // 커지면 턴마다 그대로 얹힌다.
  const imageKB = Math.round(
    parts.reduce((n, p) => n + ('inlineData' in p ? p.inlineData.data.length : 0), 0) / 1024,
  );
  const t0 = Date.now();

  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
    try {
      const raw = await generateOnce(model, parts);
      const parsed = parseResponseWithOneRetry(model, parts, raw);
      console.log(
        `[GeminiService] text call ${Date.now() - t0}ms ` +
          `upload=${imageKB}KB attempts=${attempt + 1}`,
      );
      return parsed;
    } catch (err) {
      lastError = err;
      if (!isRetryableStatus(err) || attempt === RETRY_BACKOFF_MS.length) {
        throw err;
      }
      await sleep(RETRY_BACKOFF_MS[attempt]);
    }
  }

  // Unreachable, but keeps TypeScript happy about the return type.
  throw lastError;
}

async function generateOnce(
  model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>,
  parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[],
): Promise<{ text: string; usage: TokenUsage }> {
  const result = await model.generateContent(parts);
  return {
    text: result.response.text(),
    // usageMetadata is a real GenerateContent REST/SDK field but may lag
    // behind this SDK version's TS types (same reasoning as the
    // thinkingConfig cast in getModel() above), so it's read defensively.
    usage: toTokenUsage((result.response as { usageMetadata?: unknown }).usageMetadata as never),
  };
}

function cleanJsonResponse(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json/i, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```/i, '');
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.replace(/```$/i, '');
  }

  // Fix unescaped LaTeX macros in Gemini JSON output.
  // JSON.parse converts \t, \n, \r, \f, \b to control characters, and throws on \a.
  // If the model outputs `\triangle` unescaped, it becomes a tab + `riangle`.
  // We double-escape known math commands to prevent this.
  const LATEX_MACROS = [
    'triangle',
    'text',
    'theta',
    'tan',
    'frac',
    'beta',
    'right',
    'nabla',
    'angle',
    'circ',
    'sqrt',
    'pm',
    'geq',
    'leq',
    'neq',
    'infty',
    'alpha',
    'pi',
    'sin',
    'cos',
    'log',
    'lim',
    'ln',
    'times',
    'div',
    'overline',
    'vec',
    'mathbf',
  ].join('|');
  const UNESCAPED_MACRO_REGEX = new RegExp(`(^|[^\\\\])\\\\(${LATEX_MACROS})`, 'g');

  cleaned = cleaned.replace(UNESCAPED_MACRO_REGEX, '$1\\\\$2');

  return cleaned.trim();
}

async function parseResponseWithOneRetry(
  model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>,
  parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[],
  first: { text: string; usage: TokenUsage },
): Promise<GeminiTutoringResponse & { usage: TokenUsage }> {
  try {
    return {
      ...(JSON.parse(cleanJsonResponse(first.text)) as GeminiTutoringResponse),
      usage: first.usage,
    };
  } catch {
    // "구조화 JSON 파싱 실패 시 1회 재요청" (TRD.md §3.1).
    const retry = await generateOnce(model, parts);
    try {
      return {
        ...(JSON.parse(cleanJsonResponse(retry.text)) as GeminiTutoringResponse),
        usage: retry.usage,
      };
    } catch {
      throw new Error(`Gemini response was not valid JSON after 1 retry: ${retry.text}`);
    }
  }
}

/**
 * Analyzes one or more captured math problem/solution images and returns the
 * first structured tutoring response (OCR, problem type, first hint,
 * board_prompt, confidence — TRD.md §1.3 step 3).
 */
export async function analyzeImage(
  images: string | string[],
  context: TutoringSession,
  systemPrompt: string,
  studentQuestion?: string,
  directSolveMode?: boolean,
): Promise<GeminiTutoringResponse & { usage: TokenUsage }> {
  const imageList = Array.isArray(images) ? images : [images];

  // Cache check for single-image analysis with no specific student question.
  // Skipped entirely (read AND write) when directSolveMode is on: the cache
  // key is only the image hash, with no awareness of which systemPrompt/mode
  // produced the cached response. Without this, the very bug this flag
  // exists to prevent could resurface - snap the same photo once in normal
  // hint mode, then again with "바로 정답" toggled on, and the hint-mode
  // response (asking a follow-up question instead of solving) would be
  // served back instead of a fresh direct-solve call.
  const canCache =
    !directSolveMode &&
    imageList.length === 1 &&
    (!studentQuestion || studentQuestion.trim().length === 0);
  let cacheKey = '';

  if (canCache) {
    cacheKey = getImageHash(imageList[0]);
    const cached = imageAnalysisCache.get(cacheKey);
    if (cached) {
      console.log('[GeminiService] Using cached image analysis result');
      return cached;
    }
  }

  // 모델 판단에 안 쓰이는 필드는 직렬화에서 뺀다 - usage(비용 집계),
  // sessionId, boardRegenerationCount 가 매 턴 ~80토큰씩 나가고 있었고,
  // usage 는 턴마다 값이 바뀌어 프롬프트 캐시 prefix 도 깨뜨린다
  // (2026-07-31 비용 분석).
  const {
    problemImageBase64: _img,
    lastBoardImageBase64: _board,
    history: _history,
    usage: _usage,
    sessionId: _sid,
    boardRegenerationCount: _regen,
    ...contextText
  } = context;

  const parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] = [
    { text: systemPrompt },
    { text: `Session context: ${JSON.stringify(contextText)}` },
  ];

  if (studentQuestion && studentQuestion.trim().length > 0) {
    parts.push({
      text: `Before taking this photo, the student said: ${studentQuestion}`,
    });
  }

  imageList.forEach((img) => {
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: img } });
  });

  const response = await callGeminiWithRetry(parts);

  if (canCache) {
    if (imageAnalysisCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = imageAnalysisCache.keys().next().value;
      if (oldestKey) imageAnalysisCache.delete(oldestKey);
    }
    imageAnalysisCache.set(cacheKey, response);
  }

  return response;
}

/**
 * Evaluates the student's spoken/typed response against the current
 * tutoring session and returns the next structured tutoring response
 * (EVAL judgment — TRD.md §1.3 step 8).
 */
export async function evaluateStudentInput(
  inputText: string,
  context: TutoringSession,
  systemPrompt: string,
): Promise<GeminiTutoringResponse & { usage: TokenUsage }> {
  // 모델 판단에 안 쓰이는 필드는 직렬화에서 뺀다 - usage(비용 집계),
  // sessionId, boardRegenerationCount 가 매 턴 ~80토큰씩 나가고 있었고,
  // usage 는 턴마다 값이 바뀌어 프롬프트 캐시 prefix 도 깨뜨린다
  // (2026-07-31 비용 분석).
  const {
    problemImageBase64: _img,
    lastBoardImageBase64: _board,
    history: _history,
    usage: _usage,
    sessionId: _sid,
    boardRegenerationCount: _regen,
    ...contextText
  } = context;

  const parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] = [];

  // 사진을 맨 앞에 둔다. 같은 세션의 EVAL 턴은 전부 같은 이미지를 다시
  // 보내는데(이미지 토큰이 턴 비용의 대부분), Gemini 의 implicit prompt
  // caching 은 직전 요청과 바이트 단위로 동일한 "앞부분" 만 할인한다 -
  // 예전 순서(시스템프롬프트/컨텍스트가 앞)는 hintCount/wrongStreak 가
  // 턴마다 바뀌어 prefix 가 절대 일치하지 않았다. 이미지가 첫 파트면 그
  // 구간은 매 턴 동일해 캐시 할인이 걸린다.
  //
  // 전사본(lastBoardImageBase64)이 있으면 원본 사진 대신 그걸 보낸다
  // (스펙 2026-07-29 전사 1회 + 오버레이): 학생이 보는 화면과 같은
  // 이미지여야 annotations 좌표가 화면과 정확히 일치하고, 세션 내내 같은
  // 바이트라 캐시도 유지된다. 전사본은 다운스케일 JPEG 로 저장돼 있다.
  const evalImage =
    context.lastBoardImageBase64?.trim() || context.problemImageBase64?.trim() || '';
  if (evalImage.length > 0) {
    parts.push({
      inlineData: { mimeType: 'image/jpeg', data: evalImage },
    });
  }

  parts.push({ text: systemPrompt }, { text: `Session context: ${JSON.stringify(contextText)}` });

  // Limit history to last 4 messages (2 back-and-forth turns) to reduce
  // token count and API cost. The system prompt already captures the
  // session's hintCount/wrongStreak for policy decisions.
  const MAX_HISTORY_TURNS = 4;

  if (context.history) {
    const recentHistory = context.history.slice(-MAX_HISTORY_TURNS);
    recentHistory.forEach((msg) => {
      parts.push({
        text: `${msg.role === 'user' ? 'Student' : 'Tutor'}: ${msg.message}`,
      });
    });
  }

  parts.push({ text: `Student: ${inputText}` });

  // EVAL 첨부(전사본 판서)만 해상도 노브를 태운다 - 사진 분석 턴은 기본.
  return callGeminiWithRetry(parts, Config.GEMINI_EVAL_MEDIA_RESOLUTION);
}

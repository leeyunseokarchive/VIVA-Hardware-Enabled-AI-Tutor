/**
 * Gemini 기반 음성 전사 (charing_viva 방식 이식).
 *
 * 발화 전체 WAV 를 Gemini 에 inline 오디오로 바로 보내 전사한다.
 * Google Cloud STT(speech:recognize) 대비 한국어 수학 발화 인식이 훨씬
 * 정확하다(문맥 이해 기반). 실시간 자막은 없다 — 발화가 끝난 뒤 한 번에
 * 전사되어 기존 텍스트 파이프라인(FSM/의도분류/로그)으로 들어간다.
 *
 * gemini.service.ts 의 모델 캐시는 JSON 스키마 고정이라 재사용하지 않고,
 * 전사 전용의 plain-text 모델 인스턴스를 따로 캐시한다. 키/모델은 동일하게
 * `.env` 의 EXPO_PUBLIC_GEMINI_API_KEY / EXPO_PUBLIC_GEMINI_TEXT_MODEL_ID.
 */
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
// 모델 *캐시* 는 위 주석대로 공유하지 않는다 (스키마가 다르다). 공유하는 건
// 기본 모델 id 하나뿐 - 폴백이 파일마다 갈리면 `.env` 없는 환경이 서비스별로
// 다른 모델을 쓴다.
import { DEFAULT_TEXT_MODEL_ID } from './gemini.service';

const TRANSCRIBE_PROMPT = [
  '다음 오디오는 한국 중고등학생이 수학 튜터에게 말한 내용이다.',
  '들리는 말을 한국어로 정확히 받아써라.',
  '규칙:',
  '- 받아쓴 문장만 출력한다. 설명, 따옴표, 접두어 금지.',
  '- 수학 용어(이차방정식, 근의 공식, 인수분해, 루트, 제곱 등)에 주의한다.',
  // "오" 를 감탄사로 적어버리면 FSM 이 숫자 답을 영영 못 받는다 - 튜터
  // 질문에 대한 수/답 발화는 아라비아 숫자·수식으로 정규화해 적는다.
  '- 수나 답을 말하는 발화는 아라비아 숫자와 수식으로 표기한다. 예: "오" → "5", "이십오" → "25", "루트 오" → "루트 5", "이분의 일" → "1/2". 짧은 한 마디("오", "삼")도 튜터 질문에 대한 대답이면 감탄사가 아니라 숫자다.',
  '- 말이 없거나 알아들을 수 없으면 아무것도 출력하지 않는다(빈 출력).',
].join('\n');

/** 직전 튜터 발화를 전사 힌트로 붙일 때의 최대 길이 - 컨텍스트는 한 문장이면
 * 충분하고, 오디오 토큰이 지배적이라 이 정도면 비용 증가는 사실상 0 이다. */
const CONTEXT_MAX_CHARS = 200;

let cachedModel: ReturnType<GoogleGenerativeAI['getGenerativeModel']> | null = null;

function getTranscribeModel() {
  if (cachedModel) return cachedModel;
  const apiKey = process.env.EXPO_PUBLIC_GEMINI_API_KEY;
  const modelId = process.env.EXPO_PUBLIC_GEMINI_TEXT_MODEL_ID || DEFAULT_TEXT_MODEL_ID;
  if (!apiKey) {
    throw new Error('Missing EXPO_PUBLIC_GEMINI_API_KEY. Check .env.');
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  const thinkingConfig = modelId.startsWith('gemini-3')
    ? { thinkingLevel: 'low' }
    : { thinkingBudget: 0 };
  cachedModel = genAI.getGenerativeModel({
    model: modelId,
    generationConfig: { thinkingConfig } as any,
  });
  return cachedModel;
}

/**
 * base64 WAV(LINEAR16 mono 16kHz) 를 Gemini 로 전사한다.
 * 말이 없으면 '' 로 정상 resolve.
 *
 * `tutorQuestion` 은 직전 튜터 발화(질문) - 있으면 프롬프트에 붙여 "오" 같은
 * 짧은 대답이 감탄사가 아니라 숫자 5 임을 모델이 문맥으로 잡게 한다.
 */
export async function transcribeWavWithGemini(
  wavBase64: string,
  tutorQuestion?: string,
): Promise<string> {
  const model = getTranscribeModel();
  const contextLine = tutorQuestion?.trim()
    ? `\n\n직전에 튜터가 학생에게 한 말: "${tutorQuestion.trim().slice(0, CONTEXT_MAX_CHARS)}"\n학생의 발화는 대개 이 말에 대한 대답이다.`
    : '';
  const result = await model.generateContent([
    { text: TRANSCRIBE_PROMPT + contextLine },
    { inlineData: { mimeType: 'audio/wav', data: wavBase64 } },
  ]);
  const text = result.response.text().trim();
  // 모델이 지시를 어기고 따옴표/접두어를 붙이는 드문 경우 정리.
  return text.replace(/^["'「]|["'」]$/g, '').trim();
}

export type StudentIntent = 'solve' | 'concept' | 'unclear' | 'done';

/** 전사+의도분류 통합 프롬프트. 전사 규칙은 TRANSCRIBE_PROMPT 와 동일 기조. */
const CLASSIFY_PROMPT = [
  '다음 오디오는 한국 중고등학생이 수학 튜터 "비바"를 불러서 한 첫 마디다.',
  '두 가지를 한 번에 한다: (1) 들리는 말을 한국어로 정확히 받아쓴다 (2) 의도를 분류한다.',
  '전사 규칙:',
  '- 수학 용어(이차방정식, 근의 공식, 루트, 제곱 등)에 주의한다.',
  '- 수를 말하면 아라비아 숫자·수식으로 표기한다. 예: "이십오" → "25".',
  '- 말이 없거나 알아들을 수 없으면 transcript 는 빈 문자열.',
  'intent 분류:',
  '- "solve": 눈앞의 특정 문제를 풀어달라/도와달라/채점해달라. 예: "이거 어떻게 풀어?", "이 문제 모르겠어", "채점해줘", "59번 풀자".',
  '- "concept": 개념·정의·원리 질문 (특정 지면 문제를 가리키지 않음). 예: "삼각함수가 뭐야?", "sin 30도가 왜 1/2이야?", "근의 공식 설명해줘".',
  '- "done": 비바가 더 이상 필요 없다는 의사 표시 - 이해했다/그만하겠다는 마무리 대답, 거칠거나 무례한 표현 포함. 예: "이제 됐어", "이해했어", "알겠어", "응 고마워", "꺼져", "이제 가도 돼", "굿 이제 가도 돼", "알았어 이해했으니까 꺼져".',
  '- "unclear": 수학과 무관한 말, 잡담, 알아들을 수 없음, 빈 발화.',
  '출력은 JSON 만: {"transcript": "...", "intent": "solve|concept|unclear|done"}',
].join('\n');

const CLASSIFY_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    transcript: { type: SchemaType.STRING },
    intent: { type: SchemaType.STRING, enum: ['solve', 'concept', 'unclear', 'done'] },
  },
  required: ['transcript', 'intent'],
};

let cachedClassifyModel: ReturnType<GoogleGenerativeAI['getGenerativeModel']> | null = null;

function getClassifyModel() {
  if (cachedClassifyModel) return cachedClassifyModel;
  const apiKey = process.env.EXPO_PUBLIC_GEMINI_API_KEY;
  const modelId = process.env.EXPO_PUBLIC_GEMINI_TEXT_MODEL_ID || DEFAULT_TEXT_MODEL_ID;
  if (!apiKey) throw new Error('Missing EXPO_PUBLIC_GEMINI_API_KEY. Check .env.');
  const thinkingConfig = modelId.startsWith('gemini-3')
    ? { thinkingLevel: 'low' }
    : { thinkingBudget: 0 };
  cachedClassifyModel = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: modelId,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: CLASSIFY_SCHEMA,
      thinkingConfig,
    } as any,
  });
  return cachedClassifyModel;
}

const INTENTS: StudentIntent[] = ['solve', 'concept', 'unclear', 'done'];

/**
 * 의도파악 루프용 전사+분류 통합 1회 호출. 전사(transcribeWavWithGemini)와
 * 별개의 JSON 모델 인스턴스를 쓴다 — 기존 전사 경로의 plain-text 캐시를
 * 건드리면 안 된다.
 * `vivaLastLine` 은 직전 비바 발화 — 짧은 대답의 문맥 힌트 (전사 경로와 동일).
 */
export async function transcribeAndClassify(
  wavBase64: string,
  vivaLastLine?: string,
): Promise<{ transcript: string; intent: StudentIntent }> {
  const model = getClassifyModel();
  const contextLine = vivaLastLine?.trim()
    ? `\n\n직전에 비바가 학생에게 한 말: "${vivaLastLine.trim().slice(0, CONTEXT_MAX_CHARS)}"`
    : '';
  const result = await model.generateContent([
    { text: CLASSIFY_PROMPT + contextLine },
    { inlineData: { mimeType: 'audio/wav', data: wavBase64 } },
  ]);
  const parsed = JSON.parse(result.response.text()) as {
    transcript?: string;
    intent?: string;
  };
  const transcript = (parsed.transcript ?? '').trim();
  const intent =
    transcript && INTENTS.includes(parsed.intent as StudentIntent)
      ? (parsed.intent as StudentIntent)
      : 'unclear';
  return { transcript, intent };
}

/**
 * 키보드 입력 경로용 의도분류 — 오디오 대신 타이핑한 텍스트를 받는다.
 * 전사(STT)는 필요 없으니 intent 만 분류하고 transcript 는 입력을 그대로
 * 돌려준다. 분류 모델/스키마는 transcribeAndClassify 와 공유한다.
 */
export async function classifyText(
  text: string,
  vivaLastLine?: string,
): Promise<{ transcript: string; intent: StudentIntent }> {
  const input = text.trim();
  if (!input) return { transcript: '', intent: 'unclear' };
  const model = getClassifyModel();
  const contextLine = vivaLastLine?.trim()
    ? `\n\n직전에 비바가 학생에게 한 말: "${vivaLastLine.trim().slice(0, CONTEXT_MAX_CHARS)}"`
    : '';
  const result = await model.generateContent([
    {
      text:
        CLASSIFY_PROMPT.replace('다음 오디오는', '다음 문장은').replace(
          '(1) 들리는 말을 한국어로 정확히 받아쓴다 (2) 의도를 분류한다.',
          'transcript 는 입력 문장을 그대로 두고 의도(intent)만 분류한다.',
        ) +
        contextLine +
        `\n\n학생이 입력한 문장: "${input}"`,
    },
  ]);
  const parsed = JSON.parse(result.response.text()) as {
    transcript?: string;
    intent?: string;
  };
  const intent = INTENTS.includes(parsed.intent as StudentIntent)
    ? (parsed.intent as StudentIntent)
    : 'unclear';
  // transcript 는 학생이 실제 친 문장을 신뢰한다(모델이 바꿔쓰지 않게).
  return { transcript: input, intent };
}

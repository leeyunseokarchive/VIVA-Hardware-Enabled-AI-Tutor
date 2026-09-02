/**
 * Board image generation service (TRD.md §3.3).
 * Calls the Gemini image model to generate hints, diagrams, or equations.
 *
 * 모델이 gemini-3.1-flash-lite-image 에서 gemini-3.1-flash-image 로 올라갔다
 * (실기기 피드백 2026-07-29: 판서가 원본 문제에 없는 텍스트/도형을 임의로
 * 그린다). lite 는 공식 문서상 두 가지 결정적 제약이 있었다.
 *  - 1K 해상도 전용. 16:9 로 1K 면 ~1344x768 인데, 문제지 한 장을 그 해상도로
 *    재작화하면 한글·숫자가 뭉개지고 모델이 그 자리를 그럴듯한 글자/도형으로
 *    메운다. 그게 정확히 신고된 증상이다.
 *  - multi-turn editing 미지원. 아래 hasPreviousBoard 경로는 직전 판서를 입력
 *    이미지로 주고 "수정만" 시키는데, lite 는 그 기능 자체가 없어서 매 턴
 *    사실상 재생성됐다 (판서 일관성 문제의 잔재).
 * 그래도 한글 전사가 깨지면 다음 수는 gemini-3-pro-image (단가 2배).
 */
import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from '@google/generative-ai';
import type { TutoringSession } from '../types/Tutoring';
import { toTokenUsage, type TokenUsage } from '../types/ApiUsage';
import type { BoardDebugRecord, BoardVerifyDebug } from './sessionDebug.service';
import { DEFAULT_TEXT_MODEL_ID } from './gemini.service';
import { APP_BACKGROUND_COLOR } from '../theme';
import { CONCEPT_BOARD_RULES } from '../prompts/conceptBoardPrompt';
const Config = {
  GEMINI_API_KEY: process.env.EXPO_PUBLIC_GEMINI_API_KEY,
  GEMINI_IMAGE_MODEL_ID: process.env.EXPO_PUBLIC_GEMINI_IMAGE_MODEL_ID || 'gemini-3.1-flash-image',
  // 판서 출력 해상도 ('1K' | '2K' | '4K'). 정확도와 지연·비용을 맞바꾸는
  // 노브다. 2026-07-29 2K → 1K 로 내림(비용 절감 A/B): 전사 1회 + 오버레이
  // 전환으로 이미지 생성이 세션당 최대 2장뿐이고 검증+원본 폴백이 있어 1K
  // 전사 품질 하락을 잡아낼 안전망이 생겼다. 1K $0.067 / 2K $0.101 (장당).
  // 전사가 자주 검증에 걸리면 2K 로 되돌린다 - apiPricing.service 의
  // 가격표는 이 값을 같이 읽으므로 따로 맞출 필요 없다.
  // EXPO_PUBLIC_* 는 babel transform 시점에 인라인되므로 `expo start -c` 로
  // Metro 캐시만 비우면 바뀐다 - 네이티브 재빌드 불필요, A/B 가 싸다.
  GEMINI_IMAGE_SIZE: process.env.EXPO_PUBLIC_GEMINI_IMAGE_SIZE || '1K',
};

/**
 * 색 토큰의 원본은 src/theme.ts 로 옮겼다 (2026-07-29 UI 통일). 판서
 * 프롬프트가 배경색을 쓰는 관계로 여기서 재수출해 기존 import 경로
 * (`from '../services/board.service'`)를 그대로 살린다.
 */
export { APP_BACKGROUND_COLOR, SURFACE_COLOR, SURFACE_BORDER_COLOR } from '../theme';

/** 세션 시작 시 1회 생성되는 "순수 전사" 판서의 고정 지시 (스펙 2026-07-29
 * 전사 1회 + 오버레이). 힌트 표시는 이미지가 아니라 앱 오버레이가 맡으므로,
 * 이미지 모델의 임무를 전사만으로 좁힌다 - 임무가 단순할수록 환각 여지도
 * 검증 기준도 좁아진다. SPECIFIC HINT INSTRUCTION 자리에 그대로 들어간다. */
export const TRANSCRIPTION_INSTRUCTION =
  'TRANSCRIPTION ONLY. Do NOT add any hint annotations of your own: no arrows, no question marks, ' +
  'no underlines, no circles, no emphasis of any kind. The output must be nothing but the faithful, ' +
  'cleaned-up transcription of the problem (and any existing student work) from the photo.';

/**
 * Calls the Google Gemini image model via REST API to generate a custom
 * chalkboard/whiteboard hint image (base64 encoded PNG).
 */
export interface BoardGenResult {
  imageBase64: string;
  /** 이미지 모델에 실제 전송된 텍스트 파트 전문 (디버그 저장용). */
  fullPrompt: string;
  genMs: number;
}

export async function generateBoardImage(
  problemImageBase64: string,
  boardPrompt: string,
  context: TutoringSession,
  onUsage?: (usage: TokenUsage) => void,
  /** 직전 턴 판서(base64). 있으면 처음부터 다시 그리는 대신 이 이미지를
   * "수정"한다 - 매 턴 전체 재생성이 배치/서체/내용이 턴마다 달라지는 판서
   * 일관성 문제의 주범이었다 (실기기 피드백 2026-07-28). */
  previousBoardBase64?: string,
  opts?: {
    /** 분석 턴의 problem_facts - GROUND TRUTH 블록으로 주입된다. */
    problemFacts?: string;
    /** 사후검증 불합격 시 재생성 지시 목록. 이게 있으면 previousBoardBase64 는
     * "직전 턴 판서"가 아니라 "방금 불합격한 1차본"으로 해석된다. */
    correctionNotes?: string[];
    /** previousBoardBase64 의 MIME. 교정 base 는 다운스케일 실패 시 PNG 로
     * 떨어질 수 있어 고정할 수 없다. */
    baseMimeType?: string;
  },
): Promise<BoardGenResult> {
  const problemFacts = opts?.problemFacts;
  const correctionNotes = opts?.correctionNotes;
  // Enforce the generation limit per TRD §3.3 (raised from the original 5
  // to 15 per session):
  // "boardRegenerationCount >= 15면 API를 호출하지 않고 오류를 반환한다."
  if (context.boardRegenerationCount >= 15) {
    throw new Error('API_LIMIT_EXCEEDED');
  }

  const apiKey = Config.GEMINI_API_KEY;
  const modelId = Config.GEMINI_IMAGE_MODEL_ID;

  if (!apiKey || !modelId) {
    throw new Error('Missing GEMINI_API_KEY or GEMINI_IMAGE_MODEL_ID in react-native-config.');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelId,
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: {
        aspectRatio: '16:9',
        // lite 모델에서는 올릴 수 없던 값 (1K ~1344x768 -> 2K ~2688x1536).
        imageSize: Config.GEMINI_IMAGE_SIZE,
      },
    } as any,
  });

  const hasProblemImage = !!problemImageBase64 && problemImageBase64.length > 0;
  const hasPreviousBoard = !!previousBoardBase64 && previousBoardBase64.length > 0;

  // 순수 전사 턴은 "annotation 금지"(SPECIFIC HINT INSTRUCTION)인데 아래
  // 공용 규칙 3 이 화살표·점선 원을 허용 목록으로 광고하면 한 요청 안에서
  // 지시가 충돌한다 - 실기기에서 전사 판서에 동그라미가 그려진 원인
  // (2026-07-30). ANSWER POLICY 충돌(규칙 5) 때와 같은 패턴이라 같은 방식,
  // 즉 턴 종류를 보고 한쪽으로 정리한다.
  const isTranscription = boardPrompt === TRANSCRIPTION_INSTRUCTION;

  // SOLVE_STAGE 는 이미 정답을 공개하기로 결정된 단계다 (정답 모드 / wrongStreak
  // 동의 / 학생이 스스로 정답 도달). 그런데 아래 규칙 5 는 최종 답을 무조건
  // 금지하고 있었고, system_prompt.ts 의 BOARD_PROMPT_POLICY 는 같은 단계에서
  // "풀이 단계를 판서로 시각화해도 된다" 고 지시한다 - 한 요청 안에서 서로
  // 반대되는 지시가 부딪히면 모델이 어느 쪽도 제대로 안 따르고 드리프트한다.
  // 단계를 보고 한쪽으로 정리한다. context.fsmState 는 이 시점에 이미 이번 턴
  // 값으로 갱신돼 있다 (finishWithSolution/submitStudentInput 이 setSessionState
  // 를 먼저 하고, 판서 effect 는 그 커밋 뒤에 돈다).
  // 전사 턴은 제외: 바로 정답 모드/손풀이 정답의 첫 판서는 fsmState 가 이미
  // SOLVE_STAGE 인 채로 전사를 요청하는데, 거기에 "최종 답을 그려라"(규칙 5
  // reveal 분기)가 같이 실리면 TRANSCRIPTION ONLY 와 정면 충돌한다.
  const revealAnswer = !isTranscription && context.fsmState === 'SOLVE_STAGE';

  // Shared annotation-style rules, independent of whether we're drawing on
  // a flat background or on top of the student's real photo.
  const annotationRules =
    'ANNOTATION RULES:\n' +
    '1. CONTENT STYLE: Draw clean, flat, modern digital vector-style elements only. ' +
    'Use a neat, modern sans-serif font (like Pretendard/Inter). Never use handwritten, chalk, or script fonts.\n' +
    '2. COLORS: Use only these colors for drawing elements:\n' +
    '   - Primary ink: #2B2926 (dark brown-black) for equations, text, shapes\n' +
    '   - Accent/highlight: #369B75 (green) for arrows, question marks, emphasis lines\n' +
    '   - Secondary accent: #E8845C (warm orange) for marking errors or key attention points\n' +
    '   Do NOT use red, blue, yellow, or any other colors.\n' +
    '   CRITICAL: NEVER write these color codes (like "#2B2926") as text in the generated image. Only use them as drawing colors.\n' +
    (isTranscription
      ? '3. ANNOTATION ELEMENTS: NONE. This is a pure transcription - draw ZERO annotation elements: ' +
        'no question marks, no arrows, no underlines, no brackets, no circles, no emphasis of any kind.\n'
      : '3. ANNOTATION ELEMENTS: Use ONLY these annotation types:\n' +
        '   - Question marks (?) next to unknowns to solve\n' +
        '   - Simple straight arrows (→) pointing to key elements\n' +
        '   - Thin underlines or brackets for grouping terms\n' +
        '   - Dashed circles around key values or angles\n') +
    '4. STRICTLY FORBIDDEN elements — do NOT draw ANY of these:\n' +
    '   - Stars, stamps, stickers, checkmarks (✓), "잘했어요", "Good job" or ANY praise/reward marks\n' +
    '   - Decorative underlines, wavy lines, squiggles, or ornamental borders\n' +
    '   - Emoji, cartoon faces, thumbs up, or any non-mathematical decorations\n' +
    '   - Grid lines, ruled lines, or notebook-style backgrounds\n' +
    '   - Drop shadows, 3D effects, or gradient fills on any element\n' +
    '   - Title text like "힌트", "문제", "풀이" — jump straight into the math content\n' +
    (revealAnswer
      ? '5. ANSWER POLICY: This is the solution stage - the answer is being revealed to the student on purpose. ' +
        'DO show the worked steps in order, and DO show the final numeric answer/roots as the last line.\n' +
        // 확정 정답이 있으면 이미지 모델이 답을 독립 재도출하지 못하게 못박는다 -
        // 음성 recap 과 판서가 서로 다른 답을 내는 사고의 차단선.
        (context.finalAnswer?.trim()
          ? `   The authoritative final answer (already computed by the tutor from the original problem) is: ${context.finalAnswer.trim()}. ` +
            'The final line MUST state exactly this answer - do NOT compute or display a different one.\n'
          : '')
      : '5. ANSWER POLICY: Do NOT display the final numeric answer, complete solution, or equation roots under any circumstances.\n') +
    '6. LANGUAGE: All text labels must be in Korean (except standard math variables x, y, a, b and geometric point names A, B, C).\n' +
    '   CRITICAL: Minimize long Korean sentences to prevent text rendering glitches. Use simple math symbols, short keywords, or visual cues instead.\n' +
    '7. LAYOUT: Leave comfortable margins (at least 10% on each side). Do not crowd elements to the edges.\n' +
    // 실기기 피드백 2026-07-29: 판서가 문제의 변 이름/수치를 다른 기호로
    // 바꾸거나, 힌트와 무관한 곳에 밑줄·강조를 넣는다. 아래 두 규칙 +
    // PROBLEM GROUND TRUTH 블록이 그 증상 겨냥.
    '8. NOTATION FIDELITY: Use EXACTLY the symbols, point/side labels, and given values as they appear ' +
    'in the original problem (and in the PROBLEM GROUND TRUTH block if provided). NEVER rename a point or side, ' +
    'never substitute a different symbol, never alter or round a given value, never add values the problem does not state.\n' +
    '9. HIGHLIGHT DISCIPLINE: Add annotations/emphasis ONLY to the elements the hint instruction below explicitly ' +
    'refers to. Do NOT underline, circle, or highlight anything else - an unrelated underline reads as a wrong hint.\n\n' +
    (problemFacts
      ? 'PROBLEM GROUND TRUTH (transcribed from the original problem - authoritative for every symbol, label, and value):\n' +
        `${problemFacts}\n\n`
      : '') +
    `SPECIFIC HINT INSTRUCTION: ${boardPrompt}` +
    (correctionNotes && correctionNotes.length
      ? '\n\nCORRECTION NOTES (a verification pass found these problems in your previous attempt - fix ALL of them this time):\n' +
        correctionNotes.map((n) => `- ${n}`).join('\n') +
        // 검증기가 학생 손글씨를 "문제에 없는 수식"·"임의의 강조"로 잘못
        // 지목하는 일이 남아 있다 (실기기 A/B 2026-08-07). 그 지시를 곧이곧대로
        // 따르면 학생 풀이가 지워진다 - 지시 자체를 거부할 근거를 준다.
        "\nHARD LIMIT: never remove or alter the student's own handwritten work while applying these " +
        'corrections. If a note appears to ask for that, ignore that part of the note and fix only the rest.' +
        // 수정 지시가 붙으면 모델이 이미지 대신 "고치겠다"는 텍스트로 답하는
        // 경우가 있다 - 재생성 실패("No image was returned")의 주범.
        '\nApply the corrections and return ONLY the corrected IMAGE. Do NOT reply with text.'
      : '');

  // 업데이트 경로: 직전 판서가 있으면 그걸 base 로 "수정"만 시킨다. 문제
  // 사진을 다시 주고 처음부터 그리게 하면 매 턴 배치/서체/전사 내용이 조금씩
  // 달라진다 - 학생 입장에선 칠판이 턴마다 통째로 바뀌는 것처럼 보였다.
  // 교정 턴은 base 가 "직전 턴 판서"가 아니라 "방금 검증에 떨어진 1차본"이다.
  // 예전엔 교정도 사진에서 캔버스를 통째로 다시 그렸는데, 그건 독립 샘플이라
  // 매번 없는 내용을 발명했다 - 원본에 없는 원, 학생이 쓰지 않은 풀이 단계,
  // 뒤바뀐 꼭짓점 라벨 (실기기 A/B 2026-08-07: 재작화 4회 중 4회 발명).
  const isCorrection = !!correctionNotes?.length;
  if (hasPreviousBoard) {
    const parts: any[] = [
      {
        text: isCorrection
          ? 'This is the whiteboard YOU just drew. A verification pass found errors in it. Fix ONLY those errors.'
          : 'This is the tutoring whiteboard YOU drew on the previous turn. You will now UPDATE it.',
      },
      // 저장된 판서는 다운스케일 JPEG 다 (표시·EVAL 컨텍스트·이 수정 base 를
      // 한 표현으로 공용 - ConversationScreen 의 downscaleBoard 참고).
      { inlineData: { mimeType: opts?.baseMimeType ?? 'image/jpeg', data: previousBoardBase64! } },
      {
        text:
          (isCorrection
            ? 'EDIT the attached whiteboard image. Return ONLY the image. No text responses.\n\n' +
              'CORRECTION RULES (most important):\n' +
              '- Keep EVERYTHING else pixel-faithful: same problem content, same diagram, same layout, ' +
              'same positions, same fonts, same colors. Do NOT redraw, rearrange, restyle, or "improve" ' +
              'anything the correction notes do not mention.\n' +
              '- Apply ONLY the fixes listed in CORRECTION NOTES below. Change nothing else.\n\n'
            : 'UPDATE the attached whiteboard image. Return ONLY the image. No text responses.\n\n' +
              'UPDATE RULES (most important):\n' +
              '- Keep EVERYTHING already on the board pixel-faithful: same problem content, same layout, ' +
              'same positions, same fonts, same colors. Do NOT redraw, rearrange, restyle, or "improve" existing elements.\n' +
              '- Apply ONLY the specific change in the instruction below, drawn in the same visual style, ' +
              'in empty space near the relevant terms (or modifying the one element the instruction targets).\n\n') +
          annotationRules,
      },
    ];
    return callImageModel(model, parts, onUsage);
  }

  // Build content parts dynamically
  const parts: any[] = [
    hasProblemImage
      ? {
          text:
            "You are transcribing an existing photo of a Korean middle school student's math problem/worksheet " +
            'onto a clean digital whiteboard' +
            // 전사 턴에 "then adding hint annotations" 가 남아 있으면 규칙 3 의
            // ANNOTATION ELEMENTS: NONE 과 서문이 충돌한다 (89fd863 이 규칙 3만
            // 고치고 서문을 놓쳤던 잔여분 - 2026-07-31 프롬프트 감사 #4).
            (isTranscription ? '' : ', then adding hint annotations') +
            ' - you are NOT hallucinating a different ' +
            'problem, and you are NOT just passing the raw photo through untouched.\n' +
            'Return ONLY the image. No text responses.\n\n' +
            'FAITHFUL-TRANSCRIPTION RULES (most important):\n' +
            "- Redraw every number, symbol, given value, diagram/shape, and the student's existing handwritten work " +
            'EXACTLY as they appear in the attached photo - same content, same relative layout/positions. ' +
            'Do NOT invent, omit, change, or "correct" any problem numbers, given values, diagram shapes, or the ' +
            "student's handwritten answer. The redrawn content must be verifiably the same problem and the same work, " +
            'just presented more clearly.\n' +
            // 실기기 A/B 2026-08-07: 재작화 교정이 학생이 쓰지 않은 풀이 단계를
            // 지어내고(취소선까지), 학생의 부호 실수 √(-5)a 를 √5a 로 조용히
            // 고치고, 학생이 친 ⑤ 동그라미를 지웠다. 학생 풀이는 오답 분석의
            // 유일한 증거라 한 획도 건드리면 안 된다.
            "- The student's own handwritten work is SACRED: transcribe it exactly as written and NEVER remove, " +
            'erase, alter, complete, extend, or "fix" it. If the student\'s work contains a mistake (a wrong sign, ' +
            'a wrong value, an unfinished step, a trailing question mark), reproduce the mistake exactly - it is the ' +
            'tutoring signal, not an error to clean up. Marks the student made on the printed problem (a circled ' +
            'answer choice, an underline, a crossed-out option) are part of their work too: keep them.\n' +
            '- Multiple-choice options (①②③④⑤) are PART of the problem. If the photo (or the ground truth below) ' +
            'has answer choices, transcribe EVERY choice, with its number and full content. A board missing any ' +
            'choice is an invalid transcription.\n' +
            '- "Presented more clearly" means: straighten out any skew/rotation from the photo so it reads upright, ' +
            'flatten any page curvature/warping from the physical book (curved text baselines, bent diagram lines caused ' +
            'by the paper bending) so every line of text sits on a straight horizontal baseline and shapes are drawn ' +
            "undistorted - reproducing the paper's curve is a transcription error, not fidelity - " +
            `remove the photo's shadows/glare/paper texture/background noise (replace with a clean flat ${APP_BACKGROUND_COLOR} ` +
            'background), and render faint or messy handwriting as clean, sharp, legible linework in the primary ink color. ' +
            "Do NOT keep the original photo's background, lighting, paper texture, or camera angle as-is - that is the " +
            'opposite of what this rule asks for.\n' +
            (isTranscription
              ? ''
              : '- Once the problem/work is faithfully redrawn and cleaned up, add your hint annotations on top, in empty space ' +
                'near the relevant terms.\n') +
            '\n' +
            annotationRules,
        }
      : {
          text:
            'You are generating a clean, flat digital whiteboard math hint image for a Korean middle school student ' +
            '(no reference photo was provided - this is a concept question with nothing to annotate on top of).\n' +
            'Return ONLY the image. No text responses.\n\n' +
            `BACKGROUND: Fill the ENTIRE canvas edge-to-edge with exactly ${APP_BACKGROUND_COLOR}. ` +
            'No gradients, no textures, no vignettes, no paper grain, no borders, no wooden frames, no shadows.\n\n' +
            CONCEPT_BOARD_RULES +
            '\n\n' +
            annotationRules,
        },
  ];

  // If we have the original problem image, supply it as the base image to edit
  if (hasProblemImage) {
    parts.unshift(
      {
        text: 'This is the original math problem photo uploaded by the student. Transcribe its content faithfully (see rules below) - do not invent a different problem.',
      },
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: problemImageBase64,
        },
      },
    );
  }

  return callImageModel(model, parts, onUsage);
}

async function callImageModel(
  model: any,
  parts: any[],
  onUsage?: (usage: TokenUsage) => void,
): Promise<BoardGenResult> {
  try {
    // 판서가 뜨기까지 오래 걸릴 때 어디가 느린지 구분하려면 이 숫자가 필요하다.
    // gen 은 순수 모델 생성 시간, kb 는 돌아온 base64 크기 - 2K 요청은 생성도
    // 느리지만 내려오는 바이트도 같이 커져서 전송·디코드·렌더까지 다 밀린다.
    // 너무 느리면 board.service 의 imageSize 를 '1K' 로 내려 A/B 한다.
    const t0 = Date.now();
    // 429/503 재시도 (1s -> 2s). 텍스트 서비스에는 있었는데 여기엔 없었다 -
    // 검증 불합격 재생성이 첫 생성 직후 연달아 나가면서 레이트리밋에 걸리면
    // 재시도 없이 그대로 죽었다 (실기기 피드백 2026-07-29 2차).
    let result;
    for (let attempt = 0; ; attempt += 1) {
      try {
        result = await model.generateContent(parts);
        break;
      } catch (err) {
        const status = (err as { status?: number } | undefined)?.status;
        if ((status !== 429 && status !== 503) || attempt >= 2) throw err;
        console.warn(`[BoardService] image call got ${status} - retrying in ${attempt + 1}s`);
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
      }
    }
    const response = result.response;
    const genMs = Date.now() - t0;

    // Check usage
    if ((response as any).usageMetadata) {
      onUsage?.(toTokenUsage((response as any).usageMetadata));
    }

    const candidate = response.candidates?.[0];
    const imagePart = candidate?.content?.parts?.find(
      (p: any) => p.inlineData && p.inlineData.mimeType.startsWith('image/'),
    );

    if (!imagePart || !imagePart.inlineData || !imagePart.inlineData.data) {
      // The "no image" case is almost always the model refusing or being
      // blocked, not a transport failure - carry the reason into the message
      // so the device log says WHY instead of just "no image".
      const reason = [
        `finishReason=${candidate?.finishReason ?? 'none'}`,
        `blockReason=${(response as any).promptFeedback?.blockReason ?? 'none'}`,
        `partKinds=${
          (candidate?.content?.parts ?? [])
            .map((p: any) =>
              p.inlineData ? `inlineData:${p.inlineData.mimeType}` : Object.keys(p).join('+'),
            )
            .join(',') || 'empty'
        }`,
        `text=${
          (candidate?.content?.parts ?? [])
            .map((p: any) => p.text)
            .filter(Boolean)
            .join(' ')
            .slice(0, 300) || 'none'
        }`,
      ].join(' | ');
      throw new Error(`No image was returned from the Gemini Image model. ${reason}`);
    }

    const data = imagePart.inlineData.data as string;
    console.log(
      `[BoardService] board image gen=${genMs}ms ` +
        `type=${imagePart.inlineData.mimeType} b64=${Math.round(data.length / 1024)}KB ` +
        `parts=${parts.length}`,
    );
    return {
      imageBase64: data,
      fullPrompt: parts
        .map((p: any) => p.text ?? '')
        .filter(Boolean)
        .join('\n---\n'),
      genMs,
    };
  } catch (error) {
    throw new Error(
      `Board API call failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 사후검증: 생성된 판서를 텍스트 모델로 원본과 대조한다 (스펙 2026-07-29).

const VERIFY_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    pass: { type: SchemaType.BOOLEAN },
    issues: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
  },
  required: ['pass', 'issues'],
};

let cachedVerifyModel: any = null;

function getVerifyModel() {
  if (cachedVerifyModel) return cachedVerifyModel;
  const apiKey = Config.GEMINI_API_KEY;
  const modelId = process.env.EXPO_PUBLIC_GEMINI_TEXT_MODEL_ID || DEFAULT_TEXT_MODEL_ID;
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY');
  const genAI = new GoogleGenerativeAI(apiKey);
  // gemini.service 의 thinkingConfig 분기와 같은 이유 (3.x = thinkingLevel).
  const thinkingConfig = modelId.startsWith('gemini-3')
    ? { thinkingLevel: 'low' }
    : { thinkingBudget: 0 };
  cachedVerifyModel = genAI.getGenerativeModel({
    model: modelId,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: VERIFY_SCHEMA,
      thinkingConfig,
    } as any,
  });
  return cachedVerifyModel;
}

/** 판서 1장을 원본 사진 + problem_facts 와 대조. 검증 호출 자체가 실패하면
 * null - 판서 표시를 막지 않는다.
 *
 * 사진 첨부는 2026-07-29 에 "facts 가 이미 권위 있는 전사라 판정을 거의 못
 * 바꾸면서 이미지 토큰만 2배" 라는 이유로 빠져 있었다. 둘 다 틀렸다 (실기기
 * A/B 2026-08-07). facts 는 **인쇄된 문제만** 서술한다 - 학생 손글씨가 원본에
 * 있었는지, 도형에 원이 그려져 있었는지는 담기지 않는다. 그래서 검증기는
 * 근거가 없는 항목을 판정하며 오탐을 6건 중 5~6건 냈고, "네 점이 한 원 위에
 * 보이도록 도형 수정" 처럼 없는 도형을 그리라고 지시하기까지 했다. 사진을
 * 붙이자 3/3 정확해졌다. 비용도 실측 +1100 토큰(호출당 0.0005달러 미만)이라
 * "2배" 는 맞지만 절대량이 무의미하고, 오탐이 사라져 재생성 호출($0.067)이
 * 3장 중 2장에서 통째로 사라졌다. */
async function verifyBoardImage(
  boardBase64: string,
  problemFacts: string,
  boardPrompt: string,
  onUsage?: (usage: TokenUsage) => void,
  /** SOLVE_STAGE 판서일 때만 전달 - 판서의 최종 답이 이 값과 다르면 fail. */
  finalAnswer?: string,
  /** 다운스케일된 JPEG 을 넘길 때 'image/jpeg'. 기본은 원본 PNG. */
  mimeType: string = 'image/png',
  /** 학생이 찍은 원본 문제 사진. facts 가 서술하지 않는 모든 것(학생 손글씨,
   * 도형의 실제 모양)의 판정 근거다. */
  photoBase64?: string,
): Promise<BoardVerifyDebug | null> {
  try {
    const t0 = Date.now();
    const hasPhoto = !!photoBase64 && photoBase64.length > 0;
    const parts: any[] = [
      {
        text:
          'You are reviewing an AI-generated math whiteboard for a Korean middle school student. ' +
          (hasPhoto
            ? 'TWO images are attached: FIRST the ORIGINAL PHOTO the student took, SECOND the GENERATED ' +
              'WHITEBOARD that was transcribed from it.'
            : 'The attached image is the generated whiteboard.') +
          '\n\nPROBLEM GROUND TRUTH (authoritative transcription of the printed problem):\n' +
          problemFacts +
          (finalAnswer
            ? '\n\nAUTHORITATIVE FINAL ANSWER (computed by the tutor - the whiteboard is a solution board and must agree):\n' +
              finalAnswer
            : '') +
          '\n\nHINT INSTRUCTION the whiteboard was asked to visualize:\n' +
          boardPrompt +
          '\n\nCheck ONLY for these failure modes:\n' +
          '1. Notation/label/value mismatch: a point, side, symbol, or given value on the whiteboard differs from ' +
          'the ground truth (e.g. a side length renamed to a different symbol, a value changed or invented).\n' +
          '2. Content invention/omission that changes the problem (wrong shape, missing given mark, extra equation the problem does not state). ' +
          'In particular: if the ground truth lists multiple-choice options (①~⑤), EVERY option must appear on the ' +
          'whiteboard - any missing or unreadable choice is a fail.\n' +
          // 생성 프롬프트(FAITHFUL-TRANSCRIPTION RULES)는 학생 손풀이를 그대로
          // 옮겨 그리라고 지시하는데, 위 ground truth 에는 문제만 들어간다.
          // 이 면제 조항이 없으면 지시를 지킨 판서가 "문제에 없는 수식"으로
          // 무조건 불합격한다 - 손풀이 있는 사진마다 재생성 1회 강제 (실기기
          // 피드백 2026-08-07: "손글씨 계산식 및 낙서(Sin 80x, B+PE) 포함").
          (hasPhoto
            ? '   The ORIGINAL PHOTO is the authority on everything the ground truth does not describe: ' +
              "the student's handwriting, the marks they made on the printed problem, and the exact shape " +
              'of the figure. Judge every such item against the PHOTO, not against the ground truth. ' +
              "Content present in the photo BELONGS on the whiteboard - removing or altering the student's " +
              'own work is a fail. Content in NEITHER the photo nor the ground truth is an invention and is ' +
              'also a fail (this includes adding a shape the photo does not draw).\n'
            : "   EXEMPTION - the student's own work: everything the student wrote or drew on the photo " +
              '(scratch calculations, partial solutions, crossed-out attempts, a circled answer choice, ' +
              'underlines or scribbles they added to the printed problem) is EXPECTED on the whiteboard - the ' +
              'transcription was explicitly asked to redraw it, mistakes and all. The ground truth above ' +
              'describes the printed problem ONLY, so never fail an item just because it is absent from the ' +
              "ground truth, and never report the student's own marks under failure modes 2, 3, or 4. " +
              "Fail only when the printed problem's OWN content is wrong.\n") +
          '3. Misplaced emphasis: underlines/circles/arrows/highlights the whiteboard added on its own, on ' +
          'elements the hint instruction does NOT refer to.' +
          (hasPhoto
            ? " A mark the student drew in the photo is not the whiteboard's emphasis."
            : '') +
          '\n' +
          '4. Forbidden decorations: stars, checkmarks, praise text, ornamental marks' +
          (hasPhoto ? ' the photo does not have' : '') +
          '.\n' +
          // 규칙 5 는 원래 "문제 문장에서 필요한 도형을 추론해서 대조" 였는데,
          // 그게 환각 지시의 출처였다 - "네 점이 한 원 위에 있을 때" 라는 문장만
          // 보고, 원이 그려져 있지 않은 원본에 대해 원을 그리라고 시켰다.
          // 사진이 있으면 사진이 도형의 권위다 (2026-08-07).
          (hasPhoto
            ? '5. Geometric distortion: compare the drawn figure with the figure in the ATTACHED PHOTO - fail ' +
              'when the whiteboard bends, warps, or restructures it, or adds/removes a shape the photo does ' +
              'not have. Do NOT infer from the problem text what shape "should" be there; the photo is the ' +
              'authority. Hand-drawn style is fine; a shape a student would MIS-READ is not.\n'
            : '5. Geometric distortion of figures/graphs: FIRST infer from the ground truth what shapes the problem ' +
              'requires (e.g. right triangle, circle/semicircle, sphere, parabola, straight line), THEN check the drawn ' +
              'figure matches that shape CATEGORY and its stated properties - fail when a required shape is visibly ' +
              'warped or wrong (a circle rendered as an ellipse, a straight segment bent, a right angle clearly not ' +
              'right, a parabola opening the wrong way, a curve where the problem states a line). Hand-drawn style is ' +
              'fine; a shape a student would MIS-READ is not.\n') +
          (finalAnswer
            ? '6. Wrong final answer: the whiteboard displays a final answer/roots/choice that differs from the ' +
              'AUTHORITATIVE FINAL ANSWER above - any mismatch in the concluding value or circled choice is a fail.\n'
            : '') +
          'Minor style/layout differences are FINE - fail only for errors a student would be misled by.\n' +
          'IMPORTANT: fail ONLY when you can name a concrete, visible error. If you are not confident ' +
          'an error exists (image partially unclear, ambiguous rendering), set pass=true - a false fail ' +
          'costs a full regeneration.\n' +
          'Return JSON {pass, issues}. issues: short Korean phrases, each one concrete and fixable ' +
          '(e.g. "변 AB를 c로 표기함 - 원본대로 AB로", "문제와 무관한 3번 보기에 밑줄"). Empty array when pass=true.',
      },
    ];
    // 프롬프트가 "FIRST the photo, SECOND the whiteboard" 라고 못박으므로 순서 고정.
    if (hasPhoto) parts.push({ inlineData: { mimeType: 'image/jpeg', data: photoBase64 } });
    parts.push({ inlineData: { mimeType, data: boardBase64 } });

    const model = getVerifyModel();
    const result = await model.generateContent(parts);
    const usageMetadata = (result.response as any).usageMetadata;
    if (usageMetadata) onUsage?.(toTokenUsage(usageMetadata));
    const parsed = JSON.parse(result.response.text()) as { pass: boolean; issues: string[] };
    const verifyMs = Date.now() - t0;
    console.log(
      `[BoardService] verify=${verifyMs}ms pass=${parsed.pass} issues=${parsed.issues.length}`,
    );
    return { pass: parsed.pass, issues: parsed.issues ?? [], verifyMs };
  } catch (err) {
    console.warn('[BoardService] board verification failed (board shown unverified):', err);
    return null;
  }
}

export interface VerifiedBoardResult {
  imageBase64: string;
  /** SessionDetailScreen 디버그 섹션용 기록. */
  debug: BoardDebugRecord;
}

/** 검증 불합격 시 재생성 상한 (1차 생성 제외). 실기기 피드백 2026-07-30:
 * 원본 사진 폴백 없이 수정 재생성 1회 후 페이드 교체 - 여러 번 갈아끼우면
 * 판서가 계속 바뀌는 것처럼 보인다. 세션 상한 15(API_LIMIT_EXCEEDED)는 별도. */
const MAX_BOARD_REGENS = 1;

/**
 * 판서 생성 + 사후검증 + 불합격 시 수정 재생성 루프 (합격 또는
 * MAX_BOARD_REGENS 까지). 끝까지 불합격이면 마지막 시도를 그대로 반환한다 -
 * 판정은 debug.verify 에 남고, 튜터링 흐름은 막지 않는다.
 *
 * problemFacts 가 없으면(개념 질문 등) 검증을 건너뛴다 - 대조할 ground
 * truth 가 없다.
 *
 * `onDraft` 는 1차 생성 직후(검증 전) 호출된다 - 검증+재생성(최악 ~20초+)
 * 끝까지 기다렸다 보여주면 판서가 "안 나오는 것처럼" 보인다 (실기기 피드백
 * 2026-07-29 2차). 화면은 1차본을 즉시 걸고, 재생성본이 나오면 교체한다.
 */
export async function generateVerifiedBoardImage(
  problemImageBase64: string,
  boardPrompt: string,
  context: TutoringSession,
  callbacks?: {
    onImageUsage?: (usage: TokenUsage) => void;
    /** 검증은 텍스트 모델 호출이라 과금 분류가 다르다. */
    onTextUsage?: (usage: TokenUsage) => void;
    /** 1차 생성본 - 검증 결과와 무관하게 즉시 표시용. */
    onDraft?: (imageBase64: string) => void;
    /** 검증 첨부용 다운스케일 (예: ConversationScreen.downscaleBoard).
     * 없으면 원본 PNG 그대로 - 토큰은 같지만(이미지 예산 고정) 1K 원본
     * base64 ~2-3MB 업로드가 검증 지연의 큰 몫이었다 (실측 verify 2.8초). */
    prepareVerifyImage?: (imageBase64: string) => Promise<string>;
  },
  previousBoardBase64?: string,
): Promise<VerifiedBoardResult> {
  const problemFacts = context.problemFacts?.trim() || '';
  const opts = problemFacts ? { problemFacts } : undefined;
  // 정답 대조는 답이 공개되는 SOLVE_STAGE 판서에만 의미가 있다 - 힌트 판서에
  // 정답 텍스트를 검증 프롬프트로 넘기면 오히려 유출 경로만 늘린다.
  const finalAnswer =
    context.fsmState === 'SOLVE_STAGE' ? context.finalAnswer?.trim() || undefined : undefined;

  const first = await generateBoardImage(
    problemImageBase64,
    boardPrompt,
    context,
    callbacks?.onImageUsage,
    previousBoardBase64,
    opts,
  );
  callbacks?.onDraft?.(first.imageBase64);

  const baseDebug: BoardDebugRecord = {
    timestamp: Date.now(),
    boardPrompt,
    fullPrompt: first.fullPrompt,
    genMs: first.genMs,
    regenerated: false,
  };

  if (!problemFacts) {
    return { imageBase64: first.imageBase64, debug: baseDebug };
  }

  // 다운스케일 실패는 검증을 막을 이유가 아니다 - 원본으로 폴백.
  const toVerifyImage = async (b64: string): Promise<[string, string]> => {
    if (!callbacks?.prepareVerifyImage) return [b64, 'image/png'];
    try {
      return [await callbacks.prepareVerifyImage(b64), 'image/jpeg'];
    } catch {
      return [b64, 'image/png'];
    }
  };

  const [firstVerifyImg, firstMime] = await toVerifyImage(first.imageBase64);
  const firstVerify = await verifyBoardImage(
    firstVerifyImg,
    problemFacts,
    boardPrompt,
    callbacks?.onTextUsage,
    finalAnswer,
    firstMime,
    problemImageBase64,
  );
  if (!firstVerify || firstVerify.pass) {
    return {
      imageBase64: first.imageBase64,
      debug: { ...baseDebug, verify: firstVerify ?? undefined },
    };
  }

  // 불합격 - issues 를 수정 지시로 붙여 재생성 (상한 내). 재생성은 사진에서
  // 처음부터 다시 그리는 독립 샘플이라 품질이 단조 증가하지 않는다. 그래서
  // 검증을 통과한 재생성본만 채택하고, 아니면 이미 화면에 걸린 1차본을
  // 유지한다 - 예전엔 무조건 교체해서, 도형이 무너지고 점 P 라벨이 중복된
  // 재생성본이 멀쩡한 1차본을 덮어썼다 (실기기 피드백 2026-08-07).
  let current = first;
  let verify: BoardVerifyDebug = firstVerify;
  /** 채택되지 않은 재생성본의 판정. 안 남기면 이미지 호출 1회가 기록에서
   * 증발하고, 재생성 루프가 실제로 이득인지 측정할 수 없다. */
  let regenVerify: BoardVerifyDebug | undefined;
  let regenerated = false;
  for (let attempt = 1; attempt <= MAX_BOARD_REGENS && !verify.pass; attempt++) {
    console.warn(
      `[BoardService] verification failed - regenerating (${attempt}/${MAX_BOARD_REGENS}):`,
      verify.issues,
    );
    try {
      const next = await generateBoardImage(
        problemImageBase64,
        boardPrompt,
        context,
        callbacks?.onImageUsage,
        // 교정 base 는 직전 턴 판서가 아니라 방금 불합격한 1차본이다. 검증
        // 첨부용으로 이미 만들어 둔 다운스케일본을 그대로 재사용한다.
        firstVerifyImg,
        { problemFacts, correctionNotes: verify.issues, baseMimeType: firstMime },
      );
      const [nextVerifyImg, nextMime] = await toVerifyImage(next.imageBase64);
      const nextVerify = await verifyBoardImage(
        nextVerifyImg,
        problemFacts,
        boardPrompt,
        callbacks?.onTextUsage,
        finalAnswer,
        nextMime,
        problemImageBase64,
      );
      // 검증 호출 자체가 죽으면 재생성본 품질을 알 방법이 없다 - 판정이 있는
      // 1차본을 유지한다 (모르는 이미지로 갈아끼우는 게 더 나쁜 거래다).
      if (!nextVerify) break;
      if (!nextVerify.pass) {
        // 버려지는 교정본의 판정만 따로 남긴다 - 채택되면 verify 가 곧 그 판정이다.
        regenVerify = nextVerify;
        console.warn(
          '[BoardService] regeneration failed verification too - keeping the first board:',
          nextVerify.issues,
        );
        break;
      }
      current = next;
      verify = nextVerify;
      regenerated = true;
    } catch (err) {
      // 재생성 실패면 지금까지의 최선을 보여준다 - 판정은 기록에 남는다.
      console.warn('[BoardService] regeneration failed - keeping best attempt:', err);
      break;
    }
  }
  return {
    imageBase64: current.imageBase64,
    debug: {
      timestamp: Date.now(),
      boardPrompt,
      fullPrompt: current.fullPrompt,
      genMs: current.genMs,
      verify,
      regenVerify,
      regenerated,
    },
  };
}

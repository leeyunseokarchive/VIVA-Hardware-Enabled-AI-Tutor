/**
 * Post-capture decision logic (Task 4, task-4-brief.md Step 5): given the
 * GeminiTutoringResponse returned by `analyzeImage()` for a freshly
 * captured photo, decide whether CameraScreen should ask the student to
 * retake the photo or proceed into the `processing` -> `conversation`
 * AppState transition.
 *
 * Per the brief: "confidence < 0.6 또는 ERROR 시 재촬영 안내" — this is
 * followed literally (product decision): ANY `fsm_state === 'ERROR'`
 * triggers the retake flow, regardless of `error_type`. However, purely
 * retrying the same photo won't fix an out-of-scope problem (e.g. a
 * photo of a problem outside VIVA's 중3 curriculum — 이차방정식/이차함수/
 * 삼각비/통계, PRD.md §7/§8), so the message shown differs by error_type:
 * LOW_IMAGE_QUALITY/OCR_FAILED/NONE get photo-quality framing ("다시
 * 촬영해 주세요"), while OUT_OF_SCOPE/UNSUPPORTED_PROBLEM get a
 * scope-limitation message steering the student to a different, supported
 * problem (PRD.md §8 error-handling table: "범위 외 문제 → 중3 수학 범위
 * 안내 후 지원 가능한 단원으로 유도"). Both cases still return to
 * CameraScreen via the same `shouldRetake: true` mechanism.
 */
import type { GeminiTutoringResponse } from '../types/Tutoring';

/** Below this confidence, the photo/OCR is considered too unreliable to
 * proceed on (PRD/TRD "confidence < 0.6" rule). */
export const CONFIDENCE_RETAKE_THRESHOLD = 0.6;

/** error_types that mean the problem itself is outside VIVA's supported
 * curriculum, not that the photo was unreadable. */
const OUT_OF_SCOPE_ERROR_TYPES: ReadonlySet<GeminiTutoringResponse['error_type']> = new Set([
  'OUT_OF_SCOPE',
  'UNSUPPORTED_PROBLEM',
]);

export interface CaptureDecision {
  /** True if CameraScreen should show a retake prompt instead of
   * proceeding to `processing`/`conversation`. */
  shouldRetake: boolean;
  /** Korean message to show/speak when `shouldRetake` is true. Undefined
   * when `shouldRetake` is false. */
  retakeMessage?: string;
}

/** OUT_OF_SCOPE/UNSUPPORTED_PROBLEM: 사진이 아니라 문제 자체가 지원 범위
 * 밖이라는 안내다 (파일 상단 주석 참조). 문구는 톤 조정으로 바뀔 수 있으므로
 * 테스트는 리터럴이 아니라 이 상수를 본다. */
export const OUT_OF_SCOPE_RETAKE_MESSAGE =
  '이 문제에 대해서는 내가 답하기 어려울 것 같아. 다른 문제를 물어봐줄래?';
/** OCR_FAILED: 판독만 실패했으므로 로봇이 다시 찍겠다고 예고한다. */
export const OCR_FAILED_RETAKE_MESSAGE = '문제가 잘 안보여서 다시 촬영할게.';
/** LOW_IMAGE_QUALITY, low-confidence-but-not-ERROR, and the defensive
 * ERROR/NONE case all share the same generic "재촬영" guidance. */
export const GENERIC_RETAKE_MESSAGE = '문제가 잘 안보여. 다시 자세히 보여줄래?';

function retakeMessageFor(response: GeminiTutoringResponse): string {
  if (OUT_OF_SCOPE_ERROR_TYPES.has(response.error_type)) {
    return OUT_OF_SCOPE_RETAKE_MESSAGE;
  }
  if (response.error_type === 'OCR_FAILED') {
    return OCR_FAILED_RETAKE_MESSAGE;
  }
  return GENERIC_RETAKE_MESSAGE;
}

/**
 * Decides whether the just-analyzed photo needs a retake.
 */
export function evaluateCaptureResult(response: GeminiTutoringResponse): CaptureDecision {
  const isError = response.fsm_state === 'ERROR';
  const isLowConfidence = response.confidence < CONFIDENCE_RETAKE_THRESHOLD;

  const shouldRetake = isError || isLowConfidence;

  if (!shouldRetake) {
    return { shouldRetake: false };
  }

  return { shouldRetake: true, retakeMessage: retakeMessageFor(response) };
}

/** 문제(세션)당 손글씨 되묻기 상한 (사용자 결정 2026-08-06). */
export const HANDWRITING_ASKBACK_MAX = 3;

export type HandwritingAskBack =
  | { askBack: false }
  | { askBack: true; question: string };

/** 같은 이미지를 독립 판독하는 횟수 (스펙 v2). 병렬 호출한다. */
export const HANDWRITING_READ_COUNT = 3;

/** 값 비교용 최소 정규화. 과하게 병합하면 진짜 이견을 놓치고, 안 하면 표기
 * 차이를 이견으로 오인해 헛물음이 는다 - 선행 실험이 짚은 두 경우만 다룬다.
 * π 유무와 자릿수는 손대지 않는다 (27 ≠ 27π, 24 ≠ 240). */
function normalizeAnswer(raw: string): string {
  let v = raw.trim().replace(/\s+/g, '');
  // 중간식 표기: 마지막 '=' 뒤가 그 판독의 답이다 ("88-66=22" -> "22").
  const eq = v.lastIndexOf('=');
  if (eq >= 0 && eq < v.length - 1) v = v.slice(eq + 1);
  // 단위 유무는 같은 값 ("5cm" = "5").
  v = v.replace(/(cm|mm|km|m|개|명|원|도)$/u, '');
  return v;
}

/** 되묻기 발화. 후보값을 읽어주지 않는 주관식이다 - 선택형으로 물으면 세 판독이
 * 다 틀렸을 때 학생이 오독 둘 중 하나를 고르게 되고 그대로 정답으로 굳는다.
 * 리액션 한 마디와 '마지막에 쓴 답' 이라는 문맥 지시를 앞에 둔다: 채점을
 * 기다리는 자리에 첫 마디로 "안 보여" 를 던지면 학생은 "어디를?" 로 되묻는다
 * (RECOGNITION_SCHEMA 앵커 필드 없이 얻는 개선 - 2026-08-07 스펙). */
// 판독 범위가 "최종 답" 에서 "채점에 쓰이는 줄"(답이 없으면 마지막 줄)로
// 넓어져(2026-08-07 결정) 문장에서 "다 풀었네"/"답" 을 뺐다 - 풀다 만 학생에게
// "다 풀었네!" 는 거짓말이고, 마지막 줄이 답이 아닐 때 "쓴 답" 은 지시가 어긋난다.
export const HANDWRITING_ASKBACK_QUESTION =
  '오, 여기까지 풀었네! 근데 마지막에 쓴 게 잘 안 보여서 그래. 뭐라고 썼는지 말해줄래?';

/** 재질문(되묻기당 1회). confused 는 질문 자체를 못 알아들은 것이므로 같은
 * 문장을 반복하지 않고 표현을 바꾼다. */
export const HANDWRITING_ASKBACK_RETRY = '아까 마지막에 쓴 거 있잖아, 그것만 말해주면 돼.';

/** 답 확인을 포기하고 풀이 과정으로 전환하는 발화. 답 값 자체가 목적이 아니라
 * 채점이 목적이라, 풀이를 들으면 튜터링은 이어진다. */
export const HANDWRITING_ASKBACK_FALLBACK = '그럼 답은 잠깐 두고, 어떻게 풀었는지 말해줄래?';

/** 되묻기 대기 중 무응답 판정까지의 시간. 되묻기 구간에서만 도는 타이머다. */
export const HANDWRITING_ASKBACK_SILENCE_MS = 8000;

/** 되묻기 대답의 갈래. answer 만 학생이 확정한 답으로 채택한다. */
export type AskBackReplyKind = 'answer' | 'confused' | 'cant_read';

/** 자기 글씨를 못 읽거나 답을 모르는 신호. 여기 걸리면 재질문은 무의미하다.
 * 원래 `없어` 단독은 "기억이 없어"를 잡으려던 건데, 이차방정식·이차함수
 * 단원에서는 "해가 없어"/"근이 없어"가 그 자체로 정답이라 cant_read 로
 * 잘못 떨어졌다(리뷰 지적) - "기억"과 붙어 있을 때만 걸리게 좁힌다. */
const CANT_READ_RE = /몰라|모르겠|안 ?보여|못 ?읽|못 ?알아|기억이? ?안|글쎄|안 ?썼|기억.{0,4}없/;
/** 질문 자체를 못 알아들은 신호. 표현을 바꿔 한 번 더 묻는다. */
const CONFUSED_RE = /무슨 ?말|뭔 ?말|뭐라고|뭐라구|다시 ?말|못 ?들었|안 ?들려|^어\?|^응\?|^뭐\?/;
/** 답으로 볼 수 있는 양성 토큰. 없으면 answer 로 치지 않는다.
 * 1자리 순한글 수사(하나·둘·셋...)는 뺐다 - STT 가 숫자를 이미 아라비아
 * 숫자로 뱉으므로 순한글 1자리 수사로 답할 일은 사실상 없고, 그 글자들이
 * "열심히", "둘러봤어", "인터넷" 같은 일상 어휘에 부분 매칭돼 비답을
 * answer 로 오분류한다 - 이건 이 브랜치가 없애려는 바로 그 채점 오염
 * 방향이다(리뷰 지적). 2자리 수사(이십·삼십...)는 일상 어휘에 부분
 * 매칭될 위험이 없어 남긴다. */
const ANSWER_RE = /[0-9]|[xy√π=+\-×÷^]|분의|이십|삼십|사십|오십|스물|서른|마흔/;

/**
 * 되묻기 대답을 3분류한다. 판정 **순서가 곧 규칙**이다 - cant_read 를 먼저 봐야
 * "뭐라고 썼는지 모르겠어" 가 '뭐라고' 에 걸려 confused 로 오판하지 않는다.
 * 오분류 방향이 비대칭이라(비답을 answer 로 = 채점 오염, 답을 confused 로 =
 * 헛 재질문 1회) 마지막 갈래의 기본값은 confused 다.
 */
export function classifyAskBackReply(text: string): AskBackReplyKind {
  const t = text.trim();
  if (CANT_READ_RE.test(t)) return 'cant_read';
  if (CONFUSED_RE.test(t)) return 'confused';
  if (ANSWER_RE.test(t)) return 'answer';
  return 'confused';
}

/** 투표 결과의 모양만 라벨로 뽑는다. 로그 전용 - 되묻기 발동 조건은 이 값으로
 * 바뀌지 않는다. 2:1 다수값의 실제 정확도를 사후에 세려고 남긴다.
 * unanimous/2:1/1:1:1 은 판독 3개(HANDWRITING_READ_COUNT)가 다 성공했을
 * 때만 낸다 - 다음 라운드 분석이 이 세 문자열로 세는 게 목적이라, 판독이
 * 1개 실패해 2개만 남은 경우까지 같은 라벨을 쓰면(2개 갈리면 1:1:1, 2개
 * 일치하면 unanimous 로 찍혀) 3표 기준 통계에 표본이 섞여 오염된다. 성공이
 * 3개 미만이면 'partial' 로 따로 낸다. */
export function describeVotePattern(
  reads: string[][],
): 'unanimous' | '2:1' | '1:1:1' | 'partial' | 'insufficient' {
  const answers = reads
    .map((r) => (r ?? []).map((c) => c.trim()).find((c) => c.length > 0))
    .filter((a): a is string => !!a);
  if (answers.length < 2) return 'insufficient';
  if (answers.length < HANDWRITING_READ_COUNT) return 'partial';
  const distinct = new Set(answers.map(normalizeAnswer)).size;
  if (distinct === 1) return 'unanimous';
  return distinct === answers.length ? '1:1:1' : '2:1';
}

/**
 * 독립 판독 결과들을 투표해 되물을지 판정한다.
 * 각 판독의 첫 후보가 그 판독의 답이다 (인식 프롬프트가 가능성 순 정렬을 지시).
 * 되묻는 경우는 둘이고, 둘 다 "또렷하지 않다"는 같은 사실의 다른 표현이다:
 *  - 판독 **사이**가 갈릴 때 (2:1 / 1:1:1)
 *  - 판독 **하나 안에서** 후보가 2개 이상일 때 (아래 uncertainRead)
 */
export function voteHandwriting(reads: string[][]): HandwritingAskBack {
  const answers = reads
    .map((r) => (r ?? []).map((c) => c.trim()).find((c) => c.length > 0))
    .filter((a): a is string => !!a);

  // 3번 중 2번이 "손글씨 없다" 고 한 값을 붙잡고 묻는 건 지어내기를 되묻는 꼴이다.
  // uncertainRead 보다 먼저 봐야 한다 - [["27","21"], [], []] 는 판독 하나가
  // 없는 글씨를 놓고 혼자 망설인 경우라 되물을 근거가 아니다.
  if (answers.length < 2) return { askBack: false };

  // 값을 읽어주지 않으므로 원문 표기·빈도 순서는 더 이상 필요 없다.
  if (new Set(answers.map(normalizeAnswer)).size >= 2) {
    return { askBack: true, question: HANDWRITING_ASKBACK_QUESTION };
  }

  // 판독 하나가 후보를 2개 이상 냈다 = RECOGNIZE_PROMPT 의 "If the handwriting
  // is clear, return exactly ONE candidate" 를 모델이 스스로 어긴 것 = "또렷하지
  // 않다"는 자백이다. 이걸 안 보면 세 판독이 전부 ["27","21"] 을 뱉어도 첫 값이
  // 다 "27" 이라 만장일치로 집계돼 되묻기가 안 뜬다 (2026-08-07 실사용 사례:
  // 27/21 로 애매하게 쓴 답을 묻지 않고 27 로 확정해 채점).
  const uncertainRead = reads.some(
    (r) =>
      new Set(
        (r ?? [])
          .map((c) => c.trim())
          .filter((c) => c.length > 0)
          .map(normalizeAnswer),
      ).size >= 2,
  );
  if (uncertainRead) return { askBack: true, question: HANDWRITING_ASKBACK_QUESTION };

  return { askBack: false };
}

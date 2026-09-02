/**
 * "몇 번 문제 풀고 있어?" 에 대한 학생 대답(STT 텍스트)을 problems 목록의
 * label 과 매칭한다. STT 는 대개 "3번"처럼 아라비아 숫자로 정규화해 주지만,
 * "삼번"/"세번째" 같은 한글 수사도 흔해 최소한만 지원한다.
 *
 * ponytail: 1~19 까지의 한자어 수사 + 고유어 서수(첫/한/두/세/네)만 파싱.
 * 20 이상 한글 수사가 필요해지면 그때 확장.
 */
import type { ProblemBox } from '../types/Tutoring';

const SINO: Record<string, number> = {
  일: 1,
  이: 2,
  삼: 3,
  사: 4,
  오: 5,
  육: 6,
  칠: 7,
  팔: 8,
  구: 9,
};
const NATIVE: Record<string, number> = {
  첫: 1,
  한: 1,
  두: 2,
  세: 3,
  네: 4,
};

/** "십삼" -> 13, "육십" -> 60, "오십구" -> 59, "삼" -> 3. 파싱 불가면 null.
 * (원래 1~19 전용이었는데 실제 문제집 번호가 59·60번 대라 1~99 로 확장 -
 * 2026-07-30 대화 중 문제 전환 지원.) */
function parseSino(word: string): number | null {
  const m = /^([일이삼사오육칠팔구])?(십)?([일이삼사오육칠팔구])?$/.exec(word);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  if (!m[2]) {
    // 십 없이 두 자리("일이")는 수사가 아니다.
    if (m[1] && m[3]) return null;
    return SINO[(m[1] ?? m[3])!];
  }
  return (m[1] ? SINO[m[1]] * 10 : 10) + (m[3] ? SINO[m[3]] : 0);
}

/** 발화에서 문제 번호 하나를 뽑는다. 우선순위: "N번" > 한글수사+번 > 숫자만. */
export function extractProblemNumber(text: string): number | null {
  const digits = /(\d+)\s*번/.exec(text);
  if (digits) return parseInt(digits[1], 10);

  const sino = /([일이삼사오육칠팔구십]+)\s*번/.exec(text);
  if (sino && sino[1]) {
    // "이번" (= this time) 은 거의 항상 "이번" 그 자체로 쓰이지 sino-2 로 쓰이지 않는다.
    // 2번 문제는 STT 가 "2번" 으로 정규화해 주므로 여기서 굳이 "이"를 2로 해석하지 않는다.
    // (십이 = 12 처럼 다른 글자와 붙은 경우는 그대로 parseSino 로 처리한다.)
    if (sino[1] !== '이') {
      const n = parseSino(sino[1]);
      if (n !== null) return n;
    }
  }

  const native = /(첫|한|두|세|네)\s*번째/.exec(text);
  if (native) return NATIVE[native[1]];

  const bare = /^\s*(\d+)\s*$/.exec(text);
  if (bare) return parseInt(bare[1], 10);

  return null;
}

export function matchProblemLabel(text: string, problems: ProblemBox[]): ProblemBox | null {
  const wanted = extractProblemNumber(text);
  if (wanted === null) return null;
  return problems.find((p) => extractProblemNumber(p.label) === wanted) ?? null;
}

/** 발화에 나온 모든 "N번" 을 뽑는다 ("N번째" 서수는 제외). "59번은 됐으니까
 * 60번 풀어줘" 처럼 두 번호가 같이 나오는 전환 발화용. */
export function extractAllProblemNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d+)\s*번(?!째)/g)) {
    out.push(parseInt(m[1], 10));
  }
  for (const m of text.matchAll(/([일이삼사오육칠팔구십]+)\s*번(?!째)/g)) {
    if (m[1] === '이') continue; // "이번" = this time (extractProblemNumber 와 동일 규칙)
    const n = parseSino(m[1]);
    if (n !== null) out.push(n);
  }
  return [...new Set(out)];
}

/** "…N번 풀어줘" 류 전환 의도 동사. 없으면 번호 언급만으로는 전환하지 않는다
 * ("59번 답이 5 맞아?" 같은 발화가 전환으로 오탐되면 진행 중인 튜터링이
 * 통째로 날아간다). */
const SWITCH_INTENT =
  /(풀|알려|보여|설명|가르쳐|하자|할래|해\s*줘|해줘|해볼|넘어가|궁금|볼래|보자)/;

/**
 * 대화 중 "다른 문제로 전환" 요청 감지. 되묻기 대답 매칭(matchProblemLabel)
 * 보다 훨씬 보수적이다 - 오탐 비용이 "진행 중 세션 교체" 라서:
 * - 명시적 "N번" 표기 필수 (맨몸 숫자 "5" 는 답변이지 전환이 아니다)
 * - 전환 의도 동사 동반 필수
 * - 현재 문제와 다른 번호가 정확히 1개 매칭될 때만 (0개/여러 개면 null -
 *   애매하면 일반 EVAL 로 흘려보내 Gemini/ERROR_POLICY 가 처리한다)
 */
export function matchProblemSwitch(
  text: string,
  problems: ProblemBox[],
  currentLabel?: string,
): ProblemBox | null {
  if (!SWITCH_INTENT.test(text)) return null;
  const currentNumber = currentLabel !== undefined ? extractProblemNumber(currentLabel) : null;
  const candidates = extractAllProblemNumbers(text)
    .filter((n) => currentNumber === null || n !== currentNumber)
    .map((n) => problems.find((p) => extractProblemNumber(p.label) === n))
    .filter((p): p is ProblemBox => !!p);
  return candidates.length === 1 ? candidates[0] : null;
}

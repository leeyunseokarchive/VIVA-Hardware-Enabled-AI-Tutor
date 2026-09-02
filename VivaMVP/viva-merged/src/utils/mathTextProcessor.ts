/**
 * Shared math text processing utilities.
 *
 * TTS와 자막은 같은 Gemini message를 다르게 렌더링한다:
 * - TTS: 기호 → 한국어 발음 (예: √ → "루트", ² → "의 제곱")
 * - 자막: LaTeX/마크다운 → 유니코드 수학 기호 (예: \sqrt{48} → √48)
 *
 * 핵심 원칙: TTS는 "루트"라고 발음하더라도, 자막에선 √ 기호로 보여야 한다.
 */

// ─── Shared cleanup (both TTS and subtitle) ───

function stripMarkdown(text: string): string {
  let cleaned = text;
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
  cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  cleaned = cleaned.replace(/\$/g, '');

  // LaTeX 이형 표기 -> 표준형 정규화 (양쪽 공통). 축약형(\le, \ne)은 아래
  // 개별 매핑이 몰라서 catch-all 이 통째로 지웠다 - "x 3" 처럼 부등호가
  // 소리·자막 양쪽에서 사라지는 게 최악이라 여기서 먼저 승격한다.
  cleaned = cleaned.replace(/\\[()[\]]/g, ''); // \( \) \[ \] 인라인 수식 구분자
  cleaned = cleaned.replace(/\\text\s*\{([^}]+)\}/g, '$1'); // \overline{\text{AB}} 중첩 해소
  cleaned = cleaned.replace(/\\dfrac/g, '\\frac');
  cleaned = cleaned.replace(/\\tfrac/g, '\\frac');
  cleaned = cleaned.replace(/\\le(?![a-zA-Z])/g, '\\leq'); // \left/\leq 는 lookahead 로 보호
  cleaned = cleaned.replace(/\\ge(?![a-zA-Z])/g, '\\geq');
  cleaned = cleaned.replace(/\\ne(?![a-zA-Z])/g, '\\neq');
  cleaned = cleaned.replace(/\\lt(?![a-zA-Z])/g, '<');
  cleaned = cleaned.replace(/\\gt(?![a-zA-Z])/g, '>');
  cleaned = cleaned.replace(/\\%/g, '%');
  // 도(°) 표기 정규화. 모델이 LaTeX(^\circ)를 어기고 ^{\circ}/^{°}/^{도}/^도/^°
  // 로 쓰면 자막에 "^도" 처럼 캐럿이 새어나오고(브레이스 없는 지수 규칙이 못
  // 잡는다) TTS 도 "도" 를 못 만든다 - 전부 표준 ^\circ 로 승격해, 아래 공통
  // 규칙 하나(\\?\^?\\circ)가 자막은 °, TTS 는 "도" 로 바꾸게 한다.
  cleaned = cleaned.replace(/\^\s*\{\s*(?:\\circ|°|도)\s*\}/g, '^\\circ');
  cleaned = cleaned.replace(/\^\s*(?:°|도)/g, '^\\circ');
  return cleaned;
}

// ─── TTS: symbols → Korean pronunciation ───

export function cleanMathForTTS(text: string): string {
  let cleaned = stripMarkdown(text);

  // Brand name
  cleaned = cleaned.replace(/\bVIVA\b/gi, '비바');

  // Trig functions (before generic \command removal)
  cleaned = cleaned.replace(/\\sin/g, '사인 ');
  cleaned = cleaned.replace(/\\cos/g, '코사인 ');
  cleaned = cleaned.replace(/\\tan/g, '탄젠트 ');
  // \lim/\log 는 맵에 없어서 맨 아래 catch-all 이 통째로 지워버렸다 -
  // "리미트/로그" 가 나레이션에서 소리 없이 사라지는 것보다 나쁜 게 없다.
  cleaned = cleaned.replace(/\\lim/g, '리미트 ');
  cleaned = cleaned.replace(/\\log/g, '로그 ');
  cleaned = cleaned.replace(/\\ln/g, '자연로그 ');
  // 프롬프트는 LaTeX(\tan A)를 지시하지만 모델이 가끔 맨몸 ASCII 로 쓴다 -
  // ko-KR 보이스가 라틴 문자를 음차해 "텐 에이" 가 되는 것의 발음 폴백.
  cleaned = cleaned.replace(/\btan\b/g, '탄젠트');
  cleaned = cleaned.replace(/\bsin\b/g, '사인');
  cleaned = cleaned.replace(/\bcos\b/g, '코사인');
  cleaned = cleaned.replace(/\blim\b/g, '리미트');
  cleaned = cleaned.replace(/\blog\b/g, '로그');

  // Square roots (Must process BEFORE fractions to handle \frac{\sqrt{2}}{2} properly)
  cleaned = cleaned.replace(/\\sqrt\s*\{([^}]+)\}/g, '루트 $1');
  cleaned = cleaned.replace(/\\sqrt\s*([a-zA-Z0-9]+)/g, '루트 $1');

  // Fractions: \frac{a}{b} → b분의 a
  cleaned = cleaned.replace(/\\frac\s*\{([^}]+)\}\s*\{([^}]+)\}/g, '$2분의 $1');

  // Unicode √ → 루트
  cleaned = cleaned.replace(/√([a-zA-Z0-9(]+)/g, '루트 $1');

  // Exponents: x^2 → x의 제곱, x^3 → x의 세제곱, x^n → x의 n제곱
  // 중괄호 지수(2^{10})와 \overline{AB}^2 의 "}" 뒤 지수를 먼저 처리 -
  // 기존 규칙은 base 에 } 가 없어 피타고라스 문장이 "선분 AB^2" 로 새어나갔다.
  cleaned = cleaned.replace(
    /([a-zA-Z0-9)}]*)\^\{\s*(-?[0-9a-zA-Z]+)\s*\}/g,
    (_m, base: string, exp: string) => {
      const label =
        exp === '2' ? '제곱' : exp === '3' ? '세제곱' : `${exp.replace('-', '마이너스 ')}제곱`;
      return `${base}의 ${label}`;
    },
  );
  cleaned = cleaned.replace(/([a-zA-Z0-9)}]+)\^2(?![0-9])/g, '$1의 제곱');
  cleaned = cleaned.replace(/([a-zA-Z0-9)}]+)\^3(?![0-9])/g, '$1의 세제곱');
  cleaned = cleaned.replace(/([a-zA-Z0-9)}]+)\^([0-9a-zA-Z]+)/g, '$1의 $2제곱');

  // Superscript unicode → Korean
  cleaned = cleaned.replace(/²/g, '의 제곱');
  cleaned = cleaned.replace(/³/g, '의 세제곱');

  // Subscripts: a_1 → a 1, a_{10} → a 10
  cleaned = cleaned.replace(/([a-zA-Z])_\{([0-9a-zA-Z]+)\}/g, '$1 $2');
  cleaned = cleaned.replace(/([a-zA-Z])_([0-9a-zA-Z]+)/g, '$1 $2');

  // Inequality symbols
  cleaned = cleaned.replace(/≥/g, ' 크거나 같다 ');
  cleaned = cleaned.replace(/≤/g, ' 작거나 같다 ');
  cleaned = cleaned.replace(/≠/g, ' 같지 않다 ');
  cleaned = cleaned.replace(/\\geq/g, ' 크거나 같다 ');
  cleaned = cleaned.replace(/\\leq/g, ' 작거나 같다 ');
  cleaned = cleaned.replace(/\\neq/g, ' 같지 않다 ');
  // 등호식 "x = 3" 의 = 는 Chirp 가 잘 읽지만 < > 는 못 믿는다 - ≥ 와 같은 어순 관례.
  cleaned = cleaned.replace(/</g, ' 작다 ');
  cleaned = cleaned.replace(/>/g, ' 크다 ');
  // 근삿값 (중등은 ≒ 를 쓴다)
  cleaned = cleaned.replace(/\\approx/g, ' 약 ');
  cleaned = cleaned.replace(/\\fallingdotseq/g, ' 약 ');
  cleaned = cleaned.replace(/≈/g, ' 약 ');
  cleaned = cleaned.replace(/≒/g, ' 약 ');

  // Geometry & Degrees
  cleaned = cleaned.replace(/삼각형\s*\\triangle\s*/g, '삼각형 ');
  cleaned = cleaned.replace(/각\s*\\angle\s*/g, '각 ');
  cleaned = cleaned.replace(/선분\s*\\overline\s*\{([^}]+)\}/g, '선분 $1');

  cleaned = cleaned.replace(/\\?\^?\\circ/g, '도');
  cleaned = cleaned.replace(/°/g, '도');
  cleaned = cleaned.replace(/\\angle\s*/g, '각 ');
  cleaned = cleaned.replace(/\\triangle\s*/g, '삼각형 ');
  cleaned = cleaned.replace(/\\overline\s*\{([^}]+)\}/g, '선분 $1');
  // problem_facts/이력 echo 로 유니코드 기호가 그대로 오는 경로의 발음 폴백
  cleaned = cleaned.replace(/∠\s*/g, '각 ');
  cleaned = cleaned.replace(/△\s*/g, '삼각형 ');

  // Common math symbols
  cleaned = cleaned.replace(/\\pm/g, '플러스 마이너스');
  cleaned = cleaned.replace(/±/g, '플러스 마이너스');
  cleaned = cleaned.replace(/\\times/g, ' 곱하기 ');
  cleaned = cleaned.replace(/×/g, ' 곱하기 ');
  cleaned = cleaned.replace(/\\div/g, ' 나누기 ');
  cleaned = cleaned.replace(/÷/g, ' 나누기 ');
  cleaned = cleaned.replace(/\\cdot/g, ' 곱하기 ');
  cleaned = cleaned.replace(/·/g, ' 곱하기 ');
  cleaned = cleaned.replace(/\\theta/g, '세타');
  cleaned = cleaned.replace(/θ/g, '세타');
  cleaned = cleaned.replace(/\\pi/g, '파이');
  cleaned = cleaned.replace(/π/g, '파이');
  cleaned = cleaned.replace(/\\alpha/g, '알파');
  cleaned = cleaned.replace(/α/g, '알파');
  cleaned = cleaned.replace(/\\beta/g, '베타');
  cleaned = cleaned.replace(/β/g, '베타');
  cleaned = cleaned.replace(/\\infty/g, '무한대');
  cleaned = cleaned.replace(/∞/g, '무한대');

  // Remove remaining LaTeX commands with an argument (e.g., \vec{AB} -> AB)
  cleaned = cleaned.replace(/\\[a-zA-Z]+\s*\{([^}]+)\}/g, ' $1 ');

  // Remove remaining LaTeX commands without arguments
  cleaned = cleaned.replace(/\\[a-zA-Z]+/g, ' ');

  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

// ─── Subtitle: LaTeX/markdown → Unicode math symbols ───

export function cleanMathForSubtitle(text: string): string {
  let cleaned = stripMarkdown(text);

  // Trig functions → clean text (no backslash)
  cleaned = cleaned.replace(/\\sin/g, 'sin');
  cleaned = cleaned.replace(/\\cos/g, 'cos');
  cleaned = cleaned.replace(/\\tan/g, 'tan');
  cleaned = cleaned.replace(/\\log/g, 'log');
  cleaned = cleaned.replace(/\\lim/g, 'lim');
  cleaned = cleaned.replace(/\\ln/g, 'ln');

  // 모델이 프롬프트를 어기고 한글로 풀어 쓴 경우의 폴백 - 자막 원칙은
  // "발음은 루트, 표기는 √" (파일 헤더). 숫자가 뒤따르는 명확한 경우만.
  cleaned = cleaned.replace(/루트\s*(\d+)/g, '√$1');

  // Square roots (Must process BEFORE fractions to handle \frac{\sqrt{2}}{2} properly)
  cleaned = cleaned.replace(/\\sqrt\s*\{([^}]+)\}/g, '√$1');
  cleaned = cleaned.replace(/\\sqrt\s*([a-zA-Z0-9]+)/g, '√$1');

  // Fractions: \frac{a}{b} → a/b. 다항 분자/분모(x+1)는 괄호로 묶어야
  // "x+1/3" 오독이 없다.
  const wrapFracPart = (s: string) => {
    const t = s.trim();
    return /[+\-\s]/.test(t) ? `(${t})` : t;
  };
  cleaned = cleaned.replace(
    /\\frac\s*\{([^}]+)\}\s*\{([^}]+)\}/g,
    (_m, a: string, b: string) => `${wrapFracPart(a)}/${wrapFracPart(b)}`,
  );

  // Superscript unicode map
  const superscripts: Record<string, string> = {
    '0': '⁰',
    '1': '¹',
    '2': '²',
    '3': '³',
    '4': '⁴',
    '5': '⁵',
    '6': '⁶',
    '7': '⁷',
    '8': '⁸',
    '9': '⁹',
    '-': '⁻',
  };

  // Exponents: x^{12} → x¹², x^2 → x²
  cleaned = cleaned.replace(/\^{([^}]+)}/g, (_match, p1) => {
    return p1
      .split('')
      .map((char: string) => superscripts[char] || char)
      .join('');
  });
  cleaned = cleaned.replace(/\^([0-9]+)/g, (_match: string, p1: string) => {
    return p1
      .split('')
      .map((char: string) => superscripts[char] || char)
      .join('');
  });

  // Subscript: a_1 → a₁
  const subscriptMap: Record<string, string> = {
    '0': '₀',
    '1': '₁',
    '2': '₂',
    '3': '₃',
    '4': '₄',
    '5': '₅',
    '6': '₆',
    '7': '₇',
    '8': '₈',
    '9': '₉',
  };
  cleaned = cleaned.replace(/_\{([^}]+)\}/g, (_match, p1) => {
    return p1
      .split('')
      .map((char: string) => subscriptMap[char] || char)
      .join('');
  });
  cleaned = cleaned.replace(/_([0-9])/g, (_match: string, p1: string) => {
    return subscriptMap[p1] || p1;
  });

  // Inequality
  cleaned = cleaned.replace(/\\geq/g, '≥');
  cleaned = cleaned.replace(/\\leq/g, '≤');
  cleaned = cleaned.replace(/\\neq/g, '≠');

  // Geometry & Degrees
  cleaned = cleaned.replace(/삼각형\s*\\triangle\s*/g, '△');
  cleaned = cleaned.replace(/각\s*\\angle\s*/g, '∠');
  // 선분은 글자마다 콤바이닝 오버라인(U+0305)을 얹어 A̅B̅ 로 표기 -
  // "선분 AB" 텍스트 대신 수학 기호. 발음("선분 AB")은 TTS 쪽이 유지한다.
  const toOverline = (s: string) =>
    s
      .trim()
      .split('')
      .map((ch) => (/\s/.test(ch) ? ch : ch + '\u0305'))
      .join('');
  cleaned = cleaned.replace(/선분\s*\\overline\s*\{([^}]+)\}/g, (_m, p1: string) => toOverline(p1));
  cleaned = cleaned.replace(/\\overline\s*\{([^}]+)\}/g, (_m, p1: string) => toOverline(p1));

  cleaned = cleaned.replace(/\\?\^?\\circ/g, '°');
  cleaned = cleaned.replace(/\\angle\s*/g, '∠');
  cleaned = cleaned.replace(/\\triangle\s*/g, '△');

  // Common math symbols → unicode
  cleaned = cleaned.replace(/\\pm/g, '±');
  cleaned = cleaned.replace(/\\times/g, '×');
  cleaned = cleaned.replace(/\\div/g, '÷');
  cleaned = cleaned.replace(/\\cdot/g, '·');
  cleaned = cleaned.replace(/\\approx/g, '≈');
  cleaned = cleaned.replace(/\\fallingdotseq/g, '≒');
  cleaned = cleaned.replace(/\\theta/g, 'θ');
  cleaned = cleaned.replace(/\\pi/g, 'π');
  cleaned = cleaned.replace(/\\alpha/g, 'α');
  cleaned = cleaned.replace(/\\beta/g, 'β');
  cleaned = cleaned.replace(/\\infty/g, '∞');

  // Remove remaining LaTeX commands with an argument (e.g., \vec{AB} -> AB)
  cleaned = cleaned.replace(/\\[a-zA-Z]+\s*\{([^}]+)\}/g, '$1');

  // Remove remaining LaTeX commands without arguments
  cleaned = cleaned.replace(/\\[a-zA-Z]+/g, '');

  return cleaned;
}

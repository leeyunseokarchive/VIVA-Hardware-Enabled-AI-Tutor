import { cleanMathForTTS, cleanMathForSubtitle } from '../mathTextProcessor';

describe('cleanMathForTTS', () => {
  it('reads sqrt as 루트', () => {
    expect(cleanMathForTTS('\\sqrt{48}')).toBe('루트 48');
  });
  it('reads fractions as 분의', () => {
    expect(cleanMathForTTS('\\frac{3}{4}')).toBe('4분의 3');
  });
  it('reads exponents in Korean', () => {
    expect(cleanMathForTTS('x^2')).toBe('x의 제곱');
    expect(cleanMathForTTS('x^3')).toBe('x의 세제곱');
    expect(cleanMathForTTS('x^4')).toBe('x의 4제곱');
  });
  it('reads ± as 플러스 마이너스', () => {
    expect(cleanMathForTTS('\\pm')).toBe('플러스 마이너스');
  });
  it('reads subscripts', () => {
    expect(cleanMathForTTS('a_1')).toBe('a 1');
  });
  it('reads inequality signs', () => {
    expect(cleanMathForTTS('x ≥ 3')).toBe('x 크거나 같다 3');
    expect(cleanMathForTTS('x ≤ 3')).toBe('x 작거나 같다 3');
  });
  it('reads trigonometric function names correctly', () => {
    expect(cleanMathForTTS('\\sin\\theta')).toBe('사인 세타');
    expect(cleanMathForTTS('\\cos\\theta')).toBe('코사인 세타');
    expect(cleanMathForTTS('\\tan\\theta')).toBe('탄젠트 세타');
  });
  it('handles bare numbers without change', () => {
    expect(cleanMathForTTS('답은 2야')).toBe('답은 2야');
  });
  it('handles question marks normally', () => {
    expect(cleanMathForTTS('이거 맞아?')).toBe('이거 맞아?');
  });
  it('strips markdown emphasis', () => {
    expect(cleanMathForTTS('**중요한** 내용')).toBe('중요한 내용');
  });
  it('reads unicode √ as 루트', () => {
    expect(cleanMathForTTS('√48')).toBe('루트 48');
  });
  it('reads ² as 의 제곱', () => {
    expect(cleanMathForTTS('x²')).toBe('x의 제곱');
  });
  it('reads brand name', () => {
    expect(cleanMathForTTS('VIVA')).toBe('비바');
  });
  // 2026-07-30: \lim/\log 는 catch-all 이 통째로 삭제해 나레이션에서 소리
  // 없이 사라졌고, 맨몸 tan 은 ko-KR 보이스가 "텐" 으로 음차했다.
  it('reads \\lim and \\log instead of deleting them', () => {
    expect(cleanMathForTTS('\\lim x')).toBe('리미트 x');
    expect(cleanMathForTTS('\\log 2')).toBe('로그 2');
  });
  it('reads bare ASCII math names in Korean (model fallback)', () => {
    expect(cleanMathForTTS('tan A 값은?')).toBe('탄젠트 A 값은?');
  });
  it('handles duplicated geometry prefixes correctly', () => {
    expect(cleanMathForTTS('삼각형 \\triangle ABD')).toBe('삼각형 ABD');
    expect(cleanMathForTTS('각 \\angle A')).toBe('각 A');
    expect(cleanMathForTTS('선분 \\overline{AD}')).toBe('선분 AD');
  });
  it('strips left over commands with arguments', () => {
    expect(cleanMathForTTS('\\text{cm}')).toBe('cm');
    expect(cleanMathForTTS('\\vec{AB}')).toBe('AB');
    expect(cleanMathForTTS('\\overline{AD}')).toBe('선분 AD');
  });
  // 2026-07-30 2차 감사: 축약형·중괄호 지수·유니코드 폴백이 catch-all 에
  // 먹혀 소리 없이 사라지던 케이스들.
  it('reads short-form inequality aliases (\\le/\\ge/\\ne/\\lt)', () => {
    expect(cleanMathForTTS('x \\le 3')).toBe('x 작거나 같다 3');
    expect(cleanMathForTTS('x \\ge 3')).toBe('x 크거나 같다 3');
    expect(cleanMathForTTS('x \\ne 0')).toBe('x 같지 않다 0');
    expect(cleanMathForTTS('2 \\lt 5')).toBe('2 작다 5');
  });
  it('reads strict inequalities and \\cdot', () => {
    expect(cleanMathForTTS('x < 3')).toBe('x 작다 3');
    expect(cleanMathForTTS('x > 3')).toBe('x 크다 3');
    expect(cleanMathForTTS('2 \\cdot 3')).toBe('2 곱하기 3');
  });
  it('reads braced exponents and pythagorean overline powers', () => {
    expect(cleanMathForTTS('2^{10}')).toBe('2의 10제곱');
    expect(cleanMathForTTS('x^{-2}')).toBe('x의 마이너스 2제곱');
    expect(cleanMathForTTS('\\overline{AB}^2')).toBe('선분 AB의 제곱');
    expect(cleanMathForTTS('45^{\\circ}')).toBe('45도');
  });
  it('reads degree variants the model writes off-spec as 도 (no stray caret)', () => {
    expect(cleanMathForTTS('45^\\circ')).toBe('45도');
    expect(cleanMathForTTS('45^도')).toBe('45도');
    expect(cleanMathForTTS('45^{도}')).toBe('45도');
    expect(cleanMathForTTS('45^°')).toBe('45도');
    expect(cleanMathForTTS('45°')).toBe('45도');
  });
  it('reads approximation, percent, braced subscripts', () => {
    expect(cleanMathForTTS('\\approx 3.14')).toBe('약 3.14');
    expect(cleanMathForTTS('x \\fallingdotseq 1.4')).toBe('x 약 1.4');
    expect(cleanMathForTTS('50\\%')).toBe('50%');
    expect(cleanMathForTTS('a_{10}')).toBe('a 10');
  });
  it('reads unicode geometry/inequality fallbacks (facts echo path)', () => {
    expect(cleanMathForTTS('∠ABC')).toBe('각 ABC');
    expect(cleanMathForTTS('△ABC')).toBe('삼각형 ABC');
    expect(cleanMathForTTS('x ≠ 0')).toBe('x 같지 않다 0');
  });
});

describe('cleanMathForSubtitle', () => {
  it('converts \\sqrt to √ symbol', () => {
    expect(cleanMathForSubtitle('\\sqrt{48}')).toBe('√48');
  });
  it('converts fractions to slash notation', () => {
    expect(cleanMathForSubtitle('\\frac{3}{4}')).toBe('3/4');
  });
  it('converts exponents to superscript unicode', () => {
    expect(cleanMathForSubtitle('x^2')).toBe('x²');
    expect(cleanMathForSubtitle('x^3')).toBe('x³');
  });
  it('converts \\pm to ±', () => {
    expect(cleanMathForSubtitle('\\pm')).toBe('±');
  });
  it('converts trig functions to clean text', () => {
    expect(cleanMathForSubtitle('\\sin\\theta')).toBe('sinθ');
    expect(cleanMathForSubtitle('\\cos\\theta')).toBe('cosθ');
    expect(cleanMathForSubtitle('\\tan\\theta')).toBe('tanθ');
  });
  it('converts inequality LaTeX to symbols', () => {
    expect(cleanMathForSubtitle('\\geq')).toBe('≥');
    expect(cleanMathForSubtitle('\\leq')).toBe('≤');
  });
  it('strips markdown but keeps question marks', () => {
    expect(cleanMathForSubtitle('**이거** 맞아?')).toBe('이거 맞아?');
  });
  it('converts subscripts to unicode', () => {
    expect(cleanMathForSubtitle('a_1')).toBe('a₁');
  });
  it('converts multi-digit exponents', () => {
    expect(cleanMathForSubtitle('x^{12}')).toBe('x¹²');
  });
  it('renders degree variants as ° (no stray caret leaks to subtitle)', () => {
    expect(cleanMathForSubtitle('45^{\\circ}')).toBe('45°');
    expect(cleanMathForSubtitle('45^\\circ')).toBe('45°');
    expect(cleanMathForSubtitle('45^도')).toBe('45°');
    expect(cleanMathForSubtitle('45^{도}')).toBe('45°');
    expect(cleanMathForSubtitle('45^°')).toBe('45°');
  });
  // 2026-07-30: 자막 원칙 "발음은 루트, 표기는 √" - 모델이 한글로 풀어 쓴
  // 경우의 폴백 + \lim 유실 방지.
  it('converts spelled-out 루트 N to √N', () => {
    expect(cleanMathForSubtitle('루트 5가 뭘까?')).toBe('√5가 뭘까?');
  });
  it('keeps \\lim as lim instead of deleting it', () => {
    expect(cleanMathForSubtitle('\\lim')).toBe('lim');
  });
  it('handles duplicated geometry prefixes correctly', () => {
    expect(cleanMathForSubtitle('삼각형 \\triangle ABD')).toBe('△ABD');
    expect(cleanMathForSubtitle('각 \\angle A')).toBe('∠A');
    expect(cleanMathForSubtitle('선분 \\overline{AD}')).toBe('A\u0305D\u0305');
  });
  it('strips left over commands with arguments', () => {
    expect(cleanMathForSubtitle('\\text{cm}')).toBe('cm');
    expect(cleanMathForSubtitle('\\vec{AB}')).toBe('AB');
    expect(cleanMathForSubtitle('\\overline{AD}')).toBe('A\u0305D\u0305');
  });
  // 2026-07-30 3차: 선분은 "선분 AB" 텍스트 대신 콤바이닝 오버라인 A̅B̅
  it('renders \\overline as combining-overline glyphs', () => {
    expect(cleanMathForSubtitle('\\overline{AB}^2')).toBe('A\u0305B\u0305²');
    expect(cleanMathForSubtitle('\\(\\overline{\\text{AB}}\\)')).toBe('A\u0305B\u0305');
  });
  // 2026-07-30 2차 감사분
  it('converts short-form aliases and \\cdot/\\approx', () => {
    expect(cleanMathForSubtitle('x \\le 3')).toBe('x ≤ 3');
    expect(cleanMathForSubtitle('x \\ge 3')).toBe('x ≥ 3');
    expect(cleanMathForSubtitle('x \\ne 0')).toBe('x ≠ 0');
    expect(cleanMathForSubtitle('2 \\cdot 3')).toBe('2 · 3');
    expect(cleanMathForSubtitle('\\approx 3.14')).toBe('≈ 3.14');
    expect(cleanMathForSubtitle('x \\fallingdotseq 1.4')).toBe('x ≒ 1.4');
    expect(cleanMathForSubtitle('50\\%')).toBe('50%');
    expect(cleanMathForSubtitle('\\dfrac{1}{2}')).toBe('1/2');
  });
  it('parenthesizes multi-term fraction parts', () => {
    expect(cleanMathForSubtitle('\\frac{x+1}{3}')).toBe('(x+1)/3');
    expect(cleanMathForSubtitle('\\frac{-1}{2}')).toBe('(-1)/2');
    expect(cleanMathForSubtitle('\\frac{\\sqrt{2}}{2}')).toBe('√2/2');
  });
  it('converts negative exponents to superscript minus', () => {
    expect(cleanMathForSubtitle('x^{-2}')).toBe('x⁻²');
  });
});

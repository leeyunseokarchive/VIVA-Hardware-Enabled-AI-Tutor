/**
 * Post-processes STT (Speech-to-Text) results to correct common
 * misrecognitions of mathematical terms in Korean.
 *
 * iOS SFSpeechRecognizer doesn't support contextualStrings through
 * @react-native-voice/voice, so we correct after recognition instead.
 */

// Compound math term normalization: collapse spaces in common terms
// that STT might split into separate words.
const COMPOUND_TERMS: [RegExp, string][] = [
  [/이차\s*방정식/g, '이차방정식'],
  [/이차\s*함수/g, '이차함수'],
  [/삼각\s*비/g, '삼각비'],
  [/삼각\s*함수/g, '삼각함수'],
  [/근의\s*공식/g, '근의 공식'],
  [/인수\s*분해/g, '인수분해'],
  [/완전\s*제곱\s*식/g, '완전제곱식'],
  [/확률\s*과?\s*통계/g, '확률과 통계'],
];

// Mathematical term replacements for display context.
// STT output is spoken Korean → we normalize to math-aware text
// so Gemini receives cleaner input.
const MATH_TERM_CORRECTIONS: [RegExp, string][] = [
  // "루트 N" → "√N"
  [/루트\s*(\d+)/g, '√$1'],
  // "엑스" → "x"
  [/엑스/g, 'x'],
  // "와이" → "y" (in math context)
  [/와이(?=\s*(의|더하기|빼기|곱하기|나누기|제곱|$))/g, 'y'],
  // "의 제곱" → "²"
  [/([a-zA-Z0-9])의\s*제곱/g, '$1²'],
  // "의 세제곱" → "³"
  [/([a-zA-Z0-9])의\s*세제곱/g, '$1³'],
  // Trig function names (Korean → standard)
  [/사인\s*/g, 'sin '],
  [/코사인\s*/g, 'cos '],
  [/탄젠트\s*/g, 'tan '],
  // Greek letters in math context
  [/세타/g, 'θ'],
  [/파이\s*(?=[a-zA-Z가-힣])/g, 'π'], // "파이 r" → "πr", "파이 알" → "π알"
  // "알 제곱" → "r²" (파이 알 제곱 context)
  [/알\s*제곱/g, 'r²'],
];

export function postProcessSTT(text: string): string {
  let result = text;

  // 1. Normalize compound math terms
  for (const [pattern, replacement] of COMPOUND_TERMS) {
    result = result.replace(pattern, replacement);
  }

  // 2. Apply math term corrections
  for (const [pattern, replacement] of MATH_TERM_CORRECTIONS) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

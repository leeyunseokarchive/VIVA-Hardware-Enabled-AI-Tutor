/**
 * TTS 자막 문장분할 + 표시 타이밍. ConversationScreen 에 있던 로직을
 * IntentScreen(개념 설명)과 공유하려고 추출했다 (2026-08-12).
 * 마지막 문장을 지우는 cue 는 일부러 없다 - 재생 길이 추정이 실제보다 짧게
 * 나와도 오디오가 끝날 때까지 자막이 화면을 덮어야 한다 (기존 주석 유지).
 */
export function splitIntoSentences(text: string): string[] {
  const matches = text.match(/[^.!?\n]+[.!?\n]*/g);
  if (!matches) return [text];
  return matches.map((s) => s.trim()).filter(Boolean);
}

export interface SubtitleCue {
  sentence: string;
  showAtMs: number;
}

// durationMillis 가 0으로 오는 경로(파이 스피커 sink)의 추정치.
export const SUBTITLE_MS_PER_CHAR = 150;

// tts.service.ts 의 TTS_PAUSE_MARKER 와 정확히 같아야 한다 - 이 파일은 RN/
// 서비스 의존이 없는 순수 유틸이라 import 대신 리터럴을 복제한다(system_prompt.ts
// 의 PAUSE_MARKER 와 동일 패턴). 마커 1개 = SSML <break time="450ms"/> 이고
// 450/150 = 3 글자치 가중이라 문장 배분 비율에 반영한다.
const PAUSE_MARKER = '[[PAUSE]]';
const PAUSE_CHAR_WEIGHT = 3;

/** durationMs 를 문장 가중치(글자수 + 3*포즈수) 비례로 배분한 표시 스케줄.
 * text 에 [[PAUSE]] 마커가 남아 있으면(TTS 로 보낼 원문 그대로) 문장별로
 * 몇 개 포함됐는지 세어 가중치에 반영한 뒤, 표시용 문장에서는 공백으로
 * 바꿔 화면에 리터럴 토큰이 노출되지 않게 한다. durationMs 가 0 이하면
 * 가중치 합 × SUBTITLE_MS_PER_CHAR 로 전체 길이를 추정한다. */
export function buildSubtitleSchedule(text: string, durationMs: number): SubtitleCue[] {
  const weighted = splitIntoSentences(text)
    .map((raw) => {
      const pauseCount = raw.split(PAUSE_MARKER).length - 1;
      const sentence = raw.split(PAUSE_MARKER).join(' ').trim();
      return { sentence, weight: sentence.length + PAUSE_CHAR_WEIGHT * pauseCount };
    })
    .filter((s) => s.sentence.length > 0);
  const totalWeight = weighted.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight === 0) return [];
  const total = durationMs > 0 ? durationMs : totalWeight * SUBTITLE_MS_PER_CHAR;
  const cues: SubtitleCue[] = [];
  let accumulated = 0;
  for (const { sentence, weight } of weighted) {
    cues.push({ sentence, showAtMs: accumulated });
    accumulated += total * (weight / totalWeight);
  }
  return cues;
}

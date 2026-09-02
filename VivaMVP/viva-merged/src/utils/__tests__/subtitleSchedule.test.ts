import {
  splitIntoSentences,
  buildSubtitleSchedule,
  SUBTITLE_MS_PER_CHAR,
} from '../subtitleSchedule';

describe('splitIntoSentences', () => {
  it('마침표·물음표·느낌표·줄바꿈 단위로 나눈다', () => {
    expect(splitIntoSentences('약분은 분모와 분자를 같은 수로 나누는 거야. 쉽지? 해보자!')).toEqual([
      '약분은 분모와 분자를 같은 수로 나누는 거야.',
      '쉽지?',
      '해보자!',
    ]);
  });

  it('구두점이 없으면 통째로 한 문장', () => {
    expect(splitIntoSentences('안녕')).toEqual(['안녕']);
  });
});

describe('buildSubtitleSchedule', () => {
  it('duration 을 문장 길이 비례로 배분한다', () => {
    // 길이 5("가나다다.")와 5("라마바사.") - 각 50%씩
    const cues = buildSubtitleSchedule('가나다다. 라마바사.', 1000);
    expect(cues).toHaveLength(2);
    expect(cues[0].showAtMs).toBe(0);
    expect(cues[1].showAtMs).toBeCloseTo(500);
  });

  it('duration 0 이면 글자수 × SUBTITLE_MS_PER_CHAR 로 추정한다', () => {
    const cues = buildSubtitleSchedule('가나다다. 라마바사.', 0);
    expect(cues[1].showAtMs).toBeCloseTo(5 * SUBTITLE_MS_PER_CHAR);
  });

  it('빈 텍스트면 빈 배열', () => {
    expect(buildSubtitleSchedule('', 1000)).toEqual([]);
  });

  it('[[PAUSE]] 가 있는 문장은 charLen + 3*pauseCount 로 가중치를 받는다', () => {
    // 1문장 "가나"(2자, pause 0, 가중치 2) vs 2문장 "[[PAUSE]]다라"(2자+pause 1, 가중치 5)
    // 가중치 비 2:5, 합 7 -> 전체 700ms 중 두 번째는 200ms 지점부터.
    const cues = buildSubtitleSchedule('가나\n[[PAUSE]]다라', 700);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ sentence: '가나', showAtMs: 0 });
    expect(cues[1].sentence).toBe('다라');
    expect(cues[1].showAtMs).toBeCloseTo(200);
  });

  it('[[PAUSE]] 마커는 표시용 문장에서 공백으로 바뀐다', () => {
    const cues = buildSubtitleSchedule('맞아![[PAUSE]]다음 문장이야.', 1000);
    expect(cues.map((c) => c.sentence)).toEqual(['맞아!', '다음 문장이야.']);
  });

  it('duration 0 이고 pause 가 있으면 가중치(charLen+3*pauseCount) 기준으로 추정한다', () => {
    const cues = buildSubtitleSchedule('가나\n[[PAUSE]]다라', 0);
    // 총 가중치 = 2(가나) + (2+3)(다라+pause) = 7 -> 7 * SUBTITLE_MS_PER_CHAR
    expect(cues[1].showAtMs).toBeCloseTo(2 * SUBTITLE_MS_PER_CHAR);
  });
});

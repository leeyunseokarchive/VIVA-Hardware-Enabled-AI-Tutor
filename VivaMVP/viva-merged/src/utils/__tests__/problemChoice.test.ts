import { matchProblemLabel, matchProblemSwitch } from '../problemChoice';
import type { ProblemBox } from '../../types/Tutoring';

const PROBLEMS: ProblemBox[] = [
  { label: '3번', box_2d: [100, 100, 400, 500] },
  { label: '13번', box_2d: [450, 100, 800, 500] },
];

describe('matchProblemLabel', () => {
  it.each([
    ['3번', '3번'],
    ['3번이요', '3번'],
    ['지금 3번 풀고 있어', '3번'],
    ['삼번', '3번'],
    ['세번째 문제', '3번'],
    ['13번', '13번'],
    ['십삼번', '13번'],
    ['3', '3번'], // 숫자만 말한 경우
  ])('matches %s -> %s', (utterance, expectedLabel) => {
    expect(matchProblemLabel(utterance, PROBLEMS)?.label).toBe(expectedLabel);
  });

  it.each([
    ['몰라'],
    ['이거 뭐야'], // "이" 가 sino-2 로 오인되면 안 됨 ("번" 없이)
    ['7번'], // 목록에 없는 번호
    [''],
    ['이번 문제도 모르겠어'], // "이번" = this time, sino-2 아님
    ['한번 더 설명해줘'], // "한번" = once, native ordinal 1 아님
    ['세번이나 틀렸어'], // "세번" = 3 times, native ordinal 3 아님
    ['이십번'], // 20, 지원 범위 밖 -> 10으로 오매칭 금지
  ])('returns null for %s', (utterance) => {
    expect(matchProblemLabel(utterance, PROBLEMS)).toBeNull();
  });

  it('returns null when problems list is empty', () => {
    expect(matchProblemLabel('3번', [])).toBeNull();
  });

  it('matches 십이번 -> 12번 (이 in sino compound still works)', () => {
    const problemsWith12: ProblemBox[] = [{ label: '12번', box_2d: [0, 0, 100, 100] }];
    expect(matchProblemLabel('십이번', problemsWith12)?.label).toBe('12번');
  });
});

// 대화 중 문제 전환 감지 (2026-07-30: "59번 풀다 60번 풀어줘" 가 재촬영
// 안내로 빠지던 것의 수정). 오탐 = 진행 중 세션 교체라 보수적이어야 한다.
describe('matchProblemSwitch', () => {
  const PAGE: ProblemBox[] = [
    { label: '59번', box_2d: [100, 100, 400, 500] },
    { label: '60번', box_2d: [450, 100, 800, 500] },
    { label: '61번', box_2d: [810, 100, 990, 500] },
  ];

  it.each([
    ['59번은 됐으니까 60번 문제 풀어줘', '60번'], // 두 번호 언급 - 현재 문제 제외
    ['60번 풀어줘', '60번'],
    ['60번은 어떻게 풀어?', '60번'],
    ['61번이 궁금해', '61번'],
    ['육십번 알려줘', '60번'],
  ])('detects switch: %s -> %s', (utterance, expected) => {
    expect(matchProblemSwitch(utterance, PAGE, '59번')?.label).toBe(expected);
  });

  it.each([
    ['5'], // 맨몸 숫자 = 답변이지 전환이 아니다
    ['60'], // 맨몸 숫자는 목록에 있어도 전환 아님
    ['59번 풀어줘'], // 현재 문제 재언급
    ['모르겠어, 알려줘'], // 번호 없음
    ['60번'], // 전환 의도 동사 없음
    ['60번이랑 61번 풀어줘'], // 여러 개 매칭 - 애매하면 null
    ['7번 풀어줘'], // 목록에 없는 번호
  ])('returns null for %s', (utterance) => {
    expect(matchProblemSwitch(utterance, PAGE, '59번')).toBeNull();
  });

  it('does not exclude anything when currentLabel is undefined', () => {
    expect(matchProblemSwitch('59번 풀어줘', PAGE, undefined)?.label).toBe('59번');
  });
});

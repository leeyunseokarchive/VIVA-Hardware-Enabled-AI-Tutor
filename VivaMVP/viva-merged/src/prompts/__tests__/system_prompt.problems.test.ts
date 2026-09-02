import { buildSystemPrompt } from '../system_prompt';

describe('PROBLEM_DETECTION_POLICY', () => {
  // 사진 분석 턴(freshPhoto)에만 감지 정책이 들어간다 - EVAL 턴 첨부는
  // 전사본이라 재감지 지시가 낭비다 (2026-07-31 freshPhoto 게이트).
  it('includes box_2d instructions on a fresh-photo analysis turn', () => {
    const prompt = buildSystemPrompt({ hasProblemImage: true, freshPhoto: true });
    expect(prompt).toContain('box_2d');
    expect(prompt).toContain('0-1000');
  });

  it('omits problem-detection instructions for no-photo concept questions', () => {
    const prompt = buildSystemPrompt({ noPhotoConceptQuestion: true });
    expect(prompt).not.toContain('box_2d');
  });

  // EVAL 턴(사진은 세션에 있지만 이번 첨부는 전사본): 감지/전사 정책이
  // 빠져야 한다. 단 boardAttached 면 ANNOTATION_POLICY 의 box_2d 는 있다.
  it('omits problem detection on EVAL turns without a fresh photo', () => {
    const prompt = buildSystemPrompt({ hasProblemImage: true });
    expect(prompt).not.toContain('list them ALL');
    expect(prompt).not.toContain('problem_facts (photos only');
  });

  // 바로 정답 모드는 힌트 루프를 건너뛰려고 별도 분기로 early-return 하는데,
  // 거기서 이 정책을 빼먹으면 Gemini 가 `problems` 를 안 채우고 FSM 의
  // 다문제 되묻기 게이트(problems.length >= 2)가 영영 안 열린다.
  it('still includes problem detection in 바로 정답 mode with a fresh photo', () => {
    const prompt = buildSystemPrompt({
      hasProblemImage: true,
      freshPhoto: true,
      directSolveMode: true,
    });
    expect(prompt).toContain('box_2d');
    expect(prompt).toContain('0-1000');
  });

  // 되묻기 게이트는 problems 가 2개 이상일 때만 열린다 - "한 문제만 다뤄라"
  // 로 읽힐 문장이 이 정책에 들어오면 모델이 배열을 1개로 뭉개 게이트가
  // 죽는다(실제로 한 번 그렇게 회귀했다).
  it('tells the model to list every ambiguous problem, not just one', () => {
    const prompt = buildSystemPrompt({ hasProblemImage: true, freshPhoto: true });
    expect(prompt).toContain('list them ALL');
  });

  // 실기기 회귀(2026-07-28): 198번을 풀던 중 정답 모드로 전환하자 크롭에
  // 걸쳐 있던 196번을 풀어버림 - 어느 문제를 풀지는 대화가 결정해야 한다.
  it('direct-solve mode pins the solution to the problem in the conversation', () => {
    const prompt = buildSystemPrompt({ hasProblemImage: true, directSolveMode: true });
    expect(prompt).toContain('NEVER switch to a different problem');
  });
});

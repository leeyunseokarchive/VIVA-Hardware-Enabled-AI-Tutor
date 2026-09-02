/**
 * Unit tests for the one piece of real branching logic in
 * `system_prompt.ts`: hint-intensity tier selection (PRD.md §5) and the
 * wrongStreak>=3 escalation instruction. The prompt strings themselves are
 * validated empirically against real Gemini responses in `test-prompt.js`
 * (see task-3-report.md) — this file only guards the templating logic.
 *
 * 프롬프트 본문은 한국어에서 영어로 바뀌었다(모델 지시는 영어, 학생에게
 * 말하는 문장만 한국어). 그래서 문자열 기대값도 현재 문안 기준이다.
 */
import {
  buildSystemPrompt,
  hintIntensityInstruction,
  wrongStreakInstruction,
} from '../system_prompt';

describe('hintIntensityInstruction', () => {
  it('treats hintCount<=0 as "no hints given yet"', () => {
    expect(hintIntensityInstruction(0)).toContain('Ask the first guiding question');
  });

  it('selects the pure-Socratic tier for hintCount 1-2', () => {
    expect(hintIntensityInstruction(1)).toContain('Pure Socratic questions only');
    expect(hintIntensityInstruction(2)).toContain('Pure Socratic questions only');
  });

  it('selects the partial-cue tier for hintCount 3-4', () => {
    expect(hintIntensityInstruction(3)).toContain('partial formulas or next step hints');
    expect(hintIntensityInstruction(4)).toContain('partial formulas or next step hints');
  });

  it('does not regress to the pure-Socratic tier once hintCount exceeds 4', () => {
    const result = hintIntensityInstruction(5);
    expect(result).not.toContain('Pure Socratic questions only');
    expect(result).toContain('Do NOT give final answers even if asked repeatedly');
  });
});

describe('wrongStreakInstruction', () => {
  it('stays in normal hint mode below the threshold', () => {
    expect(wrongStreakInstruction(0)).toContain('Normal flow');
    expect(wrongStreakInstruction(2)).toContain('Normal flow');
  });

  it('requires asking for consent (not forcing SOLVE_STAGE) at wrongStreak>=3', () => {
    const result = wrongStreakInstruction(3);
    expect(result).toContain('많이 어려워 보이는데, 답을 같이 볼까?');
    expect(result).toContain('DO NOT transition to SOLVE_STAGE yourself');
  });

  it('keeps escalating for wrongStreak beyond 3', () => {
    expect(wrongStreakInstruction(5)).toContain('많이 어려워 보이는데, 답을 같이 볼까?');
  });
});

describe('buildSystemPrompt', () => {
  it('defaults hintCount/wrongStreak to 0 when no context is given', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('hintCount=0');
    expect(prompt).toContain('wrongStreak=0');
  });

  it('interpolates the given hintCount/wrongStreak into the prompt', () => {
    const prompt = buildSystemPrompt({ hintCount: 4, wrongStreak: 3 });
    expect(prompt).toContain('hintCount=4');
    expect(prompt).toContain('wrongStreak=3');
    expect(prompt).toContain('많이 어려워 보이는데, 답을 같이 볼까?');
  });

  it('D-37 후속: 첫 사진 분석 턴의 전사 판서 기본값(requires_board=true) 조항이 포함된다 (2026-08-05 판서 미생성 수정)', () => {
    const prompt = buildSystemPrompt({ hasProblemImage: true, freshPhoto: true });
    expect(prompt).toContain('FIRST photo-analysis turn');
    expect(prompt).toContain('DEFAULT to requires_board=true');
  });

  it('always includes the required identity/prohibition/board-prompt clauses', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('You are VIVA, a Socratic math tutor');
    expect(prompt).toContain('NEVER output the final answer or calculation results directly');
    // 힌트 턴 기본은 판서 재생성 없음(annotations 오버레이) - 단 오버레이로
    // 못 그리는 새 획(보조선·개형)이 필요할 때만 예외적으로 board_update 허용
    // (2026-07-30: "풀이 이미지가 필요한데 안 나온다" 수정).
    expect(prompt).toContain('DEFAULT: set board_update_needed=false');
    expect(prompt).toContain('HINT-turn EXCEPTION');
    expect(prompt).toContain('never draw final answers');
    // 수학 표기는 LaTeX 강제 - TTS 발음 변환·자막 기호 렌더링의 입력 계약.
    expect(prompt).toContain('Write ALL math inside message as LaTeX commands');
  });

  // 재촬영 필요 판단은 산문이 아니라 구조화 ERROR 로만 - 앱의 로봇 재촬영
  // 트리거가 fsm_state=ERROR 에만 걸려 있다 (2026-07-30, "말로만 재촬영"
  // 수정). ERROR_POLICY 는 사진이 있는 턴에만 들어간다.
  it('forbids prose-only retake talk on photo turns', () => {
    expect(buildSystemPrompt({ hasProblemImage: true })).toContain(
      'NEVER merely SAY in prose that a retake is needed',
    );
  });

  // 오버레이 좌표 정책은 첨부가 전사본일 때(boardAttached)만 들어간다 -
  // 첫 분석 턴(첨부 = 원본 사진)에 좌표를 받으면 화면과 어긋난 곳에 그려진다.
  it('includes the annotation policy only when a board image is attached', () => {
    expect(buildSystemPrompt({ boardAttached: true })).toContain('annotations (visual pointing');
    expect(buildSystemPrompt()).not.toContain('annotations (visual pointing');
    expect(buildSystemPrompt({ hasProblemImage: true })).not.toContain(
      'annotations (visual pointing',
    );
  });

  // 오버레이 정밀도 (07-30): 대상을 먼저 명명(text 필수 - 문자열/도형 요소
  // 겸용)하고 tight box 를 강제한다. 새 획이 필요하면 판서 수정 경로로 유도.
  it('requires target naming and tight boxes in the annotation policy', () => {
    const prompt = buildSystemPrompt({ boardAttached: true });
    expect(prompt).toContain('`text` is REQUIRED');
    expect(prompt).toContain('box_2d must tightly enclose the target');
    expect(prompt).toContain('Annotations only overlay UI');
  });

  // 정답 도달 시 "맞아!"+칭찬만 하고 끝나던 옛 정책의 회귀 방지: 학생이 최종
  // 정답에 도달하면 전체 풀이를 한 번 말로 정리해줘야 한다. 같은 질문을
  // 되묻는 것도 금지(답했는데 비슷한 질문 반복하던 실기기 증상).
  it('tells the model to recap the full solution on a confirmed final answer, and never re-ask an answered question', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('COMPLETE recap of the full solution');
    expect(prompt).toContain('NEVER repeat a question the student already answered');
  });
});

describe('buildSystemPrompt directSolveMode', () => {
  it('includes the direct-solve policy when directSolveMode is true', () => {
    const prompt = buildSystemPrompt({ hintCount: 0, wrongStreak: 0, directSolveMode: true });
    expect(prompt).toContain('바로 정답');
    expect(prompt).toContain('SOLVE_STAGE');
  });

  it('omits the direct-solve policy by default', () => {
    const prompt = buildSystemPrompt({ hintCount: 0, wrongStreak: 0 });
    expect(prompt).not.toContain('바로 정답');
  });

  it('omits the direct-solve policy when directSolveMode is explicitly false', () => {
    const prompt = buildSystemPrompt({ hintCount: 0, wrongStreak: 0, directSolveMode: false });
    expect(prompt).not.toContain('바로 정답');
  });
});

// D-30 회귀 방지: 실기기 2026-07-31 사고 - ④ \frac{80\sqrt{3}}{9} 를 16 으로
// 오인식 → 계산 답이 선지에 없자 억지 대수로 ③ 에 끼워맞춰 D-27 이 오답을
// 세션에 고정했다. 객관식 self-check 는 정답 도출이 일어나는 모든 분기
// (일반 힌트 + 바로 정답)에 있어야 한다.
describe('multiple-choice self-check (D-30)', () => {
  it.each([
    ['hint mode', { hasProblemImage: true, freshPhoto: true }],
    ['direct-solve mode', { hasProblemImage: true, freshPhoto: true, directSolveMode: true }],
  ])('includes the self-check and force-fit ban in %s', (_label, ctx) => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('SELF-CHECK');
    expect(prompt).toContain('answer_not_in_choices');
    expect(prompt).toContain('NEVER bend your algebra');
  });

  it('tells EVAL turns to always report answer_not_in_choices=false', () => {
    const prompt = buildSystemPrompt({ hasProblemImage: true });
    expect(prompt).toContain('including all EVAL turns - set false');
  });
});

describe('student_dismissal (학생 하차 신호)', () => {
  it.each([
    ['hint mode', {}],
    ['direct-solve mode', { directSolveMode: true }],
  ])('defines the student_dismissal rule in %s', (_label, ctx) => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('student_dismissal');
    expect(prompt).toContain('꺼져');
  });
});

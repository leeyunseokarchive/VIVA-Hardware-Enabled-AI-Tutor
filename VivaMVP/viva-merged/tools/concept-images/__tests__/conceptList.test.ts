/** 개념 목록 무결성 — id 중복·빈 별칭이 있으면 LLM 매칭이 조용히 어긋난다. */
import { CONCEPT_LIST } from '../conceptList';
import { CONCEPT_BOARD_RULES, conceptBoardPrompt } from '../../../src/prompts/conceptBoardPrompt';

describe('CONCEPT_LIST', () => {
  it('20개, id 유일, kebab-case', () => {
    expect(CONCEPT_LIST).toHaveLength(20);
    const ids = CONCEPT_LIST.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(id).toMatch(/^[a-z0-9-]+$/));
  });

  it('이름·별칭·도해 지시문이 비지 않는다', () => {
    CONCEPT_LIST.forEach((c) => {
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.aliases.length).toBeGreaterThan(0);
      expect(c.sketch.length).toBeGreaterThan(10);
    });
  });
});

describe('conceptBoardPrompt', () => {
  it('물음표·질문 금지 규칙과 개념명·지시문을 포함한다', () => {
    const p = conceptBoardPrompt('삼각비', '직각삼각형과 sin·cos·tan 정의');
    expect(p).toContain('삼각비');
    expect(p).toContain('직각삼각형과 sin·cos·tan 정의');
    expect(p).toContain(CONCEPT_BOARD_RULES);
    expect(CONCEPT_BOARD_RULES).toContain('물음표');
  });

  it('칠판 물체·질감 금지와 배경색 지정을 포함한다 (2026-08-13 피드백)', () => {
    expect(CONCEPT_BOARD_RULES).toContain('#FAF7F0');
    expect(CONCEPT_BOARD_RULES).toContain('칠판');
    expect(CONCEPT_BOARD_RULES).toContain('그리지 않는다');
  });
});
